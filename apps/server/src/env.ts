import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const serverDirectory = resolve(sourceDirectory, '..')
const repositoryDirectory = resolve(serverDirectory, '../..')

config({
  path: [resolve(serverDirectory, '.env'), resolve(repositoryDirectory, '.env')],
  quiet: true
})

const commaSeparatedOrigins = z.string().transform((value, context) => {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  if (origins.length === 0) {
    context.addIssue({ code: 'custom', message: 'CORS_ORIGINS must contain at least one origin' })
    return z.NEVER
  }

  return origins
})

const encryptionKey = z.string().transform((value, context) => {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    context.addIssue({
      code: 'custom',
      message: 'COMPONENT_SECRETS_KEY must be base64 that decodes to exactly 32 bytes'
    })
    return z.NEVER
  }
  return decoded
})

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.string().min(1),
    COMPONENT_SECRETS_KEY: encryptionKey,
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(1),
    CORS_ORIGINS: commaSeparatedOrigins,
    KEYCLOAK_ISSUER: z.url(),
    KEYCLOAK_CLIENT_ID: z.string().min(1),
    KEYCLOAK_CLIENT_SECRET: z.string().min(1),
    KEYCLOAK_ADMIN_ROLE: z.string().min(1).default('admin'),
    FEED_ALLOW_PRIVATE_HOSTS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    WEB_ORIGIN: z.url().optional(),
    SERVE_WEB_DIR: z.string().min(1).optional(),
    // The translator editor's Python runs: container CLI, image (infra/python-sandbox) and an
    // optional container runtime such as gVisor's `runsc`.
    PYTHON_SANDBOX_DOCKER: z.string().min(1).default('docker'),
    PYTHON_SANDBOX_IMAGE: z.string().min(1).default('justcampus-python-sandbox:latest'),
    PYTHON_SANDBOX_RUNTIME: z.string().min(1).optional(),
    // The transcription module's object storage (S3-compatible, MinIO in docker compose). The
    // server reaches it at the endpoint; browsers upload and play through signed URLs on the public
    // endpoint, which defaults to the same. Without a bucket the module offers no uploads.
    TRANSCRIPTION_S3_ENDPOINT: z.url().optional(),
    TRANSCRIPTION_S3_PUBLIC_ENDPOINT: z.url().optional(),
    TRANSCRIPTION_S3_REGION: z.string().min(1).default('us-east-1'),
    TRANSCRIPTION_S3_BUCKET: z.string().min(1).optional(),
    TRANSCRIPTION_S3_ACCESS_KEY: z.string().min(1).optional(),
    TRANSCRIPTION_S3_SECRET_KEY: z.string().min(1).optional(),
    TRANSCRIPTION_S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    // The ffmpeg and ffprobe binaries the transcription worker runs, and where it keeps its
    // temporary files (default: the system's temporary directory).
    TRANSCRIPTION_FFMPEG: z.string().min(1).default('ffmpeg'),
    TRANSCRIPTION_FFPROBE: z.string().min(1).default('ffprobe'),
    TRANSCRIPTION_WORK_DIR: z.string().min(1).optional(),
    // The TURN servers' shared secret (coturn `static-auth-secret`), from which the server makes
    // short-lived credentials for each live session when the module's TURN auth is `ephemeral`.
    // It never leaves the server.
    TRANSCRIPTION_TURN_SECRET: z.string().min(16).optional()
  })
  .transform((value) => ({
    ...value,
    WEB_ORIGIN: value.WEB_ORIGIN ?? value.CORS_ORIGINS[0]!
  }))

export const env = envSchema.parse(process.env)

// ---------------------------------------------------------------------------
// Outbound proxy
// ---------------------------------------------------------------------------

/**
 * Hosts that reach the internet only through a proxy (the campus host): Node's `fetch` (the
 * transcription and translator upstreams, Keycloak) and its `http`/`https` modules (the S3 client)
 * use `HTTPS_PROXY`/`HTTP_PROXY` only with `NODE_USE_ENV_PROXY=1` (Node 22.21 and 24.5 or later)
 * or `--use-env-proxy`, and go direct to the hosts of `NO_PROXY`. Object storage, Keycloak and
 * local services usually sit inside and must be listed there. Nothing here changes requests; the
 * server only warns at start about settings that would send them the wrong way.
 */

/** A proxy variable as Node reads it: lower case before upper case; empty counts as unset. */
export function proxyVariable(
  environment: NodeJS.ProcessEnv,
  name: 'HTTPS_PROXY' | 'HTTP_PROXY' | 'NO_PROXY'
): string | null {
  return environment[name.toLowerCase()]?.trim() || environment[name]?.trim() || null
}

function ipNumber(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return null
  return parts.reduce((value, part) => value * 256 + Number(part), 0)
}

/**
 * Whether `NO_PROXY` sends requests to `url` direct, read as strictly as Node's `http` module
 * does (`fetch` is a little more lenient): `*`, the exact host, `.domain` or `*.domain` for its
 * subdomains, an IPv4 address or `from-to` range, each optionally with `:port`.
 */
export function noProxyCovers(noProxy: string | null, url: string): boolean {
  if (!noProxy) return false
  const target = new URL(url)
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')
  return noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((raw) => {
      const entry = raw.toLowerCase()
      if (entry === '*') return true
      const portMatch = /^(.+?):(\d+)$/.exec(entry)
      if (portMatch && !portMatch[1]!.includes(':') && portMatch[2] !== port) return false
      const name = portMatch && !portMatch[1]!.includes(':') ? portMatch[1]! : entry
      const range = /^([\d.]+)-([\d.]+)$/.exec(name)
      if (range) {
        const [from, to, value] = [ipNumber(range[1]!), ipNumber(range[2]!), ipNumber(host)]
        return from !== null && to !== null && value !== null && value >= from && value <= to
      }
      if (name.startsWith('*.')) return host.endsWith(name.slice(1))
      if (name.startsWith('.')) return host.endsWith(name)
      return host === name.replace(/^\[|\]$/g, '')
    })
}

/**
 * What the server warns about at start: proxy variables Node ignores without
 * `NODE_USE_ENV_PROXY=1`, and `internalUrls` (object storage, Keycloak, the server itself) that
 * the proxy would get. Never names the proxy, whose URL may hold credentials.
 */
export function outboundProxyWarnings(
  environment: NodeJS.ProcessEnv,
  internalUrls: readonly string[],
  execArgv: readonly string[] = []
): string[] {
  const proxies = {
    'http:': proxyVariable(environment, 'HTTP_PROXY'),
    'https:': proxyVariable(environment, 'HTTPS_PROXY')
  }
  if (!proxies['http:'] && !proxies['https:']) return []
  const enabled =
    environment.NODE_USE_ENV_PROXY === '1' ||
    [...execArgv, ...(environment.NODE_OPTIONS?.split(/\s+/) ?? [])].includes('--use-env-proxy')
  if (!enabled) {
    return [
      'HTTPS_PROXY/HTTP_PROXY is set but Node ignores it without NODE_USE_ENV_PROXY=1: outbound requests go direct.'
    ]
  }
  const noProxy = proxyVariable(environment, 'NO_PROXY')
  return internalUrls.flatMap((url) => {
    const protocol = new URL(url).protocol as keyof typeof proxies
    if (!proxies[protocol] || noProxyCovers(noProxy, url)) return []
    return [`${new URL(url).host} would be reached through the proxy: add it to NO_PROXY.`]
  })
}

for (const warning of outboundProxyWarnings(
  process.env,
  [
    `http://127.0.0.1:${env.PORT}`,
    `http://localhost:${env.PORT}`,
    env.KEYCLOAK_ISSUER,
    env.TRANSCRIPTION_S3_ENDPOINT
  ].filter((url): url is string => Boolean(url)),
  process.execArgv
)) {
  console.warn(`Outbound proxy: ${warning}`)
}
