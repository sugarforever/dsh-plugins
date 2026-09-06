import { watch, type FSWatcher, type WatchEventType } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspaceWatchCallbacks, WorkspaceWatcher } from './runtime.ts'

export type NativeWatch = (
  root: string,
  options: { recursive: true },
  listener: (eventType: WatchEventType, filename: string | Buffer | null) => void,
) => FSWatcher

const HARD_EXCLUDED = /(^|[/\\])(?:\.git|\.zvec-grep|node_modules)(?:[/\\]|$)/

function changedPath(root: string, filename: string | Buffer | null): string | undefined {
  if (filename === null) return undefined
  const name = filename.toString()
  if (!name || HARD_EXCLUDED.test(name)) return undefined
  const absolutePath = isAbsolute(name) ? resolve(name) : resolve(root, name)
  const pathFromRoot = relative(root, absolutePath)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) return undefined
  return absolutePath
}

export function createWorkspaceWatcherWith(
  root: string,
  callbacks: WorkspaceWatchCallbacks,
  nativeWatch: NativeWatch,
): WorkspaceWatcher {
  const watcher = nativeWatch(root, { recursive: true }, (_eventType, filename) => {
    const path = changedPath(root, filename)
    if (path !== undefined) callbacks.change(path)
  })
  watcher.on('error', callbacks.error)
  return {
    ready: Promise.resolve(),
    close: () => watcher.close(),
  }
}

export function createWorkspaceWatcher(root: string, callbacks: WorkspaceWatchCallbacks): WorkspaceWatcher {
  return createWorkspaceWatcherWith(root, callbacks, watch as NativeWatch)
}
