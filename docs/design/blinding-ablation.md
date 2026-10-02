# Identity-blinding ablation — design (not yet run)

Status: design only. No experiment has been run. This document specifies how
to test SkillArray's actual differentiating hypothesis — that mechanical
identity blinding changes reviewer behavior for the better — rather than
asserting it without data.

## The hypothesis, stated precisely

SkillArray's README currently claims identity blinding "matters" because,
without it, "a reviewer can tailor its rebuttal to which specific model or
vendor it believes wrote a claim, rather than to the claim's actual
evidence." This is a plausible mechanism, not a measured effect. No run has
tested whether it actually changes outcomes. This document exists to make
that claim earn its place rather than stay asserted indefinitely.

## Design

Hold everything constant except identity visibility:

- **Same source** target repository/document across both conditions.
- **Same initial findings**: run Phase 1 once per reviewer, reuse the exact
  same Phase 1 output for both conditions, rather than re-running Phase 1
  twice and introducing model non-determinism as a confound.
- **Same reviewer pair**: identical provider/model/effort configuration in
  both conditions.

**Condition A (identity visible)**: skip `blind-relabel.mjs relabel`/`scan`
entirely for the peer-exchange step. Each reviewer sees the peer's real
`A`/`B` findings file, with provider/model identity intact (e.g. the task
packet or file naming explicitly states which seat is which vendor). This is
a protocol variant used only for this experiment — it must never run as a
normal review mode, since it discards a currently-load-bearing guarantee.

**Condition B (identity mechanically blinded)**: the current, shipped
protocol exactly as-is — `relabel`/`scan` applied per `review-protocol.md`'s
Blind exchange section.

## Metrics

- **Concession rate**: fraction of the peer's claims a reviewer marks
  `conceded` (from the existing `peer_responses[].response` enum — no new
  vocabulary needed).
- **Correct refutation rate**: fraction of `disputed-with-counter-fact`
  responses that turn out, against ground truth, to correctly refute a false
  claim.
- **Incorrect concession rate**: fraction of `conceded` responses that turn
  out, against ground truth, to have conceded a claim that was actually
  correct — i.e., caving to a peer's claim without it being true. This is
  the metric most directly diagnostic of "did knowing the peer's identity
  change whether this reviewer pushed back."
- **Final precision**: run each condition's full findings through
  `bench/score.mjs` against the same ground-truth defect set.
- **Unresolved rate**: fraction of findings that end in an `unresolved-*`
  `final_state`, per condition.

All of these require a ground-truth-labeled target — the same dataset
requirement as the benchmark harness (`docs/design/benchmark-harness.md`),
and this experiment should reuse whatever seeded-defect corpus that harness
uses, not build a separate one.

## Why this could become a real differentiator, and why it isn't one yet

If Condition B shows a meaningfully lower incorrect-concession rate and
higher correct-refutation rate than Condition A on the same source and same
initial findings, that is direct evidence the blinding mechanism changes
reviewer behavior, not just reviewer *knowledge*. That would be a
defensible, data-backed claim distinct from "we blind identities because it
seems like it should help." Until this experiment runs, README's current
"provider, model, and seat identity are mechanically removed... though
writing style or phrasing can still hint at who's who" framing is the
correct level of claim: a mechanical guarantee against explicit leakage,
with no performance claim attached.

## Implementation note

Building Condition A requires a protocol-variant flag that skips the blind
exchange step — this touches the same dispatch/synthesis code path as the
frozen protocol, but only as an experiment harness, never as a shipped
review mode. It should live under `bench/` (or a sibling
experiment-harness location), not under `plugins/reviews/`, so it is
structurally impossible to invoke it accidentally from a real `/pair-review`
or `/cross-review` run. This satisfies Phase A's protocol-freeze intent: the
frozen protocol itself is never modified; a separate, clearly-labeled
research harness reuses its pieces.

## What this document is not

This is not a benchmark result and not a claim that blinding improves review
quality. No experiment has been run. Building the Condition-A harness and
running this experiment both require explicit approval before implementation,
consistent with this repository's standing verify-before-design rule.
