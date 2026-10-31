# Task packet: review of the restructure plan for the two review skills (minimum code, best first-run result)
Review round: 1

Profile: Architecture + Document. Target: @@TARGET@@, branch main, HEAD ea0b739, working tree DIRTY (every change since ea0b739 is uncommitted; the code as it is now is what the plan restructures).
Read-only review: do not edit, create or delete any file in the target; do not commit.

The thing under review is a plan, not the code: `C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md`. It proposes how to restructure the two review skills so they (1) find as many real defects as possible in the first run, using the strengths of two independent reviewers, (2) with the least code, (3) without losing any feature that stays or any fix made so far, and (4) without adding new defects. Read the plan, then check every claim it makes against the code and the data below. Each of your claims is either a defect in the plan (a step that would lose a fix or a feature, a wrong reading of the data, a gate that does not catch what it says, a missing step) or a better, simpler alternative the plan missed. Your Suggested fix must be the replacement plan text: the step, the module and the gate, written so it can be pasted into the plan. Up to 12 claims per seat; rank by how much they change the outcome.

## Scope
- In scope: the plan, judged against both skills as they are now: `plugins/pair-review/skills/pair-review/` and `plugins/cross-review/skills/cross-review/` (SKILL.md, references/, scripts/, scripts/tests/). The shared scripts are byte-identical in both skills (`scripts/validate-repository.mjs` enforces it); `opencode-dispatch.mjs` and `dispatch-integration.test.mjs` exist only in cross-review.
- Also in scope: the data the plan relies on (Evidence below), and whether the plan's numbers follow from it.
- Out of scope: new defects in the current code (unless one shows a plan step is wrong), style, naming, CHANGELOG wording, `bench/`, `docs/design/`, the target's `.claude/` folder.
- The skills must stay generic: they review any code base, design or document.

## Acceptance criteria (tag each one so claims can cite it)
- [AC-1] Feature parity: every feature the skills document today (SKILL.md, references/, each script's --help) is kept by the plan, except the ones under Known deviations. On your Checks performed line, list the features you checked.
- [AC-2] Every past fix stays fixed: each defect class in `findings-rounds-1-5.md` and in the closing list's known gaps has a named module, test or gate in the plan that keeps it fixed after the restructure.
- [AC-3] Minimum code: each module the plan keeps or adds is needed; no new flag, mode, file or dependency unless a stated goal needs it; the size estimate follows from the code.
- [AC-4] First-run result: each review-method change (the plan's decisions A, B, C and the estimate line) is tied to data, and raises the number of real defects found or lowers false ones without breaking the two seats' independence or the blinding.
- [AC-5] Safe order: every step can ship alone, has a gate that would catch a lost fix or a lost feature, and no step needs a big unreviewed change.
- [AC-6] Portability: every step works on Windows, macOS and Linux, and on both supported hosts (a native-agent host and a CLI-dispatch host), including detached workers.
- [AC-7] Weight: anything the plan keeps that could be removed with no loss of a stated goal, or a bigger simplification than the plan names.

## Known deviations from the criteria
Decided by the maintainer; do not spend a claim on these unless the plan gets one of them wrong:
- Drop the manual route (running each phase script by hand); `review-run` is the one entry.
- Drop the OpenCode runtime (its dispatcher, tests and docs).
- Strict seat output format: a seat file in any other form is refused and the seat is asked once to rewrite it (this reverses an earlier "a Blocked: line in any form counts").
- Edit the existing code step by step; no rewrite from scratch.
- The version stays 1.1.0 during the work; nothing is committed until the maintainer says so.
- Not proposed on purpose: fixed roles per model ("one model does docs, the other does code"); a claim that roles help must bring data.

## Start here
1. `C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md`: the plan (sections 1-7).
2. `C:/Users/dev/cross-review-runs/closing-plan/evidence/findings-rounds-1-5.md`: all 47 findings of the last five rounds, with triggers and which seat found each.
3. The code the plan restructures, largest first: `scripts/blind-relabel.mjs` (3,514 lines), `scripts/preflight.mjs` (2,170), `scripts/review-run.mjs` (1,596), `scripts/codex-dispatch.mjs` (1,430), `scripts/build-report.mjs` (1,408), `scripts/build-manifest.mjs` (1,053), `scripts/claude-dispatch.mjs` (600); then `spawn-utils.mjs`, `detach-utils.mjs`, `path-utils.mjs`, `build-brief.mjs`, `exchange.mjs`, `native-agent.mjs`, `run-descriptor.mjs`.
4. `references/review-protocol.md`, `references/phase-2-cross-examination.md` and `references/phase-3-scorecard.md` for decisions A and B.
This is a start, not a limit.

## Evidence both seats may cite
- Pre-flight `C:/Users/dev/cross-review-runs/closing-plan/evidence/preflight.json` (Tier 1, no test run): HEAD ea0b739, snapshotHash a092d57bfa03a88438e5a85478da029f84c28b2212133a6c4b82cdd77df62134, 113 changed files. Its warning about files with review output names the skills' own test fixtures: expected.
- `C:/Users/dev/cross-review-runs/closing-plan/evidence/findings-rounds-1-5.md`: 47 findings; raised by both seats 11, first seat only 19, second seat only 17.
- `C:/Users/dev/cross-review-runs/closing-plan/evidence/closing-list.md`: the state after round 5 and its known gaps.
- Real run folders for the replay-test idea (read-only): `C:/Users/dev/cross-review-runs/closing-r1` to `closing-r5`, each with `run/` (seat files, results, phase3) and `work/`.
- Local checks the author ran before this review (each can be rerun; treat the counts as leads, not conclusions):
  - Strict format (H4): `C:/Users/dev/cross-review-runs/closing-plan/evidence/strict-format-count.mjs` over 173 older seat files (list: `C:/Users/dev/cross-review-runs/closing-plan/evidence/seatfiles2.txt`) and the 10 seat files of closing rounds 1-5. Older files: 157 of 173 have no `Blocked:` line at all (written before the rule existed). Closing rounds: the counter's strict reading fits 4 of 10, but by hand the other 6 are quoted test inputs inside Checks performed (those rounds reviewed the Blocked reader itself) plus one emphasized heading `## **Checks performed**`; every one of the 10 ends its section with one exact `Blocked: <text>` line. A rule "read only the last exact `Blocked:` line of the section" would fit 9 of 10.
  - Replay (H1): in `C:/Users/dev/cross-review-runs/closing-r5/run/manifest.json` the values that change between two builds of the same run are `run_id` (random), the orchestrator's usage (read from the live session transcript) and temp worktree paths; seat durations come from the stored result files.
  - Per-script command lines (H8): the docs name blind-relabel.mjs 45 times, build-brief.mjs 27, exchange.mjs 16, the dispatchers 11 to 13; `--env-passthrough` has no review-run path today (hand dispatch only); `--exec-in` and `--repo` belong to preflight, which stays a user-facing step.
  - Job object (H10): the detached dispatch worker starts through WMI on Windows (outside the host's job), with a fallback to a plain detached process when WMI is refused (inside some sandboxes), where it stays inside the host's job.
A seat that can write runs single test files itself (`node --test scripts/tests/<name>.test.mjs`, with TMPDIR/TEMP pointed at its own scratch folder); a seat that cannot cites STATIC_TRACE.

## Author-reported evidence (not reproducible; do not cite as EXECUTED)
- A look-back over 45 earlier runs (677 findings): 0 of 466 claims both seats agreed on were refuted by the auditor; 21 of 58 disputed claims were. Most of those runs reviewed these skills or a few field targets.
- Full suites before the plan: 1092 and 1193 tests pass, 0 fail; mutation scripts for each round's fixes all red.

## Hypotheses to test
In `## Checks performed`, end each hypothesis line with CONFIRMED (the defect in the plan is real), REFUTED or PARTLY CONFIRMED.
- [H1] Step 0's replay tests cannot compare the manifest and report byte for byte (timestamps, durations, token counts read from transcripts, absolute paths), so the safety net is weaker than the plan says.
- [H2] Running the steps in-process instead of as separate node programs loses something the separate processes give today (crash isolation, a per-step exit code, a clean module state, the fingerprint and drift checks between steps).
- [H3] Putting the seats' working folders beside the run folder does not keep the run folder's location from a seat: the brief, the native prompt file, the evidence paths or a tool error can still name it.
- [H4] The strict seat format would refuse a large share of the real seat files in `closing-r1` to `closing-r5` (and earlier runs), so ask-again rounds would become common and costly.
- [H5] Decision A (a related-defect sweep in Phase 2) breaks the independence of the two passes, lets the blinding leak, or loads the auditor beyond what the gain justifies.
- [H6] Decision B (skip the audit of agreed MEDIUM and LOW claims) rests on data that does not support it: the 466 agreed claims come mostly from self-reviews of one target family.
- [H7] The "estimated missed defects" line from the overlap between the seats is misleading enough to mislead a stop decision (the seats share one packet, and merging two claims into one finding is a judgment).
- [H8] Removing the per-script command lines loses a capability that stays documented or that a hosted run needs (for example passing environment variables to a seat, a second repository, test commands per repository, a detached worker on Windows).
- [H9] A larger simplification than the plan names exists in blind-relabel.mjs, preflight.mjs or build-report.mjs.
- [H10] A Windows job object around the seat CLIs breaks the detached worker started through WMI, a native-agent seat, or a CLI seat's own sandbox.

## Checks
- Run tests and repros only in a disposable copy outside the target, or by importing the shipped module from the target without writing into it.
- For a data claim, show the count you made and from which file.
- For each hypothesis, say what you checked; for AC-1, list the features you verified.

## Severity note
HIGH: a plan step that would lose a fix or a kept feature, break the blinding or the independence of the two passes, or make a review report clean when it is not. MEDIUM: code the plan keeps or adds without need, a large simplification missed, a gate that would not catch what it is for, or a number in the plan the data does not support. LOW: wording, ordering, small gaps. Every HIGH states its Trigger: which step and which input or state. The reader is the maintainer deciding the final plan.

## Output
Findings in the required schema in your own findings file. A `## Checks performed` section: one line per AC and per H tag, ending in MET / PARTIAL / NOT MET or CONFIRMED / REFUTED / PARTLY CONFIRMED, plus a Coverage line (read fully / read partly / not read), and last the `Blocked:` line your brief describes.
Web verification is off (repo-only review). Close with one line: `web: 0 queries, 0 page fetches`.
