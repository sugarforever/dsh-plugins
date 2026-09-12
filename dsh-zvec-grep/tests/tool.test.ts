import { describe, expect, it, vi } from 'vitest'
import { createSearchTool } from '../src/tool.ts'

describe('zvec_search tool', () => {
  it('uses the calling session workspace and projects bounded source locations', async () => {
    const search = vi.fn(async () => ({
      status: 'ready' as const,
      result: {
        query: 'authentication flow',
        root: '/repo',
        source: 'index' as const,
        coverage: 'ranked_sample' as const,
        items: [{
        kind: 'indexed_entity' as const,
        rank: 1,
        file: { absolutePath: '/repo/src/auth.ts', relativePath: 'src/auth.ts' },
        range: { kind: 'text' as const, startLine: 10, endLine: 18, startOffset: 0, endOffset: 35 },
        content: 'export function authenticate() {}',
        status: 'fresh' as const,
        score: 0.91,
        matchedBy: ['vector'] as never,
        metadata: {
          kind: 'code',
          symbolType: 'function',
          symbolName: 'authenticate',
          signature: 'function authenticate(): void',
          modifiers: ['exported'],
        },
        }],
        diagnostics: {
          index: { hitsReturned: 1, routes: [{ mode: 'fts' }, { mode: 'vector' }] },
          timings: [{ name: 'query_embedding', durationMs: 7 }, { name: 'total', durationMs: 42 }],
        },
      },
      info: { indexed: true, status: { filesScanned: 56, filesIndexed: 56, entitiesIndexed: 390, fragmentsTruncated: 0, filesFailed: 0 } },
    }))
    const tool = createSearchTool({ search } as never, { defaultLimit: 10, maxLimit: 30 })

    const value = await tool.execute(
      { query: 'authentication flow', limit: 8 },
      { agent: { session: { header: { cwd: '/repo' } } }, signal: new AbortController().signal } as never,
    ) as { results: Array<Record<string, unknown>>; diagnostics?: unknown; indexed?: unknown; warning?: string }

    expect(search).toHaveBeenCalledWith('/repo', { query: 'authentication flow', limit: 8 })
    expect(value).toEqual(expect.objectContaining({
      status: 'ready',
      root: '/repo',
      diagnostics: { hits: 1, routes: 'fts,vector', totalMs: 42 },
      indexed: { files: 56, entities: 390, truncated: 0, failed: 0 },
    }))
    expect(value.warning).toBeUndefined()
    expect(value.results).toEqual([expect.objectContaining({
      path: 'src/auth.ts',
      startLine: 10,
      endLine: 18,
      symbol: 'function authenticate',
    })])
  })

  it('names a markdown heading and warns when a ready index holds no files', async () => {
    const search = vi.fn(async () => ({
      status: 'ready' as const,
      result: {
        query: 'installation',
        root: '/container',
        source: 'index' as const,
        coverage: 'ranked_sample' as const,
        items: [{
          file: { relativePath: 'README.md' },
          range: { kind: 'text' as const, startLine: 5, endLine: 8 },
          content: '### Installation',
          status: 'fresh' as const,
          matchedBy: 'fts',
          metadata: { kind: 'markdown', heading: 'Installation', level: 3, scope: 'pkg::Installation' },
        }],
      },
      info: { indexed: true, status: { filesIndexed: 0, entitiesIndexed: 0 } },
    }))
    const tool = createSearchTool({ search } as never, { defaultLimit: 10, maxLimit: 30 })

    const value = await tool.execute(
      { query: 'installation' },
      { agent: { session: { header: { cwd: '/container' } } }, signal: new AbortController().signal } as never,
    ) as { warning?: string; results: Array<Record<string, unknown>> }

    expect(value.warning).toContain('nested git repositories are excluded')
    expect(value.results[0]).toEqual(expect.objectContaining({ heading: 'Installation', scope: 'pkg::Installation' }))
    expect(value.results[0]?.symbol).toBeUndefined()
  })

  it('omits coverage diagnostics when the engine cannot report them', async () => {
    const search = vi.fn(async () => ({
      status: 'ready' as const,
      result: {
        query: 'anything',
        root: '/repo',
        source: 'index' as const,
        coverage: 'ranked_sample' as const,
        items: [],
      },
    }))
    const tool = createSearchTool({ search } as never, { defaultLimit: 10, maxLimit: 30 })

    const value = await tool.execute(
      { query: 'anything' },
      { agent: { session: { header: { cwd: '/repo' } } }, signal: new AbortController().signal } as never,
    ) as Record<string, unknown>

    expect(value.indexed).toBeUndefined()
    expect(value.warning).toBeUndefined()
    expect(value.diagnostics).toEqual({})
  })

  it('reports the engine version and warns only when it leaves the tested range', async () => {
    const run = async (version: string) => {
      const search = vi.fn(async () => ({
        status: 'ready' as const,
        result: {
          query: 'anything',
          root: '/repo',
          source: 'index' as const,
          coverage: 'ranked_sample' as const,
          items: [],
        },
        engine: { version, range: '^0.2.1' },
      }))
      const tool = createSearchTool({ search } as never, { defaultLimit: 10, maxLimit: 30 })
      return tool.execute(
        { query: 'anything' },
        { agent: { session: { header: { cwd: '/repo' } } }, signal: new AbortController().signal } as never,
      ) as Promise<{ engine?: unknown; warning?: string }>
    }

    const inside = await run('0.2.9')
    expect(inside.engine).toEqual({ version: '0.2.9', range: '^0.2.1' })
    expect(inside.warning).toBeUndefined()

    const outside = await run('0.3.0')
    expect(outside.warning).toContain('outside the range')
  })

  it('returns a programmatic indexing status unchanged', async () => {
    const search = vi.fn(async () => ({
      status: 'indexing' as const,
      root: '/repo',
      message: 'The workspace index is still being built.',
    }))
    const tool = createSearchTool({ search } as never, { defaultLimit: 10, maxLimit: 30 })

    await expect(tool.execute(
      { query: 'authentication flow' },
      { agent: { session: { header: { cwd: '/repo' } } }, signal: new AbortController().signal } as never,
    )).resolves.toEqual({
      status: 'indexing',
      root: '/repo',
      message: 'The workspace index is still being built.',
    })
  })

  it('rejects calls without a session workspace', async () => {
    const tool = createSearchTool({ search: vi.fn() } as never, { defaultLimit: 10, maxLimit: 30 })
    await expect(tool.execute(
      { query: 'anything' },
      { agent: { session: { header: {} } }, signal: new AbortController().signal } as never,
    )).rejects.toThrow('requires a session workspace')
  })
})
