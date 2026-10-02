---
name: cross-review
description: >-
  Reviews code, designs, or documents with two reviewer providers, then
  cross-examines their findings. Supports Claude/Fable, OpenAI Codex, and
  OpenCode-routed providers, with first-run model setup, saved preferences,
  and changing models anytime.
  Use for cross-vendor review, Claude plus Codex review, or /cross-review.
license: MIT
compatibility: >-
  Requires Node.js 22+, a selected reviewer runtime, and a harness that can run
  an isolated Claude reviewer and background shell processes.
  Git is recommended for source-change auditing. Claude Code is the primary target.
metadata:
  version: 1.0.0
---

# Cross Review

Reviewer A and B use two different providers. The orchestrator is neither
reviewer. Seat A always runs on this harness (Claude); seat B runs through
Codex CLI or OpenCode's configured provider bridge, never the Claude harness —
no other layout has a defined dispatch path, and `review-config.mjs` enforces
this. State the resolved provider, runtime, model, and effort before dispatch.
Do not change authentication or provider configuration during setup.

## Start here: model setup

Read [references/configuration.md](references/configuration.md) before dispatch.
Run the bundled configuration helper's (`scripts/review-config.mjs`) `show` and
`catalog` commands. Without
saved choices, ask for each seat's provider, runtime, model, and optional effort.
Show the catalog returned by the helper; it is the only list of curated model
choices, so never offer a model from memory or from an older copy of these
docs. Fable must be offered with the Claude choices when the harness exposes
it. For a Codex seat, `codex debug models` shows what the installed CLI can
actually run. Its output is about 500 KB of JSON, so never print it raw; use
the parse command in model-capabilities.md's "Codex seat" section. For an
OpenCode seat, run `opencode models` and show only configured providers and
model IDs. Do not inherit an unidentified runtime
default.

**What to read.** Always read configuration.md, the phase file for the phase
you are running, and review-profiles.md. The phase files hold every
orchestrator step. [references/review-protocol.md](references/review-protocol.md)
holds the rules the seats, the auditor and the verifiers follow, and
`build-brief.mjs` copies them into their briefs: read the sections a phase file
names (its section index gives their lines), not the whole file. In
model-capabilities.md read only the section for each runtime you selected
(skip "OpenCode seats" when no seat runs on OpenCode; it is most of the file).
In the phase files, skip the OpenCode paragraphs for the same reason.

`/cross-review setup` changes choices anytime; `/cross-review config` shows them.
Natural-language requests to change either seat also enter setup. Setup, config,
and reset do not dispatch reviewers.

## Invocation

```text
/cross-review setup
/cross-review config
/cross-review reset
/cross-review [reviewer-a] [reviewer-b] -- <task>
```

Use the delimiter when task text could look like a model selector. Existing
positional calls remain supported when unambiguous. IDs containing colons must
be supplied as a named seat with a separate effort in natural language.

To request the opt-in Falsification pass (see references/review-protocol.md),
include the phrase **"deep verify disputed high-severity findings"** in the
task text — this is the canonical phrase the orchestrator recognizes as an
explicit request; falsification never runs without it.

The auditor re-checks only claims the other reviewer did not concede (light
audit, the default). To have it re-check every claim, include the phrase
**"double check all claims"** in the task text; pass `--audit-depth full` to
both `build-brief.mjs --mode auditor` and `blind-relabel.mjs translate`.

Explicit choices override saved values for one run only. A changed provider,
runtime, or model resets that seat's old effort to `default` unless effort is
also supplied. Cross-review always uses adversarial exchange and requires
different providers. For two Claude-harness reviewers or collaborative mode,
use pair-review.

## Preflight

1. Resolve preferences and inspect
   [references/model-capabilities.md](references/model-capabilities.md).
   Verify both models are available through their selected runtime. Unknown or
   unsupported explicit choices require user resolution, never silent fallback.
2. Check the selected runtime only: Claude harness model metadata for `claude`,
   `codex --version`, `codex login status`, `codex exec --help`, and
   `codex exec resume --help` for `codex`; or `opencode --version`,
   `opencode models`, and `opencode run --help` for `opencode`. Do not read
   credential files. Confirm the two selected provider IDs differ.
3. Resolve this skill's actual directory from the loaded SKILL.md location.
   Verify the linked references and bundled dispatcher exist. No sibling skill
   installation is required.
4. Read the target, discover its checks, and freeze the task packet and selected
   settings in a unique run directory. Configuration changes apply to subsequent
   reviews. An explicit request to change models during this review starts new
   independent passes; never relabel existing findings.

## Review phases

Read the reference for the phase being executed:

1. [Independent passes](references/phase-1-independent-passes.md):
   run Claude and Codex concurrently against the same snapshot.
2. [Cross-examination](references/phase-2-cross-examination.md):
   exchange completed findings once, preserving both original passes.
   `scripts/exchange.mjs prepare` builds both delta briefs and `finish`
   appends both rebuttal files.
3. [Scorecard](references/phase-3-scorecard.md):
   verify contested claims and retain unresolved disagreements. An opt-in
   Falsification pass independently checks a specific HIGH/CRITICAL disputed
   claim before synthesis, when the task explicitly requests it.

Build every brief with [scripts/build-brief.mjs](scripts/build-brief.mjs), append
rebuttals with `blind-relabel.mjs append-rebuttals`, and stage the auditor's
folder with `blind-relabel.mjs audit-prep`; the phase files give the exact
commands. Full-tool readers (the Claude seat, the auditor) write their own
result files; the orchestrator never retypes a reviewer's or auditor's output.

Dispatch a Codex seat with [scripts/codex-dispatch.mjs](scripts/codex-dispatch.mjs)
and an OpenCode seat with [scripts/opencode-dispatch.mjs](scripts/opencode-dispatch.mjs).
Pass the resolved `--model` on every dispatch, including resume. Pass `--effort`
only when the runtime supports and the user explicitly selected it; omit it for
`default`. Claude seats use the harness's explicit model/effort mechanism.
Snapshot all arguments for the run. Dispatchers do not load user preferences.

Result metadata records requested model/effort; it is not proof of server-side
selection. Use runtime evidence for resolved values, otherwise record `null`
and explain what could not be verified. Any dispatcher error or missing seat
means the review is incomplete; do not synthesize a completed two-vendor verdict.

OpenCode is selected only when the user chose it. It is never a silent fallback.

## Run checklist

1. Setup and Preflight above; state the resolved seats.
2. [Phase 1](references/phase-1-independent-passes.md): run directory,
   `preflight.mjs`, the frozen `task-packet.md`, `build-brief.mjs --mode phase1`
   for each seat, then seat A's agent and seat B's dispatcher at the same time.
3. Completion gate: `blind-relabel.mjs validate --phase1-dir <run-dir>/phase1
   --target-dir <target-dir> --packet <run-dir>/task-packet.md` exits 0.
4. [Phase 2](references/phase-2-cross-examination.md): `exchange.mjs prepare`;
   seat A's delta brief by SendMessage, seat B's by a resume dispatch on its
   Phase 1 thread; then `exchange.mjs finish`. Extra tasks the user asked for (a
   fix design) run after it (phase 2, Extra tasks after the exchange).
5. [Phase 3](references/phase-3-scorecard.md): `blind-relabel.mjs flip` and
   `audit-prep`; falsification verifiers only on request; the fresh auditor
   (`build-brief.mjs --mode auditor`); `translate`; `scorecard`.
6. `build-manifest.mjs`, the report, `blind-relabel.mjs clear-cache`, and
   worktree cleanup for an isolated seat.

## Rules that apply throughout

1. **Keep the orchestrator's context small.** Run Phase 1 and Phase 2 in one
   session (a Claude seat resumes only from the session that started it).
   Every call re-sends the whole conversation, so the orchestrator's cost per
   step grows with its context: between reviews, start a new session or
   `/compact` once the context has grown large. Record the session's own cost with
   `build-manifest --seat-transcript orchestrator=<session .jsonl>@<review start>/<review end>`
   (ISO times) on the review's first `build-manifest`: in a session that runs
   several reviews, the window counts only this review's calls. The file is `~/.claude/projects/<project>/<session id>.jsonl`, next to the
   folder that holds its subagents' transcripts.
2. **Tell the user local time.** The scripts store every time in UTC (`startedAt`,
   `finishedAt`, the `Z` times). Whenever you mention a time to the user, convert it
   to this machine's local time first and put UTC in brackets: "seat B started at
   12:07 PM (17:07 UTC)". Plain `Get-Date` or `date` shows the local offset.
3. For a run that may last more than a day, keep the run directory and any
   source snapshot outside the OS temporary folder.
4. After the exchange has started, a seat is resumed or the review is reported
   incomplete, never replaced. Before it, a seat whose provider is unavailable
   may move to another provider (phase 1, Stalled or unavailable seats).
5. Never hand-edit or retype reviewer or auditor output: return it to its seat
   and apply the reply with `blind-relabel.mjs splice`.
6. A scan hit: delete the relabeled file and allow one redaction round; if the
   second scan still hits, stop the run and report.
7. Never fork the orchestrator's conversation into a seat, a verifier or the
   auditor.
8. Capture the output of `--wait` and of every script: a non-zero exit states
   its reason there. Windows PowerShell 5.1 shows a script's stderr WARNING as a
   NativeCommandError even at exit 0; read result.json as UTF-8 (in Python,
   `encoding="utf-8"`).
9. Falsification (deep verify) runs only when the user asks for it.
10. Name in the report every fix made after the reviewed snapshot as not
    re-reviewed.
11. The manifest records what happened, never what was intended.
12. The review never edits or commits the target.

## Maintenance

This directory is independently installable. Its configuration helper, helper
tests, configuration reference, model-capability reference, review protocol, and
review profiles are also bundled with pair-review. Keep those copies identical
when maintaining both packages; neither package imports files from the other.
The shared scripts include `snapshot-utils.mjs` (imported by `preflight.mjs`) and
`build-brief.mjs`, which reads only the shared review-protocol.md, and
`exchange.mjs`, which runs the shared `blind-relabel.mjs` and `build-brief.mjs`.
The phase references and dispatchers are maintained here
and do not require updates to another skill.
