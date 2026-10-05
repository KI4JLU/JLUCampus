import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  noProxyCovers,
  outboundProxyWarnings,
  PRODUCTION_BRIDGE_URL,
  proxyVariable,
  reachedThroughProxy
} from './env.js'

const run = promisify(execFile)

describe('NO_PROXY', () => {
  it('matches as strictly as Node’s http module', () => {
    const noProxy = 'localhost,127.0.0.1,.ts.net,*.campus.test,minio:9000,10.0.0.1-10.0.0.9'
    expect(noProxyCovers(noProxy, 'http://localhost:3000/api/health')).toBe(true)
    expect(noProxyCovers(noProxy, 'http://127.0.0.1:9100')).toBe(true)
    expect(noProxyCovers(noProxy, 'https://box.tail1234.ts.net')).toBe(true)
    expect(noProxyCovers(noProxy, 'https://keycloak.campus.test/realms/x')).toBe(true)
    expect(noProxyCovers(noProxy, 'http://minio:9000')).toBe(true)
    expect(noProxyCovers(noProxy, 'http://minio:9001')).toBe(false)
    expect(noProxyCovers(noProxy, 'http://10.0.0.5:9000')).toBe(true)
    expect(noProxyCovers(noProxy, 'http://10.0.0.10:9000')).toBe(false)
    expect(noProxyCovers(noProxy, 'https://api.hrz.uni-giessen.de/v1')).toBe(false)
    // A bare domain is the host only for `http`, which the S3 client uses.
    expect(noProxyCovers('uni-giessen.de', 'https://s3.uni-giessen.de')).toBe(false)
    expect(noProxyCovers('*', 'https://anything.example')).toBe(true)
    expect(noProxyCovers(null, 'http://localhost')).toBe(false)
  })

  it('reads lower case before upper case', () => {
    expect(proxyVariable({ https_proxy: 'http://a', HTTPS_PROXY: 'http://b' }, 'HTTPS_PROXY')).toBe(
      'http://a'
    )
    expect(proxyVariable({ NO_PROXY: ' localhost ' }, 'NO_PROXY')).toBe('localhost')
    expect(proxyVariable({ HTTP_PROXY: '' }, 'HTTP_PROXY')).toBeNull()
  })
})

describe('proxy warnings at start', () => {
  const internal = [
    'http://127.0.0.1:3000',
    'https://keycloak.campus.test/realms/x',
    'http://minio:9000'
  ]
  const proxy = 'http://user:secret@proxy.campus.test:3128'

  it('says nothing without a proxy', () => {
    expect(outboundProxyWarnings({}, internal)).toEqual([])
  })

  it('warns that Node ignores the proxy without NODE_USE_ENV_PROXY', () => {
    const warnings = outboundProxyWarnings({ HTTPS_PROXY: proxy }, internal)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('NODE_USE_ENV_PROXY=1')
    expect(outboundProxyWarnings({ HTTPS_PROXY: proxy }, internal, ['--use-env-proxy'])).toEqual(
      outboundProxyWarnings({ HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: '1' }, internal)
    )
  })

  it('names the internal hosts the proxy would get, never the proxy itself', () => {
    const warnings = outboundProxyWarnings(
      { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NODE_USE_ENV_PROXY: '1', NO_PROXY: '127.0.0.1' },
      internal
    )
    expect(warnings).toEqual([
      'keycloak.campus.test would be reached through the proxy: add it to NO_PROXY.',
      'minio:9000 would be reached through the proxy: add it to NO_PROXY.'
    ])
    expect(warnings.join(' ')).not.toContain('secret')
    // Only HTTPS_PROXY: plain-http hosts go direct anyway.
    expect(
      outboundProxyWarnings({ HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: '1' }, internal)
    ).toEqual(['keycloak.campus.test would be reached through the proxy: add it to NO_PROXY.'])
    expect(
      outboundProxyWarnings(
        {
          HTTPS_PROXY: proxy,
          HTTP_PROXY: proxy,
          NODE_USE_ENV_PROXY: '1',
          NO_PROXY: 'localhost,127.0.0.1,.campus.test,minio'
        },
        internal
      )
    ).toEqual([])
  })
})

describe('the production realtime bridge behind a proxy (B-6)', () => {
  const proxy = 'http://proxy.campus.test:3128'
  const enabled = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NODE_USE_ENV_PROXY: '1' }

  it('warns when NO_PROXY misses host.docker.internal', () => {
    expect(
      outboundProxyWarnings({ ...enabled, NO_PROXY: 'localhost,127.0.0.1,minio' }, [
        PRODUCTION_BRIDGE_URL
      ])
    ).toEqual(['host.docker.internal:8089 would be reached through the proxy: add it to NO_PROXY.'])
    expect(
      outboundProxyWarnings(
        { ...enabled, NO_PROXY: 'localhost,127.0.0.1,minio,host.docker.internal' },
        [PRODUCTION_BRIDGE_URL]
      )
    ).toEqual([])
  })

  it('knows when a request goes through the proxy', () => {
    expect(reachedThroughProxy(enabled, PRODUCTION_BRIDGE_URL)).toBe(true)
    expect(reachedThroughProxy({ HTTP_PROXY: proxy }, PRODUCTION_BRIDGE_URL)).toBe(false)
    expect(
      reachedThroughProxy({ HTTP_PROXY: proxy }, PRODUCTION_BRIDGE_URL, ['--use-env-proxy'])
    ).toBe(true)
    expect(reachedThroughProxy({ ...enabled, HTTP_PROXY: '' }, PRODUCTION_BRIDGE_URL)).toBe(false)
  })
})

/** Node 22.21 and 24.5 brought `NODE_USE_ENV_PROXY` to `fetch` and `http` alike. */
function supportsEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21)
}

/**
 * The server's outbound requests behind a proxy, with Node as it runs the server: a child process
 * with only the proxy variables, a local proxy that records what reaches it, and a local service
 * in `NO_PROXY`. No request leaves this machine.
 */
describe.skipIf(!supportsEnvProxy(process.versions.node))('requests behind a proxy', () => {
  const seen: string[] = []
  let proxy: Server
  let tunnelled: Server
  let direct: Server
  let proxyUrl: string
  let directPort: number

  beforeAll(async () => {
    // `http` sends plain-http requests to the proxy as they are; `fetch` asks for a tunnel even
    // for them, which leads to `tunnelled`. HTTPS tunnels are refused: where they went is enough.
    proxy = createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      response.end('through the proxy')
    })
    tunnelled = createServer((_request, response) => response.end('through the proxy'))
    proxy.on('connect', (request, socket) => {
      seen.push(`CONNECT ${request.url}`)
      if (request.url?.endsWith(':443')) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const upstream = connect((tunnelled.address() as AddressInfo).port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(socket).pipe(upstream)
      })
    })
    direct = createServer((_request, response) => response.end('direct'))
    await Promise.all(
      [proxy, tunnelled, direct].map(
        (server) => new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      )
    )
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    directPort = (direct.address() as AddressInfo).port
  })
  afterAll(async () => {
    for (const server of [proxy, tunnelled, direct]) server.closeAllConnections()
    await Promise.all(
      [proxy, tunnelled, direct].map(
        (server) => new Promise((done) => server.close(() => done(null)))
      )
    )
  })

  it('sends upstreams through the proxy and NO_PROXY hosts direct, with fetch and http', async () => {
    const script = `
      import { get } from 'node:http'
      const viaHttp = (url) => new Promise((resolve, reject) => {
        get(url, (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => resolve(body))
        }).on('error', reject)
      })
      const results = {
        fetchUpstream: await (await fetch('http://upstream.invalid/v1/models')).text(),
        fetchLocal: await (await fetch('http://127.0.0.1:${directPort}/')).text(),
        httpStorage: await viaHttp('http://storage.invalid/bucket'),
        httpLocal: await viaHttp('http://localhost:${directPort}/'),
        hrz: await fetch('https://api.hrz.uni-giessen.de/v1/models').then(
          () => 'answered',
          () => 'refused'
        )
      }
      console.log(JSON.stringify(results))
    `
    const { stdout } = await run('node', ['--input-type=module', '-e', script], {
      env: {
        PATH: process.env.PATH,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: 'localhost,127.0.0.1,.ts.net'
      },
      timeout: 20_000
    })
    expect(JSON.parse(stdout)).toEqual({
      fetchUpstream: 'through the proxy',
      fetchLocal: 'direct',
      httpStorage: 'through the proxy',
      httpLocal: 'direct',
      hrz: 'refused'
    })
    expect(seen).toContain('CONNECT upstream.invalid:80')
    expect(seen).toContain('GET http://storage.invalid/bucket')
    expect(seen).toContain('CONNECT api.hrz.uni-giessen.de:443')
    expect(seen.some((line) => line.includes(String(directPort)))).toBe(false)
  })
})
