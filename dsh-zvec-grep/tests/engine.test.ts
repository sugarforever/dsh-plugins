import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EngineLoader,
  EngineUnavailableError,
  isPathLike,
  packageDirectory,
  type ZvecGrepModule,
} from '../src/engine.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-zvec-engine-'))
  temporaryDirectories.push(directory)
  return directory
}

const engineStub: ZvecGrepModule = {
  createZvecGrep: async () => ({
    index: async () => ({}),
    context: async ({ query }) => ({ query: query ?? '', root: '/workspace', source: 'index', coverage: 'ranked_sample', items: [] }),
    close: async () => undefined,
  }),
}

/** Writes a fake engine package that resolves exclusively through its exports map. */
async function writeEnginePackage(root: string, version: string): Promise<string> {
  const directory = join(root, '@zvec', 'zvec-grep')
  await mkdir(join(directory, 'dist'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: '@zvec/zvec-grep',
    version,
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  }))
  await writeFile(join(directory, 'dist', 'index.js'), 'export const createZvecGrep = () => {}\n')
  return pathToFileURL(join(directory, 'dist', 'index.js')).href
}

describe('engine specifier helpers', () => {
  it('separates package specifiers from filesystem locations', () => {
    expect(['@zvec/zvec-grep', 'zvec-grep'].map(isPathLike)).toEqual([false, false])
    expect(['./engine.js', '../engine.js', '/opt/engine.js', 'C:\\engine.js', 'C:/engine.js', 'file:///opt/engine.js'].map(isPathLike))
      .toEqual([true, true, true, true, true, true])
  })

  it('extracts package directories from scoped and unscoped specifiers', () => {
    expect(packageDirectory('/root', '@zvec/zvec-grep')).toBe(join('/root', '@zvec', 'zvec-grep'))
    expect(packageDirectory('/root', 'zvec-grep')).toBe(join('/root', 'zvec-grep'))
    expect(packageDirectory('/root', '@zvec')).toBeUndefined()
    expect(packageDirectory('/root', '')).toBeUndefined()
  })
})

describe('EngineLoader resolution', () => {
  it('prefers the bare specifier and never probes the global root when it resolves', async () => {
    const importModule = vi.fn(async () => engineStub)
    const readGlobalRoot = vi.fn(async () => '/global')
    const loader = new EngineLoader({ specifier: '@zvec/zvec-grep', importModule, readGlobalRoot })

    await expect(loader.load()).resolves.toMatchObject({ createZvecGrep: expect.any(Function) })
    expect(importModule).toHaveBeenCalledExactlyOnceWith('@zvec/zvec-grep')
    expect(readGlobalRoot).not.toHaveBeenCalled()
  })

  it('falls back to the global npm root when the package is not installed next to the plugin', async () => {
    const root = await scratch()
    const entry = await writeEnginePackage(root, '0.2.1')
    const importModule = vi.fn(async (specifier: string) => {
      if (specifier === '@zvec/zvec-grep') throw new Error('ERR_MODULE_NOT_FOUND')
      return engineStub
    })
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule,
      readGlobalRoot: async () => root,
    })

    await expect(loader.load()).resolves.toMatchObject({ createZvecGrep: expect.any(Function) })
    expect(importModule).toHaveBeenNthCalledWith(2, entry)
  })

  it('resolves an explicit directory location through its package manifest', async () => {
    const root = await scratch()
    const entry = await writeEnginePackage(root, '0.2.1')
    const importModule = vi.fn(async () => engineStub)
    const readGlobalRoot = vi.fn(async () => undefined)
    const loader = new EngineLoader({
      specifier: join(root, '@zvec', 'zvec-grep'),
      importModule,
      readGlobalRoot,
    })

    await expect(loader.load()).resolves.toMatchObject({ createZvecGrep: expect.any(Function) })
    expect(importModule).toHaveBeenCalledExactlyOnceWith(entry)
    expect(readGlobalRoot).not.toHaveBeenCalled()
  })

  it('resolves an explicit file location without reading a manifest', async () => {
    const root = await scratch()
    const file = join(root, 'engine.mjs')
    await writeFile(file, 'export const createZvecGrep = () => {}\n')
    const importModule = vi.fn(async () => engineStub)
    const loader = new EngineLoader({ specifier: file, importModule, readGlobalRoot: async () => undefined })

    await expect(loader.load()).resolves.toMatchObject({ createZvecGrep: expect.any(Function) })
    expect(importModule).toHaveBeenCalledExactlyOnceWith(pathToFileURL(file).href)
  })

  it('accepts a CommonJS-style default export and normalizes the factory to a promise', async () => {
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule: async () => ({ default: { createZvecGrep: () => ({ index: async () => ({}), context: async () => ({}), close: async () => undefined }) } }),
      readGlobalRoot: async () => undefined,
    })

    const module = await loader.load()
    await expect(module.createZvecGrep({ root: '/workspace', embedding: 'e', device: 'auto' })).resolves.toBeDefined()
  })

  it('skips a module that does not export the factory and reports every attempt', async () => {
    const root = await scratch()
    await writeEnginePackage(root, '0.2.1')
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule: async () => ({ nope: true }),
      readGlobalRoot: async () => root,
    })

    const failure = await loader.load().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(EngineUnavailableError)
    const message = String((failure as Error).message)
    expect(message).toContain('does not export createZvecGrep')
    expect(message).toContain('npm install -g @zvec/zvec-grep')
    expect(message).toContain('Do not retry zvec_search')
    expect((failure as EngineUnavailableError).attempts).toHaveLength(2)
  })

  it('lists the resolved global root in the failure report when the engine is absent', async () => {
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule: async () => { throw new Error('ERR_MODULE_NOT_FOUND') },
      readGlobalRoot: async () => '/global/node_modules',
    })

    const failure = await loader.load().catch((error: unknown) => error)
    expect((failure as EngineUnavailableError).attempts).toHaveLength(1)
    expect(String((failure as Error).message)).toContain('ERR_MODULE_NOT_FOUND')
  })

  it('caches the resolved module across loads', async () => {
    const importModule = vi.fn(async () => engineStub)
    const loader = new EngineLoader({ specifier: '@zvec/zvec-grep', importModule, readGlobalRoot: async () => undefined })

    await loader.load()
    await loader.load()
    expect(importModule).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent loads into a single probe', async () => {
    const importModule = vi.fn(async () => engineStub)
    const loader = new EngineLoader({ specifier: '@zvec/zvec-grep', importModule, readGlobalRoot: async () => undefined })

    await Promise.all([loader.load(), loader.load(), loader.load()])
    expect(importModule).toHaveBeenCalledOnce()
  })

  it('reuses a failure within the retry interval and probes again afterwards', async () => {
    let now = 0
    const importModule = vi.fn(async () => { throw new Error('ERR_MODULE_NOT_FOUND') })
    const readGlobalRoot = vi.fn(async () => undefined)
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule,
      readGlobalRoot,
      retryIntervalMs: 1_000,
      now: () => now,
      onWarning: undefined,
    })

    await loader.load().catch(() => undefined)
    await loader.load().catch(() => undefined)
    expect(importModule).toHaveBeenCalledOnce()

    now = 1_001
    await loader.load().catch(() => undefined)
    expect(importModule).toHaveBeenCalledTimes(2)
  })

  it('recovers once the engine becomes resolvable', async () => {
    let now = 0
    let available = false
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule: async () => {
        if (!available) throw new Error('ERR_MODULE_NOT_FOUND')
        return engineStub
      },
      readGlobalRoot: async () => undefined,
      retryIntervalMs: 1_000,
      now: () => now,
    })

    await expect(loader.load()).rejects.toBeInstanceOf(EngineUnavailableError)
    available = true
    await expect(loader.load()).rejects.toBeInstanceOf(EngineUnavailableError)
    now = 2_000
    await expect(loader.load()).resolves.toMatchObject({ createZvecGrep: expect.any(Function) })
  })

  it('warns softly when the resolved engine leaves the tested range', async () => {
    const root = await scratch()
    await writeEnginePackage(root, '1.0.0')
    const onWarning = vi.fn()
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule: async (specifier: string) => {
        if (specifier === '@zvec/zvec-grep') throw new Error('ERR_MODULE_NOT_FOUND')
        return engineStub
      },
      readGlobalRoot: async () => root,
      onWarning,
    })

    await loader.load()
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('1.0.0'))
  })

  it('warns softly when a pre-1.0 engine moves to another minor', async () => {
    const root = await scratch()
    await writeEnginePackage(root, '0.3.0')
    const onWarning = vi.fn()
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule: async (specifier: string) => {
        if (specifier === '@zvec/zvec-grep') throw new Error('ERR_MODULE_NOT_FOUND')
        return engineStub
      },
      readGlobalRoot: async () => root,
      onWarning,
    })

    await loader.load()
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('0.3.0'))
  })

  it('does not warn for a matching major version', async () => {
    const root = await scratch()
    await writeEnginePackage(root, '0.2.9')
    const onWarning = vi.fn()
    const loader = new EngineLoader({
      specifier: '@zvec/zvec-grep',
      importModule: async (specifier: string) => {
        if (specifier === '@zvec/zvec-grep') throw new Error('ERR_MODULE_NOT_FOUND')
        return engineStub
      },
      readGlobalRoot: async () => root,
      onWarning,
    })

    await loader.load()
    expect(onWarning).not.toHaveBeenCalled()
  })
})
