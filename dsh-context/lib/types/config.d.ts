import z from '@deepseek-ai/schemastery';
export interface Config {
    /**
     * How many recent message blocks the steady-state context digest may cover.
     */
    maxMessages?: number;
    /**
     * Hard character cap for any injected context text (refresh and rolling
     * compaction digests share this bound).
     */
    maxSummaryLength?: number;
    /**
     * How many recent turns the steady-state context digest may cover.
     */
    maxTurnsPerSummary?: number;
    /**
     * Opt-in rolling compaction (sibling engine to `dsh-compaction-basic`):
     * when enabled, the plugin shadows old surface spans with its bounded
     * digest — under pre-step pressure and on context-window overflow — instead
     * of only refreshing its single context node. Disabled by default so the
     * plugin never fights a dedicated compaction engine.
     */
    rollingCompaction?: boolean;
    /**
     * Fraction of the routed model's context window that triggers pre-step
     * pressure compaction. Ignored unless `rollingCompaction` is enabled.
     */
    pressureRatio?: number;
    /**
     * How many of the most recent turns stay verbatim when rolling compaction
     * runs; everything older is shadowed by the digest.
     */
    retainTurns?: number;
    /**
     * Cap on consecutive context-window overflow recoveries per session.
     */
    maxOverflowRetries?: number;
}
export declare const ConfigSchema: z<Config>;
export declare function resolveConfig(config: Config): Required<Config>;
//# sourceMappingURL=config.d.ts.map