import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import type { WorkspaceSearchRuntime } from './runtime.ts';
export declare const STATUS_PATH = "/api/dsh-zvec-grep/status";
export declare function registerStatusRoute(connection: HostConnectionFetch, runtime: Pick<WorkspaceSearchRuntime, 'statusFor'>, sessions: {
    list(): Array<{
        id: string;
        header: {
            cwd?: string;
        };
    }>;
}, pollIntervalMs: number): () => void;
//# sourceMappingURL=status-route.d.ts.map