import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ZvecGrepContextOptions, ZvecGrepContextResult, ZvecGrepIndexOptions } from '@zvec/zvec-grep'

export interface SearchEngine {
  index(options?: ZvecGrepIndexOptions): Promise<unknown>
  context(options: ZvecGrepContextOptions): Promise<ZvecGrepContextResult>
  close(): Promise<void>
}

export interface WorkspaceWatcher {
  ready?: Promise<void>
  close(): void | Promise<void>
}

export interface WorkspaceWatchCallbacks {
  change(path: string): void
  error(error: unknown): void
}

export type WorkspaceSearchOutcome =
  | { status: 'indexing'; root: string; message: string }
  | { status: 'refreshing'; root: string; message: string }
  | { status: 'error'; root: string; message: string }
  | { status: 'ready'; result: ZvecGrepContextResult }

export interface WorkspaceIndexStatus {
  root: string
  status: Phase
  pendingChanges: number
  updatedAt: number
  message?: string
}

export interface WorkspaceSearchRuntimeOptions {
  create(root: string): Promise<SearchEngine>
  watch?: (root: string, callbacks: WorkspaceWatchCallbacks) => WorkspaceWatcher
  debounceMs?: number
  reconcileIntervalMs?: number
}

type Phase = 'indexing' | 'refreshing' | 'ready' | 'error'

interface WorkspaceState {
  root: string
  engine: Promise<SearchEngine>
  initialIndex: Promise<void>
  controller: AbortController
  phase: Phase
  updatedAt: number
  error?: unknown
  watcher?: WorkspaceWatcher
  debounceTimer?: ReturnType<typeof setTimeout>
  reconcileTimer?: ReturnType<typeof setInterval>
  refresh?: Promise<void>
  changedPaths: Set<string>
  fullReconcile: boolean
}

const statusMessages = {
  indexing: 'The workspace index is still being built.',
  refreshing: 'The workspace index is being refreshed in the background.',
} as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function canonicalizeRoot(root: string): string {
  const absolute = resolve(root)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

export class WorkspaceSearchRuntime {
  private readonly workspaces = new Map<string, WorkspaceState>()

  constructor(private readonly options: WorkspaceSearchRuntimeOptions) {}

  activate(root: string): Promise<void> {
    root = canonicalizeRoot(root)
    const existing = this.workspaces.get(root)
    if (existing) return existing.initialIndex

    const state: WorkspaceState = {
      root,
      engine: this.options.create(root),
      initialIndex: Promise.resolve(),
      controller: new AbortController(),
      phase: 'indexing',
      updatedAt: Date.now(),
      changedPaths: new Set(),
      fullReconcile: false,
    }
    this.workspaces.set(root, state)
    this.startWatcher(state)
    state.initialIndex = this.indexInitially(state)
    return state.initialIndex
  }

  settled(root: string): Promise<void> {
    root = canonicalizeRoot(root)
    const state = this.workspaces.get(root)
    if (!state) throw new Error(`Workspace is not active: ${root}`)
    return state.initialIndex
  }

  status(): WorkspaceIndexStatus[] {
    return [...this.workspaces.values()].map(state => ({
      root: state.root,
      status: state.phase,
      pendingChanges: state.changedPaths.size + (state.fullReconcile ? 1 : 0),
      updatedAt: state.updatedAt,
      ...(state.phase === 'error' ? { message: errorMessage(state.error) } : {}),
    }))
  }

  statusFor(root: string): WorkspaceIndexStatus | undefined {
    root = canonicalizeRoot(root)
    return this.status().find(status => status.root === root)
  }

  async search(root: string, options: ZvecGrepContextOptions): Promise<WorkspaceSearchOutcome> {
    root = canonicalizeRoot(root)
    let state = this.workspaces.get(root)
    if (!state) {
      void this.activate(root).catch(() => undefined)
      state = this.workspaces.get(root)!
    }
    if (state.phase === 'indexing') return { status: 'indexing', root, message: statusMessages.indexing }
    if (state.phase === 'refreshing') return { status: 'refreshing', root, message: statusMessages.refreshing }
    if (state.phase === 'error') return { status: 'error', root, message: errorMessage(state.error) }

    const engine = await state.engine
    const result = await engine.context({ ...options, root, autoUpdate: false })
    return { status: 'ready', result }
  }

  async close(): Promise<void> {
    const states = [...this.workspaces.values()]
    this.workspaces.clear()
    for (const state of states) {
      state.controller.abort(new Error('dsh-zvec-grep disposed'))
      if (state.debounceTimer) clearTimeout(state.debounceTimer)
      if (state.reconcileTimer) clearInterval(state.reconcileTimer)
    }
    await Promise.allSettled(states.map(state => Promise.resolve(state.watcher?.close())))
    await Promise.allSettled(states.flatMap(state => [state.initialIndex, state.refresh].filter((task): task is Promise<void> => Boolean(task))))
    await Promise.allSettled(states.map(async state => (await state.engine).close()))
  }

  private startWatcher(state: WorkspaceState): void {
    if (this.options.watch) {
      state.watcher = this.options.watch(state.root, {
        change: path => this.queuePath(state, path),
        error: () => this.queueReconcile(state),
      })
    }
    const intervalMs = this.options.reconcileIntervalMs ?? 60 * 60_000
    if (intervalMs > 0) {
      state.reconcileTimer = setInterval(() => this.queueReconcile(state), intervalMs)
      state.reconcileTimer.unref?.()
    }
  }

  private async indexInitially(state: WorkspaceState): Promise<void> {
    try {
      await state.watcher?.ready
      state.controller.signal.throwIfAborted()
      const engine = await state.engine
      await engine.index({ root: state.root, signal: state.controller.signal })
      this.setPhase(state, state.changedPaths.size > 0 || state.fullReconcile ? 'refreshing' : 'ready')
      state.error = undefined
      if (state.phase === 'refreshing') this.scheduleRefresh(state)
    } catch (error) {
      this.setPhase(state, 'error')
      state.error = error
      throw error
    }
  }

  private queuePath(state: WorkspaceState, path: string): void {
    if (state.controller.signal.aborted) return
    state.changedPaths.add(path)
    if (state.phase !== 'indexing') this.setPhase(state, 'refreshing')
    this.scheduleRefresh(state)
  }

  private queueReconcile(state: WorkspaceState): void {
    if (state.controller.signal.aborted) return
    state.fullReconcile = true
    if (state.phase !== 'indexing') this.setPhase(state, 'refreshing')
    this.scheduleRefresh(state)
  }

  private scheduleRefresh(state: WorkspaceState): void {
    if (state.phase === 'indexing' || state.refresh || state.controller.signal.aborted) return
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = undefined
      state.refresh = this.refresh(state).finally(() => {
        state.refresh = undefined
        if (state.changedPaths.size > 0 || state.fullReconcile) this.scheduleRefresh(state)
      })
    }, this.options.debounceMs ?? 750)
    state.debounceTimer.unref?.()
  }

  private async refresh(state: WorkspaceState): Promise<void> {
    const fullReconcile = state.fullReconcile
    const changedPaths = [...state.changedPaths]
    state.fullReconcile = false
    state.changedPaths.clear()
    try {
      const engine = await state.engine
      await engine.index({
        root: state.root,
        signal: state.controller.signal,
        ...(fullReconcile ? {} : { changedPaths }),
      })
      this.setPhase(state, state.changedPaths.size > 0 || state.fullReconcile ? 'refreshing' : 'ready')
      state.error = undefined
    } catch (error) {
      if (!state.controller.signal.aborted) {
        this.setPhase(state, 'error')
        state.error = error
      }
    }
  }

  private setPhase(state: WorkspaceState, phase: Phase): void {
    if (state.phase === phase) return
    state.phase = phase
    state.updatedAt = Date.now()
  }
}
