import type { SearchEngine, ZvecContextOptions, ZvecContextResult } from './engine.ts';
export type { SearchEngine } from './engine.ts';
export interface WorkspaceWatcher {
    ready?: Promise<void>;
    close(): void | Promise<void>;
}
export interface WorkspaceWatchCallbacks {
    change(path: string): void;
    error(error: unknown): void;
}
export type WorkspaceSearchOutcome = {
    status: 'indexing';
    root: string;
    message: string;
} | {
    status: 'refreshing';
    root: string;
    message: string;
} | {
    status: 'error';
    root: string;
    message: string;
} | {
    status: 'ready';
    result: ZvecContextResult;
};
export interface WorkspaceIndexStatus {
    root: string;
    status: Phase;
    pendingChanges: number;
    updatedAt: number;
    message?: string;
}
export interface WorkspaceSearchRuntimeOptions {
    create(root: string): Promise<SearchEngine>;
    watch?: (root: string, callbacks: WorkspaceWatchCallbacks) => WorkspaceWatcher;
    debounceMs?: number;
    reconcileIntervalMs?: number;
}
type Phase = 'indexing' | 'refreshing' | 'ready' | 'error';
export declare class WorkspaceSearchRuntime {
    private readonly options;
    private readonly workspaces;
    constructor(options: WorkspaceSearchRuntimeOptions);
    activate(root: string): Promise<void>;
    settled(root: string): Promise<void>;
    status(): WorkspaceIndexStatus[];
    statusFor(root: string): WorkspaceIndexStatus | undefined;
    search(root: string, options: ZvecContextOptions): Promise<WorkspaceSearchOutcome>;
    /**
     * Re-attempts engine resolution for a workspace whose engine never loaded. The engine loader
     * decides whether another probe is allowed yet, so repeated searches stay cheap. Indexing is
     * restarted in the background; the caller still returns immediately.
     */
    private reactivate;
    close(): Promise<void>;
    private startWatcher;
    private indexInitially;
    private failWorkspace;
    private queuePath;
    private queueReconcile;
    private scheduleRefresh;
    private refresh;
    private setPhase;
}
//# sourceMappingURL=runtime.d.ts.map