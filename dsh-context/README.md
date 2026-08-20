# dsh-context

`dsh-context` is a DeepSeek Harness plugin that adds a pre-step context-engineering hook,
following the discipline documented in `docs/context-engineering.md`: the model should always
see a minimal, bounded, cache-stable set of history — never a growing dump.

## What it does

The plugin listens on `agent/pre-step` and maintains **one** durable context node per session:
a bounded digest of the recent user/assistant turns, injected as a `user/message` with
`source.kind: 'plugin'` and `form: 'snapshot'` (a later snapshot from this producer supersedes
the earlier one). The node is **replaced in place** on refresh — the surface never grows a new
node per turn, and the position stays stable for prompt caching.

Optionally (`rollingCompaction`), it doubles as a template/rule-based sibling to
`dsh-compaction-basic`: under pre-step pressure or on a provider-confirmed context-window
overflow, it shadows the **oldest** surface span with its bounded digest — a summary that
*removes* what it covers, not one that piles on top of it.

## How context management works

1. DeepSeek Harness opens a request step and emits `agent/pre-step`.
2. The plugin first lets downstream handlers run and captures their decision.
3. If the decision is accepted (`enter`), it reads the **model-visible surface**
   (`agent.session.surface.nodes` + the derived messages) — never the raw event log, which
   contains shadowed events after a compaction.
4. It renders a bounded digest of the recent window (message and turn budgets from config),
   **excluding its own previous injections** so the digest never summarizes itself.
5. The digest is injected with `surfaceOp: replace` over the plugin's own previous node when it
   still exists (stable position, no growth); after a compaction shadowed it, a fresh node is
   appended at the tail (self-healing).
6. If the digest would be byte-identical to the last injection, nothing is written at all —
   the request prefix stays stable across turns (fingerprint-gated, cache-stable).

```mermaid
flowchart TD
  A[agent/pre-step event] --> B{downstream next()}
  B --> C{reject or aborted?}
  C -- yes --> D[Return decision unchanged]
  C -- no --> E[Read session.surface.nodes]
  E --> F[Render recent-turn digest]
  F --> G{rollingCompaction and pressure?}
  G -- yes --> H[Shadow oldest span with digest]
  G -- no --> I{digest identical to last?}
  I -- yes --> J[Skip injection - cache stable]
  I -- no --> K[Replace own node in place]
  K --> L[Return enter decision]
  H --> L
```

### Invariant boundaries

- Context is injected only on accepted downstream decisions (`kind: enter`), never on reject.
- The plugin owns **at most one context node** on the surface; refresh replaces it in place.
- The digest is bounded and deterministic: at most `maxTurnsPerSummary` turns, at most
  `maxMessages` message blocks, at most `maxSummaryLength` characters.
- Rolling compaction shadows only the oldest span (the last `retainTurns` turns stay verbatim),
  never splits a tool-call/result pair, and is rejected unless the digest is strictly smaller
  than what it shadows (shrink guard).

### Why `agent/pre-step` is used

- It is the earliest per-turn interception point before request execution.
- It can return either `reject` to block the step or `enter` with rewritten `messages`.
- Any context the pre-step waterfall injects is logged durably as `user/message`
  ("model-visible means logged"), so it is replayable and survives compaction.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `maxMessages` | `24` | Max message blocks the digest may cover. |
| `maxSummaryLength` | `500` | Hard character cap for any injected digest text. |
| `maxTurnsPerSummary` | `2` | Max turns sampled into the digest. |
| `rollingCompaction` | `false` | Enable the sibling rolling-compaction engine (see below). |
| `pressureRatio` | `0.8` | Fraction of the model's context window that triggers pre-step pressure compaction. |
| `retainTurns` | `1` | Turns kept verbatim when rolling compaction runs. |
| `maxOverflowRetries` | `3` | Cap on consecutive overflow recoveries (refreshes after a successful step). |

### Rolling compaction (opt-in)

Enable only when a dedicated compaction engine (`dsh-compaction-basic`) is **not** installed —
the plugin then owns the seam itself with harness-native primitives:

- **Pre-step pressure**: when the estimated request (derived history + claimed batch) reaches
  `contextWindow × pressureRatio`, the oldest span is shadowed by the digest; that digest
  doubles as this turn's context node.
- **Overflow recovery**: on `agent/request-error` classified as `CONTEXT_WINDOW_EXCEEDED`
  (canonical code or wording classifier), the oldest span is shadowed and the loop is asked to
  retry from the replacement surface. Other listeners' decisions are delegated to first; a
  failed or non-shrinking compaction stays terminal (harness default).
- Token accounting is heuristic (`chars / 4` + per-message overhead); the routed model's
  `contextWindow` comes from the session's `request/context` metadata.

## Quick test

```bash
npm install
npm run test
npm run typecheck
npm run build
```
