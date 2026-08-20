import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createMessage,
  createUserMessage,
  type CallId,
  type MessageSource,
  type ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveConfig } from './config.ts'
import {
  PLUGIN_NAME,
  buildEventIndex,
  estimateRequestTokens,
  isOwnContextNode,
  selectCompactSpan,
  summarizeRecent,
} from './summarize.ts'

const config = resolveConfig({})

let next = 0
function resetSeq(): void {
  next = 0
}

function turnStart(turn: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: ++next, time: 1000, data: { turn } }
}

function user(text: string, source: MessageSource = { kind: 'user' }): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: ++next,
    time: 1000,
    data: createUserMessage({ source, content: [{ type: 'text', text }] }),
    surfaceOp: 'append',
  }
}

function assistant(text: string, turn: number): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: ++next,
    time: 1000,
    data: {
      turn,
      step: 1,
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'text', text }],
      }),
    },
    surfaceOp: 'append',
  }
}

function assistantToolCall(turn: number, callId: CallId): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: ++next,
    time: 1000,
    data: {
      turn,
      step: 1,
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
      }),
    },
    surfaceOp: 'append',
  }
}

function toolResult(turn: number, callId: CallId, text: string): SessionEvent<'tool/result'> {
  const message = createMessage({
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] as [
      ToolResultBlock,
    ],
    source: { kind: 'tool', callId },
  })
  return {
    type: 'tool/result',
    seq: ++next,
    time: 1000,
    data: { turn, step: 1, message },
    surfaceOp: 'append',
  }
}

function surfaceNodes(events: readonly SessionEvent[]): number[] {
  return events
    .filter(
      (event): event is SessionEvent<'user/message' | 'assistant/message' | 'tool/result'> =>
        event.type === 'user/message' ||
        event.type === 'assistant/message' ||
        event.type === 'tool/result',
    )
    .map(event => event.seq)
}

const pad = (text: string, length = 200): string => text + 'x'.repeat(Math.max(0, length - text.length))

describe('summarizeRecent (steady-state window)', () => {
  it('includes both user and assistant text, in surface order', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user('hello'),
      assistant('hi there', 1),
      turnStart(2),
      user('how are you'),
      assistant('fine', 2),
    ]
    const index = buildEventIndex(events)
    const window = summarizeRecent(surfaceNodes(events), index, config)
    expect(window.text).toBe('User: hello\nAssistant: hi there\nUser: how are you\nAssistant: fine')
    expect(window.nodeSeqs).toEqual([2, 3, 5, 6])
  })

  it('caps the window by maxMessages (newest first)', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user('u1'),
      assistant('a1', 1),
      turnStart(2),
      user('u2'),
      assistant('a2', 2),
    ]
    const index = buildEventIndex(events)
    const window = summarizeRecent(surfaceNodes(events), index, resolveConfig({ maxMessages: 2 }))
    expect(window.text).toBe('User: u2\nAssistant: a2')
  })

  it('caps the window by maxTurnsPerSummary', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user('u1'),
      assistant('a1', 1),
      turnStart(2),
      user('u2'),
      assistant('a2', 2),
    ]
    const index = buildEventIndex(events)
    const window = summarizeRecent(surfaceNodes(events), index, resolveConfig({ maxTurnsPerSummary: 1 }))
    expect(window.text).toBe('User: u2\nAssistant: a2')
  })

  it('excludes its own previous context nodes', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user('u1'),
      assistant('a1', 1),
      user('previous digest', {
        kind: 'plugin',
        plugin: PLUGIN_NAME,
        form: 'snapshot',
        sections: [{ name: 'context', text: 'previous digest' }],
      }),
    ]
    const index = buildEventIndex(events)
    const window = summarizeRecent(surfaceNodes(events), index, config)
    expect(window.text).not.toContain('previous digest')
    expect(window.text).toBe('User: u1\nAssistant: a1')
  })

  it('skips tool results and clamps to maxSummaryLength', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user('u1'),
      assistantToolCall(1, 'c1' as CallId),
      toolResult(1, 'c1' as CallId, 'huge tool output '.repeat(50)),
      assistant(pad('a1'), 1),
    ]
    const index = buildEventIndex(events)
    const window = summarizeRecent(surfaceNodes(events), index, resolveConfig({ maxSummaryLength: 30 }))
    expect(window.text).not.toContain('huge tool output')
    expect(window.text.endsWith('…')).toBe(true)
    expect(window.text.length).toBeLessThanOrEqual(31)
  })

  it('returns empty when there is nothing to summarize', () => {
    resetSeq()
    const events = [turnStart(1)]
    const index = buildEventIndex(events)
    expect(summarizeRecent(surfaceNodes(events), index, config).text).toBe('')
  })
})

describe('selectCompactSpan (rolling compaction)', () => {
  it('shadows everything before the retained tail', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user(pad('u1')),
      assistant(pad('a1'), 1),
      turnStart(2),
      user(pad('u2')),
      assistant(pad('a2'), 2),
      turnStart(3),
      user(pad('u3')),
      assistant(pad('a3'), 3),
    ]
    const index = buildEventIndex(events)
    const span = selectCompactSpan(surfaceNodes(events), index, config)
    expect(span).not.toBeNull()
    expect(span!.shadowedSeqs).toEqual([2, 3, 5, 6]) // turns 1-2; turn 3 retained
    expect(span!.text).toContain('u1')
    expect(span!.text).not.toContain('u3')
  })

  it('returns null when there are not enough turns to shadow', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user(pad('u1')),
      assistant(pad('a1'), 1),
      turnStart(2),
      user(pad('u2')),
      assistant(pad('a2'), 2),
    ]
    const index = buildEventIndex(events)
    expect(selectCompactSpan(surfaceNodes(events), index, resolveConfig({ retainTurns: 2 }))).toBeNull()
  })

  it('extends the range to keep a tool-call/result pair together', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user(pad('u1')),
      assistantToolCall(1, 'c1' as CallId),
      turnStart(2),
      toolResult(2, 'c1' as CallId, pad('result')),
      user(pad('u2')),
      assistant(pad('a2'), 2),
    ]
    const index = buildEventIndex(events)
    const span = selectCompactSpan(surfaceNodes(events), index, config)
    expect(span).not.toBeNull()
    // the tool result lives in the retained tail but belongs to the shadowed call
    expect(span!.shadowedSeqs).toContain(3) // assistant tool-call
    expect(span!.shadowedSeqs).toContain(5) // its tool/result
    expect(span!.start).toBe(2)
    expect(span!.end).toBe(5)
  })

  it('rejects the span when the digest would not shrink it', () => {
    resetSeq()
    const events = [
      turnStart(1),
      user('hi'),
      assistant('yo', 1),
      turnStart(2),
      user('hey'),
      assistant('sup', 2),
    ]
    const index = buildEventIndex(events)
    expect(selectCompactSpan(surfaceNodes(events), index, config)).toBeNull()
  })

  it('returns null for a degenerate surface', () => {
    resetSeq()
    const events = [turnStart(1), user('only message')]
    const index = buildEventIndex(events)
    expect(selectCompactSpan(surfaceNodes(events), index, config)).toBeNull()
  })
})

describe('estimation', () => {
  it('estimates request tokens from message content plus overhead', () => {
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'abcdefgh' }],
    })
    const estimate = estimateRequestTokens([message])
    expect(estimate).toBe(2 + 4) // 8 chars / 4 + one message overhead
  })
})

describe('isOwnContextNode', () => {
  it('recognizes only plugin-authored context nodes', () => {
    resetSeq()
    const own = user('digest', {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'snapshot',
      sections: [{ name: 'context', text: 'digest' }],
    })
    const plain = user('plain')
    const reply = assistant('reply', 1)
    expect(isOwnContextNode(own)).toBe(true)
    expect(isOwnContextNode(plain)).toBe(false)
    expect(isOwnContextNode(reply)).toBe(false)
  })
})

describe('session surface integration', () => {
  it('refresh replaces its own node in place; compaction shadow is self-healing', () => {
    resetSeq()
    const session = Session.create(SessionId('context-test'))
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'u1' }] }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'a1' }] }),
    }, { surfaceOp: 'append' })

    // First injection appends at the tail (seq 2).
    const first = session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'snapshot', sections: [{ name: 'context', text: 'digest v1' }] },
      content: [{ type: 'text', text: 'digest v1' }],
    }), { surfaceOp: 'append' })
    expect(first.seq).toBe(2)

    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'u2' }] }), { surfaceOp: 'append' })

    // Refresh replaces the first node in place; the surface keeps positional
    // order (seq 4 sits where seq 2 sat, between a1 and u2).
    session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'snapshot', sections: [{ name: 'context', text: 'digest v2' }] },
      content: [{ type: 'text', text: 'digest v2' }],
    }), { surfaceOp: { op: 'replace', start: first.seq, end: first.seq }, sourceEventSeqs: [first.seq] })

    const messages = session.deriveMessages()
    expect(messages.map(m => (m.content[0]?.type === 'text' ? m.content[0].text : ''))).toEqual([
      'u1',
      'a1',
      'digest v2',
      'u2',
    ])
    expect(session.surface.nodes).toEqual([0, 1, 4, 3])

    // A compaction shadows the refresh node; a later refresh re-appends.
    // The replacement node is a new event (seq 5) sitting where seq 4 sat.
    session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'snapshot', sections: [{ name: 'context', text: 'compacted' }] },
      content: [{ type: 'text', text: 'compacted' }],
    }), { surfaceOp: { op: 'replace', start: 4, end: 4 }, sourceEventSeqs: [4] })
    expect(session.surface.nodes).toEqual([0, 1, 5, 3])

    session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'snapshot', sections: [{ name: 'context', text: 'digest v3' }] },
      content: [{ type: 'text', text: 'digest v3' }],
    }), { surfaceOp: 'append' })
    expect(session.surface.nodes).toEqual([0, 1, 5, 3, 6])
    expect(session.deriveMessages().map(m => (m.content[0]?.type === 'text' ? m.content[0].text : ''))).toEqual([
      'u1',
      'a1',
      'compacted',
      'u2',
      'digest v3',
    ])
  })
})
