# Benchmark harness — design

`bench/score.mjs` is built and tested (39 tests, `node --test
bench/tests/score.test.mjs`). The 4-arm run orchestration
(`bench/run-comparison.mjs`) is also built and tested against a fake
adapter. What's missing is the actual data: no real benchmark run has
happened yet. That needs labeled cases, live model access, and a real
budget.

## What the scorer does

`bench/score.mjs` takes a real `findings.json` (the schema is in
`review-protocol.md`) and a labeled ground-truth defect file, and
computes precision, recall, F1, severity-weighted recall, how many
independently-corroborated findings were actually real, and
cost-per-confirmed-defect when a cost figure is supplied. It also
tracks canonicalization false-merges, but only when given an explicit
origin-to-defect mapping — that can't be inferred automatically, so it
reports `null` rather than guessing zero.

It also has a `calibrationTable()` function: given scored runs with
known ground truth, it buckets findings by basis, evidence strength,
verifier confirmation, and independent discovery, then computes the
real hit rate per bucket. That's the path to eventually saying something
like "findings with EXECUTED basis and REPRODUCED evidence were right
94% of the time" — earned from outcomes, not from a model's own stated
confidence.

Matching a ground-truth defect to a finding defaults to a substring-hint
heuristic, which is weak and documented as such. A real run should use
an explicit `--mapping` file instead, produced by a human or an
independent adjudication pass.

## The four arms

`bench/run-comparison.mjs` runs:

1. Claude alone
2. Codex alone
3. Independent union (1+2's findings merged, no cross-examination — the
   baseline SkillArray needs to beat to justify its own cost)
4. Full SkillArray

Further ablations are still just design ideas, not built: running the
same model twice instead of two different ones, disabling identity
blinding (`docs/design/blinding-ablation.md`), and adding the
Falsification pass (`docs/design/ux-modes.md`'s DEEP tier).

## The budget problem

SkillArray needs to win on more than raw spend. Arm 4 uses more tokens
than arms 1-3 by construction, so a fair comparison holds total token
spend constant and asks which arm gets the best precision/recall at that
budget — comparing a single strong model run at 3x effort against
SkillArray at its normal effort, not against SkillArray at 3x too.
Dollar cost matters alongside token count too, since pricing differs
across providers. Any comparative claim needs to state the budget it was
measured at, or it isn't really a claim.

That comparison isn't fully possible yet: `codex-dispatch.mjs` and
`opencode-dispatch.mjs` now report token usage from each provider's own
event stream, but `estimated_cost_usd` is still always null (no price
table), `pair-review`'s Claude subagents report no usage at all, and
`bench/adapters/live.mjs`'s `skillarray`/`union` arms only capture the
outer process's usage, not what a spawned Codex reviewer used inside the
run.

## Getting labeled cases

A few ways to build the case set, roughly cheapest to hardest:

- Seeded mutation defects — fully controlled ground truth, cheap to
  build. The user's own 18-bug VSI collector checklist is a natural seed.
- Real historical PR defects — closer to organic bugs, but needs a
  repository with clean bug-fix history and licensing that allows reuse.
- Security defects — rare enough in the wild that they probably need
  their own seeded corpus (known CWE patterns injected into a fixture).
- Architecture/document contradictions — a planted contradiction in a
  design doc, to exercise the Architecture/Document review profiles.
- Licensed public benchmarks, only where reuse is explicitly permitted.
  None vetted yet.

## Keeping it reproducible

Every arm's raw artifacts — task packet, Phase 1/2 output, manifest,
findings, and whatever mapping file scored it — need to be kept under a
run directory keyed by arm, dataset, and timestamp. That way a reported
number can be recomputed from `bench/score.mjs` alone, without re-running
expensive, non-deterministic model calls. This is the plan; no run has
happened yet to actually store anything under it.

## What this isn't

This document is design, not a result. No arm has actually run yet, so
nothing here supports a claim about SkillArray's review quality relative
to a single model or an undebated union.
