import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ZvecContextItem, ZvecContextResult } from './engine.ts'
import type { WorkspaceSearchOutcome, WorkspaceSearchRuntime } from './runtime.ts'

export interface SearchToolConfig {
  defaultLimit: number
  maxLimit: number
}

function lineRange(item: ZvecContextItem): { startLine?: number; endLine?: number } {
  const range = item.excerptRange ?? item.range
  if ('startLine' in range && 'endLine' in range) {
    return { startLine: range.startLine, endLine: range.endLine }
  }
  if ('page' in range) return { startLine: range.page, endLine: range.page }
  return {}
}

function projectResult(result: ZvecContextResult) {
  return {
    status: 'ready' as const,
    query: result.query,
    root: result.root,
    source: result.source,
    coverage: result.coverage,
    results: result.items.map(item => ({
      path: item.file.relativePath,
      ...lineRange(item),
      content: item.content,
      status: item.status,
      matchedBy: Array.isArray(item.matchedBy) ? item.matchedBy.join(',') : String(item.matchedBy),
      ...(item.score === undefined ? {} : { score: item.score }),
    })),
  }
}

function project(outcome: WorkspaceSearchOutcome) {
  return outcome.status === 'ready' ? projectResult(outcome.result) : outcome
}

export function createSearchTool(runtime: WorkspaceSearchRuntime, config: SearchToolConfig) {
  return defineTool({
    name: 'zvec_search',
    description: 'Search the current workspace by meaning, concepts, architecture, relationships, and data flow. Returns indexing or refreshing status immediately when the background index is not ready, and an error status carrying the install command when the optional zvec-grep engine is not available. Use exact grep for known literals or exhaustive matches.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search intent.' },
      limit: { type: 'integer', description: `Maximum results, from 1 to ${config.maxLimit}. Defaults to ${config.defaultLimit}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          root: { type: 'string', required: true },
          message: { type: 'string' },
          query: { type: 'string' },
          source: { type: 'string' },
          coverage: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                startLine: { type: 'integer' },
                endLine: { type: 'integer' },
                content: { type: 'string', required: true },
                status: { type: 'string', required: true },
                matchedBy: { type: 'string', required: true },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const root = exec.agent?.session.header.cwd
      if (!root) throw new Error('zvec_search requires a session workspace')
      const limit = args.limit ?? config.defaultLimit
      if (limit < 1 || limit > config.maxLimit) {
        throw new Error(`zvec_search limit must be between 1 and ${config.maxLimit}`)
      }
      return project(await runtime.search(root, { query: args.query, limit }))
    },
  })
}
