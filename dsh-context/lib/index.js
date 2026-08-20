import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, isContextWindowExceededError } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

//#region src/config.ts
const ConfigSchema = z.object({
	maxMessages: z.number().step(1).min(1).max(500).default(24),
	maxSummaryLength: z.number().step(1).min(120).max(4e3).default(500),
	maxTurnsPerSummary: z.number().step(1).min(1).max(16).default(2),
	rollingCompaction: z.boolean().default(false),
	pressureRatio: z.number().step(.05).min(.5).max(.95).default(.8),
	retainTurns: z.number().step(1).min(1).max(8).default(1),
	maxOverflowRetries: z.number().step(1).min(1).max(10).default(3)
});
function resolveConfig(config) {
	return {
		maxMessages: config.maxMessages ?? 24,
		maxSummaryLength: config.maxSummaryLength ?? 500,
		maxTurnsPerSummary: config.maxTurnsPerSummary ?? 2,
		rollingCompaction: config.rollingCompaction ?? false,
		pressureRatio: config.pressureRatio ?? .8,
		retainTurns: config.retainTurns ?? 1,
		maxOverflowRetries: config.maxOverflowRetries ?? 3
	};
}

//#endregion
//#region src/summarize.ts
/** Stable producer identity for every node this plugin writes. */
const PLUGIN_NAME = "context-engineer";
/** Incremental {@link EventIndex} builder; fold only the newly appended events. */
var EventIndexBuilder = class {
	eventBySeq = /* @__PURE__ */ new Map();
	turnStarts = [];
	processed = 0;
	/** Fold events appended since the last call. */
	add(events) {
		for (let i = this.processed; i < events.length; i++) {
			const event = events[i];
			this.eventBySeq.set(event.seq, event);
			if (event.type === "turn/start") this.turnStarts.push({
				seq: event.seq,
				turn: event.data.turn
			});
		}
		this.processed = events.length;
	}
	get index() {
		return {
			eventBySeq: this.eventBySeq,
			turnStarts: this.turnStarts
		};
	}
};
/** True when the event is one of this plugin's own context nodes. */
function isOwnContextNode(event) {
	if (event.type !== "user/message") return false;
	const source = event.data.source;
	return source.kind === "plugin" && source.plugin === PLUGIN_NAME;
}
/** Visible conversation text of a message: top-level text blocks only. */
function visibleText(message) {
	let text = "";
	for (const block of message.content) if (block.type === "text") text += block.text;
	return text;
}
/** Prompt bytes of a message for token estimation: text, reasoning, tool results. */
function promptChars(message) {
	let chars = 0;
	for (const block of message.content) switch (block.type) {
		case "text":
		case "reasoning":
			chars += block.text.length;
			break;
		case "tool-result":
			for (const nested of block.content) if (nested.type === "text" || nested.type === "reasoning") chars += nested.text.length;
			break;
		default: break;
	}
	return chars;
}
/** Heuristic token estimate: ~4 chars per token, matches the harness's rough budget. */
function estimateTokens(chars) {
	return Math.ceil(chars / 4);
}
/** Whole-request estimate: prompt chars of every message plus per-message overhead. */
function estimateRequestTokens(messages) {
	let chars = 0;
	for (const message of messages) chars += promptChars(message);
	return estimateTokens(chars) + messages.length * 4;
}
/** The digest text a node carries for a span of surface nodes, in surface order. */
function renderDigest(seqs, index, maxSummaryLength) {
	const rows = [];
	for (const seq of seqs) {
		const event = index.eventBySeq.get(seq);
		if (!event || isOwnContextNode(event)) continue;
		const text = nodeVisibleText(event).trim();
		if (!text) continue;
		rows.push(`${event.type === "assistant/message" ? "Assistant" : "User"}: ${text}`);
	}
	if (rows.length === 0) return "";
	return clampSummary(rows.join("\n"), maxSummaryLength);
}
function nodeVisibleText(event) {
	switch (event.type) {
		case "user/message": return visibleText(event.data);
		case "assistant/message": return visibleText(event.data.message);
		default: return "";
	}
}
function clampSummary(text, maxSummaryLength) {
	const trimmed = text.trim();
	if (trimmed.length <= maxSummaryLength) return trimmed;
	return `${trimmed.slice(0, maxSummaryLength).trimEnd()}…`;
}
/** Turn number owning a surface seq: the last `turn/start` at or before it. */
function turnOfSeq(index, seq) {
	const starts = index.turnStarts;
	let lo = 0;
	let hi = starts.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = lo + hi >> 1;
		if (starts[mid].seq <= seq) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found >= 0 ? starts[found].turn : void 0;
}
function summarizeRecent(nodes, index, config) {
	const collected = [];
	let turnsSeen = 0;
	let currentTurn;
	for (let i = nodes.length - 1; i >= 0; i--) {
		if (collected.length >= config.maxMessages) break;
		const seq = nodes[i];
		const event = index.eventBySeq.get(seq);
		if (!event || isOwnContextNode(event)) continue;
		const text = nodeVisibleText(event).trim();
		if (!text) continue;
		const turn = turnOfSeq(index, seq);
		if (currentTurn === void 0) {
			currentTurn = turn;
			turnsSeen = 1;
		} else if (turn !== currentTurn) {
			if (turnsSeen >= config.maxTurnsPerSummary) break;
			currentTurn = turn;
			turnsSeen += 1;
		}
		collected.push({
			seq,
			role: event.type === "assistant/message" ? "Assistant" : "User",
			text
		});
	}
	if (collected.length === 0) return {
		nodeSeqs: [],
		text: ""
	};
	const ordered = collected.reverse();
	const rendered = ordered.map(({ role, text }) => `${role}: ${text}`).join("\n");
	return {
		nodeSeqs: ordered.map(({ seq }) => seq),
		text: clampSummary(rendered, config.maxSummaryLength)
	};
}
/**
* Select the oldest span to shadow under pressure/overflow, retaining the last
* `retainTurns` turns verbatim. The range is extended to tool-call/result
* pairing boundaries so the surface fold never splits a pair, and rejected
* (null) unless the digest is strictly smaller than what it shadows.
*/
function selectCompactSpan(nodes, index, config) {
	if (nodes.length <= 1) return null;
	const newestSeq = nodes[nodes.length - 1];
	const newestTurn = turnOfSeq(index, newestSeq);
	if (newestTurn === void 0) return null;
	const tailStartTurn = newestTurn - config.retainTurns + 1;
	if (tailStartTurn < 1) return null;
	const tailStartSeq = index.turnStarts.find((start) => start.turn === tailStartTurn)?.seq;
	if (tailStartSeq === void 0) return null;
	const candidates = nodes.filter((seq) => seq < tailStartSeq);
	if (candidates.length === 0) return null;
	let lo = candidates[0];
	let hi = candidates[candidates.length - 1];
	const pairs = collectToolPairs(index);
	let changed = true;
	while (changed) {
		changed = false;
		for (const pair of pairs) if ((pair.callSeq >= lo && pair.callSeq <= hi) !== (pair.resultSeq >= lo && pair.resultSeq <= hi)) {
			lo = Math.min(lo, pair.callSeq, pair.resultSeq);
			hi = Math.max(hi, pair.callSeq, pair.resultSeq);
			changed = true;
		}
	}
	const shadowedSeqs = nodes.filter((seq) => seq >= lo && seq <= hi);
	if (shadowedSeqs.length === 0) return null;
	const text = renderDigest(shadowedSeqs, index, config.maxSummaryLength);
	if (text.length === 0) return null;
	let shadowedChars = 0;
	for (const seq of shadowedSeqs) {
		const event = index.eventBySeq.get(seq);
		if (event) shadowedChars += nodePromptChars(event);
	}
	if (estimateTokens(text.length) >= estimateTokens(shadowedChars)) return null;
	return {
		start: lo,
		end: hi,
		shadowedSeqs,
		text
	};
}
function nodePromptChars(event) {
	switch (event.type) {
		case "user/message": return promptChars(event.data);
		case "assistant/message": return promptChars(event.data.message);
		case "tool/result": return promptChars(event.data.message);
		default: return 0;
	}
}
function collectToolPairs(index) {
	const callSeqByCallId = /* @__PURE__ */ new Map();
	const resultSeqByCallId = /* @__PURE__ */ new Map();
	for (const event of index.eventBySeq.values()) if (event.type === "assistant/message") {
		for (const block of event.data.message.content) if (block.type === "tool-call") callSeqByCallId.set(block.id, event.seq);
	} else if (event.type === "tool/result") resultSeqByCallId.set(event.data.message.source.callId, event.seq);
	const pairs = [];
	for (const [callId, callSeq] of callSeqByCallId) {
		const resultSeq = resultSeqByCallId.get(callId);
		if (resultSeq !== void 0) pairs.push({
			callSeq,
			resultSeq
		});
	}
	return pairs;
}

//#endregion
//#region src/index.ts
const name = "context-engineer";
const inject = ["agents"];
/** Plugin schema; consumers validate against it without importing `Config` the type. */
const Config = ConfigSchema;
/** `snapshot`: a later injection from this producer supersedes the earlier one. */
const PLUGIN_CONTEXT_FORM = "snapshot";
const states = /* @__PURE__ */ new WeakMap();
function getState(session) {
	let state = states.get(session);
	if (!state) {
		state = {
			index: new EventIndexBuilder(),
			lastSeq: void 0,
			fingerprint: void 0,
			overflowCompactions: 0
		};
		states.set(session, state);
	}
	state.index.add(session.events);
	return state;
}
function isOnSurface(session, seq) {
	return session.surface.nodes.includes(seq);
}
function buildContextMessage(text) {
	return createUserMessage({
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME,
			form: PLUGIN_CONTEXT_FORM,
			sections: [{
				name: "context",
				text
			}]
		},
		content: [{
			type: "text",
			text: `Context summary (${text.length} chars):\n${text}`
		}]
	});
}
/**
* Append the context node durably: replace the previous one in place when it
* is still on the surface (stable position, no growth), otherwise append at
* the tail (e.g. after a compaction shadowed it).
*/
function appendContext(session, message, previousSeq) {
	if (previousSeq !== void 0 && isOnSurface(session, previousSeq)) return session.append("user/message", message, {
		surfaceOp: {
			op: "replace",
			start: previousSeq,
			end: previousSeq
		},
		sourceEventSeqs: [previousSeq]
	}).seq;
	return session.append("user/message", message, { surfaceOp: "append" }).seq;
}
/**
* Opt-in rolling compaction at pre-step pressure. Shadows the oldest span
* (everything before the retained tail) with a bounded digest, which becomes
* the plugin's context node for this turn. Returns the replacement node's seq,
* or null when pressure is below threshold / nothing is compactable.
*/
function maybePressureCompact(session, state, config, claimedMessages) {
	const contextWindow = session.requestContext()?.contextWindow;
	if (!contextWindow || contextWindow <= 0) return null;
	if (estimateRequestTokens(session.deriveMessages()) + estimateRequestTokens(claimedMessages) < Math.floor(contextWindow * config.pressureRatio)) return null;
	const span = selectCompactSpan(session.surface.nodes, state.index.index, config);
	if (!span) return null;
	return {
		seq: session.append("user/message", buildContextMessage(span.text), {
			surfaceOp: {
				op: "replace",
				start: span.start,
				end: span.end
			},
			sourceEventSeqs: [...span.shadowedSeqs]
		}).seq,
		span
	};
}
/** The context-window-overflow classification detail for one failure. */
function overflowDetail(failure) {
	return [
		failure.code,
		String(failure.status ?? ""),
		failure.message
	].filter(Boolean).join(" ");
}
async function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	ctx.on("agent/pre-step", async ({ agent, turn, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted || turn <= 1) return decision;
		const session = agent.session;
		const state = getState(session);
		if (state.overflowCompactions > 0) state.overflowCompactions = 0;
		if (config.rollingCompaction) {
			const compacted = maybePressureCompact(session, state, config, decision.messages);
			if (compacted !== null) {
				state.lastSeq = compacted.seq;
				state.fingerprint = compacted.span.text;
				ctx.logger.info(`dsh-context: pressure compaction shadowed ${compacted.span.shadowedSeqs.length} nodes -> seq ${compacted.seq}`);
				return decision;
			}
		}
		const window = summarizeRecent(session.surface.nodes, state.index.index, config);
		if (window.text.length === 0) return decision;
		if (state.lastSeq !== void 0 && isOnSurface(session, state.lastSeq) && state.fingerprint === window.text) return decision;
		const seq = appendContext(session, buildContextMessage(window.text), state.lastSeq);
		state.lastSeq = seq;
		state.fingerprint = window.text;
		ctx.logger.debug(`dsh-context: injected context summary (${window.text.length} chars) at seq ${seq}`);
		return decision;
	}, { prepend: true });
	ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
		if (!config.rollingCompaction) return next();
		const action = await next();
		if (action?.kind === "retry" || signal.aborted) return action;
		const session = agent.session;
		const state = getState(session);
		if (state.overflowCompactions >= config.maxOverflowRetries) return void 0;
		const detail = overflowDetail(failure);
		if (!(failure.code === CONTEXT_WINDOW_EXCEEDED_CODE || isContextWindowExceededError(detail))) return void 0;
		const span = selectCompactSpan(session.surface.nodes, state.index.index, config);
		if (!span) return void 0;
		const event = session.append("user/message", buildContextMessage(span.text), {
			surfaceOp: {
				op: "replace",
				start: span.start,
				end: span.end
			},
			sourceEventSeqs: [...span.shadowedSeqs]
		});
		state.overflowCompactions += 1;
		ctx.logger.info(`dsh-context: overflow compaction shadowed ${span.shadowedSeqs.length} nodes -> seq ${event.seq}`);
		return { kind: "retry" };
	});
	ctx.logger.info(`dsh-context: configured maxSummaryLength=${config.maxSummaryLength}, maxMessages=${config.maxMessages}, maxTurnsPerSummary=${config.maxTurnsPerSummary}, rollingCompaction=${config.rollingCompaction}`);
}

//#endregion
export { Config, apply, inject, name };