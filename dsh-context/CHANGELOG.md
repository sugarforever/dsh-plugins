# Changelog

## 0.2.0

- Read history from the **model-visible surface** (`session.surface.nodes` + derived messages)
  instead of the raw event log; this also fixes user messages never being included in the
  digest (the MVP read `event.data.message`, which only exists on assistant events).
- Replace-based, fingerprint-gated injection: the plugin owns at most one context node,
  refreshed in place via `surfaceOp: replace` (stable position, no per-turn growth); byte-identical
  digests are skipped to keep the request prefix cache-stable. Self-healing when a compaction
  shadows the node (fresh append at the tail).
- Valid `ContextForm` vocabulary (`form: 'snapshot'` with sections) instead of the ad-hoc
  `'summary'` value.
- Opt-in rolling compaction (`rollingCompaction`, default off): pre-step pressure and
  context-window-overflow recovery shadow the oldest span with a bounded digest —
  tool-call/result pairing-safe range selection, `retainTurns` verbatim tail, shrink guard,
  per-successful-response retry cap.
- Fix latent `Config` declaration-merge type error (`export const Config` vs imported type).
- Test suite covering window selection, budgets, self-node filtering, span selection, pairing,
  shrink guard, and real `Session` surface replace/compaction semantics.

## 0.1.0

- Initial MVP: pre-step context summary injector with message and summary budgets.
