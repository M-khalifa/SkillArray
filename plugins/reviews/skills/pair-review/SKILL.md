---
name: pair-review
description: >-
  Reviews code, designs, or documents with two distinct Claude models.
  Supports collaborative, adversarial, and independent passes, first-run
  model setup, saved preferences, and changing models anytime.
  Use for pair review, two Claude reviewers, or /pair-review.
license: MIT
compatibility: >-
  Requires Node.js 22+ and a harness that can run two isolated Claude
  reviewers with explicit model selection and resume or relay their findings.
  Claude Code is the primary target. Model access depends on the user's account.
metadata:
  version: 1.0.0
---

# Pair Review

Two distinct Claude models independently review the same target, then exchange
findings. The orchestrator coordinates and verifies; it never fills either seat.

## Start here: model setup

Read [references/configuration.md](references/configuration.md) before dispatch.
Run the bundled configuration helper's (`scripts/review-config.mjs`) `show`
command. If no saved configuration
exists, ask the user to choose both models and optional effort levels before
the first review. Do not silently install a default pair.

`/pair-review setup` runs the same setup anytime; `/pair-review config` shows
current choices. A request such as "change pair-review's second model to Sonnet"
also updates setup. These commands configure only; they do not launch a review.

## Invocation

```text
/pair-review setup
/pair-review config
/pair-review reset
/pair-review [collaborate|adversarial|none] [modelA[:effort]] [modelB[:effort]] -- <task>
```

The delimiter separates optional model selectors from task text. Natural-language
requests work too; do not infer a model selection from a model name mentioned
inside the review target. Existing positional invocations remain supported when
unambiguous; otherwise ask which part is the task.

To request the opt-in Falsification pass (see references/review-protocol.md),
include the phrase **"deep verify disputed high-severity findings"** in the
task text — the canonical phrase the orchestrator recognizes as an explicit
request; falsification never runs without it.

The auditor re-checks only claims the other reviewer did not concede (light
audit, the default). To have it re-check every claim, include the phrase
**"double check all claims"** in the task text; pass `--audit-depth full` to
both `build-brief.mjs --mode auditor` and `blind-relabel.mjs translate`.

- Saved mode defaults to `collaborate` at setup. `adversarial` attacks each
  other's findings; `none` skips peer exchange — the fresh auditor still
  compares and canonicalizes the two independent findings sets, without
  rebuttal data.
- Explicit run choices override saved values without saving them. Missing
  selectors use saved choices. A model change clears that seat's saved effort
  to `default`, unless the user also supplies an effort.
- For an ID containing a colon, use an explicit named seat and separate effort
  in natural language rather than interpreting the ID as `model:effort`.
- Both resolved models must be distinct, including when different aliases map
  to the same actual model. Never silently substitute.

## Review phases

1. Resolve configuration and validate availability using
   [references/model-capabilities.md](references/model-capabilities.md).
   Snapshot the selected settings for this run; do not reread preferences
   between review rounds.
2. [Independent passes](references/phase-1-independent-passes.md): both seats
   review the same snapshot without seeing each other's findings.
3. [Cross-examination](references/phase-2-cross-examination.md): each seat
   rebuts the other's blind findings once; skipped in mode `none`.
4. [Scorecard](references/phase-3-scorecard.md): a fresh auditor adjudicates,
   then `translate`, the scorecard or `joint-findings.md`, and the manifest.

**What to read.** Always read configuration.md, the phase file for the phase
you are running, and review-profiles.md. The phase files hold every
orchestrator step. [references/review-protocol.md](references/review-protocol.md)
holds the rules the seats, the auditor and the verifiers follow, and
`build-brief.mjs` copies them into their briefs: read the sections a phase file
names (its section index gives their lines), not the whole file.

## Run checklist

1. Setup above; resolve both models and confirm they are distinct.
2. [Phase 1](references/phase-1-independent-passes.md): run directory,
   `preflight.mjs`, the frozen task packet, `build-brief.mjs --mode phase1` for
   each seat, then both seat agents at the same time.
3. Completion gate: `blind-relabel.mjs validate --phase1-dir <run-dir>/phase1
   --target-dir <target-dir> --packet <task-packet>` exits 0.
4. [Phase 2](references/phase-2-cross-examination.md), unless mode is `none`:
   `exchange.mjs prepare --seat-b-harness`, each seat's delta brief by
   SendMessage, then `exchange.mjs finish`. Extra tasks the user asked for (a
   fix design) run after it (phase 2, Extra tasks after the exchange).
5. [Phase 3](references/phase-3-scorecard.md): `blind-relabel.mjs flip` and
   `audit-prep`; falsification verifiers only on request; the fresh auditor
   (`build-brief.mjs --mode auditor`); `translate`; the scorecard or
   `joint-findings.md`.
6. `build-manifest.mjs`, the report, and `blind-relabel.mjs clear-cache`.

## Rules that apply throughout

1. **Keep the orchestrator's context small.** Run Phase 1 and Phase 2 in one
   session (both seats resume only from the session that started them).
   Every call re-sends the whole conversation, so the orchestrator's cost per
   step grows with its context: between reviews, start a new session or
   `/compact` once the context has grown large. Record the session's own cost
   with `build-manifest --seat-transcript orchestrator=<session .jsonl>@<review start>/<review end>`
   (ISO times) on the review's first `build-manifest`: in a session that runs
   several reviews, the window counts only this review's calls. The file is `~/.claude/projects/<project>/<session id>.jsonl`, next to the
   folder that holds its subagents' transcripts.
2. **Tell the user local time.** The scripts store times in UTC; whenever you
   mention a time to the user, give this machine's local time first with UTC
   in brackets ("started at 12:07 PM (17:07 UTC)").
3. For a run that may last more than a day, keep the run directory and any
   source snapshot outside the OS temporary folder.
4. After the exchange has started, a seat is resumed or the review is reported
   incomplete, never replaced. Before it, a seat whose model is unavailable may
   be replaced (phase 1, Stalled or unavailable seats).
5. Never hand-edit or retype reviewer or auditor output: return it to its seat
   and apply the reply with `blind-relabel.mjs splice`.
6. A scan hit: delete the relabeled file and allow one redaction round; if the
   second scan still hits, stop the run and report.
7. Never fork the orchestrator's conversation into a seat, a verifier or the
   auditor.
8. Capture the output of every script: a non-zero exit states its reason
   there. Windows PowerShell 5.1 shows a script's stderr WARNING as a
   NativeCommandError even at exit 0.
9. Falsification (deep verify) runs only when the user asks for it.
10. Name in the report every fix made after the reviewed snapshot as not
    re-reviewed.
11. The manifest records what happened, never what was intended.
12. The review never edits or commits the target; no sandbox enforces this for
    Claude seats, so check the target after each phase (phase 1, Completion
    gate).

A failed or unavailable seat means an incomplete review. Report what completed
and the failure; never label a single pass as a completed pair review. Before
the exchange, a seat whose model became unavailable may be replaced, or the run
moved to cross-review, under phase-1-independent-passes.md's A provider
becomes unavailable during Phase 1.
