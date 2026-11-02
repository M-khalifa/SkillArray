---
name: cross-review
description: >-
  Reviews code, designs, or documents with two reviewer providers, then
  cross-examines their findings. Supports Claude/Fable and OpenAI Codex,
  with first-run model setup, saved preferences, and changing models anytime.
  Use for cross-vendor review, Claude plus Codex review, or /cross-review.
license: MIT
compatibility: >-
  Requires Node.js 22+, a selected reviewer runtime, and a harness that can run
  an isolated Claude reviewer and background shell processes.
  Git is recommended for source-change auditing. Claude Code is the primary target.
metadata:
  version: 1.2.0
---

# Cross Review

Reviewer A and B use two different providers. The orchestrator is neither
reviewer. Seat A always runs as a Claude reviewer, on either host; seat B runs
through Codex (the CLI on Claude Code, a native Codex agent on a Codex host), never as a Claude reviewer — no other layout
has a defined dispatch path, and `review-config.mjs`
enforces this. State the resolved provider, runtime, model, and effort before
dispatch. Do not change authentication or provider configuration during setup.

## Quickstart

First run `node --version`. The scripts need Node.js 22 or newer: if the command is missing or reports an older version,
stop before any setup or paid call and tell the user to install a current Node.js (Windows `winget install OpenJS.NodeJS.LTS`,
macOS `brew install node`, Debian or Ubuntu the NodeSource or distribution package, or https://nodejs.org), then rerun.

With `scripts/review-run.mjs` (the sequencer) a review is these commands; open a phase file only when a step fails, a seat has to be
replaced, a scan stops the run, or you run the falsification pass or a re-review. Read `references/configuration.md` only for first-time setup and
`references/review-profiles.md` when you write the packet. Your host file (below) says how each actor is started.

```text
node "<skill-dir>/scripts/review-config.mjs" seats --host <claude-code|codex> --out "<work>/seats.json"   # decide web on or off (--repo-only) first: it cannot change once run.json exists; --falsification runs the deep-verify pass before the audit (a deep verify asked for after the audit works without it only with a native auditor, which can be resumed); from the saved choices; add --a <model> --b <model> (also --a-provider, --a-runtime, --a-effort) to override them for this run only, --auditor <model> to run the auditor on another model than seat A, --repo-only when web verification is off
node "<skill-dir>/scripts/preflight.mjs" --cd "<target>" --compact --out "<evidence-dir>/preflight.json" [--exec "<test command>"] [--timeout <seconds>] [--base <commit>]   # evidence for the packet (--base: list work already committed since that commit): run the tests here (--exec is refused with --host); keep <evidence-dir> outside the run folder
<write <run-dir>/task-packet.md from references/task-packet-template.md>
node "<skill-dir>/scripts/preflight.mjs" --host <host> --cd "<target>" --run-dir "<run-dir>" --seats "<work>/seats.json" [--keep-target-copy]   # --keep-target-copy keeps the target as reviewed in <run-dir>-target-copy, so the run can become a bench case (bench/case-from-run.mjs --target); it holds the target's code: delete it with the run folders
node "<skill-dir>/scripts/review-run.mjs" phase1 --run-dir "<run-dir>" --start --local     # starts CLI seats; native seats get a prompt file
<spawn each native seat with the prompt file the output names>
node "<skill-dir>/scripts/review-run.mjs" phase1 --run-dir "<run-dir>" --wait --native-agent <native seat: A or B>=<agent id, Codex thread id or rollout path>   # rerun on exit 3
node "<skill-dir>/scripts/review-run.mjs" phase2 --run-dir "<run-dir>" --start   # then resume each native seat with its prompt file
node "<skill-dir>/scripts/review-run.mjs" phase2 --run-dir "<run-dir>" --wait   # the agent ids given in phase 1 are remembered
node "<skill-dir>/scripts/review-run.mjs" audit --run-dir "<run-dir>" --prepare
node "<skill-dir>/scripts/review-run.mjs" audit --run-dir "<run-dir>" --finish   # spawn a native auditor with its prompt file, then:
node "<skill-dir>/scripts/review-run.mjs" audit --run-dir "<run-dir>" --finish --native-agent auditor=<agent id, Codex thread id or rollout path>
node "<skill-dir>/scripts/review-run.mjs" manifest --run-dir "<run-dir>" --init --seat-transcript orchestrator=auto@<review start>/<review end>   # optional: a body to edit (what only you know) and this session's own cost
node "<skill-dir>/scripts/review-run.mjs" manifest --run-dir "<run-dir>"   # collects every input and reads that body; writes <run-dir>/manifest.json (without --init, give --seat-transcript orchestrator=... here: one call is enough)
node "<skill-dir>/scripts/review-run.mjs" report --run-dir "<run-dir>" --format chat   # the report for the chat window: paste the output verbatim as your reply, never retype it; add --all for every finding, criterion and the cost; --out report.md for a ticket, --html page.html only when the user asks
```

Project knowledge: when you write `task-packet.md`, first read the project's own instructions (CLAUDE.md, AGENTS.md, REVIEW.md), the user's memory notes and local skills that concern this target, and its docs. Put the facts that matter for this review into the packet (Scope or Start here, Known deviations, Hypotheses to test), after you remove model and vendor names and earlier review verdicts (a finding marked fixed comes back as a hypothesis to recheck; one decided or accepted goes under Known deviations). The user's own bug checklists come from `review-config.mjs checklists`. No seat is given the user's memory or skills, so the packet is how that knowledge reaches them. A CLI seat reads only the target and the project's CLAUDE.md, AGENTS.md and REVIEW.md. A native seat or auditor (started with the host's agent tool) also gets whatever the host loads into every agent, such as the user's global instructions and memory: its brief tells it to treat that as unchecked context, never as evidence. Use CLI seats when that matters.
Each `review-run` phase call (`phase1`, `phase2`, `audit`) prints at most ten lines and a `next:` line; exit 3 means a seat is still running, so rerun the same command (a larger `--max-wait`, default 480 s, means fewer reruns; keep the shell timeout above it). A CLI seat that stopped part way (a reboot, a crash, a killed worker) is dispatched again by the next `--wait` of its phase, alone: the seat that finished is kept, so never start the phase over.
`review-run status --run-dir <a> --run-dir <b>` prints one line per run (its step, and each seat's progress) and runs nothing, for several runs at once. `review-run cleanup --run-dir <dir>` lists the seats' scratch folders of a finished run with their sizes, and `--yes` deletes them (a seat may not be allowed to delete its own). `review-config seats ... --out <file> --replace` overwrites an existing seats file, for example to switch a seat's transport before preflight.
When `phase1 --wait`, `phase2` or `audit --finish` stops because the target changed after the Phase 1 snapshot, it names the changed files. If they are outside what the review covers (another session edited the same repository), rerun the same command with `--accept-drift`: the manifest and the report record it, and say that a seat or the auditor may have read the changed files. `phase1 --start` never accepts drift.
Do not pipe a script into `Select-Object -First` or `head` on PowerShell: PowerShell itself reports exit 255 (-1) for any program it stops early, even `node -e` with no script of ours. The output is already short; redirect it to a file instead.
A large target reviews better as several runs, each with a packet scoped to one area (for example one feature, then the merge with upstream), than as one run over everything: each seat reads its area in full. A test suite too heavy for this machine (it was stopped for low memory, or it hits `--timeout`) can run outside `--exec`; cite its log and the snapshot it ran on in the packet.
A review of two repositories works: give the second one to both preflights with `--repo <path>` (its snapshotHash is recorded and `review-run` warns if it changes) and run its tests with `--exec-in <path> "<command>"` (or `--exec-in-file <path> <file>`, one command per line as `--exec-file`, for PowerShell 5.1 and quoted paths with spaces); the packet names both paths.
Give a shell call that waits a timeout above `--max-wait` plus 60 s. On a host low on memory, the host may stop background shells: run `--wait`, `--exec` and test steps in the foreground. The scorecard is `<run-dir>/phase3/scorecard.md`.

On a Codex host the second `preflight` needs `--allow-trial --probe-claude-session --yes-paid` (seat A is a Claude CLI seat: the probe is one paid check that its session survives a call). On Claude Code it needs no extra flag.
When `codex doctor` shows a failed sandbox row, the second `preflight` stops until you add `--yes-paid` (one small live `codex exec` probe) or `--skip-codex-doctor`; on a Codex host use `--skip-codex-doctor`, because a nested `codex exec` is blocked there.
On macOS an ASCII run-folder path is still the safe choice: the handling of a folder name quoted in another Unicode form is not yet verified on a Mac. With git 2.36 or later the review's own git commands turn the fsmonitor daemon off; with older git set `core.fsmonitor=false` for the target if your git config turns it on (each snapshot would start a daemon that outlives the run). Put the run folder, the evidence folder and the work folder outside the target, and the evidence folder outside the run folder (a packet that names the run folder is refused at `phase1 --start`; the second `preflight` warns first): the second `preflight` refuses a run folder inside it, because every dispatcher's write check would count the run's own files as target writes. With a Claude CLI seat keep them also outside the target's git repository, or in a folder that repository git-ignores: that seat's worktree snapshots the whole repository and the run's own files would break the Phase 2 resume.
A CLI seat or auditor runs with a filtered environment (OS basics, proxy and certificate variables, its CLI's own config folder). A seat that needs more, such as `CLAUDE_CODE_USE_BEDROCK` and the `AWS_*` variables of a Bedrock seat, gets them from `review-config seats --env A=CLAUDE_CODE_USE_BEDROCK,AWS_REGION` (repeat for B or auditor; the auditor takes seat A's list unless it has its own), `--env-mode <role>=inherit` (the whole environment) or `--use-api-key <role>` (ANTHROPIC_API_KEY, Claude only). run.json stores the names, never the values: on Windows a seat's worker starts through WMI with the user's own environment, so set those variables for the user, not only in this shell.
On Windows every CLI seat and CLI auditor runs inside a job object: a process its CLI starts (a server, a watcher) is stopped when the CLI ends, also one whose launcher has exited, and result.json `leftoversStopped` names it. The job adds a few seconds to each start. Where a sandbox refuses the job, result.json has `jobRefused` and the run warns that a process it started may still be running. On Linux and macOS the groups the CLI's tool commands lead are watched while it runs, and every process carrying the seat's run id (`REVIEW_SEAT_RUN_ID`, inherited also by one that left its group); what is still running when the CLI ends is stopped and named in `leftoversStopped`. On macOS the run id finds a job that is a non-Apple program (node, Homebrew python); an Apple system program (`/bin/sh`, `/bin/sleep`, `/usr/bin/perl`) hides its environment and is not found.
A Codex CLI seat runs with every MCP server off (it lists them with `codex mcp list --json` and passes `-c mcp_servers.<name>.enabled=false` for each), because such a server (node_repl, cua_repl) runs code outside its read-only sandbox; if that list cannot be read nothing is started. A native seat keeps the host's or the user's servers.
Give a Codex seat an explicit effort (`--b-effort high`, or `--a-effort` for an OpenAI seat A): with `default` a field run got a 61-second pass with one claim; the manifest records the effort the rollout ran with (`effort_resolved`; `codex-default (not reported)` on the default, which the rollout does not log), and `review-config seats` warns about a Codex seat left on it. Its read-only sandbox may not read a path outside the target, write a temp file (so test suites fail) or reach a port, as seen on Linux and Windows; on Windows its PowerShell may also run in Constrained Language mode, which refuses object creation (`ConversionSupportedOnlyToCoreTypes`). Its brief names no scratch folder and tells it to write no file, so give it executed test evidence another way: run the suite in preflight Tier 2 (`--exec`, `--compact`) and cite those logs in the packet, the way the packet template does; also paste the result lines (counts, failing tests) into the packet, because every brief holds the packet while a log outside the target may not be readable to this seat. To check what it can reach: `preflight --host ... --probe-reach --yes-paid` (one small paid call) checks the paths and ports the packet names, the second `preflight` and `phase1 --start` warn about paths outside the target on Linux and Windows, and a seat whose own lines say a read or command was blocked gets a "may have reviewed blind" warning and a report caveat. Preflight also runs `python` (`python3` on Linux and macOS), `rg` and `git` inside the Codex sandbox (`codex sandbox`, free) and warns about each one the seat cannot start, naming where this host has it (on Windows it runs them through PowerShell, the seat's shell, and the sandbox account cannot start a program installed under the user profile: install it for all users, or put a copy under Program Files on PATH; the per-user one can stay first); `phase1 --start` repeats the warning (`seat-tools.json`); `--skip-codex-doctor` skips it too.

If a native agent replies that it cannot read its brief (its shell or file tools time out), that is a host tool failure, not a reviewer finding: keep the agent and the run folder, do not respawn or hand-write its file, and report the review as incomplete until the tools work again, then resume the same agent. With `--native-agent`, `--wait` detects this itself: once the agent's transcript shows its turn ended and the file is still missing, or its last reply starts with `blocked:` (a partly written file), it fails with that reply quoted (agents are told to reply `blocked:` and the error). `--native-done` for an agent whose file is missing or has no claim fails after a short grace, naming the file.

## Host table

Support is decided per actor (host, runtime, transport) in `scripts/host-support.mjs`. On Claude Code
everything in this skill is supported.
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
the parse command in model-capabilities.md's "Codex seat" section. Do not inherit an unidentified runtime
default.

**What to read.** With `review-run`, the Quickstart and your host file are enough; configuration.md is for first-time setup and
review-profiles.md for the packet. Open the phase file for the phase you are running only for a failed step, a replaced seat, a
redaction round, the falsification pass or a re-review. [references/review-protocol.md](references/review-protocol.md)
holds the rules the seats, the auditor and the verifiers follow, and
`review-run` copies them into their briefs: read the sections a phase file
names (its section index gives their lines), not the whole file. In
model-capabilities.md read only the section for each runtime you selected.

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

The auditor re-checks every claim, also the ones the other reviewer conceded and the ones both reviewers raised: agreement between two seats is not proof that a finding is right.

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
   `codex exec resume --help` for `codex`. Do not read
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
   lists every flag the Claude CLI dispatcher uses, and writes `<run-dir>/run.json`, the seat
   table every later script reads. The check is free; `--probe-dispatch` only prints the one
   paid probe it would run unless `--yes-paid` is also given.

## Review phases

Read the reference for the phase being executed:

1. [Independent passes](references/phase-1-independent-passes.md):
   run Claude and Codex concurrently against the same snapshot.
2. [Cross-examination](references/phase-2-cross-examination.md):
   exchange completed findings once, preserving both original passes.
   `review-run phase2 --start` builds both delta briefs and `--wait`
   appends both rebuttal files.
3. [Scorecard](references/phase-3-scorecard.md):
   verify contested claims and retain unresolved disagreements. An opt-in
   Falsification pass independently checks a specific HIGH/CRITICAL disputed
   claim before synthesis, when the task explicitly requests it.

`scripts/review-run.mjs` runs the three phase commands from `run.json`: `phase1`, `phase2`
and `audit`, each with two halves (`--start` and `--wait`; `--prepare` and `--finish`), then
`manifest` and `report`. It builds every brief, appends the rebuttals and stages the auditor's
folder. Each phase call prints at most ten lines and one `next:` line, stops at the first failed step and keeps
every artifact. The phase files say what each step does and checks. `review-run splice` and
`review-run scan` are the redaction round's tools, `review-run verifier-brief` builds a
falsification verifier's brief, and `review-run recheck` drafts a re-review packet;
`review-run --help` prints every option. Full-tool readers (the Claude seat, the auditor) write
their own result files; the orchestrator never retypes a reviewer's or auditor's output.

`review-run` passes each seat's resolved model on every call, including resume, and its effort
only when the runtime supports it and the user explicitly selected it (never for `default`). A
native Claude seat uses the host's explicit model/effort mechanism. All arguments come from the
`run.json` snapshot of the run; the seat runs do not load user preferences.

Result metadata records requested model/effort; it is not proof of server-side
selection. Use runtime evidence for resolved values, otherwise record `null`
and explain what could not be verified. Any dispatcher error or missing seat
means the review is incomplete; do not synthesize a completed two-vendor verdict.

## Run checklist

1. Setup and Preflight above; state the resolved seats.
2. [Phase 1](references/phase-1-independent-passes.md): run directory,
   `preflight.mjs`, the frozen `task-packet.md`, then `review-run phase1 --start`
   (both briefs, both seats at the same time) and `phase1 --wait`.
3. Completion gate: `review-run phase1 --wait` validates both seat files against
   the target and the task packet and passes only when both are valid. A seat file must be in the strict format (`scripts/seat-file.mjs`: claim headings, exactly `## Checks performed` or only `## No findings`, and in that section exactly one `Blocked:` line; every claim has a `Same shape elsewhere:` line); `review-run phase1 --wait` returns a refused file to its seat once to rewrite (a CLI seat is resumed, a native seat gets a message file), and a file refused again makes the review INCOMPLETE (`phase1/format-refused.json`, shown by the manifest and the report). A `## No findings` seat that names a block is incomplete; a seat with claims and a block gets the "may have reviewed blind" caveat.
4. [Phase 2](references/phase-2-cross-examination.md): `review-run phase2 --start`
   (relabel, scan, both delta briefs; a CLI seat is resumed on its Phase 1 session, a native
   seat by the resume action the host file names), then `phase2 --wait` (appends both rebuttal
   files and validates). Extra tasks the user asked for (a
   fix design) run after it (phase 2, Extra tasks after the exchange).
5. [Phase 3](references/phase-3-scorecard.md): `review-run audit --prepare` (coin flip and the
   auditor's staged folder); falsification verifiers only on request; `audit --finish` (the fresh
   auditor, translate, the scorecard, cache and worktree cleanup).
6. `review-run manifest` and `review-run report`.

## Rules that apply throughout

1. **Keep the orchestrator's context small.** Run Phase 1 and Phase 2 in one
   session (a native seat resumes only from the session that started it).
   Every call re-sends the whole conversation, so the orchestrator's cost per
   step grows with its context: between reviews, start a new session or
   `/compact` once the context has grown large. Record the session's own cost with
   `review-run manifest --seat-transcript orchestrator=<session .jsonl>@<review start>/<review end>` (or `orchestrator=auto@<start>/<end>`, which finds this session's transcript; when one session runs several reviews, `review-run status` prints each run's first brief time, the latest safe `<start>`)
   (ISO times) on the review's first `review-run manifest`: in a session that runs
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
   and apply the reply with `review-run splice`.
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
13. Every report you relay or write keeps its attribution line, `Reviewed with
    <skill> <version> (SkillArray, MIT license): https://github.com/M-khalifa/SkillArray`,
    exactly as `review-run report` printed it: chat (short or `--all`), text,
    Markdown, HTML, JSON, and any PDF or document made from them. Paste the chat
    report verbatim and put your own notes after it; never shorten a report in a
    way that drops this line.

## Reviewing the same code again

Each fix pass adds new code, and the next review mostly finds bugs in that new code: in a four-round series on one module
about half of each round's findings came from the previous fixes. Review again after a fix pass only when the last round had a
finding that only one seat raised on code that was changed. Stop after the first round where each finding was raised by both
seats, or where nothing new is on changed code: another round costs the same tokens and finds less. A packet from `review-run recheck` carries a `Review round: N` line, and from round 3 the report asks you to step back: a test over every input combination the findings name, or a redesign, usually beats another round. The packet never names the old run folder (its manifest names the seats' models): `previous-run.json` next to the packet records it for you; keep it out of the seats' reach. Every `recheck` option is in [phase-3-scorecard.md](references/phase-3-scorecard.md), Re-review.

For a last check of a small fix diff, one fresh reviewer can be enough. Draft the packet with `review-run recheck
--from-run <old-run-dir> --out <new-run-dir>/task-packet.md` (or write the short packet in references/task-packet-template.md), spawn one fresh
agent (never a fork) with it, ask it to return its findings as text in its reply (a subagent may not be allowed to write a report file), and require evidence that fits each finding: a command and its output when the finding can be run, otherwise the cited lines (file:line and the quoted passage). Treat what it reports as leads to verify:
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
The phase references are maintained here and do not require updates to another skill.

Shared scripts, identical in both skills and checked by the repository-level `scripts/validate-repository.mjs`
(in the SkillArray repository, not in this folder): `claude-dispatch.mjs`, `codex-dispatch.mjs`, `detach-utils.mjs`, `worktree-utils.mjs`, `rollout-utils.mjs`,
`run-descriptor.mjs` (reads and writes `run.json`), `review-run.mjs` (the sequencer) and
`preflight.mjs`, with their tests. The host files `references/hosts/claude-code.md` and `references/hosts/codex.md` are not
parity files: each skill's host files differ where its transports differ.
