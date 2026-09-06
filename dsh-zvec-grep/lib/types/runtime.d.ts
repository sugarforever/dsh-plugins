import type { ZvecGrepContextOptions, ZvecGrepContextResult, ZvecGrepIndexOptions } from '@zvec/zvec-grep';
export interface SearchEngine {
    index(options?: ZvecGrepIndexOptions): Promise<unknown>;
    context(options: ZvecGrepContextOptions): Promise<ZvecGrepContextResult>;
    close(): Promise<void>;
}
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
    result: ZvecGrepContextResult;
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
    search(root: string, options: ZvecGrepContextOptions): Promise<WorkspaceSearchOutcome>;
    close(): Promise<void>;
    private startWatcher;
    private indexInitially;
    private queuePath;
    private queueReconcile;
    private scheduleRefresh;
    private refresh;
    private setPhase;
}
export {};
//# sourceMappingURL=runtime.d.ts.map