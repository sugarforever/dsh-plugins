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
        }],
        diagnostics: {},
      },
    }))
    const tool = createSearchTool({ search } as never, { defaultLimit: 10, maxLimit: 30 })

    const value = await tool.execute(
      { query: 'authentication flow', limit: 8 },
      { agent: { session: { header: { cwd: '/repo' } } }, signal: new AbortController().signal } as never,
    ) as { results: Array<Record<string, unknown>> }

    expect(search).toHaveBeenCalledWith('/repo', { query: 'authentication flow', limit: 8 })
    expect(value).toEqual(expect.objectContaining({ status: 'ready', root: '/repo' }))
    expect(value.results).toEqual([expect.objectContaining({ path: 'src/auth.ts', startLine: 10, endLine: 18 })])
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
