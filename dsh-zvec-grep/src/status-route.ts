import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import type { WorkspaceSearchRuntime } from './runtime.ts'

export const STATUS_PATH = '/api/dsh-zvec-grep/status'

export function registerStatusRoute(
  connection: HostConnectionFetch,
  runtime: Pick<WorkspaceSearchRuntime, 'statusFor'>,
  sessions: { list(): Array<{ id: string; header: { cwd?: string } }> },
  pollIntervalMs: number,
): () => void {
  return connection.register({
    path: STATUS_PATH,
    methods: ['GET'],
    async fetch(request) {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!sessionId) return new Response('missing sessionId', { status: 400 })
      const session = sessions.list().find(item => String(item.id) === sessionId)
      const root = session?.header.cwd
      if (!root) return new Response('not found', { status: 404 })
      const internal = runtime.statusFor(root)
      if (internal === undefined) return new Response('not found', { status: 404 })
      const status = {
        status: internal.status,
        pendingChanges: internal.pendingChanges,
        updatedAt: internal.updatedAt,
        ...(internal.status === 'error' ? { errorCode: 'index_failed' } : {}),
      }
      return new Response(JSON.stringify({
        version: 1,
        pollIntervalMs,
        status,
      }), { headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      } })
    },
  })
}
