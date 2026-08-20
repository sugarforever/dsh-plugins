import z from '@deepseek-ai/schemastery'

export interface Config {
  /**
   * How many recent message blocks the steady-state context digest may cover.
   */
  maxMessages?: number
  /**
   * Hard character cap for any injected context text (refresh and rolling
   * compaction digests share this bound).
   */
  maxSummaryLength?: number
  /**
   * How many recent turns the steady-state context digest may cover.
   */
  maxTurnsPerSummary?: number
  /**
   * Opt-in rolling compaction (sibling engine to `dsh-compaction-basic`):
   * when enabled, the plugin shadows old surface spans with its bounded
   * digest — under pre-step pressure and on context-window overflow — instead
   * of only refreshing its single context node. Disabled by default so the
   * plugin never fights a dedicated compaction engine.
   */
  rollingCompaction?: boolean
  /**
   * Fraction of the routed model's context window that triggers pre-step
   * pressure compaction. Ignored unless `rollingCompaction` is enabled.
   */
  pressureRatio?: number
  /**
   * How many of the most recent turns stay verbatim when rolling compaction
   * runs; everything older is shadowed by the digest.
   */
  retainTurns?: number
  /**
   * Cap on consecutive context-window overflow recoveries per session.
   */
  maxOverflowRetries?: number
}

export const ConfigSchema: z<Config> = z.object({
  maxMessages: z.number().step(1).min(1).max(500).default(24),
  maxSummaryLength: z.number().step(1).min(120).max(4000).default(500),
  maxTurnsPerSummary: z.number().step(1).min(1).max(16).default(2),
  rollingCompaction: z.boolean().default(false),
  pressureRatio: z.number().step(0.05).min(0.5).max(0.95).default(0.8),
  retainTurns: z.number().step(1).min(1).max(8).default(1),
  maxOverflowRetries: z.number().step(1).min(1).max(10).default(3),
})

export function resolveConfig(config: Config): Required<Config> {
  return {
    maxMessages: config.maxMessages ?? 24,
    maxSummaryLength: config.maxSummaryLength ?? 500,
    maxTurnsPerSummary: config.maxTurnsPerSummary ?? 2,
    rollingCompaction: config.rollingCompaction ?? false,
    pressureRatio: config.pressureRatio ?? 0.8,
    retainTurns: config.retainTurns ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 3,
  }
}
