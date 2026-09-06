import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { createZvecGrep } from '@zvec/zvec-grep'
import { WorkspaceSearchRuntime } from './runtime.ts'
import { createSearchTool, type SearchToolConfig } from './tool.ts'
import { createWorkspaceWatcher } from './watcher.ts'
import { registerStatusRoute } from './status-route.ts'

export const name = 'dsh-zvec-grep'
export const inject = ['sessions', 'tools', 'systemPrompt']

export interface Config {
  embedding?: string
  device?: 'auto' | 'cpu' | 'metal' | 'vulkan' | 'cuda'
  defaultLimit?: number
  maxLimit?: number
  watchDebounceMs?: number
  reconcileIntervalMs?: number
  statusPollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  embedding: z.string().default('local/potion-code-16m-v2'),
  device: z.union(['auto', 'cpu', 'metal', 'vulkan', 'cuda']).default('auto'),
  defaultLimit: z.number().step(1).min(1).max(30).default(10),
  maxLimit: z.number().step(1).min(1).max(100).default(30),
  watchDebounceMs: z.number().step(1).min(50).max(30_000).default(750),
  reconcileIntervalMs: z.number().step(1).min(0).max(86_400_000).default(3_600_000),
  statusPollIntervalMs: z.number().step(1).min(250).max(60_000).default(2_000),
})

function activate(runtime: WorkspaceSearchRuntime, ctx: Context, root: string | undefined): void {
  if (!root) return
  void runtime.activate(root).catch(error => {
    ctx.logger.warn(`dsh-zvec-grep: automatic indexing failed for ${root}: ${String(error)}`)
  })
}

export function mountPlugin(ctx: Context, runtime: WorkspaceSearchRuntime, config: SearchToolConfig): void {
  ctx.systemPrompt.section({
    name: 'tool:zvec-search',
    order: 103,
    text: 'Use zvec_search for semantic or cross-file workspace discovery when wording or location is unknown. Use exact grep for known identifiers, literals, regular expressions, or exhaustive occurrence lists.',
  })
  ctx.tools.register(createSearchTool(runtime, config))
  ctx.on('session/created', session => { activate(runtime, ctx, session.header.cwd) }, { global: true })
  for (const session of ctx.sessions.list()) activate(runtime, ctx, session.header.cwd)
  ctx.effect(() => () => runtime.close())
}

export function apply(ctx: Context, config: Config): void {
  if ((config.defaultLimit ?? 10) > (config.maxLimit ?? 30)) {
    throw new Error('dsh-zvec-grep: defaultLimit cannot exceed maxLimit')
  }
  const runtime = new WorkspaceSearchRuntime({
    create: root => createZvecGrep({
      root,
      embedding: config.embedding ?? 'local/potion-code-16m-v2',
      device: config.device ?? 'auto',
    }),
    watch: createWorkspaceWatcher,
    debounceMs: config.watchDebounceMs ?? 750,
    reconcileIntervalMs: config.reconcileIntervalMs ?? 3_600_000,
  })
  mountPlugin(ctx, runtime, {
    defaultLimit: config.defaultLimit ?? 10,
    maxLimit: config.maxLimit ?? 30,
  })
  const statusFiber = ctx.inject(['connection'], childCtx => {
    childCtx.effect(
      () => registerStatusRoute(childCtx.connection.fetch, runtime, childCtx.sessions, config.statusPollIntervalMs ?? 2_000),
      'dsh-zvec-grep: status route',
    )
  })
  ctx.effect(() => () => statusFiber.dispose(), 'dsh-zvec-grep: optional web status')
}
