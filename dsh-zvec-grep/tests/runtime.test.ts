import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSearchRuntime, type SearchEngine, type WorkspaceWatchCallbacks } from '../src/runtime.ts'

/**
 * The runtime canonicalizes every workspace root through realpath before storing it, so tests
 * must expect that same absolute form. On a case-insensitive filesystem this also normalizes
 * `/workspace` to the real casing of an existing directory such as `D:\WorkSpace`.
 */
function canonical(root: string): string {
  const absolute = resolve(root)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

const WORKSPACE = canonical('/workspace')

function engine(): SearchEngine {
  return {
    index: vi.fn(async () => ({ filesIndexed: 1 })),
    context: vi.fn(async ({ query }) => ({ query: query ?? '', root: WORKSPACE, source: 'index' as const, coverage: 'ranked_sample' as const, items: [], diagnostics: {} })),
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
    fixture.runtime.activate(WORKSPACE)
    await fixture.runtime.settled(WORKSPACE)
    expect(fixture.watch).toHaveBeenCalledWith(WORKSPACE, expect.any(Object))
    expect(fixture.backend.index).toHaveBeenCalledWith(expect.objectContaining({ root: WORKSPACE }))
  })

  it('reports the index counts captured when the workspace indexed', async () => {
    const backend = engine()
    backend.info = vi.fn(async () => ({
      indexed: true,
      status: { filesIndexed: 56, entitiesIndexed: 390, fragmentsTruncated: 0, filesFailed: 0 },
    }))
    const fixture = harness(backend)
    fixture.runtime.activate(WORKSPACE)
    await fixture.runtime.settled(WORKSPACE)

    const first = await fixture.runtime.search(WORKSPACE, { query: 'one' })
    const second = await fixture.runtime.search(WORKSPACE, { query: 'two' })

    expect(first).toEqual(expect.objectContaining({
      status: 'ready',
      info: expect.objectContaining({ status: expect.objectContaining({ filesIndexed: 56 }) }),
    }))
    expect(second).toEqual(expect.objectContaining({ status: 'ready' }))
    // The counts only move when the index does, so a search must not re-read them.
    expect(backend.info).toHaveBeenCalledTimes(1)
  })

  it('ignores an engine that cannot report its index counts', async () => {
    const backend = engine()
    backend.info = vi.fn(async () => { throw new Error('lock busy') })
    const fixture = harness(backend)
    fixture.runtime.activate(WORKSPACE)
    await fixture.runtime.settled(WORKSPACE)

    const outcome = await fixture.runtime.search(WORKSPACE, { query: 'anything' })

    expect(outcome).toEqual(expect.objectContaining({ status: 'ready' }))
    expect('info' in outcome).toBe(false)
  })

  it('reports a search failure as a structured error without poisoning the workspace', async () => {
    const backend = engine()
    backend.context = vi.fn(async () => {
      throw new Error('zvec file metadata storage does not exist')
    })
    const fixture = harness(backend)
    fixture.runtime.activate(WORKSPACE)
    await fixture.runtime.settled(WORKSPACE)

    await expect(fixture.runtime.search(WORKSPACE, { query: 'anything' })).resolves.toEqual(expect.objectContaining({
      status: 'error',
      root: WORKSPACE,
      message: 'zvec file metadata storage does not exist',
    }))
    // A transient failure (a concurrent index run holding the write lock) must not stick.
    expect(fixture.runtime.statusFor(WORKSPACE)?.status).toBe('ready')
  })

  it('reports the resolved engine version and tested range with an outcome', async () => {
    const runtime = new WorkspaceSearchRuntime({
      create: async () => engine(),
      watch: vi.fn(() => ({ close: vi.fn() })),
      debounceMs: 25,
      reconcileIntervalMs: 0,
      engineVersion: () => '0.2.9',
      engineRange: '^0.2.1',
    })
    runtime.activate(WORKSPACE)
    await runtime.settled(WORKSPACE)

    await expect(runtime.search(WORKSPACE, { query: 'anything' })).resolves.toEqual(expect.objectContaining({
      engine: { version: '0.2.9', range: '^0.2.1' },
    }))
    await runtime.close()
  })

  it('publishes workspace status snapshots across indexing and watcher refreshes', async () => {
    vi.useFakeTimers()
    const fixture = harness()
    fixture.runtime.activate(WORKSPACE)
    expect(fixture.runtime.status()).toEqual([
      expect.objectContaining({ root: WORKSPACE, status: 'indexing', pendingChanges: 0 }),
    ])
    await fixture.runtime.settled(WORKSPACE)
    expect(fixture.runtime.status()).toEqual([
      expect.objectContaining({ root: WORKSPACE, status: 'ready', pendingChanges: 0 }),
    ])

    fixture.callbacks().change(`${WORKSPACE}/src/a.ts`)
    expect(fixture.runtime.status()).toEqual([
      expect.objectContaining({ root: WORKSPACE, status: 'refreshing', pendingChanges: 1 }),
    ])
    await vi.advanceTimersByTimeAsync(25)
    expect(fixture.runtime.status()).toEqual([
      expect.objectContaining({ root: WORKSPACE, status: 'ready', pendingChanges: 0 }),
    ])
  })

  it('deduplicates activation for sessions sharing a workspace', async () => {
    const backend = engine()
    const create = vi.fn(async () => backend)
    const runtime = new WorkspaceSearchRuntime({ create, reconcileIntervalMs: 0 })
    runtime.activate(WORKSPACE)
    runtime.activate(WORKSPACE)
    await runtime.settled(WORKSPACE)
    expect(create).toHaveBeenCalledOnce()
    expect(backend.index).toHaveBeenCalledOnce()
  })

  it('deduplicates equivalent workspace paths', async () => {
    const backend = engine()
    const create = vi.fn(async () => backend)
    const runtime = new WorkspaceSearchRuntime({ create, reconcileIntervalMs: 0 })
    runtime.activate(WORKSPACE)
    runtime.activate(`${WORKSPACE}/.`)
    await runtime.settled(`${WORKSPACE}/../workspace`)
    expect(create).toHaveBeenCalledOnce()
    expect(backend.index).toHaveBeenCalledOnce()
  })

  it('returns indexing immediately instead of waiting for the initial index', async () => {
    let finishIndex!: () => void
    const indexing = new Promise<void>(resolve => { finishIndex = resolve })
    const backend = engine()
    vi.mocked(backend.index).mockImplementation(async () => { await indexing; return {} })
    const runtime = new WorkspaceSearchRuntime({ create: async () => backend, reconcileIntervalMs: 0 })
    runtime.activate(WORKSPACE).catch(() => undefined)

    await expect(runtime.search(WORKSPACE, { query: 'where auth is checked' })).resolves.toEqual(expect.objectContaining({ status: 'indexing', root: WORKSPACE }))
    expect(backend.context).not.toHaveBeenCalled()
    finishIndex()
    await runtime.settled(WORKSPACE)
  })

  it('does not retry a failed initial index from search', async () => {
    const backend = engine()
    vi.mocked(backend.index).mockRejectedValue(new Error('download interrupted'))
    const runtime = new WorkspaceSearchRuntime({ create: async () => backend, reconcileIntervalMs: 0 })
    runtime.activate(WORKSPACE).catch(() => undefined)
    await expect(runtime.settled(WORKSPACE)).rejects.toThrow('download interrupted')

    await expect(runtime.search(WORKSPACE, { query: 'retry me' })).resolves.toEqual(expect.objectContaining({ status: 'error', message: 'download interrupted' }))
    expect(backend.index).toHaveBeenCalledOnce()
    expect(backend.context).not.toHaveBeenCalled()
  })

  it('searches the current index without an automatic update', async () => {
    const fixture = harness()
    fixture.runtime.activate(WORKSPACE)
    await fixture.runtime.settled(WORKSPACE)

    const outcome = await fixture.runtime.search(WORKSPACE, { query: 'where auth is checked', limit: 8 })

    expect(outcome.status).toBe('ready')
    expect(fixture.backend.context).toHaveBeenCalledWith({ query: 'where auth is checked', limit: 8, root: WORKSPACE, autoUpdate: false })
  })

  it('debounces watcher events into a path-scoped background refresh', async () => {
    vi.useFakeTimers()
    const fixture = harness()
    fixture.runtime.activate(WORKSPACE)
    await fixture.runtime.settled(WORKSPACE)

    fixture.callbacks().change(`${WORKSPACE}/src/a.ts`)
    fixture.callbacks().change(`${WORKSPACE}/src/b.ts`)
    await vi.advanceTimersByTimeAsync(25)

    expect(fixture.backend.index).toHaveBeenCalledTimes(2)
    expect(fixture.backend.index).toHaveBeenLastCalledWith(expect.objectContaining({ root: WORKSPACE, changedPaths: [`${WORKSPACE}/src/a.ts`, `${WORKSPACE}/src/b.ts`] }))
  })

  it('returns refreshing immediately while a background update is active', async () => {
    vi.useFakeTimers()
    let finishRefresh!: () => void
    const fixture = harness()
    vi.mocked(fixture.backend.index).mockResolvedValueOnce({}).mockImplementationOnce(async () => new Promise<void>(resolve => { finishRefresh = resolve }))
    fixture.runtime.activate(WORKSPACE)
    await fixture.runtime.settled(WORKSPACE)
    fixture.callbacks().change(`${WORKSPACE}/src/a.ts`)
    await vi.advanceTimersByTimeAsync(25)

    await expect(fixture.runtime.search(WORKSPACE, { query: 'current state' })).resolves.toEqual(expect.objectContaining({ status: 'refreshing', root: WORKSPACE }))
    expect(fixture.backend.context).not.toHaveBeenCalled()
    finishRefresh()
  })

  it('runs periodic full reconciliation without waiting for a search', async () => {
    vi.useFakeTimers()
    const backend = engine()
    const runtime = new WorkspaceSearchRuntime({ create: async () => backend, debounceMs: 5, reconcileIntervalMs: 100 })
    runtime.activate(WORKSPACE)
    await runtime.settled(WORKSPACE)

    await vi.advanceTimersByTimeAsync(105)

    expect(backend.index).toHaveBeenCalledTimes(2)
    expect(backend.index).toHaveBeenLastCalledWith(expect.not.objectContaining({ changedPaths: expect.anything() }))
  })

  it('closes watchers and every activated workspace engine', async () => {
    const first = harness()
    const second = engine()
    const create = vi.fn(async (root: string) => root === canonical('/a') ? first.backend : second)
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
    runtime.activate(WORKSPACE).catch(() => undefined)

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
    runtime.activate(WORKSPACE).catch(() => undefined)

    await runtime.close()

    expect(backend.close).toHaveBeenCalledOnce()
    expect(backend.index).not.toHaveBeenCalled()
  })

  it('reports an unavailable engine and keeps watcher events from scheduling index work', async () => {
    vi.useFakeTimers()
    let callbacks!: WorkspaceWatchCallbacks
    const backend = engine()
    const create = vi.fn(async (): Promise<SearchEngine> => { throw new Error('engine missing') })
    const runtime = new WorkspaceSearchRuntime({
      create,
      watch: (_root, next) => { callbacks = next; return { ready: Promise.resolve(), close: vi.fn(async () => undefined) } },
      debounceMs: 25,
      reconcileIntervalMs: 0,
    })

    runtime.activate(WORKSPACE).catch(() => undefined)
    await expect(runtime.settled(WORKSPACE)).rejects.toThrow('engine missing')

    callbacks.change(`${WORKSPACE}/src/a.ts`)
    await vi.advanceTimersByTimeAsync(50)
    expect(backend.index).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledOnce()

    await expect(runtime.search(WORKSPACE, { query: 'anything' })).resolves.toEqual(
      expect.objectContaining({ status: 'error', root: WORKSPACE, message: 'engine missing' }),
    )
    expect(create).toHaveBeenCalledTimes(2)
    expect(runtime.status()).toEqual([expect.objectContaining({ root: WORKSPACE, status: 'error', message: 'engine missing', pendingChanges: 0 })])
  })

  it('resumes indexing when a later search finds the engine again', async () => {
    const backend = engine()
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('engine missing'))
      .mockResolvedValue(backend)
    const runtime = new WorkspaceSearchRuntime({ create, reconcileIntervalMs: 0 })

    runtime.activate(WORKSPACE).catch(() => undefined)
    await expect(runtime.settled(WORKSPACE)).rejects.toThrow('engine missing')

    await expect(runtime.search(WORKSPACE, { query: 'second attempt' })).resolves.toEqual(
      expect.objectContaining({ status: 'indexing', root: WORKSPACE }),
    )
    await runtime.settled(WORKSPACE)

    expect(runtime.status()).toEqual([expect.objectContaining({ root: WORKSPACE, status: 'ready', pendingChanges: 0 })])
    expect(create).toHaveBeenCalledTimes(2)
    expect(backend.index).toHaveBeenCalledOnce()
    expect(backend.context).not.toHaveBeenCalled()
  })
})
