import { type FSWatcher, type WatchEventType } from 'node:fs';
import type { WorkspaceWatchCallbacks, WorkspaceWatcher } from './runtime.ts';
export type NativeWatch = (root: string, options: {
    recursive: true;
}, listener: (eventType: WatchEventType, filename: string | Buffer | null) => void) => FSWatcher;
export declare function createWorkspaceWatcherWith(root: string, callbacks: WorkspaceWatchCallbacks, nativeWatch: NativeWatch): WorkspaceWatcher;
export declare function createWorkspaceWatcher(root: string, callbacks: WorkspaceWatchCallbacks): WorkspaceWatcher;
//# sourceMappingURL=watcher.d.ts.map