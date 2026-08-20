import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'

/** Stable producer identity for every node this plugin writes. */
export const PLUGIN_NAME = 'context-engineer'

/**
 * Index over a session's append-only log, built incrementally so steady-state
 * reads cost O(new events) instead of O(log). Holds the same frozen event
 * objects the session already owns — no copies.
 */
export interface EventIndex {
  /** seq -> event, for resolving surface node seqs to their content. */
  eventBySeq: ReadonlyMap<number, SessionEvent>
  /** `turn/start` boundaries in seq order. */
  turnStarts: ReadonlyArray<{ seq: number; turn: number }>
}

/** Incremental {@link EventIndex} builder; fold only the newly appended events. */
export class EventIndexBuilder {
  private readonly eventBySeq = new Map<number, SessionEvent>()
  private readonly turnStarts: Array<{ seq: number; turn: number }> = []
  private processed = 0

  /** Fold events appended since the last call. */
  add(events: readonly SessionEvent[]): void {
    for (let i = this.processed; i < events.length; i++) {
      const event = events[i]!
      this.eventBySeq.set(event.seq, event)
      if (event.type === 'turn/start') {
        this.turnStarts.push({ seq: event.seq, turn: event.data.turn })
      }
    }
    this.processed = events.length
  }

  get index(): EventIndex {
    return { eventBySeq: this.eventBySeq, turnStarts: this.turnStarts }
  }
}

/** Pure one-shot index build, for tests and detached replay. */
export function buildEventIndex(events: readonly SessionEvent[]): EventIndex {
  const builder = new EventIndexBuilder()
  builder.add(events)
  return builder.index
}

/** True when the event is one of this plugin's own context nodes. */
export function isOwnContextNode(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source
  return source.kind === 'plugin' && source.plugin === PLUGIN_NAME
}

/** Visible conversation text of a message: top-level text blocks only. */
export function visibleText(message: Message): string {
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** Prompt bytes of a message for token estimation: text, reasoning, tool results. */
export function promptChars(message: Message): number {
  let chars = 0
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        chars += block.text.length
        break
      case 'tool-result':
        for (const nested of block.content) {
          if (nested.type === 'text' || nested.type === 'reasoning') chars += nested.text.length
        }
        break
      default:
        break
    }
  }
  return chars
}

/** Heuristic token estimate: ~4 chars per token, matches the harness's rough budget. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Whole-request estimate: prompt chars of every message plus per-message overhead. */
export function estimateRequestTokens(messages: readonly Message[]): number {
  let chars = 0
  for (const message of messages) chars += promptChars(message)
  return estimateTokens(chars) + messages.length * 4
}

/** The digest text a node carries for a span of surface nodes, in surface order. */
function renderDigest(seqs: readonly number[], index: EventIndex, maxSummaryLength: number): string {
  const rows: string[] = []
  for (const seq of seqs) {
    const event = index.eventBySeq.get(seq)
    if (!event || isOwnContextNode(event)) continue
    const text = nodeVisibleText(event).trim()
    if (!text) continue
    rows.push(`${event.type === 'assistant/message' ? 'Assistant' : 'User'}: ${text}`)
  }
  if (rows.length === 0) return ''
  return clampSummary(rows.join('\n'), maxSummaryLength)
}

function nodeVisibleText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return visibleText(event.data)
    case 'assistant/message':
      return visibleText(event.data.message)
    default:
      return ''
  }
}

function clampSummary(text: string, maxSummaryLength: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxSummaryLength) return trimmed
  return `${trimmed.slice(0, maxSummaryLength).trimEnd()}…`
}

/** Turn number owning a surface seq: the last `turn/start` at or before it. */
function turnOfSeq(index: EventIndex, seq: number): number | undefined {
  const starts = index.turnStarts
  let lo = 0
  let hi = starts.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid]!.seq <= seq) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found >= 0 ? starts[found]!.turn : undefined
}

/**
 * The steady-state context window: the bounded recent tail of the model-visible
 * surface (user/assistant text only; tool results and this plugin's own nodes
 * are excluded). Walking newest-first enforces the message and turn budgets.
 */
export interface SummaryWindow {
  /** Covered surface node seqs, in surface order. */
  nodeSeqs: readonly number[]
  /** Bounded digest text, or '' when there is nothing to summarize. */
  text: string
}

export function summarizeRecent(
  nodes: readonly number[],
  index: EventIndex,
  config: Required<Config>,
): SummaryWindow {
  const collected: Array<{ seq: number; role: 'User' | 'Assistant'; text: string }> = []
  let turnsSeen = 0
  let currentTurn: number | undefined

  for (let i = nodes.length - 1; i >= 0; i--) {
    if (collected.length >= config.maxMessages) break
    const seq = nodes[i]!
    const event = index.eventBySeq.get(seq)
    if (!event || isOwnContextNode(event)) continue
    const text = nodeVisibleText(event).trim()
    if (!text) continue
    const turn = turnOfSeq(index, seq)
    if (currentTurn === undefined) {
      currentTurn = turn
      turnsSeen = 1
    } else if (turn !== currentTurn) {
      if (turnsSeen >= config.maxTurnsPerSummary) break
      currentTurn = turn
      turnsSeen += 1
    }
    collected.push({ seq, role: event.type === 'assistant/message' ? 'Assistant' : 'User', text })
  }
  if (collected.length === 0) return { nodeSeqs: [], text: '' }

  const ordered = collected.reverse()
  const rendered = ordered.map(({ role, text }) => `${role}: ${text}`).join('\n')
  return { nodeSeqs: ordered.map(({ seq }) => seq), text: clampSummary(rendered, config.maxSummaryLength) }
}

/** A candidate rolling-compaction replacement: the span to shadow plus its digest. */
export interface CompactSpan {
  /** Inclusive seq range to shadow; both endpoints are surface nodes. */
  start: number
  end: number
  /** Every shadowed surface node seq, for `sourceEventSeqs`. */
  shadowedSeqs: readonly number[]
  /** Bounded digest text for the replacement node. */
  text: string
}

/**
 * Select the oldest span to shadow under pressure/overflow, retaining the last
 * `retainTurns` turns verbatim. The range is extended to tool-call/result
 * pairing boundaries so the surface fold never splits a pair, and rejected
 * (null) unless the digest is strictly smaller than what it shadows.
 */
export function selectCompactSpan(
  nodes: readonly number[],
  index: EventIndex,
  config: Required<Config>,
): CompactSpan | null {
  if (nodes.length <= 1) return null

  const newestSeq = nodes[nodes.length - 1]!
  const newestTurn = turnOfSeq(index, newestSeq)
  if (newestTurn === undefined) return null
  const tailStartTurn = newestTurn - config.retainTurns + 1
  if (tailStartTurn < 1) return null
  const tailStartSeq = index.turnStarts.find(start => start.turn === tailStartTurn)?.seq
  if (tailStartSeq === undefined) return null

  // Shadow every surface node strictly before the retained tail.
  const candidates = nodes.filter(seq => seq < tailStartSeq)
  if (candidates.length === 0) return null

  let lo = candidates[0]!
  let hi = candidates[candidates.length - 1]!

  // Pair-safe boundaries: never split an assistant tool-call from its result.
  const pairs = collectToolPairs(index)
  let changed = true
  while (changed) {
    changed = false
    for (const pair of pairs) {
      const inCall = pair.callSeq >= lo && pair.callSeq <= hi
      const inResult = pair.resultSeq >= lo && pair.resultSeq <= hi
      if (inCall !== inResult) {
        lo = Math.min(lo, pair.callSeq, pair.resultSeq)
        hi = Math.max(hi, pair.callSeq, pair.resultSeq)
        changed = true
      }
    }
  }

  const shadowedSeqs = nodes.filter(seq => seq >= lo && seq <= hi)
  if (shadowedSeqs.length === 0) return null

  const text = renderDigest(shadowedSeqs, index, config.maxSummaryLength)
  if (text.length === 0) return null

  // Shrink guard: the digest must be smaller than what it shadows.
  let shadowedChars = 0
  for (const seq of shadowedSeqs) {
    const event = index.eventBySeq.get(seq)
    if (event) shadowedChars += nodePromptChars(event)
  }
  if (estimateTokens(text.length) >= estimateTokens(shadowedChars)) return null

  return { start: lo, end: hi, shadowedSeqs, text }
}

function nodePromptChars(event: SessionEvent): number {
  switch (event.type) {
    case 'user/message':
      return promptChars(event.data)
    case 'assistant/message':
      return promptChars(event.data.message)
    case 'tool/result':
      return promptChars(event.data.message)
    default:
      return 0
  }
}

interface ToolPair {
  callSeq: number
  resultSeq: number
}

function collectToolPairs(index: EventIndex): ToolPair[] {
  const callSeqByCallId = new Map<string, number>()
  const resultSeqByCallId = new Map<string, number>()
  for (const event of index.eventBySeq.values()) {
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') callSeqByCallId.set(block.id, event.seq)
      }
    } else if (event.type === 'tool/result') {
      resultSeqByCallId.set(event.data.message.source.callId, event.seq)
    }
  }
  const pairs: ToolPair[] = []
  for (const [callId, callSeq] of callSeqByCallId) {
    const resultSeq = resultSeqByCallId.get(callId)
    if (resultSeq !== undefined) pairs.push({ callSeq, resultSeq })
  }
  return pairs
}
