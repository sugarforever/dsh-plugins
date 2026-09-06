import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWatcher } from '../src/watcher.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('createWorkspaceWatcher', () => {
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
