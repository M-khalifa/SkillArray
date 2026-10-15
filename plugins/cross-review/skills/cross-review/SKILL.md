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
  version: 1.1.0
---

# Cross Review

Reviewer A and B use two different providers. The orchestrator is neither
reviewer. Seat A always runs as a Claude reviewer, on either host; seat B runs
through Codex CLI or OpenCode's configured provider bridge, never as a Claude
reviewer — no other layout has a defined dispatch path, and `review-config.mjs`
enforces this. State the resolved provider, runtime, model, and effort before
dispatch. Do not change authentication or provider configuration during setup.

## Quickstart

First run `node --version`. The scripts need Node.js 22 or newer: if the command is missing or reports an older version,
stop before any setup or paid call and tell the user to install a current Node.js (Windows `winget install OpenJS.NodeJS.LTS`,
macOS `brew install node`, Debian or Ubuntu the NodeSource or distribution package, or https://nodejs.org), then rerun.

With `scripts/review-run.mjs` (the sequencer) a review is these commands; open a phase file only when a step fails, a seat has to be
replaced, a scan stops the run, or you dispatch by hand. Read `references/configuration.md` only for first-time setup and
`references/review-profiles.md` when you write the packet. Your host file (below) says how each actor is started.

```text
node "<skill-dir>/scripts/review-config.mjs" seats --host <claude-code|codex> --out "<work>/seats.json"   # decide web on or off (--repo-only) and whether the deep-verify pass may run (--falsification) first: neither can be added once run.json exists; from the saved choices; add --a <model> --b <model> (also --a-provider, --a-runtime, --a-effort) to override them for this run only, --auditor <model> to run the auditor on another model than seat A, --repo-only when web verification is off
node "<skill-dir>/scripts/preflight.mjs" --cd "<target>" --compact --out "<evidence-dir>/preflight.json"   # evidence for the packet
<write <run-dir>/task-packet.md from references/task-packet-template.md>
node "<skill-dir>/scripts/preflight.mjs" --host <host> --cd "<target>" --run-dir "<run-dir>" --seats "<work>/seats.json"
node "<skill-dir>/scripts/review-run.mjs" phase1 --run-dir "<run-dir>" --start --local     # starts CLI seats; native seats get a prompt file
<spawn each native seat with the prompt file the output names>
node "<skill-dir>/scripts/review-run.mjs" phase1 --run-dir "<run-dir>" --wait --native-agent A=<agent id, Codex thread id or rollout path>   # rerun on exit 3
node "<skill-dir>/scripts/review-run.mjs" phase2 --run-dir "<run-dir>" --start   # then resume each native seat with its prompt file
node "<skill-dir>/scripts/review-run.mjs" phase2 --run-dir "<run-dir>" --wait --native-agent A=<agent id, Codex thread id or rollout path>
node "<skill-dir>/scripts/review-run.mjs" audit --run-dir "<run-dir>" --prepare [--audit-depth full]
node "<skill-dir>/scripts/review-run.mjs" audit --run-dir "<run-dir>" --finish   # spawn a native auditor with its prompt file, then:
node "<skill-dir>/scripts/review-run.mjs" audit --run-dir "<run-dir>" --finish --native-agent auditor=<agent id, Codex thread id or rollout path>
node "<skill-dir>/scripts/build-manifest.mjs" --run-dir "<run-dir>"   # collects every input; run it with --init first to write a body to edit, then again without: it reads that body
node "<skill-dir>/scripts/build-report.mjs" --run-dir "<run-dir>" --format chat   # the report for the chat window: paste the output verbatim as your reply, never retype it; add --all for every finding, criterion and the cost; --out report.md for a ticket, --html page.html only when the user asks
```

Each `review-run` call prints at most ten lines and a `next:` line; exit 3 means a seat is still running, so rerun the same command.
Do not pipe a script into `Select-Object -First` or `head` on PowerShell: PowerShell itself reports exit 255 (-1) for any program it stops early, even `node -e` with no script of ours. The output is already short; redirect it to a file instead.
A review of two repositories works: give the second one to both preflights with `--repo <path>` (its snapshotHash is recorded and `review-run` warns if it changes) and run its tests with `--exec-in <path> "<command>"`; the packet names both paths.
Give a shell call that waits a timeout above `--max-wait` plus 60 s. The scorecard is `<run-dir>/phase3/scorecard.md`.

On a Codex host the second `preflight` needs `--allow-trial --probe-claude-session --yes-paid` (seat A is a Claude CLI seat: the probe is one paid check that its session survives a call). On Claude Code it needs no extra flag.
When `codex doctor` shows a failed sandbox row, the second `preflight` stops until you add `--yes-paid` (one small live `codex exec` probe) or `--skip-codex-doctor`; on a Codex host use `--skip-codex-doctor`, because a nested `codex exec` is blocked there.
Put the run folder, the evidence folder and the work folder outside the target's git repository, or in a folder that repository git-ignores: with a Claude CLI or OpenCode seat the second `preflight` refuses a run folder inside it, because that seat's worktree snapshots the whole repository and the run's own files would break the Phase 2 resume.

If a native agent replies that it cannot read its brief (its shell or file tools time out), that is a host tool failure, not a reviewer finding: keep the agent and the run folder, do not respawn or hand-write its file, and report the review as incomplete until the tools work again, then resume the same agent. With `--native-agent`, `--wait` detects this itself: once the agent's transcript shows its turn ended and the file is still missing, it fails with the agent's last reply quoted (agents are told to reply `blocked:` and the error).

## Host table

Support is decided per actor (host, runtime, transport) in `scripts/host-support.mjs`. On Claude Code
everything in this skill is supported except an OpenCode seat (a trial: `preflight.mjs --allow-trial`).
Cross-review on a Codex host is a trial that preflight must prove first: the Claude CLI seat is usable only if its
session survives a call there (`--probe-claude-session --yes-paid`; see [Codex](references/hosts/codex.md)).
Match the tools you actually have, in this order, and
pass the result to `preflight.mjs --host`:

| Order | Condition | Host |
|---|---|---|
| 1 | A `--host` value that is valid and does not contradict a tool family that is present | that value |
| 2 | Both a Claude Code agent tool family and a Codex agent tool family are present | ambiguous: ask the user |
| 3 | An agent-spawn tool and `SendMessage` | `claude-code` |
| 4 | The Codex agent tool family (its tool names are not observed: pass `--host codex`) | `codex` |
| 5 | None of the above | ambiguous: ask the user |

`CODEX_THREAD_ID` and `CLAUDECODE` are hints only; both markers cross host boundaries, and both
CLIs are often installed. A non-interactive run that is ambiguous fails with "pass --host".
A run reads this file, ONE host file —
[Claude Code](references/hosts/claude-code.md) or [Codex](references/hosts/codex.md) — and the
current phase file. The host file holds the native spawn and resume rules, or the dispatch
commands and the Codex sandbox finding.

## Start here: model setup

On first-time setup read [references/configuration.md](references/configuration.md); on every later review run `show` and use the saved choices.
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

**What to read.** With `review-run`, the Quickstart and your host file are enough; configuration.md is for first-time setup and
review-profiles.md for the packet. Open the phase file for the phase you are running only for a failed step, a replaced seat, a
redaction round or a manual dispatch: the phase files hold every manual orchestrator step. [references/review-protocol.md](references/review-protocol.md)
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
**"double check all claims"** in the task text; with the sequencer, run `review-run audit --prepare --audit-depth full`
(it writes the depth into `run.json`; it cannot change once the auditor brief exists). After an exchange where every claim was
conceded and none disputed, a full audit is the safer choice when any conceded claim is HIGH or CRITICAL: agreement between two seats is not proof that the findings are right. When every conceded claim is MEDIUM or LOW, `exchange.mjs finish` prints a note instead and the light audit is enough.
Without the sequencer pass `--audit-depth full` to both `build-brief.mjs --mode auditor` and `blind-relabel.mjs translate`.

Explicit choices override saved values for one run only. A changed provider,
runtime, or model resets that seat's old effort to `default` unless effort is
also supplied. Cross-review always uses adversarial exchange and requires
different providers. For two models from one vendor (Claude or OpenAI) or collaborative mode,
use pair-review.

## Preflight

1. Resolve preferences and inspect
   [references/model-capabilities.md](references/model-capabilities.md) when a model is not already in the saved configuration.
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
5. Resolve the host (Host table above) and run
   `preflight.mjs --host <host> --cd <target-dir> --run-dir <run-dir> --seats <seats.json>`.
   It checks that this skill ships the dispatchers the seats need, that `claude -p --help`
   lists every flag `claude-dispatch.mjs` uses, and writes `<run-dir>/run.json`, the seat
   table every later script reads. The check is free; `--probe-dispatch` only prints the one
   paid probe it would run unless `--yes-paid` is also given.

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

`scripts/review-run.mjs` runs the three phase commands from `run.json`: `phase1`, `phase2`
and `audit`, each with two halves (`--start` and `--wait`; `--prepare` and `--finish`). It prints
at most ten lines and one `next:` line, stops at the first failed step and keeps every artifact.
It calls only scripts the phase files name, in their order, so those commands stay documented
in the phase files.

Dispatch a Codex seat with [scripts/codex-dispatch.mjs](scripts/codex-dispatch.mjs)
and an OpenCode seat with [scripts/opencode-dispatch.mjs](scripts/opencode-dispatch.mjs).
Pass the resolved `--model` on every dispatch, including resume. Pass `--effort`
only when the runtime supports and the user explicitly selected it; omit it for
`default`. A native Claude seat uses the host's explicit model/effort mechanism;
a CLI Claude seat gets `--model` and `--effort` on
[scripts/claude-dispatch.mjs](scripts/claude-dispatch.mjs).
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
   each seat's delta brief by its resume action (the host file names it for a
   native seat; a CLI seat is resumed on its Phase 1 session); then
   `exchange.mjs finish`. Extra tasks the user asked for (a
   fix design) run after it (phase 2, Extra tasks after the exchange).
5. [Phase 3](references/phase-3-scorecard.md): `blind-relabel.mjs flip` and
   `audit-prep`; falsification verifiers only on request; the fresh auditor
   (`build-brief.mjs --mode auditor`); `translate`; `scorecard`.
6. `build-manifest.mjs`, the report, `blind-relabel.mjs clear-cache`, and
   worktree cleanup for an isolated seat.

## Rules that apply throughout

1. **Keep the orchestrator's context small.** Run Phase 1 and Phase 2 in one
   session (a native seat resumes only from the session that started it).
   Every call re-sends the whole conversation, so the orchestrator's cost per
   step grows with its context: between reviews, start a new session or
   `/compact` once the context has grown large. Record the session's own cost with
   `build-manifest --seat-transcript orchestrator=<session .jsonl>@<review start>/<review end>`
   (ISO times) on the review's first `build-manifest`: in a session that runs
   several reviews, the window counts only this review's calls. The host file names the transcript file to use.
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
6. A scan hit: delete the relabeled file and allow one redaction round. Each hit
   names the matched token: if the second scan names the same token, stop the run and
   report; if it names a different one, the first round fixed its token, so one more
   round is allowed.
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

## Reviewing the same code again

Each fix pass adds new code, and the next review mostly finds bugs in that new code: in a four-round series on one collector
about half of each round's findings came from the previous fixes. Review again after a fix pass only when the last round had a
finding that only one seat raised on code that was changed. Stop after the first round where each finding was raised by both
seats, or where nothing new is on changed code: another round costs the same tokens and finds less.

For a last check of a small fix diff, one fresh reviewer can be enough. Draft the packet with `scripts/build-recheck-packet.mjs
--from-run <old-run-dir> --out <packet.md>` (or write the short packet in references/task-packet-template.md), spawn one fresh
agent (never a fork) with it, and require a command and its output for every finding. Treat what it reports as leads to verify:
there is no blind exchange and no auditor, so it does not replace a review round.

Your own bug checklists: `review-config.mjs checklists` lists the files in `<config dir>/checklists/` (next to your saved choices,
outside the repository, one `- item` per line) and `checklists --name NAME` prints one. Add each item to the packet as a
hypothesis `[H<n>]`. An item is one more check for each seat, so keep a list to about eight items; it widens round 1 so that
old bugs are found before the first fix pass.

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

Shared scripts, identical in both skills and checked by the repository-level `scripts/validate-repository.mjs`
(in the SkillArray repository, not in this folder): `claude-dispatch.mjs`, `codex-dispatch.mjs`, `detach-utils.mjs`, `worktree-utils.mjs`, `rollout-utils.mjs`,
`run-descriptor.mjs` (reads and writes `run.json`), `review-run.mjs` (the sequencer) and
`preflight.mjs`, with their tests. `opencode-dispatch.mjs` exists only
here. The host files `references/hosts/claude-code.md` and `references/hosts/codex.md` are not
parity files: each skill's host files differ where its transports differ.
