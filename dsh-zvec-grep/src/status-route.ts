import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import type { WorkspaceSearchRuntime } from './runtime.ts'

export const STATUS_PATH = '/api/dsh-zvec-grep/status'

/**
 * Report every workspace the host currently knows, keyed by the session cwd the runtime was
 * activated with. The route cannot ask which session is calling: the DSH desktop carrier forwards
 * the pathname but drops a registered route's query string, and plugin routes may only answer GET
 * or HEAD. The client therefore selects its own workspace from this list by cwd.
 */
export function registerStatusRoute(
  connection: HostConnectionFetch,
  runtime: Pick<WorkspaceSearchRuntime, 'statusFor'>,
  sessions: { list(): Array<{ id: string; header: { cwd?: string } }> },
  pollIntervalMs: number,
): () => void {
  return connection.register({
    path: STATUS_PATH,
    methods: ['GET'],
    async fetch() {
      const roots = [...new Set(sessions.list()
        .map(item => item.header.cwd)
        .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0))]
      if (roots.length === 0) return new Response('not found', { status: 404 })
      const workspaces = roots.map(root => {
        const internal = runtime.statusFor(root)
        return internal === undefined ? {
          root,
          status: 'indexing',
          pendingChanges: 0,
          updatedAt: 0,
        } : {
          root,
          status: internal.status,
          pendingChanges: internal.pendingChanges,
          updatedAt: internal.updatedAt,
          ...(internal.status === 'error' ? { errorCode: 'index_failed' } : {}),
        }
      })
      return new Response(JSON.stringify({
        version: 2,
        pollIntervalMs,
        workspaces,
      }), { status: 200, headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      } })
    },
  })
}
