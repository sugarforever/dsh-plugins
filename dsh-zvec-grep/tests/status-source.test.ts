import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexStatusSource } from '../src/client/status-source.ts'

afterEach(() => vi.useRealTimers())

describe('IndexStatusSource', () => {
  it('polls status, publishes immutable snapshots, and uses the host interval', async () => {
    vi.useFakeTimers()
    const fetchStatus = vi.fn(async () => new Response(JSON.stringify({
      version: 1,
      pollIntervalMs: 750,
      status: { status: 'ready', pendingChanges: 0, updatedAt: 42 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const source = new IndexStatusSource(fetchStatus)
    const listener = vi.fn()
    source.subscribe(listener)

    source.selectSession('session')
    source.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(source.getSnapshot()).toEqual(expect.objectContaining({ connection: 'ready', status: expect.objectContaining({ status: 'ready' }) }))
    expect(listener).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(749)
    expect(fetchStatus).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    source.stop()
  })

  it('surfaces transport failures without throwing from the polling loop', async () => {
    vi.useFakeTimers()
    const source = new IndexStatusSource(vi.fn(async () => { throw new Error('offline') }))
    source.selectSession('session')
    source.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot()).toEqual(expect.objectContaining({ connection: 'error', message: 'offline' }))
    source.stop()
  })

  it('names the requested status path when the host rejects the poll', async () => {
    vi.useFakeTimers()
    const source = new IndexStatusSource(vi.fn(async () => new Response('missing sessionId', { status: 400 })))
    source.selectSession('session-A')
    source.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(source.getSnapshot()).toEqual(expect.objectContaining({
      connection: 'error',
      message: 'Zvec status request failed (400) for /api/dsh-zvec-grep/status?sessionId=session-A',
    }))
    source.stop()
  })

  it('keeps loading and retries quickly when the session is not restored yet', async () => {
    vi.useFakeTimers()
    const fetchStatus = vi.fn(async () => new Response('not found', { status: 404 }))
    const source = new IndexStatusSource(fetchStatus)
    source.selectSession('session')
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
    source.selectSession('A')
    source.start()
    source.selectSession('B')
    source.selectSession('A')
    expect(fetchStatus).toHaveBeenCalledTimes(3)

    const payload = (updatedAt: number) => new Response(JSON.stringify({
      version: 1,
      pollIntervalMs: 750,
      status: { status: 'ready', pendingChanges: 0, updatedAt },
    }))
    resolvers[2]?.(payload(3))
    await vi.advanceTimersByTimeAsync(0)
    resolvers[0]?.(payload(1))
    resolvers[1]?.(payload(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot().status?.updatedAt).toBe(3)

    await vi.advanceTimersByTimeAsync(750)
    expect(fetchStatus).toHaveBeenCalledTimes(4)
    source.stop()
  })
})
