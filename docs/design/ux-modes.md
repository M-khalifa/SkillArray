# Product UX modes — design (not yet implemented)

Status: design only. No code in this document has been built. Do not build
it without a separate, explicit approval — this is Phase J of the
production-readiness pass, kept design-only per that pass's own scope split.

## Verified current state

- Effort is not a fixed named tier today. `review-config.mjs` validates
  `effort` against `EFFORT = /^[a-z][a-z0-9_-]*$/` — any lowercase token, not
  an enum of `low`/`default`/`high`. A model's own accepted effort values
  (e.g. Codex's) are what actually constrain it; SkillArray does not define
  the vocabulary.
- The Falsification pass's canonical request phrase is "deep verify disputed
  high-severity findings" (`review-protocol.md` line 266, identical in both
  packages), and its selection rule is mechanical: every claim with
  `Severity` HIGH or CRITICAL AND a rebuttal `Action` of `DISPUTE` (from the
  real, pre-relabel Phase 2 files — never the auditor's `Peer response`
  field, which does not exist yet at that point). See
  `phase-3-scorecard.md`'s Falsification pass section.
- Per-process cancellation exists today: `installSignalForwarding` +
  `posixKillTree` in `codex-dispatch.mjs` (mirrored in
  `opencode-dispatch.mjs`) forward SIGINT/SIGTERM to a single dispatched
  child and kill its process tree (SIGTERM then SIGKILL). This is scoped to
  one dispatcher process, not a whole review — there is no run-level
  "cancel this entire review" command today.
- No target/base/scope selector exists. Grepped both SKILL.md files: the
  only occurrence of "scope" is free text in the task packet ("Give both
  seats the same task packet: scope, current source snapshot..." —
  `pair-review/SKILL.md` line 71). There is no `--base`, `--diff`, or
  structured path-scoping mechanism.
- Seat resume is real and already documented, not a gap: `pair-review/SKILL.md`
  step 5 states "A reviewer may return after its initial pass; resume it for
  the exchange. This avoids agents waiting indefinitely for a peer that has
  not been released by the orchestrator." This is resume-per-seat across
  Phase 1 → Phase 2, not resume of an entire interrupted review.
- No run-level status command exists while a review is mid-flight.

## Proposed tiers

**FAST** — both seats run their independent Phase 1 pass; no peer exchange,
no Phase 3 auditor, no Falsification pass. Cheapest and fastest, but this is
not "SkillArray with steps skipped" — it is two independent single-model
opinions with no evidence cross-check, no identity blinding, and no
canonical-finding deduplication. It should be labeled and reported as such,
not as a lighter version of the full protocol's guarantees.

**STANDARD** — the current, full three-phase protocol as shipped in 1.3.0:
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
| `timeout` | Partially exists (`--timeout` on both dispatchers) but defaults to unbounded. See the separate security/timeout design work (Phase F) — not redesigned here. |
| `max_duration` | New. A run-level wall-clock budget distinct from any single dispatcher's `--timeout`. |
| `target`/`base` | New; confirmed absent today (see above). A DEEP or FAST mode that assumes a diff-scoped target without this existing would be scoping by convention, not by mechanism — flagged as a real gap, not something a mode can silently paper over. |
| `paths`/`scope` | New structured version of what is today free text in the task packet. |
| `profile` | Already exists — `review-profiles.md`'s Code/Architecture/Document lenses, selected per target. |
| `execution_policy` | New; see the separate Phase E security design — referenced here, not redesigned. |
| `provider selection` | Already exists — `cross-review`'s provider/runtime/model/effort configuration. |

## Background / status / cancel / resume

- **Cancel**: exists at the single-dispatcher-process level today
  (`installSignalForwarding`/`posixKillTree`). A run-level cancel ("stop
  this whole review, all seats") is a genuine gap — it would need to track
  every spawned process/subagent for a run and forward the signal to all of
  them, not just compose the existing per-process mechanism by accident.
- **Resume**: partially exists today, not absent — a reviewer can already be
  resumed after its Phase 1 pass for the Phase 2 exchange
  (`pair-review/SKILL.md` step 5). What's missing is resuming a review that
  was fully interrupted (harness restarted, orchestrator's own context
  lost) from a saved run directory rather than from live subagent state.
- **Background**: the harness already runs subagents non-blockingly; a
  multi-minute review does not require the orchestrator's own turn to block
  end-to-end today, in the sense that Phase 1 dispatches happen concurrently
  (`pair-review/SKILL.md` step 4: "Start both isolated reviewers
  concurrently"). What's missing is a way for the *user's own* interactive
  session to detach and check back later without holding the conversation
  open — that is a genuine gap.
- **Status**: no run-level status command exists while a review is
  in-progress. Genuine gap.

## Not in scope for this document

- `execution_policy` semantics (never/ask/allow) — separate Phase E design.
- Cost/token accounting for tier presets — depends on the observability
  work (manifest telemetry) landing first, since there is currently no
  token/cost capture mechanism to price a tier against.

## What this document is not

This is not an approval to implement. FAST mode in particular is a real
semantic change to what "a SkillArray review" means — it skips peer exchange
and adjudication entirely, which are load-bearing guarantees of the current
protocol, not implementation detail. Per the production-readiness pass's
Phase A (the current three-phase protocol is feature-frozen for 1.3.x; no
change to independence-before-influence, identity-blinded exchange, evidence
over consensus, or fresh-context adjudication without written justification
and regression coverage), FAST/DEEP mode semantics need explicit user
confirmation before any implementation, and should ship as clearly-labeled
alternatives to the protocol rather than as "lighter settings" of it.
