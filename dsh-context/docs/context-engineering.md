# Context Engineering: Algorithm and Workflow

This document is the design reference for `dsh-context`. It documents the context-engineering
algorithm and workflow used by production coding agents — traced through OpenAI Codex
(`codex-rs`, the reference implementation) — and maps each concept onto the DeepSeek Harness
architecture so the plugin can implement the same discipline with harness-native primitives.

The goal is one sentence: **the model should always see the minimal, bounded, cache-stable set of
instructions, state, and history it needs for the current request — never a growing dump of
everything that ever happened.**

---

## 1. Principles

Every decision below follows from five invariants:

| # | Invariant | Codex (reference) | DeepSeek Harness |
|---|---|---|---|
| 1 | **Model-visible means logged** — anything the model sees must be reconstructable from durable history. | Every injected fragment is a `ResponseItem` in `ContextManager.items`; runtime invariant. | `SessionEventMap` + the surface fold; `deriveMessages()` projects the request from the log ("Model-visible means logged"). |
| 2 | **No history rewrite in steady state** — context grows incrementally; the only replacement operation is compaction. | `ContextManager` appends per turn; `replace()` only on compaction/rollback. | Append-only log; the only surface mutation is `surfaceOp: {op:'replace'}` (compaction / tool-result prune). |
| 3 | **Stable prefixes for prompt caching** — keep the request prefix byte-identical across turns; invalidate only when necessary. | `prompt_cache_key` = session id; deterministic item IDs; diffs instead of full reinjection. | `dsh-session-projection-cache` + `ctx.tokenMeter` reuse the latest canonical header when the envelope matches. |
| 4 | **Everything injected is bounded** — every fragment has a hard cap; nothing is unbounded; nothing large (>~10k tokens) without review. | `ContextualUserFragment` caps; `truncation_policy` on tool output; `MAX_RENDERED_FRAGMENT_BYTES` on world-state sections. | Compaction seams enforce `retainTokens` / byte budgets; `tokenMeter` measures. |
| 5 | **Compaction is a replacement, not an addition** — summarizing must *remove* what it replaces, or the context only grows. | Compaction replaces the whole history vector with `[retained tail] + [summary]`. | Surface `replace` shadows the summarized span with one summary node. |

---

## 2. The turn-by-turn algorithm

For each user input the harness prepares one or more model requests. The context pipeline runs
in this order:

### 2.1 System prompt (base instructions)

A static-or-model-specific instruction blob, sent as the provider `instructions`/`system` role:

- **Codex**: `model_info.get_model_instructions(personality)` — a per-model template (with a
  `{{ personality }}` placeholder) or a bundled default (`prompt.md`); `config.base_instructions`
  can override. Sent via the Responses API `instructions` field (or a prefixed `developer`
  message for responses-lite models).
- **Harness**: `ctx.systemPrompt` assembly — plugins register `PromptSection`s with an `order`;
  `renderPrompt` concatenates them, `renderContextSections` turns them into a system message.
  The `dsh-context` plugin should contribute a **section** here (e.g. context-window budget
  guidance, or the skill catalog) — not per-turn messages.

### 2.2 Initial context (full reinjection)

On the first turn of a session/window (or after a compaction that cleared the baseline), the
harness injects the **full** context bundle as developer/user-role fragments:

- **Codex** `build_initial_context_with_world_state`: one developer message bundling
  `developer_instructions`, the skills catalog, token-budget context, and a **full render of
  every world-state section** (model instructions, permissions, AGENTS.md, collaboration mode,
  environments, apps, plugins, realtime, deferred tool namespaces, multi-agent mode), plus a
  contextual-user message (recommended plugins) and separate developer messages.
- **Harness**: no monolithic equivalent today. Context plugins inject per turn
  (`agent-instructions`, `time-context`, `session-reference`). A full-reinjection bundle can be
  implemented by emitting `user/message` events with `surfaceOp: 'append'` at
  `agent/session-start` (via `agent.inject()`), or at the first `agent/pre-step` of each
  context window.

### 2.3 Steady-state: world-state diffing

After the first turn, only **changes** are re-injected — never the full bundle:

- **Codex**: `WorldState` keeps typed sections; each section snapshots itself and implements
  `render_diff(previous)`. A section that is unchanged renders `None`; changed sections emit a
  tagged fragment (`<...>...</...>` markers). `record_context_updates_and_set_reference_context_item`
  compares the new `TurnContextItem` against `reference_context_item` and appends only the delta
  (plus turn-level contribution fragments). A quiet turn injects **zero** context bytes.
- **Harness**: the analog is `agent/pre-step` decision rewriting (plugin emits context only when
  its inputs changed) plus the token meter's incremental fold. The plugin should track a
  per-session fingerprint of what it injected and emit a replacement/update **only when that
  fingerprint changes** — this is what keeps the prefix stable.

### 2.4 Per-turn fragments

Small, bounded, frequently-refreshed items injected each turn:

- Time / elapsed time (`time-context`), token-budget remaining, current state notices, skill
  content on explicit `$skill` mention, file-change notices, subagent relays, etc.
- **Codex**: `ContextualUserFragment`s (`CurrentTimeReminder`, `TokenBudgetRemainingContext`,
  `SkillInstructions`, …) rendered into tagged messages.
- **Harness**: `MessageSource` with a valid `ContextForm` (`snapshot` with sections, `notice`,
  `recall`, …). Native plugins (`time-context`) already follow this pattern.

### 2.5 User input recording

The claimed inbox messages are logged as `user/message` (surface append) before the request is
built. Any context the pre-step waterfall injected is logged the same way — it is durable,
replayable, and model-visible.

### 2.6 History normalization before the request

Right before serialization the history is validated/normalized **without mutating the durable
log**:

- **Codex** `for_prompt()`: every tool call gets a matching output (synthetic `"aborted"` output
  if missing), orphan outputs are dropped, and images/audio are replaced with placeholder text
  when the model's `input_modalities` don't support them.
- **Harness**: the surface fold (`SurfaceManager`) already enforces call/result pairing at append
  time; `deriveMessages()` skips empty-content assistant messages. The plugin should always read
  **`agent.session.surface.nodes` + `deriveMessages()`**, never the raw `session.events` array —
  the raw log contains shadowed (replaced) events that must not reach the model.

### 2.7 Request assembly

The final request is `system` + derived history + the entered user messages (+ injected context),
with tool schemas attached. Order matters: **the volatile user message should come after the
stable prefix** so caching survives.

---

## 3. Compaction (the core of context management)

### 3.1 When it runs

- **Pre-turn pressure**: before the next request, if estimated usage ≥ threshold
  (Codex: `run_pre_sampling_compact`; Harness: `agent/pre-step` pressure trigger).
- **Mid-turn overflow**: a provider-confirmed `context_window_exceeded` request error
  (Codex: mid-turn `run_auto_compact`; Harness: `agent/request-error` recovery).
- **Manual**: explicit `/compact` (Harness: `dsh-command-compact` → `compaction.compactNow()`).

### 3.2 The threshold

- **Codex**: `auto_compact_token_limit = min(config limit, 90% of model context window)`,
  scoped to `Total` usage or `BodyAfterPrefix` (tokens since the window's initial prefill, i.e.
  what the cache prefix no longer covers). A small fallback buffer delays compaction; the full
  context window is a hard cap. Token accounting = server-reported last usage + byte-heuristics
  for items appended after the last model item.
- **Harness**: `ctx.tokenMeter.measure(session)` — `totalTokens` (request envelope) vs
  `surfaceTokens`; `dsh-compaction-basic` computes `thresholdTokens` from the routed model's
  `contextWindow` and a `thresholdRatio`, and honors `retainTokens` (the retained tail).

### 3.3 What the replacement history looks like

Compaction **replaces** a span with a summary; it never appends a summary on top of full history:

- **Codex**: `build_compacted_history` = `[retained recent user messages ≤ 20k tokens] +
  [summary user message]`; mid-turn compaction re-inserts canonical initial context **before the
  last real user message** so the summary stays the final item; pre-turn/manual compaction clears
  the context baseline so the next turn fully reinjects. Window ids advance, world-state baseline
  resets, token usage is recomputed — the cache prefix is intentionally invalidated because the
  history genuinely changed.
- **Harness**: `ctx.compaction.compactIfNeeded(agent, 'pressure' | 'context-overflow')` /
  `compactNow()` / `compactRegion(start, end)`. `dsh-compaction-basic` selects a balanced range
  (`selectCompactableRange`, respecting `retainTokens` and tool-call/result pairing), summarizes
  the span via `ctx.llm.stream()` (prefix-preserving for the provider KV cache), then appends a
  replacement `user/message` with `surfaceOp: {op:'replace', start, end}` +
  `sourceEventSeqs`, using `compactCheckpointSource(compactionId)` so consumers can recognize
  the checkpoint. The optional `ctx.toolResultPruner` prunes oversized tool results model-free
  before range selection. Optional `compaction/summary` etc. events are log-only.

### 3.4 Local vs remote / model-free compaction

- **Model-free first**: prune oversized tool results before spending an LLM call on a summary.
- **Model-backed summary**: one routed `ctx.llm.stream()` call; a **template/rule-based
  summarizer is a sibling backend** implementing the same `CompactionEngine` interface — this is
  the natural home for a deterministic, cheap "context window" (e.g. a rolling
  recency-weighted window) that `dsh-context` could provide.

---

## 3.5 What happens when the context window is reached (Harness, traced)

Harness has **no client-side preflight** — the loop derives messages (`deriveMessages()`) and streams;
nothing blocks or truncates before dispatch. Context capacity is advisory: the adapter reports
`resolveModelInfo(...).context.contextWindow`, logged as `request/context`. Reaching the window is
handled in two layers, both owned by `dsh-compaction-basic`:

1. **Preventive pressure at `agent/pre-step`** (default `thresholdRatio = 0.8`, `retainRatio = 0.16`):
   - `ctx.tokenMeter.measure(session)` → `totalTokens` (reuses provider usage when the latest
     request envelope matches; otherwise heuristic `estimateHeader + surfaceTokens`).
   - `thresholdTokens = contextWindow * thresholdRatio`; `retainTokens = contextWindow * retainRatio`.
   - If `totalTokens >= thresholdTokens`: optionally prune oversized tool results model-free
     (`ctx.toolResultPruner`), remeasure, then `selectCompactableRange` — walk backward from the
     tail accumulating `retainTokens`, back off to a tool-call/result balanced boundary.
   - Summarize the span with **one `ctx.llm.stream()` call that replays the conversation prefix**
     (system + tools + region messages + a final compaction instruction) so the provider's warm KV
     cache is reused; then `session.append('user/message', checkpoint, { surfaceOp: {op:'replace',
     start, end}, sourceEventSeqs })` shadows the span with one summary node.
   - Hard guard: the framed summary must be **smaller** than what it shadows
     (`framedSummaryTokenCount < shadowedTokenCount`) or the transaction fails. Retried up to
     `compactionRetries` until below threshold.
2. **Reactive overflow at `agent/request-error`** (the provider actually rejected): the adapter
   classifies the failure (`CONTEXT_WINDOW_EXCEEDED`, structured code + regex classifier
   `isContextWindowExceededError`). compaction-basic bypasses the threshold, compacts with
   `retainTokens = 0` (still pairing-balanced), and only when the surface `replaceGeneration`
   advanced does it return `{ kind: 'retry' }`; the loop then rebuilds the request from the
   replacement surface. The loop's default is **terminal** — no listener returning `retry` means
   the `LlmError` propagates and the turn closes with `reason: 'error'`.
3. **When compaction cannot help**: `selectCompactableRange` returns `null` (single oversized node
   that cannot be split, or nothing retainable) → `compactIfNeeded` returns `null` → the original
   provider error stays terminal.
4. **Durability**: `compaction/start … compaction/end` is a durable lock (orphaned start detected
   on resume); `compaction/summary` records the checkpoint, token count, and call envelope;
   stability checks (`whole-surface` for auto, `selected-span` for manual) reject a commit if the
   surface changed while summarizing; `maxOverflowRetries` caps the recovery loop per successful
   response. Manual `/compact` (`compactNow()`) runs in the idle phase with a standalone bracket
   and a durability flush, and needs no threshold.

| | Codex (reference) | Harness (traced) |
|---|---|---|
| Preventive check | `run_pre_sampling_compact` pre-turn; threshold = min(config, 90% of window), scoped Total / BodyAfterPrefix | `agent/pre-step` pressure; threshold = `contextWindow * thresholdRatio` (default 0.8) |
| Overflow recovery | mid-turn `run_auto_compact` on `ContextWindowExceeded` | `agent/request-error` → compact(`context-overflow`) → `{ kind: 'retry' }` |
| History mutation | replaces the whole `ContextManager` vector | positional `surfaceOp: replace` over the append-only log |
| Summary shape | `[retained user messages ≤20k tok] + [summary user message]` | `[retained tail ≥ retainTokens] … [summary node at the shadowed position]` |
| Summarizer | separate compact turn (local) or server memento (remote) | one prefix-reusing `ctx.llm.stream()` call per region; template backends are sibling engines |
| Model-free first | — | `ctx.toolResultPruner` before range selection |
| Per-model policy | per-model `auto_compact_token_limit` in catalog | `modelPolicies` exact-target overrides |
| Lock / hooks | pre/post-compact hooks | durable `compaction/start`…`compaction/end` bracket |

---

## 4. Token accounting and truncation

- Measure with `ctx.tokenMeter.measure()`; prefer token budgets over character counts.
- Truncate tool output at the boundary with a per-model policy (Codex: `truncation_policy`,
  e.g. 10k tokens × 1.2 serialization headroom).
- Cap every injected fragment; a fragment that can exceed ~1k tokens needs explicit design
  review; hard caps everywhere (Codex: `RESIZED_IMAGE_BYTES_ESTIMATE`, `MAX_RENDERED_FRAGMENT_BYTES`,
  `COMPACT_USER_MESSAGE_MAX_TOKENS`).

---

## 5. The workflow (who runs what, in order)

```text
turn/start
  claim inbox batch
  [plugin] pre-step waterfall (prepend/append order decided by design)
    1. await downstream next()  -> decision
    2. if reject/aborted: return decision
    3. compute context delta (surface-based, fingerprint-checked, token-budgeted)
    4. optionally run pressure compaction (ctx.compaction) before entering
    5. enter(messages) with context folded at the chosen position
  step/start
  append entered messages as user/message (surface append)
  derive model history from the surface (deriveMessages)
  assemble system prompt (ctx.systemPrompt)
  agent/request -> llm/stream
  assistant/message; tool/call* -> tool/result*
  step/end
  on request-error with context_window_exceeded:
    agent/request-error -> compact('context-overflow') -> retry from replacement surface
  next step or turn/end
```

---

## 6. Mapping table (Codex concept → Harness primitive)

| Codex concept | Codex file (reference) | Harness primitive |
|---|---|---|
| Base instructions / system prompt | `models-manager/src/model_info.rs`, `client.rs` | `ctx.systemPrompt` sections |
| Initial context bundle | `core/src/session/mod.rs` `build_initial_context_with_world_state` | `agent.inject()` / first-step `user/message` append |
| World-state diffing | `core/src/context/world_state/mod.rs` | per-plugin fingerprint + conditional pre-step injection |
| Context fragments (tagged) | `context-fragments/src/fragment.rs`, `core/src/context/*` | `MessageSource` + `ContextForm` (`snapshot` sections, `notice`, …) |
| Per-turn fragments | `core/src/session/mod.rs` | `time-context`, `agent-instructions` patterns |
| History normalization | `core/src/context_manager/normalize.rs` | surface fold + `deriveMessages()` (already enforced) |
| Token accounting | `core/src/context_manager/history.rs` | `ctx.tokenMeter.measure()` |
| Tool-output truncation | `utils/output-truncation` | `dsh-compaction-tool-result-pruner` |
| Compaction seam | `core/src/compact*.rs` | `ctx.compaction` (`CompactionEngine`) |
| Compaction triggers | `core/src/session/context_window.rs`, `turn.rs` | `agent/pre-step` pressure + `agent/request-error` overflow |
| Prompt caching | `core/src/client.rs` `prompt_cache_key` | stable surface prefix + projection cache |
| Retained tail + summary shape | `core/src/compact.rs` `build_compacted_history` | `compactRegion` + `surfaceOp.replace` |

---

## 7. Design implications for `dsh-context`

1. **Never grow context without removing** — the plugin's context must either be a
   `surfaceOp: replace` of its own previous injection, or ride the `ctx.compaction` seam.
2. **Read the surface, not the raw log** — use `agent.session.surface.nodes` and
   `deriveMessages()`; filter out shadowed events and the plugin's own previous injections.
3. **Budget in tokens, not characters** — use `ctx.tokenMeter.measure()`; cap by model
   `contextWindow` with a ratio, like `dsh-compaction-basic`.
4. **Be idempotent and cache-stable** — fingerprint what you injected; re-inject only on change;
   keep the injection position stable (decide and document prepend vs fold-after-claimed-batch).
5. **Use the harness vocabulary** — valid `ContextForm` (`snapshot` with `sections`, or a new
   registered form); `source.kind: 'plugin'`, `plugin: 'context-engineer'`.
6. **Compose with the seam** — if the goal is *compaction*, implement a `CompactionEngine`
   backend (template/rolling-window summarizer) instead of appending summaries at pre-step.
7. **Respect cancellation** — forward `signal`; return the downstream decision on abort/reject.

---

## 8. Improvement roadmap for `dsh-compaction-basic` (Codex comparison)

Reference comparison: Codex compaction (`core/src/compact*.rs`, `core/src/session/context_window.rs`,
`core/src/session/turn.rs`) vs `dsh-compaction-basic` (`packages/compaction/compaction-basic/`).

### What `dsh-compaction-basic` already does better — do not copy back

- **Surface positional replacement** over the append-only log (Codex replaces the whole history vector).
- **Cache-preserving summarization** — the compaction call replays the conversation prefix so the
  provider KV cache is reused.
- **Shrink guard** — the framed summary must be smaller than what it shadows.
- **Durable `compaction/start … compaction/end` lock** with orphan detection.
- **Tool-call/result pairing-safe boundaries**; model-free pruner runs before summarization.
- **Structured checkpoint template** and a fine-grained manual-error taxonomy
  (`busy | cancelled | changed | summary | commit | persistence`).
- **Per-model policy overrides** (`modelPolicies`).

### Improvement opportunities (from the Codex experience), by value

| # | Improvement | Codex mechanism | Current Harness gap | Suggested change |
|---|---|---|---|---|
| 1 | **Zero-cost window-reset strategy** | `compact_token_budget.rs`: token-budget compaction skips summarization and installs a fresh context window + re-injects initial context (0 LLM calls) | every compaction spends one summarization call; summarization failure is terminal | configurable strategy `summary \| window-reset \| auto`; use window-reset when the span is mostly tool/state content, or as the fallback when summarization fails or cannot shrink |
| 2 | **Re-inject canonical initial context after mid-turn compaction** | `InitialContextInjection::BeforeLastUserMessage`: developer bundle + full world-state render inserted before the last real user message; summary stays last | only the span is replaced; instruction-bearing user messages (`agent-instructions`, skills, `form: 'instructions'`/`'catalog'`) inside the span are permanently lost (the assembled `system` prompt survives, workspace instructions do not) | after compaction, emit a context-refresh message re-sending retained canonical instructions, or exclude instruction-marked nodes from the selected range |
| 3 | **Eager per-model tool-output truncation at append time** | `ContextManager::process_item` truncates tool outputs at record time per `truncation_policy` (e.g. 10k tokens × 1.2) | full-size results enter the surface; pruner only runs at compaction pressure | cap `tool/result` content at append time per model (keep `toolResultPruner` as backstop) — lowers surface pressure and compaction frequency |
| 4 | **Compact on model switch / context-window downshift** | `maybe_run_previous_model_inline_compact`: compacts with the previous model when `comp_hash` changed or switching to a smaller context window | no such trigger; switching to a smaller window can overflow with only request-error fallback | when the routed model changes and `contextWindow` decreases, trigger compaction preemptively (prefer the previous model for summarization) |
| 5 | **Pressure accounting includes the pending request + cache-prefix scoping** | pre-sampling estimates pending context diffs + user input; `AutoCompactTokenLimitScope::BodyAfterPrefix` counts only tokens after the cached prefix | measures current `totalTokens` only | include the claimed batch + this step's injected context in the measurement; optionally scope the threshold to tokens after the cached prefix so a large fully-cached prefix does not trigger premature compaction |
| 6 | **Retention favors user intent + boundary truncation** | `build_compacted_history_with_limit`: keeps the last ≤20k tokens of user messages, truncating the boundary message to fill the budget | tail retained per-node all-or-nothing across all node types | within the retained budget, prefer user/assistant messages over tool results, and truncate the boundary node instead of dropping it whole (keep the verbatim tail generally — dropping all tool state is the Codex downside not to copy) |
| 7 | **Model-visible token budget and window awareness** | `TokenBudgetContext` (window ids) + `TokenBudgetRemainingContext` (\"X tokens left\") + optional `new_context` tool | the model does not know remaining budget and cannot request a fresh window | inject a bounded one-line window/budget fragment after compaction; optionally expose a `request_new_context`-style tool |
| 8 | **Compaction degradation path** | loop re-checks the token level after compaction; `compact_model_fallback.rs` retries previous-model compaction with the current model | summarization failure/non-shrink is terminal for auto (manual has error codes) | degrade to window-reset or prune-only (no summary) to keep the session usable |
| 9 | **User-visible warning on repeated compactions** | post-compaction `WarningEvent` (\"long threads + multiple compactions reduce accuracy; start a new thread\") | info log only | after N compactions, emit a user-visible notice |

### What not to copy from Codex

- Wholesale history-vector replacement (surface replace is better).
- Keeping only user messages in the retained history (drops tool state the verbatim tail preserves).
- The generic compaction instruction (the structured checkpoint template is better).

### Recommended order

1 → 2 → 3 first (largest value, smallest change); 4–9 are incremental enhancements.


---

## 9. Implementation status (`dsh-context` 0.2.0)

The plugin now implements the sections above with harness-native primitives:

| Design requirement | Implementation |
|---|---|
| Read the surface, not the raw log (§2.6, §7.2) | `summarizeRecent` walks `session.surface.nodes` + an incremental `EventIndex` (seq → event, `turn/start` boundaries); the raw log is consulted only for turn boundaries. |
| Never grow context without removing (§7.1) | The plugin owns at most one context node: refresh is `surfaceOp: {op:'replace', start, end}` over its own previous node (`sourceEventSeqs` = the shadowed seq); after a compaction shadowed it, a fresh append re-establishes it. |
| Idempotent, cache-stable (§7.4) | Fingerprint = the rendered digest; a byte-identical candidate writes nothing. Position is stable (first-injection position, refreshed in place). |
| Harness vocabulary (§7.5) | `source.kind: 'plugin'`, `plugin: 'context-engineer'`, `form: 'snapshot'` with a `context` section (a later snapshot supersedes the earlier one). |
| Budget in tokens, not characters (§7.3) | Heuristic `chars / 4` + per-message overhead; pressure threshold = `contextWindow × pressureRatio` from `session.requestContext()`. |
| Compose with the seam (§3.4, §7.6) | `rollingCompaction` (default off, so it never fights `dsh-compaction-basic`): pre-step pressure and `agent/request-error` overflow shadow the oldest span (everything before the last `retainTurns` turns) with the bounded digest — pairing-safe boundaries, shrink guard, `maxOverflowRetries` per successful response. |
| Respect cancellation (§7.7) | Returns the downstream decision on reject/abort; overflow retry honors the turn signal. |

Not implemented (deliberately, until `dsh-compaction-basic` types are available to this plugin):
an actual `CompactionEngine` backend registration under `ctx.compaction` — the rolling engine is
a standalone sibling using the same surface primitives, sharing the digest renderer so a future
engine backend can reuse it.
