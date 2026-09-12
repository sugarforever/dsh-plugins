import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWatcher, createWorkspaceWatcherWith, type NativeWatch } from '../src/watcher.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('createWorkspaceWatcher', () => {
  it('uses one recursive native watcher and filters hard-excluded paths', async () => {
    const native = new EventEmitter() as EventEmitter & { close(): void }
    native.close = vi.fn()
    let listener: Parameters<NativeWatch>[2] | undefined
    const watch = vi.fn<NativeWatch>((_root, _options, next) => {
      listener = next
      return native as never
    })
    const change = vi.fn()
    const error = vi.fn()
    const watcher = createWorkspaceWatcherWith('/repo', { change, error }, watch as never)

    expect(watch).toHaveBeenCalledOnce()
    expect(watch).toHaveBeenCalledWith('/repo', { recursive: true }, expect.any(Function))
    expect(listener).toBeTypeOf('function')
    listener!('change', 'src/index.ts')
    listener!('change', '.git/index')
    listener!('change', 'node_modules/pkg/index.js')
    listener!('change', '.zvec-grep/manifest.json')
    listener!('change', null)

    expect(change).toHaveBeenCalledOnce()
    // The watcher reports absolute paths, matching its own resolve(root, filename).
    expect(change).toHaveBeenCalledWith(resolve('/repo', 'src/index.ts'))
    expect(error).not.toHaveBeenCalled()
    await watcher.close()
    expect(native.close).toHaveBeenCalledOnce()
  })

  it('reports workspace changes but ignores index storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-zvec-watcher-'))
    roots.push(root)
    const change = vi.fn()
    const watcher = createWorkspaceWatcher(root, { change, error: vi.fn() })
    await watcher.ready

    await writeFile(join(root, 'source.ts'), 'export const value = 1\n')
    await mkdir(join(root, '.zvec-grep'))
    await writeFile(join(root, '.zvec-grep', 'internal'), 'ignored\n')
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith(join(root, 'source.ts')))

    expect(change).not.toHaveBeenCalledWith(join(root, '.zvec-grep', 'internal'))
    await watcher.close()
  })

  it('settles readiness when closed before the initial scan completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-zvec-watcher-'))
    roots.push(root)
    const watcher = createWorkspaceWatcher(root, { change: vi.fn(), error: vi.fn() })

    await watcher.close()

    await expect(watcher.ready).resolves.toBeUndefined()
  })
})
