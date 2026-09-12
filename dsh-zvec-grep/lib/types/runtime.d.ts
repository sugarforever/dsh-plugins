import type { SearchEngine, ZvecContextOptions, ZvecContextResult, ZvecEngineInfo } from './engine.ts';
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
    engine?: WorkspaceEngineIdentity;
} | {
    status: 'refreshing';
    root: string;
    message: string;
    engine?: WorkspaceEngineIdentity;
} | {
    status: 'error';
    root: string;
    message: string;
    engine?: WorkspaceEngineIdentity;
} | {
    status: 'ready';
    result: ZvecContextResult;
    info?: ZvecEngineInfo;
    engine?: WorkspaceEngineIdentity;
};
/** Engine identity attached to every outcome, so a version mismatch is visible where it hurts. */
export interface WorkspaceEngineIdentity {
    version?: string;
    range?: string;
}
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
    /** Version of the engine the loader resolved, once it has one; reported back as diagnostics. */
    engineVersion?: () => string | undefined;
    /** The engine range this plugin was tested against; reported back as diagnostics. */
    engineRange?: string;
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
    /** Engine identity for an outcome: the resolved version and the range this plugin was tested on. */
    private engineIdentity;
    /** Coverage counts are diagnostics: an engine without `info()` must not break indexing. */
    private readIndexInfo;
    private queuePath;
    private queueReconcile;
    private scheduleRefresh;
    private refresh;
    private setPhase;
}
//# sourceMappingURL=runtime.d.ts.map