import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexStatusSource } from '../src/client/status-source.ts'

afterEach(() => vi.useRealTimers())

function payload(workspaces: unknown[], pollIntervalMs = 750): Response {
  return new Response(JSON.stringify({ version: 2, pollIntervalMs, workspaces }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('IndexStatusSource', () => {
  it('polls status, publishes immutable snapshots, and uses the host interval', async () => {
    vi.useFakeTimers()
    const fetchStatus = vi.fn(async () => payload([{ root: '/repo', status: 'ready', pendingChanges: 0, updatedAt: 42 }]))
    const source = new IndexStatusSource(fetchStatus)
    const listener = vi.fn()
    source.subscribe(listener)

    source.selectWorkspace('/repo')
    source.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(source.getSnapshot()).toEqual(expect.objectContaining({
      connection: 'ready',
      status: expect.objectContaining({ root: '/repo', status: 'ready' }),
    }))
    expect(listener).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(749)
    expect(fetchStatus).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    source.stop()
  })

  it('selects its own workspace out of the reported list', async () => {
    vi.useFakeTimers()
    const source = new IndexStatusSource(vi.fn(async () => payload([
      { root: '/other', status: 'error', pendingChanges: 3, updatedAt: 1, errorCode: 'index_failed' },
      { root: '/repo', status: 'refreshing', pendingChanges: 2, updatedAt: 9 },
    ])))
    source.selectWorkspace('/repo')
    source.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(source.getSnapshot()).toEqual(expect.objectContaining({
      connection: 'ready',
      status: expect.objectContaining({ root: '/repo', status: 'refreshing', pendingChanges: 2 }),
    }))
    source.stop()
  })

  it('surfaces transport failures without throwing from the polling loop', async () => {
    vi.useFakeTimers()
    const source = new IndexStatusSource(vi.fn(async () => { throw new Error('offline') }))
    source.selectWorkspace('/repo')
    source.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot()).toEqual(expect.objectContaining({ connection: 'error', message: 'offline' }))
    source.stop()
  })

  it('names the requested status endpoint when the host rejects the poll', async () => {
    vi.useFakeTimers()
    const source = new IndexStatusSource(vi.fn(async () => new Response('nope', { status: 500 })))
    source.selectWorkspace('/repo')
    source.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(source.getSnapshot()).toEqual(expect.objectContaining({
      connection: 'error',
      message: 'Zvec status request failed (500) for GET /api/dsh-zvec-grep/status',
    }))
    source.stop()
  })

  it('keeps loading and retries quickly while the workspace is not reported yet', async () => {
    vi.useFakeTimers()
    const fetchStatus = vi.fn(async () => payload([{ root: '/other', status: 'ready', pendingChanges: 0, updatedAt: 1 }]))
    const source = new IndexStatusSource(fetchStatus)
    source.selectWorkspace('/repo')
    source.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(source.getSnapshot()).toEqual({ connection: 'loading' })
    await vi.advanceTimersByTimeAsync(249)
    expect(fetchStatus).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    source.stop()
  })

  it('keeps loading and retries quickly when the host rejects the request with 404', async () => {
    vi.useFakeTimers()
    const fetchStatus = vi.fn(async () => new Response('not found', { status: 404 }))
    const source = new IndexStatusSource(fetchStatus)
    source.selectWorkspace('/repo')
    source.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(source.getSnapshot()).toEqual({ connection: 'loading' })
    await vi.advanceTimersByTimeAsync(249)
    expect(fetchStatus).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    source.stop()
  })

  it('discards stale A-B-A responses and does not create duplicate polling chains', async () => {
    vi.useFakeTimers()
    const resolvers: Array<(response: Response) => void> = []
    const fetchStatus = vi.fn(() => new Promise<Response>(resolve => resolvers.push(resolve)))
    const source = new IndexStatusSource(fetchStatus)
    source.selectWorkspace('A')
    source.start()
    source.selectWorkspace('B')
    source.selectWorkspace('A')
    expect(fetchStatus).toHaveBeenCalledTimes(3)

    const at = (root: string, updatedAt: number) => payload([{ root, status: 'ready', pendingChanges: 0, updatedAt }])
    resolvers[2]?.(at('A', 3))
    await vi.advanceTimersByTimeAsync(0)
    resolvers[0]?.(at('A', 1))
    resolvers[1]?.(at('B', 2))
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot().status?.updatedAt).toBe(3)

    await vi.advanceTimersByTimeAsync(750)
    expect(fetchStatus).toHaveBeenCalledTimes(4)
    source.stop()
  })

  it('polls a parameterless path because a registered route cannot receive a query string', async () => {
    vi.useFakeTimers()
    const calls: Array<{ input: unknown; init?: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init })
      return new Response('{}', { status: 500 })
    }) as typeof fetch
    try {
      const source = new IndexStatusSource()
      source.selectWorkspace('/repo')
      source.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(calls).toHaveLength(1)
      expect(calls[0]?.input).toBe('/api/dsh-zvec-grep/status')
      expect(calls[0]?.init?.body).toBeUndefined()
      source.stop()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
