---
name: pair-review
description: >-
  Reviews code, designs, or documents with two distinct models from one
  vendor (two Claude models, or two OpenAI models through Codex).
  Supports collaborative, adversarial, and independent passes, first-run
  model setup, saved preferences, and changing models anytime.
  Use for pair review, two Claude or two OpenAI reviewers, or /pair-review.
license: MIT
compatibility: >-
  Requires Node.js 22+ and a harness that can run two isolated reviewers of
  one vendor with explicit model selection and resume or relay their findings:
  Claude seats need the Claude CLI or Claude Code agents, OpenAI seats need the
  Codex CLI. Claude Code is the primary target. Model access depends on the user's account.
metadata:
  version: 1.1.0
---

# Pair Review

Two distinct models from one vendor independently review the same target, then exchange
findings. The vendor is Anthropic (two Claude models, the default) or OpenAI (two Codex
models); a pair never mixes vendors. The orchestrator coordinates and verifies; it never fills
either seat.

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

On a Codex host the second `preflight` needs `--allow-trial` (an OpenAI pair, two native agents); a Claude pair there also needs `--probe-claude-session --yes-paid` (one paid check that a Claude CLI session survives a call). On Claude Code it needs no extra flag.
When `codex doctor` shows a failed sandbox row, the second `preflight` stops until you add `--yes-paid` (one small live `codex exec` probe) or `--skip-codex-doctor`; on a Codex host use `--skip-codex-doctor`, because a nested `codex exec` is blocked there.
Put the run folder, the evidence folder and the work folder outside the target's git repository, or in a folder that repository git-ignores: with a Claude CLI seat the second `preflight` refuses a run folder inside it, because that seat's worktree snapshots the whole repository and the run's own files would break the Phase 2 resume.

If a native agent replies that it cannot read its brief (its shell or file tools time out), that is a host tool failure, not a reviewer finding: keep the agent and the run folder, do not respawn or hand-write its file, and report the review as incomplete until the tools work again, then resume the same agent. With `--native-agent`, `--wait` detects this itself: once the agent's transcript shows its turn ended and the file is still missing, it fails with the agent's last reply quoted (agents are told to reply `blocked:` and the error).

## Host table

Support is decided per actor (host, runtime, transport) in `scripts/host-support.mjs`. On Claude Code a
Claude pair and an OpenAI pair are supported. On a Codex host the default route is two native OpenAI
agents, as a trial (`preflight.mjs --host codex --allow-trial`); a Claude pair also runs there as a trial,
only after a session probe (add `--probe-claude-session --yes-paid`). See [Codex](references/hosts/codex.md).
In a Claude pair both seats, the auditor and the verifiers
are Claude models; in an OpenAI pair they are all Codex runs started through `codex-dispatch`
(see the Claude Code host file). Match the tools you actually have, in this order, and pass the result to
`preflight.mjs --host`:

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
Run the bundled configuration helper's (`scripts/review-config.mjs`) `show`
command. If no saved configuration
exists, ask the user to choose the vendor, both models and optional effort levels
before the first review. Do not silently install a default pair.

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
**"double check all claims"** in the task text; with the sequencer, run `review-run audit --prepare --audit-depth full`
(it writes the depth into `run.json`; it cannot change once the auditor brief exists). After an exchange where every claim was
conceded and none disputed, a full audit is the safer choice when any conceded claim is HIGH or CRITICAL: agreement between two seats is not proof that the findings are right. When every conceded claim is MEDIUM or LOW, `exchange.mjs finish` prints a note instead and the light audit is enough.
Without the sequencer pass `--audit-depth full` to both `build-brief.mjs --mode auditor` and `blind-relabel.mjs translate`.

- Saved mode defaults to `collaborate` at setup. `adversarial` attacks each
  other's findings; `none` skips peer exchange — the fresh auditor still
  compares and canonicalizes the two independent findings sets, without
  rebuttal data.
- For high-stakes work prefer cross-review: two models of one vendor can share
  a blind spot that neither the exchange nor the auditor catches, and a
  reviewer from another vendor has found such errors.
- Explicit run choices override saved values without saving them. Missing
  selectors use saved choices. A model change clears that seat's saved effort
  to `default`, unless the user also supplies an effort.
- For an ID containing a colon, use an explicit named seat and separate effort
  in natural language rather than interpreting the ID as `model:effort`.
- Both resolved models must be distinct, including when different aliases map
  to the same actual model. Never silently substitute.

## Review phases

1. Resolve configuration; read
   [references/model-capabilities.md](references/model-capabilities.md) only when a model is not already in the saved configuration.
   Snapshot the selected settings for this run; do not reread preferences
   between review rounds.
2. [Independent passes](references/phase-1-independent-passes.md): both seats
   review the same snapshot without seeing each other's findings.
3. [Cross-examination](references/phase-2-cross-examination.md): each seat
   rebuts the other's blind findings once; skipped in mode `none`.
4. [Scorecard](references/phase-3-scorecard.md): a fresh auditor adjudicates,
   then `translate`, the scorecard or `joint-findings.md`, and the manifest.

`scripts/review-run.mjs` runs the phase commands from `run.json`: `phase1`, `phase2` and `audit`,
each with two halves (`--start` and `--wait`; `--prepare` and `--finish`). It prints at most ten
lines and one `next:` line, stops at the first failed step and keeps every artifact. It calls only
scripts the phase files name, in their order, so those commands stay documented there. In mode
`none` it skips Phase 2.

**What to read.** With `review-run`, the Quickstart and your host file are enough; configuration.md is for first-time setup and
review-profiles.md for the packet. Open the phase file for the phase you are running only for a failed step, a replaced seat, a
redaction round or a manual dispatch: the phase files hold every manual orchestrator step. [references/review-protocol.md](references/review-protocol.md)
holds the rules the seats, the auditor and the verifiers follow, and
`build-brief.mjs` copies them into their briefs: read the sections a phase file
names (its section index gives their lines), not the whole file.

## Run checklist

1. Setup above; resolve both models and confirm they are distinct. Resolve the host (Host table
   above) and run `preflight.mjs --host <host> --cd <target-dir> --run-dir <run-dir>
   --seats <seats.json>`: it checks the dispatcher and the `claude -p --help` flags and writes
   `<run-dir>/run.json`, the seat table every later script reads.
2. [Phase 1](references/phase-1-independent-passes.md): run directory,
   `preflight.mjs`, the frozen task packet, `build-brief.mjs --mode phase1` for
   each seat, then both seat agents at the same time.
3. Completion gate: `blind-relabel.mjs validate --phase1-dir <run-dir>/phase1
   --target-dir <target-dir> --packet <task-packet>` exits 0.
4. [Phase 2](references/phase-2-cross-examination.md), unless mode is `none`:
   `exchange.mjs prepare` (add `--seat-b-harness` only for a manual run without `run.json` where seat B writes its own file), each seat's delta brief by its resume action
   (the host file names it for a native seat; a CLI seat is resumed on its Phase 1 session),
   then `exchange.mjs finish`. Extra tasks the user asked for (a
   fix design) run after it (phase 2, Extra tasks after the exchange).
5. [Phase 3](references/phase-3-scorecard.md): `blind-relabel.mjs flip` and
   `audit-prep`; falsification verifiers only on request; the fresh auditor
   (`build-brief.mjs --mode auditor`); `translate`; the scorecard or
   `joint-findings.md`.
6. `build-manifest.mjs`, the report, and `blind-relabel.mjs clear-cache`.

## Rules that apply throughout

1. **Keep the orchestrator's context small.** Run Phase 1 and Phase 2 in one
   session (native seats resume only from the session that started them).
   Every call re-sends the whole conversation, so the orchestrator's cost per
   step grows with its context: between reviews, start a new session or
   `/compact` once the context has grown large. Record the session's own cost
   with `build-manifest --seat-transcript orchestrator=<session .jsonl>@<review start>/<review end>`
   (ISO times) on the review's first `build-manifest`: in a session that runs
   several reviews, the window counts only this review's calls. The host file names the transcript file to use.
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
6. A scan hit: delete the relabeled file and allow one redaction round. Each hit
   names the matched token: if the second scan names the same token, stop the run and
   report; if it names a different one, the first round fixed its token, so one more
   round is allowed.
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

This directory is independently installable; neither package imports files from the other. Its
configuration helper, review protocol, review profiles, configuration and model-capability
references, `blind-relabel.mjs`, `build-brief.mjs`, `build-manifest.mjs`, `exchange.mjs`,
`preflight.mjs` and `snapshot-utils.mjs` are bundled with cross-review, and so are
`claude-dispatch.mjs`, `codex-dispatch.mjs`, `detach-utils.mjs`, `worktree-utils.mjs`, `rollout-utils.mjs`,
`run-descriptor.mjs` and `review-run.mjs`, with their tests. Keep those copies identical;
the repository-level `scripts/validate-repository.mjs` (in the SkillArray repository, not in this folder) checks them. The phase references are maintained here. The host
files `references/hosts/claude-code.md` and `references/hosts/codex.md` are not parity files: each
skill's host files differ where its transports differ.
