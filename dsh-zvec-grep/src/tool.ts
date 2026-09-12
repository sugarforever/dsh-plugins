import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ZvecContextItem, ZvecContextResult, ZvecEngineInfo } from './engine.ts'
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

/** What the engine says this fragment is: a code symbol or a markdown heading. */
function describeItem(item: ZvecContextItem): { symbol?: string; heading?: string; scope?: string } {
  const metadata = item.metadata
  if (metadata === undefined) return {}
  const symbol = metadata.symbolType !== undefined && metadata.symbolName !== undefined
    ? `${metadata.symbolType} ${metadata.symbolName}`
    : undefined
  const scope = typeof metadata.scope === 'string' && metadata.scope.length > 0 ? metadata.scope : undefined
  return {
    ...(symbol === undefined ? {} : { symbol }),
    ...(metadata.heading === undefined ? {} : { heading: metadata.heading }),
    ...(scope === undefined ? {} : { scope }),
  }
}

/** Which routes ran and how long the search took, so a thin answer can explain itself. */
function projectDiagnostics(result: ZvecContextResult) {
  const hits = result.diagnostics?.index?.hitsReturned
  const routes = result.diagnostics?.index?.routes
    ?.map(route => route.mode)
    .filter((mode): mode is string => typeof mode === 'string')
  const totalMs = result.diagnostics?.timings?.find(entry => entry.name === 'total')?.durationMs
  return {
    ...(hits === undefined ? {} : { hits }),
    ...(routes === undefined || routes.length === 0 ? {} : { routes: routes.join(',') }),
    ...(totalMs === undefined ? {} : { totalMs }),
  }
}

/** How much the workspace index actually covers right now. */
function projectIndexCounts(info: ZvecEngineInfo | undefined) {
  const status = info?.status
  if (status === undefined) return undefined
  return {
    ...(status.filesIndexed === undefined ? {} : { files: status.filesIndexed }),
    ...(status.entitiesIndexed === undefined ? {} : { entities: status.entitiesIndexed }),
    ...(status.fragmentsTruncated === undefined ? {} : { truncated: status.fragmentsTruncated }),
    ...(status.filesFailed === undefined ? {} : { failed: status.filesFailed }),
  }
}

function projectResult(result: ZvecContextResult, info: ZvecEngineInfo | undefined) {
  const indexed = projectIndexCounts(info)
  return {
    status: 'ready' as const,
    query: result.query,
    root: result.root,
    source: result.source,
    coverage: result.coverage,
    diagnostics: projectDiagnostics(result),
    ...(indexed === undefined ? {} : { indexed }),
    // A ready index holding nothing is almost always the wrong root: the session workspace is not
    // the code root, and nested git repositories are excluded from every workspace index.
    ...(indexed?.files === 0
      ? { warning: `the workspace index holds no files for ${result.root}; check that the session workspace is the code root (nested git repositories are excluded)` }
      : {}),
    results: result.items.map(item => ({
      path: item.file.relativePath,
      ...lineRange(item),
      ...describeItem(item),
      content: item.content,
      status: item.status,
      matchedBy: Array.isArray(item.matchedBy) ? item.matchedBy.join(',') : String(item.matchedBy),
      ...(item.score === undefined ? {} : { score: item.score }),
    })),
  }
}

function project(outcome: WorkspaceSearchOutcome) {
  return outcome.status === 'ready' ? projectResult(outcome.result, outcome.info) : outcome
}

export function createSearchTool(runtime: WorkspaceSearchRuntime, config: SearchToolConfig) {
  return defineTool({
    name: 'zvec_search',
    description: 'Search the current workspace by meaning, concepts, architecture, relationships, and data flow. Returns indexing or refreshing status immediately when the background index is not ready, and an error status carrying the install command when the optional zvec-grep engine is not available. Each hit names the symbol or heading it matched, and indexed reports how many files the workspace index actually holds - a very small count means the session workspace is not the code root. Use exact grep for known literals or exhaustive matches.',
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
          warning: { type: 'string' },
          query: { type: 'string' },
          source: { type: 'string' },
          coverage: { type: 'string' },
          diagnostics: {
            type: 'object',
            additionalProperties: false,
            properties: {
              hits: { type: 'integer' },
              routes: { type: 'string' },
              totalMs: { type: 'number' },
            },
          },
          indexed: {
            type: 'object',
            additionalProperties: false,
            properties: {
              files: { type: 'integer' },
              entities: { type: 'integer' },
              truncated: { type: 'integer' },
              failed: { type: 'integer' },
            },
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                startLine: { type: 'integer' },
                endLine: { type: 'integer' },
                symbol: { type: 'string' },
                heading: { type: 'string' },
                scope: { type: 'string' },
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
