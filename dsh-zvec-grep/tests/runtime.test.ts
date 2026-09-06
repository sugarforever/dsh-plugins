import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSearchRuntime, type SearchEngine, type WorkspaceWatchCallbacks } from '../src/runtime.ts'

function engine(): SearchEngine {
  return {
    index: vi.fn(async () => ({ filesIndexed: 1 })),
    context: vi.fn(async ({ query }) => ({ query: query ?? '', root: '/workspace', source: 'index' as const, coverage: 'ranked_sample' as const, items: [], diagnostics: {} })),
    close: vi.fn(async () => undefined),
  }
}

function harness(backend = engine()) {
  let callbacks!: WorkspaceWatchCallbacks
  const watcher = { close: vi.fn(async () => undefined) }
  const watch = vi.fn((_root: string, next: WorkspaceWatchCallbacks) => {
    callbacks = next
    return watcher
  })
  const runtime = new WorkspaceSearchRuntime({ create: async () => backend, watch, debounceMs: 25, reconcileIntervalMs: 0 })
  return { backend, callbacks: () => callbacks, runtime, watch, watcher }
}

afterEach(() => vi.useRealTimers())

describe('WorkspaceSearchRuntime', () => {
  it('starts indexing and watching when a workspace session is activated', async () => {
    const fixture = harness()
    fixture.runtime.activate('/workspace')
    await fixture.runtime.settled('/workspace')
    expect(fixture.watch).toHaveBeenCalledWith('/workspace', expect.any(Object))
    expect(fixture.backend.index).toHaveBeenCalledWith(expect.objectContaining({ root: '/workspace' }))
  })

  it('publishes workspace status snapshots across indexing and watcher refreshes', async () => {
    vi.useFakeTimers()
    const fixture = harness()
    fixture.runtime.activate('/workspace')
    expect(fixture.runtime.status()).toEqual([
      expect.objectContaining({ root: '/workspace', status: 'indexing', pendingChanges: 0 }),
    ])
    await fixture.runtime.settled('/workspace')
    expect(fixture.runtime.status()).toEqual([
      expect.objectContaining({ root: '/workspace', status: 'ready', pendingChanges: 0 }),
    ])

    fixture.callbacks().change('/workspace/src/a.ts')
    expect(fixture.runtime.status()).toEqual([
      expect.objectContaining({ root: '/workspace', status: 'refreshing', pendingChanges: 1 }),
    ])
    await vi.advanceTimersByTimeAsync(25)
    expect(fixture.runtime.status()).toEqual([
      expect.objectContaining({ root: '/workspace', status: 'ready', pendingChanges: 0 }),
    ])
  })

  it('deduplicates activation for sessions sharing a workspace', async () => {
    const backend = engine()
    const create = vi.fn(async () => backend)
    const runtime = new WorkspaceSearchRuntime({ create, reconcileIntervalMs: 0 })
    runtime.activate('/workspace')
    runtime.activate('/workspace')
    await runtime.settled('/workspace')
    expect(create).toHaveBeenCalledOnce()
    expect(backend.index).toHaveBeenCalledOnce()
  })

  it('deduplicates equivalent workspace paths', async () => {
    const backend = engine()
    const create = vi.fn(async () => backend)
    const runtime = new WorkspaceSearchRuntime({ create, reconcileIntervalMs: 0 })
    runtime.activate('/workspace')
    runtime.activate('/workspace/.')
    await runtime.settled('/workspace/../workspace')
    expect(create).toHaveBeenCalledOnce()
    expect(backend.index).toHaveBeenCalledOnce()
  })

  it('returns indexing immediately instead of waiting for the initial index', async () => {
    let finishIndex!: () => void
    const indexing = new Promise<void>(resolve => { finishIndex = resolve })
    const backend = engine()
    vi.mocked(backend.index).mockImplementation(async () => { await indexing; return {} })
    const runtime = new WorkspaceSearchRuntime({ create: async () => backend, reconcileIntervalMs: 0 })
    runtime.activate('/workspace').catch(() => undefined)

    await expect(runtime.search('/workspace', { query: 'where auth is checked' })).resolves.toEqual(expect.objectContaining({ status: 'indexing', root: '/workspace' }))
    expect(backend.context).not.toHaveBeenCalled()
    finishIndex()
    await runtime.settled('/workspace')
  })

  it('does not retry a failed initial index from search', async () => {
    const backend = engine()
    vi.mocked(backend.index).mockRejectedValue(new Error('download interrupted'))
    const runtime = new WorkspaceSearchRuntime({ create: async () => backend, reconcileIntervalMs: 0 })
    runtime.activate('/workspace').catch(() => undefined)
    await expect(runtime.settled('/workspace')).rejects.toThrow('download interrupted')

    await expect(runtime.search('/workspace', { query: 'retry me' })).resolves.toEqual(expect.objectContaining({ status: 'error', message: 'download interrupted' }))
    expect(backend.index).toHaveBeenCalledOnce()
    expect(backend.context).not.toHaveBeenCalled()
  })

  it('searches the current index without an automatic update', async () => {
    const fixture = harness()
    fixture.runtime.activate('/workspace')
    await fixture.runtime.settled('/workspace')

    const outcome = await fixture.runtime.search('/workspace', { query: 'where auth is checked', limit: 8 })

    expect(outcome.status).toBe('ready')
    expect(fixture.backend.context).toHaveBeenCalledWith({ query: 'where auth is checked', limit: 8, root: '/workspace', autoUpdate: false })
  })

  it('debounces watcher events into a path-scoped background refresh', async () => {
    vi.useFakeTimers()
    const fixture = harness()
    fixture.runtime.activate('/workspace')
    await fixture.runtime.settled('/workspace')

    fixture.callbacks().change('/workspace/src/a.ts')
    fixture.callbacks().change('/workspace/src/b.ts')
    await vi.advanceTimersByTimeAsync(25)

    expect(fixture.backend.index).toHaveBeenCalledTimes(2)
    expect(fixture.backend.index).toHaveBeenLastCalledWith(expect.objectContaining({ root: '/workspace', changedPaths: ['/workspace/src/a.ts', '/workspace/src/b.ts'] }))
  })

  it('returns refreshing immediately while a background update is active', async () => {
    vi.useFakeTimers()
    let finishRefresh!: () => void
    const fixture = harness()
    vi.mocked(fixture.backend.index).mockResolvedValueOnce({}).mockImplementationOnce(async () => new Promise<void>(resolve => { finishRefresh = resolve }))
    fixture.runtime.activate('/workspace')
    await fixture.runtime.settled('/workspace')
    fixture.callbacks().change('/workspace/src/a.ts')
    await vi.advanceTimersByTimeAsync(25)

    await expect(fixture.runtime.search('/workspace', { query: 'current state' })).resolves.toEqual(expect.objectContaining({ status: 'refreshing', root: '/workspace' }))
    expect(fixture.backend.context).not.toHaveBeenCalled()
    finishRefresh()
  })

  it('runs periodic full reconciliation without waiting for a search', async () => {
    vi.useFakeTimers()
    const backend = engine()
    const runtime = new WorkspaceSearchRuntime({ create: async () => backend, debounceMs: 5, reconcileIntervalMs: 100 })
    runtime.activate('/workspace')
    await runtime.settled('/workspace')

    await vi.advanceTimersByTimeAsync(105)

    expect(backend.index).toHaveBeenCalledTimes(2)
    expect(backend.index).toHaveBeenLastCalledWith(expect.not.objectContaining({ changedPaths: expect.anything() }))
  })

  it('closes watchers and every activated workspace engine', async () => {
    const first = harness()
    const second = engine()
    const create = vi.fn(async (root: string) => root === '/a' ? first.backend : second)
    const runtime = new WorkspaceSearchRuntime({ create, watch: first.watch, reconcileIntervalMs: 0 })
    runtime.activate('/a')
    runtime.activate('/b')
    await Promise.all([runtime.settled('/a'), runtime.settled('/b')])
    await runtime.close()
    expect(first.watcher.close).toHaveBeenCalledTimes(2)
    expect(first.backend.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('aborts an in-flight initial index before closing its engine', async () => {
    const backend = engine()
    vi.mocked(backend.index).mockImplementation(({ signal } = {}) => new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const runtime = new WorkspaceSearchRuntime({ create: async () => backend, reconcileIntervalMs: 0 })
    runtime.activate('/workspace').catch(() => undefined)

    await runtime.close()

    expect(backend.close).toHaveBeenCalledOnce()
  })

  it('can close before watcher readiness without hanging', async () => {
    let markReady!: () => void
    const ready = new Promise<void>(resolve => { markReady = resolve })
    const backend = engine()
    const runtime = new WorkspaceSearchRuntime({
      create: async () => backend,
      watch: () => ({ ready, close: () => markReady() }),
      reconcileIntervalMs: 0,
    })
    runtime.activate('/workspace').catch(() => undefined)

    await runtime.close()

    expect(backend.close).toHaveBeenCalledOnce()
    expect(backend.index).not.toHaveBeenCalled()
  })
})
