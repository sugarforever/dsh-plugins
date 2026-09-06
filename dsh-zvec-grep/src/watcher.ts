import { watch } from 'chokidar'
import type { WorkspaceWatchCallbacks, WorkspaceWatcher } from './runtime.ts'

export function createWorkspaceWatcher(root: string, callbacks: WorkspaceWatchCallbacks): WorkspaceWatcher {
  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: /(^|[/\\])(?:\.git|\.zvec-grep|node_modules)(?:[/\\]|$)/,
  })
  let settleReady!: () => void
  const ready = new Promise<void>(resolve => { settleReady = resolve })
  watcher.once('ready', settleReady)
  watcher.on('add', path => callbacks.change(path))
  watcher.on('change', path => callbacks.change(path))
  watcher.on('unlink', path => callbacks.change(path))
  watcher.on('addDir', path => callbacks.change(path))
  watcher.on('unlinkDir', path => callbacks.change(path))
  watcher.on('error', error => {
    settleReady()
    callbacks.error(error)
  })
  return {
    ready,
    close: () => {
      settleReady()
      return watcher.close()
    },
  }
}
