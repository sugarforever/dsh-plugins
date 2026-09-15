import { describe, expect, it } from 'vitest'
import { WorkspaceSearchRuntime } from '../src/runtime.ts'
import type { SearchEngine, WorkspaceWatcher } from '../src/runtime.ts'

interface FakeEngineCalls {
  indexOptions: unknown[]
  contextOptions: unknown[]
}

function fakeEngine(calls: FakeEngineCalls): SearchEngine {
  return {
    async index(options) {
      calls.indexOptions.push(options)
      return undefined
    },
    async context(options) {
      calls.contextOptions.push(options)
      return {
        query: options.query ?? '',
        root: options.root ?? '',
        source: 'rg',
        coverage: 'rg_exhaustive',
        items: [],
      }
    },
    async close() {},
  }
}

function noWatcher(): WorkspaceWatcher {
  return { close: () => undefined }
}

async function settled(runtime: WorkspaceSearchRuntime, root: string): Promise<void> {
  await runtime.activate(root).catch(error => {
    throw new Error(`initial indexing failed: ${String(error)}`)
  })
}

describe('excludePaths passthrough', () => {
  it('passes configured excludePaths to every index and context call', async () => {
    const calls: FakeEngineCalls = { indexOptions: [], contextOptions: [] }
    const runtime = new WorkspaceSearchRuntime({
      create: async () => fakeEngine(calls),
      watch: noWatcher,
      excludePaths: ['vendor/**', 'generated'],
    })
    await settled(runtime, '/ws')

    expect(calls.indexOptions).toHaveLength(1)
    expect(calls.indexOptions[0]).toMatchObject({ excludePaths: ['vendor/**', 'generated'] })

    await runtime.search('/ws', { query: 'needle' })
    expect(calls.contextOptions).toHaveLength(1)
    expect(calls.contextOptions[0]).toMatchObject({ excludePaths: ['vendor/**', 'generated'] })
  })

  it('omits the excludePaths key entirely when no filter is configured', async () => {
    const calls: FakeEngineCalls = { indexOptions: [], contextOptions: [] }
    const runtime = new WorkspaceSearchRuntime({
      create: async () => fakeEngine(calls),
      watch: noWatcher,
    })
    await settled(runtime, '/ws')
    await runtime.search('/ws', { query: 'needle' })

    expect(calls.indexOptions[0]).not.toHaveProperty('excludePaths')
    expect(calls.contextOptions[0]).not.toHaveProperty('excludePaths')

    await runtime.close()
  })
})
