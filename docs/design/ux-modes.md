# Product UX modes — design (not yet implemented)

Status: design only. No code in this document has been built. Do not build
it without a separate, explicit approval — this is Phase J of the
production-readiness pass, kept design-only per that pass's own scope split.

## Verified current state

Checked against the code on 2026-11-01 (1.2.0 with its 2026-11-02 update).

- Effort is not a fixed named tier. `review-config.mjs` validates `effort` against
  `EFFORT = /^[a-z][a-z0-9_-]*$/`, any lowercase token; a model's own accepted values constrain it.
- The Falsification pass's request phrase is "deep verify disputed high-severity findings" (SKILL.md, both skills),
  and its selection rule is mechanical: every claim with `Severity` HIGH or CRITICAL AND a rebuttal `Action` of
  `DISPUTE` (`phase-3-scorecard.md`, Falsification pass). There is no cap on how many verifiers it starts
  (no `max_verifiers` in the scripts).
- A lighter mode partly exists: pair-review's mode `none` skips the Phase 2 exchange; the fresh auditor still runs
  (`review-run.mjs` `skipsPhase2`). cross-review has no such mode.
- Cancel exists per CLI process only: `installSignalForwarding` (shared in `cli-run.mjs`, used by
  `claude-dispatch.mjs` and `codex-dispatch.mjs`) forwards SIGINT/SIGTERM and kills the child's process tree. There is
  no command that cancels a whole review.
- Status exists: `review-run status --run-dir <a> [--run-dir <b>]` prints each run's step and each seat's progress and
  runs nothing.
- Resume partly exists: `review-run` keeps its state in the run folder, and a CLI seat that stopped part way (a
  reboot, a crash, a killed worker) is dispatched again by the next `--wait` of its phase, alone. A native seat is
  resumed by its agent id. Not shown: resuming when the orchestrator session itself is lost and a native seat's agent
  is gone.
- Scope: `preflight --base <commit>` lists the work committed since that commit, as evidence for the task packet.
  There is still no structured path or diff scope; the packet's Scope section is free text.
- Cost: the manifest records each seat's token usage, so a tier can be priced from real runs.
- Background: CLI seats run detached and `--wait` exits 3 while a seat runs; the orchestrator reruns it. The user's
  own session still has to stay open to drive the phases.

## Proposed tiers

**FAST** — both seats run their independent Phase 1 pass; no peer exchange,
no Phase 3 auditor, no Falsification pass. Cheapest and fastest, but this is
not "SkillArray with steps skipped" — it is two independent single-model
opinions with no evidence cross-check, no identity blinding, and no
canonical-finding deduplication. It should be labeled and reported as such,
not as a lighter version of the full protocol's guarantees. pair-review's mode `none` is the nearest thing today: it
skips the exchange but keeps the fresh auditor, so its findings are still checked. Decide whether FAST is `none`
itself, or `none` without the auditor, before building anything.

**STANDARD** — the current, full three-phase protocol as shipped in 1.2.0:
independent Phase 1, blind Phase 2 exchange, Phase 3 fresh-context
adjudication and canonical findings. No behavior change from today.

**DEEP** — STANDARD, plus the Falsification pass, using the protocol's
*existing* trigger and selection rule verbatim: "deep verify disputed
high-severity findings" activates it, and the existing HIGH/CRITICAL +
DISPUTE selection rule decides which claims qualify. DEEP does not invent a
new selection mechanism — it is a UX label for turning on a switch that
already exists. The only new behavior DEEP would need is a cap
(`max_verifiers`, see below) if the number of qualifying claims is large,
since the pass today runs one verifier per qualifying claim with no stated
upper bound.

## Explicit controls needed

| Control | Status |
|---|---|
| `max_verifiers` | New. Bounds Falsification pass fan-out under DEEP; today there is no cap on how many verifier subagents a single run can spawn. |
| `timeout` | Exists: `flags.timeoutS` in run.json bounds CLI seats (0, the default, is no limit); a native seat is bounded by `--max-wait` on the orchestrator side. |
| `max_duration` | New. A run-level wall-clock budget distinct from any single dispatcher's `--timeout`. |
| `target`/`base` | Partly exists: `preflight --base` lists committed work for the packet; the review itself is not scoped to a diff. A mode that assumes a diff-scoped target would be scoping by convention, not by mechanism. |
| `paths`/`scope` | New structured version of what is today free text in the task packet. |
| `profile` | Already exists — `review-profiles.md`'s Code/Architecture/Document lenses, selected per target. |
| `execution_policy` | New; see the separate Phase E security design — referenced here, not redesigned. |
| `provider selection` | Already exists — `cross-review`'s provider/runtime/model/effort configuration. |

## Background / status / cancel / resume

What is left after the current state above: a command that cancels a whole review (every seat and agent of a run),
resuming when the orchestrator session itself is lost, and a way for the user's session to detach and check back.

## Not in scope for this document

- `execution_policy` semantics (never/ask/allow) — separate Phase E design.
- Prices for tier presets: the manifest's per-seat token usage is the input; the pricing itself is not designed here.

## What this document is not

This is not an approval to implement. FAST mode in particular is a real
semantic change to what "a SkillArray review" means — it skips peer exchange
and adjudication entirely, which are load-bearing guarantees of the current
protocol, not implementation detail. Per the production-readiness pass's
Phase A (the current three-phase protocol is feature-frozen for 1.2.x; no
change to independence-before-influence, identity-blinded exchange, evidence
over consensus, or fresh-context adjudication without written justification
and regression coverage), FAST/DEEP mode semantics need explicit user
confirmation before any implementation, and should ship as clearly-labeled
alternatives to the protocol rather than as "lighter settings" of it.
