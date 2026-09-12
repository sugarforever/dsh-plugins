import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import type { WorkspaceSearchRuntime } from './runtime.ts';
export declare const STATUS_PATH = "/api/dsh-zvec-grep/status";
/**
 * Report every workspace the host currently knows, keyed by the session cwd the runtime was
 * activated with. The route cannot ask which session is calling: the DSH desktop carrier forwards
 * the pathname but drops a registered route's query string, and plugin routes may only answer GET
 * or HEAD. The client therefore selects its own workspace from this list by cwd.
 */
export declare function registerStatusRoute(connection: HostConnectionFetch, runtime: Pick<WorkspaceSearchRuntime, 'statusFor'>, sessions: {
    list(): Array<{
        id: string;
        header: {
            cwd?: string;
        };
    }>;
}, pollIntervalMs: number): () => void;
//# sourceMappingURL=status-route.d.ts.map