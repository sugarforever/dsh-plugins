import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

export type IndexPhase = 'indexing' | 'refreshing' | 'ready' | 'error'

export interface WorkspaceIndexStatus {
  status: IndexPhase
  pendingChanges: number
  updatedAt: number
  errorCode?: 'index_failed'
}

export interface IndexStatusSnapshot {
  connection: 'loading' | 'ready' | 'error'
  status?: WorkspaceIndexStatus
  message?: string
}

type FetchStatus = (sessionId: string) => Promise<Response>

const STATUS_PATH = '/api/dsh-zvec-grep/status'
const ERROR_RETRY_MS = 5000

const INITIAL_SNAPSHOT: IndexStatusSnapshot = Object.freeze({ connection: 'loading' })

function parseWorkspace(value: unknown): WorkspaceIndexStatus | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (
    !['indexing', 'refreshing', 'ready', 'error'].includes(String(item.status))
    || typeof item.pendingChanges !== 'number'
    || typeof item.updatedAt !== 'number'
  ) return undefined
  return Object.freeze({
    status: item.status as IndexPhase,
    pendingChanges: item.pendingChanges,
    updatedAt: item.updatedAt,
    ...(item.errorCode === 'index_failed' ? { errorCode: 'index_failed' as const } : {}),
  })
}

function parsePayload(value: unknown): { pollIntervalMs: number; status: WorkspaceIndexStatus } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid zvec status response')
  const payload = value as Record<string, unknown>
  if (payload.version !== 1 || typeof payload.pollIntervalMs !== 'number') {
    throw new Error('Invalid zvec status response')
  }
  const status = parseWorkspace(payload.status)
  if (status === undefined) throw new Error('Invalid zvec workspace status')
  return { pollIntervalMs: payload.pollIntervalMs, status }
}

export class IndexStatusSource implements HostObservable<IndexStatusSnapshot> {
  private snapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private sessionId?: string
  private generation = 0

  constructor(private readonly fetchStatus: FetchStatus = sessionId => fetch(`${STATUS_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })) {}

  getSnapshot = (): IndexStatusSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  selectSession(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) return
    const hadSession = this.sessionId !== undefined
    this.sessionId = sessionId
    this.generation += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (hadSession || this.snapshot !== INITIAL_SNAPSHOT) this.publish(INITIAL_SNAPSHOT)
    if (this.running && sessionId !== undefined) void this.poll()
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.poll()
  }

  stop(): void {
    this.running = false
    this.generation += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async poll(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === undefined) return
    const generation = this.generation
    let nextDelay = ERROR_RETRY_MS
    try {
      const response = await this.fetchStatus(sessionId)
      if (response.status === 404) {
        nextDelay = 250
        if (this.running && this.generation === generation) this.publish(INITIAL_SNAPSHOT)
      } else {
        if (!response.ok) throw new Error(`Zvec status request failed (${response.status})`)
        const payload = parsePayload(await response.json())
        nextDelay = Math.max(250, payload.pollIntervalMs)
        if (this.running && this.generation === generation) this.publish(Object.freeze({ connection: 'ready', status: payload.status }))
      }
    } catch (error) {
      if (this.running && this.generation === generation) {
        this.publish(Object.freeze({
          connection: 'error',
          ...(this.snapshot.status === undefined ? {} : { status: this.snapshot.status }),
          message: error instanceof Error ? error.message : String(error),
        }))
      }
    }
    if (this.running && this.generation === generation) {
      this.timer = setTimeout(() => { void this.poll() }, nextDelay)
      this.timer.unref?.()
    }
  }

  private publish(snapshot: IndexStatusSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      try { listener() } catch { /* One UI listener must not stop polling. */ }
    }
  }
}
