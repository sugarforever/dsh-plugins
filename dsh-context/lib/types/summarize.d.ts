import type { Message } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { Config } from './config.ts';
/** Stable producer identity for every node this plugin writes. */
export declare const PLUGIN_NAME = "context-engineer";
/**
 * Index over a session's append-only log, built incrementally so steady-state
 * reads cost O(new events) instead of O(log). Holds the same frozen event
 * objects the session already owns — no copies.
 */
export interface EventIndex {
    /** seq -> event, for resolving surface node seqs to their content. */
    eventBySeq: ReadonlyMap<number, SessionEvent>;
    /** `turn/start` boundaries in seq order. */
    turnStarts: ReadonlyArray<{
        seq: number;
        turn: number;
    }>;
}
/** Incremental {@link EventIndex} builder; fold only the newly appended events. */
export declare class EventIndexBuilder {
    private readonly eventBySeq;
    private readonly turnStarts;
    private processed;
    /** Fold events appended since the last call. */
    add(events: readonly SessionEvent[]): void;
    get index(): EventIndex;
}
/** Pure one-shot index build, for tests and detached replay. */
export declare function buildEventIndex(events: readonly SessionEvent[]): EventIndex;
/** True when the event is one of this plugin's own context nodes. */
export declare function isOwnContextNode(event: SessionEvent): boolean;
/** Visible conversation text of a message: top-level text blocks only. */
export declare function visibleText(message: Message): string;
/** Prompt bytes of a message for token estimation: text, reasoning, tool results. */
export declare function promptChars(message: Message): number;
/** Heuristic token estimate: ~4 chars per token, matches the harness's rough budget. */
export declare function estimateTokens(chars: number): number;
/** Whole-request estimate: prompt chars of every message plus per-message overhead. */
export declare function estimateRequestTokens(messages: readonly Message[]): number;
/**
 * The steady-state context window: the bounded recent tail of the model-visible
 * surface (user/assistant text only; tool results and this plugin's own nodes
 * are excluded). Walking newest-first enforces the message and turn budgets.
 */
export interface SummaryWindow {
    /** Covered surface node seqs, in surface order. */
    nodeSeqs: readonly number[];
    /** Bounded digest text, or '' when there is nothing to summarize. */
    text: string;
}
export declare function summarizeRecent(nodes: readonly number[], index: EventIndex, config: Required<Config>): SummaryWindow;
/** A candidate rolling-compaction replacement: the span to shadow plus its digest. */
export interface CompactSpan {
    /** Inclusive seq range to shadow; both endpoints are surface nodes. */
    start: number;
    end: number;
    /** Every shadowed surface node seq, for `sourceEventSeqs`. */
    shadowedSeqs: readonly number[];
    /** Bounded digest text for the replacement node. */
    text: string;
}
/**
 * Select the oldest span to shadow under pressure/overflow, retaining the last
 * `retainTurns` turns verbatim. The range is extended to tool-call/result
 * pairing boundaries so the surface fold never splits a pair, and rejected
 * (null) unless the digest is strictly smaller than what it shadows.
 */
export declare function selectCompactSpan(nodes: readonly number[], index: EventIndex, config: Required<Config>): CompactSpan | null;
//# sourceMappingURL=summarize.d.ts.map