import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  isContextWindowExceededError,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { ConfigSchema, resolveConfig, type Config as ContextConfig } from './config.ts'
import {
  EventIndexBuilder,
  PLUGIN_NAME,
  estimateRequestTokens,
  selectCompactSpan,
  summarizeRecent,
  type CompactSpan,
} from './summarize.ts'

export const name = 'context-engineer'
export const inject = ['agents']
/** Plugin schema; consumers validate against it without importing `Config` the type. */
export const Config = ConfigSchema

export type PluginConfig = ContextConfig
/** `snapshot`: a later injection from this producer supersedes the earlier one. */
const PLUGIN_CONTEXT_FORM = 'snapshot'

/**
 * Per-session plugin state. The event index is folded incrementally; the
 * refresh node's position and fingerprint make injection idempotent and
 * cache-stable (re-inject only when the digest would change).
 */
interface SessionState {
  index: EventIndexBuilder
  /** Seq of the plugin's current refresh node, or undefined before the first. */
  lastSeq: number | undefined
  /** Digest text last injected; equality with the next candidate means skip. */
  fingerprint: string | undefined
  /** Consecutive overflow recoveries, capped by `maxOverflowRetries`. */
  overflowCompactions: number
}

const states = new WeakMap<Session, SessionState>()

function getState(session: Session): SessionState {
  let state = states.get(session)
  if (!state) {
    state = {
      index: new EventIndexBuilder(),
      lastSeq: undefined,
      fingerprint: undefined,
      overflowCompactions: 0,
    }
    states.set(session, state)
  }
  state.index.add(session.events)
  return state
}

function isOnSurface(session: Session, seq: number): boolean {
  return session.surface.nodes.includes(seq)
}

function buildContextMessage(text: string): UserMessage {
  return createUserMessage({
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: PLUGIN_CONTEXT_FORM,
      sections: [{ name: 'context', text }],
    },
    content: [{ type: 'text', text: `Context summary (${text.length} chars):\n${text}` }],
  })
}

/**
 * Append the context node durably: replace the previous one in place when it
 * is still on the surface (stable position, no growth), otherwise append at
 * the tail (e.g. after a compaction shadowed it).
 */
function appendContext(session: Session, message: UserMessage, previousSeq: number | undefined): number {
  if (previousSeq !== undefined && isOnSurface(session, previousSeq)) {
    const event = session.append('user/message', message, {
      surfaceOp: { op: 'replace', start: previousSeq, end: previousSeq },
      sourceEventSeqs: [previousSeq],
    })
    return event.seq
  }
  const event = session.append('user/message', message, { surfaceOp: 'append' })
  return event.seq
}

/**
 * Opt-in rolling compaction at pre-step pressure. Shadows the oldest span
 * (everything before the retained tail) with a bounded digest, which becomes
 * the plugin's context node for this turn. Returns the replacement node's seq,
 * or null when pressure is below threshold / nothing is compactable.
 */
function maybePressureCompact(
  session: Session,
  state: SessionState,
  config: Required<ContextConfig>,
  claimedMessages: readonly UserMessage[],
): { seq: number; span: CompactSpan } | null {
  const contextWindow = session.requestContext()?.contextWindow
  if (!contextWindow || contextWindow <= 0) return null

  const estimated =
    estimateRequestTokens(session.deriveMessages()) + estimateRequestTokens(claimedMessages)
  if (estimated < Math.floor(contextWindow * config.pressureRatio)) return null

  const span = selectCompactSpan(session.surface.nodes, state.index.index, config)
  if (!span) return null

  const event = session.append('user/message', buildContextMessage(span.text), {
    surfaceOp: { op: 'replace', start: span.start, end: span.end },
    sourceEventSeqs: [...span.shadowedSeqs],
  })
  return { seq: event.seq, span }
}

/** The context-window-overflow classification detail for one failure. */
function overflowDetail(failure: { code: string; message: string; status?: number }): string {
  return [failure.code, String(failure.status ?? ''), failure.message].filter(Boolean).join(' ')
}

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  const config = resolveConfig(rawConfig)

  ctx.on(
    'agent/pre-step',
    async ({ agent, turn, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted || turn <= 1) return decision

      const session = agent.session
      const state = getState(session)

      // A fired pre-step means the previous step settled: the overflow-retry
      // budget refreshes per successful response, as in the compaction seam.
      if (state.overflowCompactions > 0) state.overflowCompactions = 0

      // Rolling compaction (opt-in sibling engine): under pressure, shadow the
      // oldest span; its digest doubles as this turn's context node.
      if (config.rollingCompaction) {
        const compacted = maybePressureCompact(session, state, config, decision.messages)
        if (compacted !== null) {
          state.lastSeq = compacted.seq
          state.fingerprint = compacted.span.text
          ctx.logger.info(
            `dsh-context: pressure compaction shadowed ${compacted.span.shadowedSeqs.length} nodes -> seq ${compacted.seq}`,
          )
          return decision
        }
      }

      // Steady-state refresh: read the model-visible surface, never the raw
      // log; skip when the digest would be byte-identical (cache-stable).
      const window = summarizeRecent(session.surface.nodes, state.index.index, config)
      if (window.text.length === 0) return decision
      if (
        state.lastSeq !== undefined &&
        isOnSurface(session, state.lastSeq) &&
        state.fingerprint === window.text
      ) {
        return decision
      }

      const seq = appendContext(session, buildContextMessage(window.text), state.lastSeq)
      state.lastSeq = seq
      state.fingerprint = window.text
      ctx.logger.debug(`dsh-context: injected context summary (${window.text.length} chars) at seq ${seq}`)
      return decision
    },
    { prepend: true },
  )

  // Opt-in overflow recovery: on a provider-confirmed context-window overflow,
  // shadow the oldest span with the rolling digest and retry from the
  // replacement surface. Delegates to downstream listeners first; terminal by
  // default when disabled or when compaction cannot help.
  ctx.on(
    'agent/request-error',
    async ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
      if (!config.rollingCompaction) return next()
      const action = await next()
      if (action?.kind === 'retry' || signal.aborted) return action

      const session = agent.session
      const state = getState(session)
      if (state.overflowCompactions >= config.maxOverflowRetries) return undefined

      const detail = overflowDetail(failure)
      const overflow =
        failure.code === CONTEXT_WINDOW_EXCEEDED_CODE || isContextWindowExceededError(detail)
      if (!overflow) return undefined

      const span = selectCompactSpan(session.surface.nodes, state.index.index, config)
      if (!span) return undefined

      const event = session.append('user/message', buildContextMessage(span.text), {
        surfaceOp: { op: 'replace', start: span.start, end: span.end },
        sourceEventSeqs: [...span.shadowedSeqs],
      })
      state.overflowCompactions += 1
      ctx.logger.info(
        `dsh-context: overflow compaction shadowed ${span.shadowedSeqs.length} nodes -> seq ${event.seq}`,
      )
      return { kind: 'retry' }
    },
  )

  ctx.logger.info(
    `dsh-context: configured maxSummaryLength=${config.maxSummaryLength}, ` +
      `maxMessages=${config.maxMessages}, maxTurnsPerSummary=${config.maxTurnsPerSummary}, ` +
      `rollingCompaction=${config.rollingCompaction}`,
  )
}
