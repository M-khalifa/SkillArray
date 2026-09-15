# Benchmark harness — design (scorer built, orchestration not)

Status: split. `bench/score.mjs` is real, tested code (38 passing tests,
`node --test bench/tests/score.test.mjs`), built this session. The 7-arm run
orchestration described below is design only — it requires live model access,
real defect corpora, and budget the current session cannot spend, and is not
built.

## What exists today

`bench/score.mjs` takes a real `findings.json` (this repo's actual review
output — the schema documented in `review-protocol.md`'s findings.json
section) and a labeled ground-truth defect file, and computes:

- precision, recall, F1
- severity-weighted recall (a missed CRITICAL defect costs more than a
  missed LOW one)
- independently-corroborated finding precision (of findings marked
  `independently_discovered: true`, how many were real)
- true vs. false `dropped-speculative` counts (correctly-dropped noise vs. a
  real defect wrongly dropped)
- unresolved HIGH/CRITICAL finding count and IDs
- canonicalization false-merge rate (requires an explicit origin-to-defect
  mapping; reported as `null`, not a guessed 0, when that mapping isn't
  supplied — see the code's own comment for why this can't be inferred
  automatically)
- cost-per-confirmed-defect, when a `--cost` figure is supplied

It also exposes `calibrationTable()` (Phase N): given one or more scored runs
with known ground truth, it buckets findings by
`(basis, evidence_strength, verifier_confirmed, independently_discovered)`
and computes empirical `P(valid)` per bucket. This is the mechanism for
eventually being able to say "findings with EXECUTED basis and REPRODUCED
evidence strength were confirmed 94% of the time" — a claim earned from
real outcomes, never from a model's own stated confidence.

Matching a ground-truth defect to a finding defaults to a substring-hint
heuristic (weak; documented as such in the CLI's own `--help` text) and can
be overridden per-defect with an explicit `--mapping` file. A real benchmark
run should use explicit mapping, produced by a human or a separate
independent-adjudication pass, not rely on the substring heuristic alone.

## What does not exist: the 7-arm comparison

The comparison arms below require running actual reviews against actual
targets with actual model access — none of this can be fabricated or
simulated locally, and none of it has been run:

1. Strong Claude alone (single independent pass, no peer exchange)
2. Strong Codex alone (same)
3. The same strong model sampled twice independently, no exchange
4. Claude + Codex independent union, no debate (arms 1+2's findings merged
   with no cross-examination — the naive "just run two models" baseline
   SkillArray should beat to justify its own cost)
5. SkillArray's protocol with identity blinding disabled (see
   `docs/design/blinding-ablation.md` — a narrower, more controlled version
   of this same idea)
6. Full SkillArray, blinded (STANDARD tier, current 1.3.0 behavior)
7. Full SkillArray, blinded, plus the Falsification pass (DEEP tier, see
   `docs/design/ux-modes.md`)

## Equal-budget comparison — the actual hard requirement

The production-readiness directive that motivated this document was explicit
that SkillArray must not claim superiority "simply because it spends more
inference." This is the central design constraint, not a nice-to-have:

- **Equal token budget**: arms 4-7 spend more raw tokens than arms 1-3 by
  construction (more reviewer passes, cross-examination, adjudication). A
  fair comparison holds total token spend constant across arms and asks
  which arm gets the best precision/recall/cost-per-confirmed-defect at that
  budget — e.g., arm 1 (single strong model) run at 3x the effort level
  should be compared against arm 6 at its normal effort, not against arm 6
  at 3x effort too.
- **Equal dollar budget**: token cost varies by provider and model tier;
  reporting dollar cost alongside token count matters when comparing across
  providers with different per-token pricing. This is currently unfillable
  automatically — see the observability gap below.
- **Reporting requirement**: any comparative claim ("SkillArray finds more
  real defects") must be reported alongside the budget it was measured at.
  A claim with no budget context is not evidence, per this pass's own
  standing instruction not to make unverifiable claims.

## Blocking dependency: token/cost capture

Per the earlier verification pass in this session: neither `codex-dispatch.mjs`
nor `opencode-dispatch.mjs` currently parses token/usage data from the CLI's
own output, and pair-review's Claude subagents expose no usage figures back
to the orchestrator at all. Equal-token-budget comparison is not executable
until this is built (tracked under the observability/manifest work, Phase I
of the production-readiness pass) or until costs are tracked manually
per-run from each provider's own billing console.

## Dataset requirements

- **Seeded mutation defects**: cheapest to build, fully controlled ground
  truth. The user's own 18-bug VSI collector checklist (referenced in
  project memory) is a natural seed corpus for a code-review benchmark,
  since it is a real, already-enumerated defect list with known severity.
- **Real historical PR defects**: harder to source cleanly (needs a
  repository with a documented bug-fix history and licensing that permits
  use as benchmark data) but avoids the risk that seeded mutations are
  easier or harder to find than organic bugs.
- **Security defects**: a distinct category from general code-review
  defects; likely needs its own seeded corpus (e.g. known CWE patterns
  injected into a fixture) since organic security defects are rarer and
  harder to source with licensing clarity.
- **Architecture reviews / technical document contradictions**: needs target
  material for the Architecture/Document profiles specifically — a design
  doc or spec with a known, planted contradiction, since `review-profiles.md`
  already treats these as a distinct target type with a distinct evidence
  model (SOURCE_CITATION/STATIC_TRACE rather than EXECUTED).
- **Licensed public code-review benchmarks**: only where licensing
  explicitly permits reuse; not sourced or vetted in this session.

## Reproducibility

Every arm's raw run artifacts (task packet, Phase 1/2 outputs, `manifest.json`,
`findings.json`, and the ground-truth/mapping files used to score it) must be
retained under a run directory keyed by arm + dataset + timestamp, so a
reported number can be recomputed from `bench/score.mjs` alone without
re-running the (expensive, non-deterministic) model calls. This is a
principle for the harness, not yet built as a storage convention — no run
has happened to store.

## Test plan for the harness itself, once built

- `bench/score.mjs` is already covered (38 tests, pure-function scoring
  logic, no model calls needed to test it) and wired into
  `scripts/release-check.mjs`'s canonical release gate.
- The orchestration layer (whichever script eventually drives the 7 arms)
  needs: a mocked-dispatch test path so the orchestration logic itself
  (budget accounting, arm sequencing, artifact retention) is tested without
  spending real API budget on every CI run, mirroring how
  `codex-dispatch.test.mjs` already tests dispatch logic against a fake
  `spawnFn` rather than a real subprocess.
- A separate, explicitly manual/opt-in "real run" path, analogous to Phase
  O's live-provider smoke suite, for the actual comparative numbers.

## What this document is not

This is not a benchmark result. No arm has been run. No claim in this
repository about SkillArray's review quality relative to a single model or
an undebated union may cite this document as evidence — it is infrastructure
design, not a finding. The production-readiness pass's own instruction is
explicit: the empirical-evidence and production-readiness scores must not
reach a high score merely because this harness exists; they require actual
results.
