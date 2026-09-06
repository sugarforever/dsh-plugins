import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots';
export type IndexPhase = 'indexing' | 'refreshing' | 'ready' | 'error';
export interface WorkspaceIndexStatus {
    status: IndexPhase;
    pendingChanges: number;
    updatedAt: number;
    errorCode?: 'index_failed';
}
export interface IndexStatusSnapshot {
    connection: 'loading' | 'ready' | 'error';
    status?: WorkspaceIndexStatus;
    message?: string;
}
type FetchStatus = (sessionId: string) => Promise<Response>;
export declare class IndexStatusSource implements HostObservable<IndexStatusSnapshot> {
    private readonly fetchStatus;
    private snapshot;
    private readonly listeners;
    private timer?;
    private running;
    private sessionId?;
    private generation;
    constructor(fetchStatus?: FetchStatus);
    getSnapshot: () => IndexStatusSnapshot;
    subscribe: (listener: () => void) => (() => void);
    selectSession(sessionId: string | undefined): void;
    start(): void;
    stop(): void;
    private poll;
    private publish;
}
export {};
//# sourceMappingURL=status-source.d.ts.map