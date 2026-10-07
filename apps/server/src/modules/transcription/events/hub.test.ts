import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  notify: (() => {}) as (payload: string) => void,
  connected: () => {},
  unlisten: vi.fn(),
  listen: vi.fn(),
  find: vi.fn(),
  list: vi.fn()
}))
vi.mock('../../../db/index.js', () => ({
  client: {
    listen: state.listen.mockImplementation((_channel, notify, connected) => {
      state.notify = notify
      state.connected = connected
      connected()
      return Promise.resolve({ unlisten: state.unlisten })
    })
  }
}))
vi.mock('../jobs/store.js', () => ({ findJob: state.find, listJobs: state.list }))
vi.mock('../jobs/rows.js', () => ({
  publicJob: (row: unknown, result: boolean) => ({ row, result })
}))

import { createTranscriptionEventsHub } from './hub.js'

const componentId = '11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
const notification = (type = 'job', userId = 'user'): string =>
  JSON.stringify({ type, id, componentId, userId })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  state.find.mockReset()
  state.list.mockReset().mockResolvedValue([])
  state.listen.mockClear()
  state.unlisten.mockReset()
})

describe('transcription event hub', () => {
  it('shares one listener, scopes events and sends visible jobs without results', async () => {
    const hub = createTranscriptionEventsHub()
    const send = vi.fn()
    const other = vi.fn()
    const unsubscribe = hub.subscribe(componentId, 'user', { send, close: vi.fn() })
    hub.subscribe(componentId, 'other', { send: other, close: vi.fn() })
    await hub.start()
    await hub.start()
    state.find.mockResolvedValue({ id, transcriptId: 'saved' })
    state.notify(notification())
    await flush()
    expect(state.listen).toHaveBeenCalledTimes(1)
    expect(state.find).toHaveBeenCalledWith(id, componentId, 'user')
    expect(send).toHaveBeenCalledWith({
      type: 'job',
      data: { row: { id, transcriptId: 'saved' }, result: false }
    })
    expect(other).not.toHaveBeenCalled()
    unsubscribe()
    state.notify(notification())
    await flush()
    expect(state.find).toHaveBeenCalledTimes(1)
    hub.stop()
    await flush()
    expect(state.unlisten).toHaveBeenCalledTimes(1)
  })

  it('sends removals and metadata completion, ignoring invalid and unrelated payloads', async () => {
    const hub = createTranscriptionEventsHub()
    const send = vi.fn()
    hub.subscribe(componentId, 'user', { send, close: vi.fn() })
    await hub.start()
    state.find.mockResolvedValue(undefined)
    state.notify('bad json')
    state.notify('{}')
    state.notify(notification('job', 'someone else'))
    state.notify(notification())
    state.notify(notification('transcriptMetadata'))
    await flush()
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      { type: 'jobRemoved', data: { id } },
      { type: 'transcriptMetadata', data: { id } }
    ])
    expect(state.find).toHaveBeenCalledTimes(1)
    hub.stop()
  })

  it('serializes loads and ends the streams after a listener reconnect', async () => {
    const hub = createTranscriptionEventsHub()
    const send = vi.fn()
    const close = vi.fn()
    hub.subscribe(componentId, 'user', { send, close })
    await hub.start()
    let resolve!: (value: unknown) => void
    state.find.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    state.find.mockResolvedValueOnce({ id, status: 'completed' })
    state.notify(notification())
    await flush()
    state.notify(notification())
    state.connected()
    await flush()
    expect(state.find).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    resolve({ id, status: 'transcribing' })
    await flush()
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      { type: 'job', data: { row: { id, status: 'transcribing' }, result: false } },
      { type: 'job', data: { row: { id, status: 'completed' }, result: false } }
    ])
    expect(close).toHaveBeenCalledTimes(1)
    expect(state.list).not.toHaveBeenCalled()
    hub.stop()
  })

  it('retries initial listen failures and ignores a stopped listener after restart', async () => {
    const hub = createTranscriptionEventsHub()
    state.listen.mockRejectedValueOnce(new Error('initial connection failed'))
    await expect(hub.start()).rejects.toThrow('initial connection failed')
    await hub.start()
    const previousNotify = state.notify
    const previousConnected = state.connected
    hub.stop()
    const send = vi.fn()
    hub.subscribe(componentId, 'user', { send, close: vi.fn() })
    await hub.start()
    previousNotify(notification())
    previousConnected()
    await flush()
    expect(state.find).not.toHaveBeenCalled()
    expect(state.list).not.toHaveBeenCalled()
    state.notify(notification('transcriptMetadata'))
    await flush()
    expect(send).toHaveBeenCalledWith({ type: 'transcriptMetadata', data: { id } })
    hub.stop()
  })

  it('closes subscribers on a load failure or shutdown', async () => {
    const hub = createTranscriptionEventsHub()
    const close = vi.fn()
    const send = vi.fn()
    hub.subscribe(componentId, 'user', { send, close })
    await hub.start()
    state.find.mockRejectedValue(new Error('database unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.notify(notification())
    await flush()
    expect(close).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    hub.stop()
    expect(close).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })
})
