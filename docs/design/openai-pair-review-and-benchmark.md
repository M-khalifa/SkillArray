# OpenAI pair-review and the value benchmark — design draft 1

Status: design only, nothing built. Version stays 1.1.0. Two parts:
A. pair-review with two OpenAI models. B. A benchmark that measures what each review mode adds
over a single model.

## A. pair-review on two OpenAI models

### A1. Rule

pair-review = two distinct models from one vendor. Today the vendor is always Anthropic
(`review-config.mjs` layout rule: both seats `anthropic/claude`). New rule: both seats share one
provider, and that provider is `anthropic` (runtime `claude`) or `openai` (runtime `codex`).
Distinct model ids stay mandatory. cross-review is unchanged (two different providers).

### A2. Options

| Option | What it is | Verdict |
|---|---|---|
| 1. Vendor choice inside pair-review | Seats file / saved config carries the vendor; `anthropic` stays default | Chosen |
| 2. Third skill `openai-pair-review` | Copy of pair-review with Codex seats | Rejected: another 75-file parity copy, third install, three docs to keep equal |
| 3. Reuse cross-review with two OpenAI seats | Relax "different providers" | Rejected: cross-review's value claim is vendor diversity; its seat A must be on the host harness |

### A3. What has to change (checked against the code, not assumed)

| Area | Fact found | Change |
|---|---|---|
| `review-config.mjs` pair layout | Hard-codes both seats `anthropic/claude` (lines 71-75) | Allow `openai/codex` pair; reject mixed vendors; saved config records the vendor |
| `codex-dispatch.mjs` | Exists only in cross-review | Copy to pair-review, add to the parity list and to `validate-package`; its tests too |
| Distinct-model check | `review-run` compares `modelResolved` from `result.json`; only `claude-dispatch` writes it, so two Codex seats would stop with "has no init model id". Probe done 2026-10-06 (one `codex exec --json`, `gpt-5.6-terra`): the event stream has no model, but the session rollout file holds `"model":"gpt-5.6-terra"` (5 lines) | `codex-dispatch` writes `modelResolved` from the rollout (`rollout-utils.mjs` already reads it for usage); the check stays on resolved ids. If the rollout has no model line, fall back to requested ids and label it `requested ids differ`. Verified for one model only: an alias that the CLI maps to another id is untested |
| Auditor and verifiers | `dispatchAuditor` refuses any runtime but `claude` (line 631) and hard-codes `claude-dispatch.mjs` for dispatch and wait (lines 642, 649); the brief is built with `--channel file`. `checkVerifiers` not yet read | Pick the dispatcher with `dispatcherFor(auditor)`, use channel `final-message` for a Codex auditor and publish its answer as `findings.audit.json` (same mechanism as seat output), re-read `checkVerifiers` for the same hard-coding. This is a real sequencer change, not a doc change; cross-review shares the file, so its Claude auditor path must keep passing its tests |
| Phase 2 | Codex seats resume by thread id (already used by cross-review seat B) | None expected; mode `none` and `collaborate` must work with two Codex seats |
| Blinding scan | VENDOR_TOKENS already hard-stop `codex`, `openai`, `gpt-` | None; add a test with two `gpt-` seats |
| Manifest | provider fields come from `run.json` | Record vendor, both requested ids, and the distinct-check basis |
| Docs | Host files say pair-review = two Claude models | Host files, SKILL.md, README, configuration.md, CHANGELOG (1.1.0 entry) |

### A4. Host support

| Host | Seats | Status |
|---|---|---|
| Claude Code | two Codex CLI seats | Target. cross-review already runs a Codex seat from Claude Code, so the transport is proven |
| Codex (Windows) | two Codex CLI seats from inside Codex | Unsupported until a live trial passes. The Codex-host trials in 1.1.0 failed on sandbox rules for a nested CLI; a nested `codex exec` is untried and may hit the same wall |
| Claude Code | two Claude seats | Unchanged |

Under Codex, Claude seats stay unsupported (1.1.0 finding), so a Codex host user gets OpenAI pair
only if the nested trial passes; otherwise the matrix cell is named unsupported.

### A5. Honest limit

Two OpenAI models share a training lineage. They should disagree less than Claude + OpenAI. The
benchmark (part B) is how that gets measured; the docs must not claim more diversity than the
numbers show.

### A6. Tests and live proof

1. Unit: config layout accepts `openai/codex` pair, rejects mixed vendor and equal ids; distinct
   check on requested ids; auditor final-message publish.
2. Fake-dispatcher end-to-end run (same pattern as `review-run.test.mjs`) for the OpenAI pair, both
   modes.
3. One live run on a small target, two Codex seats from Claude Code, `gpt-5.6-sol` + `gpt-5.6-terra`
   (ids from `codex debug models`), seen through to the scorecard and manifest.
4. Both skill suites and `release-check` before any commit; no commit by me.

## B. Benchmark: value of each review mode

### B1. Question

Does each mode find more real defects, at what cost, than the cheaper alternative? The comparisons
the user asked for: one model vs two models, for pair-review and for cross-review.

### B2. Arms

| Id | Arm | Answers |
|---|---|---|
| S-C | Claude alone | baseline |
| S-O | OpenAI alone | baseline |
| S-C+ | Claude alone at about the pair's token budget (more effort, or best of k passes merged) | is two-model value just extra compute |
| U-C | Claude pair, independent union, no exchange | value of the exchange |
| P-C | pair-review, Claude (opus + sonnet) | pair value, Anthropic |
| P-O | pair-review, OpenAI (two models) | pair value, OpenAI |
| X | cross-review (Claude + OpenAI) | vendor diversity value |
| U-X | cross seats, independent union, no exchange | exchange value inside cross |
| D-C | same Claude model twice (pair, same model) | two samples vs two different models; needs a bench-only override of the distinct check |

The comparisons: P-C vs S-C and S-C+ (pair adds value?), P-O vs S-O, X vs S-C/S-O/U-X, P-O vs X
(same vendor vs different vendor), P-C vs D-C (model diversity vs repetition).

### B3. Cases

Labeled ground truth is the blocker (existing design says so). Build in this order:
1. Seeded defects in 6 to 10 small real repos or fixtures, 3 to 5 defects per case across
   severities, plus clean cases with no defect to count false positives.
2. Document profile: planted contradictions in design docs.
3. Held-out set, never used while tuning prompts.
A human or an independent adjudication writes the `--mapping` file; the substring heuristic in
`score.mjs` is not accepted for a reported number.

### B4. Metrics and statistics

Per arm and case: precision, recall, F1, severity-weighted recall, false-positive count on clean
cases, tokens (input, output, cached), wall clock, cost per confirmed defect. Model calls vary, so
repeat each arm-case n >= 3 and report a paired comparison across cases with a bootstrap interval,
not a single run. State the budget each number was measured at (existing rule).

### B5. What must exist first

| Gap | Fact | Action |
|---|---|---|
| Usage per arm | `adapters/live.mjs` captures only the outer process; real seat usage is in `build-manifest` | Adapter reads the manifest usage totals (per-field null if a call lacks it) |
| Price table | `estimated_cost_usd` always null | Add a dated price table file, cost shown with its date; tokens stay the primary number |
| Single-model arms | none built for S-C+, D-C | Add adapters. D-C: the bench adapter drives `exchange.mjs` and `blind-relabel.mjs` directly and skips the sequencer's distinct gate; no bypass flag is added to `review-run.mjs` (it could leak into real runs). If that is too costly, D-C leaves the pilot |
| Pair/cross arms | need the shipped runs | Drive `review-run.mjs`, never reconstruct its logic |
| Scoring | blind to arm | Scorer sees only findings and mapping, never the arm label |

### B6. Cost and staging

One measured cross-review run on a small target used about 13M input tokens in total across
orchestrator and seats (single observation, not an average). Full grid of 9 arms x 10 cases x 3
repeats is about 270 runs, so it needs a budget decision. Proposed stages: pilot (3 cases, 1 repeat,
all arms) to find broken arms and cost per arm; then pick case count from the pilot variance; then
the full run. Hypotheses and the pass bar are written down before the pilot.

## Decisions taken (2026-10-06)

1. Vendor choice inside pair-review (option 1). The user picks the vendor and both models at setup.
2. Codex-host OpenAI pair: try one more nested live trial (result below).
3. Benchmark (part B): postponed by the user, to be added later. No benchmark work is done.
4. Arms question: moot until the benchmark is taken up.
5. Version stays 1.1.0; the feature is folded into the 1.1.0 CHANGELOG entry.

## Implementation status

Built and tested (fake-dispatcher tests in both skills; live run from Claude Code):

- `review-config.mjs`: pair layout is one vendor, anthropic/claude or openai/codex, distinct models.
- `codex-dispatch.mjs` ships in pair-review (parity file) and writes `modelResolved` from the rollout.
- `review-run.mjs`: a Codex auditor is dispatched through `codex-dispatch` (final message saved as
  `findings.audit.json`); `run-descriptor.mjs` `channelFor` returns final-message for a Codex auditor.
- `preflight.mjs --host`: dispatchers are checked per runtime in use; the Claude CLI check runs only
  when an actor uses Claude.
- Live proof, 2026-10-06, Claude Code host, two Codex seats (`gpt-5.6-luna`, `gpt-5.6-terra`) and a
  Codex auditor on a seeded off-by-one: both seats found it, both models recorded as resolved from the
  rollout, scorecard 1 settled-agree MEDIUM, manifest recorded provider openai for both seats. The first
  auditor answer had a stray `]}` at the end (model JSON error); `translate` refused it, the sequencer kept
  it as an attempt file and a second dispatch passed. Run folder: portable-1.1.0/live/P1.
- Nested Codex-host trial, 2026-10-06 (Codex orchestrator in workspace-write asked to run `codex-dispatch.mjs`):
  the foreground dispatch failed at once because the sandbox shell did not find the `codex` command;
  a detached dispatch started a worker but the trial was killed for low memory before it finished.
  Result: Codex-host OpenAI pair stays unsupported in 1.1.0 and is named so in the host file. Run
  folder: portable-1.1.0/live/P2. A rerun with an allow rule for the node and codex commands was not done.
- Second Codex-host trial (a Codex session, two Codex seats, `--allow-unsupported-host`): both seats failed at start with
  "failed to initialize in-process app-server client: Access is denied (os error 5)" (the sandbox could not write
  ~/.codex/tmp/arg0). Confirms the Codex host stays unsupported; the failure was recorded cleanly in each result.json.

## Decisions for the user

All five were answered (see "Decisions taken" above). Open: the benchmark budget and who labels the cases, when the benchmark is taken up.

## Where this changes `portable-cross-review.md` (Rev 2)

Section 5 (matrix) and section 10 (layout rules) say pair-review is two Anthropic seats and never
two OpenAI models. If the decisions above are accepted, those two sections are edited in place and
section 18 loses its deferral. Until then each carries a "superseded by openai-pair-review-and-
benchmark.md section A, pending approval" line.
