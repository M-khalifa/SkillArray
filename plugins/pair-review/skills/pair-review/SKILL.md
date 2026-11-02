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
  version: 1.2.0
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
replaced, a scan stops the run, or you run the falsification pass or a re-review. Read `references/configuration.md` only for first-time setup and
`references/review-profiles.md` when you write the packet. Your host file (below) says how each actor is started.

```text
node "<skill-dir>/scripts/review-config.mjs" seats --host <claude-code|codex> --out "<work>/seats.json"   # decide web on or off (--repo-only) first: it cannot change once run.json exists; --falsification runs the deep-verify pass before the audit (a deep verify asked for after the audit works without it only with a native auditor, which can be resumed); from the saved choices; add --a <model> --b <model> (also --a-provider, --a-runtime, --a-effort) to override them for this run only, --auditor <model> to run the auditor on another model than seat A, --repo-only when web verification is off
node "<skill-dir>/scripts/preflight.mjs" --cd "<target>" --compact --out "<evidence-dir>/preflight.json" [--exec "<test command>"] [--timeout <seconds>] [--base <commit>]   # evidence for the packet (--base: list work already committed since that commit): run the tests here (--exec is refused with --host); keep <evidence-dir> outside the run folder
<write <run-dir>/task-packet.md from references/task-packet-template.md>
node "<skill-dir>/scripts/preflight.mjs" --host <host> --cd "<target>" --run-dir "<run-dir>" --seats "<work>/seats.json" [--keep-target-copy]   # --keep-target-copy keeps the target as reviewed in <run-dir>-target-copy, so the run can become a bench case (bench/case-from-run.mjs --target); it holds the target's code: delete it with the run folders
node "<skill-dir>/scripts/review-run.mjs" phase1 --run-dir "<run-dir>" --start --local     # starts CLI seats; native seats get a prompt file
<spawn each native seat with the prompt file the output names>
node "<skill-dir>/scripts/review-run.mjs" phase1 --run-dir "<run-dir>" --wait --native-agent A=<agent id, Codex thread id or rollout path> [--native-agent B=<...>]   # rerun on exit 3
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

On a Codex host the second `preflight` needs `--allow-trial` (an OpenAI pair, two native agents); a Claude pair there also needs `--probe-claude-session --yes-paid` (one paid check that a Claude CLI session survives a call). On Claude Code it needs no extra flag.
When `codex doctor` shows a failed sandbox row, the second `preflight` stops until you add `--yes-paid` (one small live `codex exec` probe) or `--skip-codex-doctor`; on a Codex host use `--skip-codex-doctor`, because a nested `codex exec` is blocked there.
On macOS an ASCII run-folder path is still the safe choice: the handling of a folder name quoted in another Unicode form is not yet verified on a Mac. With git 2.36 or later the review's own git commands turn the fsmonitor daemon off; with older git set `core.fsmonitor=false` for the target if your git config turns it on (each snapshot would start a daemon that outlives the run). Put the run folder, the evidence folder and the work folder outside the target, and the evidence folder outside the run folder (a packet that names the run folder is refused at `phase1 --start`; the second `preflight` warns first): the second `preflight` refuses a run folder inside it, because every dispatcher's write check would count the run's own files as target writes. With a Claude CLI seat keep them also outside the target's git repository, or in a folder that repository git-ignores: that seat's worktree snapshots the whole repository and the run's own files would break the Phase 2 resume.
A CLI seat or auditor runs with a filtered environment (OS basics, proxy and certificate variables, its CLI's own config folder). A seat that needs more, such as `CLAUDE_CODE_USE_BEDROCK` and the `AWS_*` variables of a Bedrock seat, gets them from `review-config seats --env A=CLAUDE_CODE_USE_BEDROCK,AWS_REGION` (repeat for B or auditor; the auditor takes seat A's list unless it has its own), `--env-mode <role>=inherit` (the whole environment) or `--use-api-key <role>` (ANTHROPIC_API_KEY, Claude only). run.json stores the names, never the values: on Windows a seat's worker starts through WMI with the user's own environment, so set those variables for the user, not only in this shell.
On Windows every CLI seat and CLI auditor runs inside a job object: a process its CLI starts (a server, a watcher) is stopped when the CLI ends, also one whose launcher has exited, and result.json `leftoversStopped` names it. The job adds a few seconds to each start. Where a sandbox refuses the job, result.json has `jobRefused` and the run warns that a process it started may still be running. On Linux and macOS the groups the CLI's tool commands lead are watched while it runs, and every process carrying the seat's run id (`REVIEW_SEAT_RUN_ID`, inherited also by one that left its group); what is still running when the CLI ends is stopped and named in `leftoversStopped`. On macOS the run id finds a job that is a non-Apple program (node, Homebrew python); an Apple system program (`/bin/sh`, `/bin/sleep`, `/usr/bin/perl`) hides its environment and is not found.
A Codex CLI seat runs with every MCP server off (it lists them with `codex mcp list --json` and passes `-c mcp_servers.<name>.enabled=false` for each), because such a server (node_repl, cua_repl) runs code outside its read-only sandbox; if that list cannot be read nothing is started. A native seat keeps the host's or the user's servers.
Give a Codex seat an explicit effort (`--b-effort high`, or `--a-effort` for an OpenAI seat A): with `default` a field run got a 61-second pass with one claim; the manifest records the effort the rollout ran with (`effort_resolved`; `codex-default (not reported)` on the default, which the rollout does not log), and `review-config seats` warns about a Codex seat left on it. Its read-only sandbox may not read a path outside the target, write a temp file (so test suites fail) or reach a port, as seen on Linux and Windows; on Windows its PowerShell may also run in Constrained Language mode, which refuses object creation (`ConversionSupportedOnlyToCoreTypes`). Its brief names no scratch folder and tells it to write no file, so give it executed test evidence another way: run the suite in preflight Tier 2 (`--exec`, `--compact`) and cite those logs in the packet, the way the packet template does; also paste the result lines (counts, failing tests) into the packet, because every brief holds the packet while a log outside the target may not be readable to this seat. To check what it can reach: `preflight --host ... --probe-reach --yes-paid` (one small paid call) checks the paths and ports the packet names, the second `preflight` and `phase1 --start` warn about paths outside the target on Linux and Windows, and a seat whose own lines say a read or command was blocked gets a "may have reviewed blind" warning and a report caveat. Preflight also runs `python` (`python3` on Linux and macOS), `rg` and `git` inside the Codex sandbox (`codex sandbox`, free) and warns about each one the seat cannot start, naming where this host has it (on Windows it runs them through PowerShell, the seat's shell, and the sandbox account cannot start a program installed under the user profile: install it for all users, or put a copy under Program Files on PATH; the per-user one can stay first); `phase1 --start` repeats the warning (`seat-tools.json`); `--skip-codex-doctor` skips it too.

If a native agent replies that it cannot read its brief (its shell or file tools time out), that is a host tool failure, not a reviewer finding: keep the agent and the run folder, do not respawn or hand-write its file, and report the review as incomplete until the tools work again, then resume the same agent. With `--native-agent`, `--wait` detects this itself: once the agent's transcript shows its turn ended and the file is still missing, or its last reply starts with `blocked:` (a partly written file), it fails with that reply quoted (agents are told to reply `blocked:` and the error). `--native-done` for an agent whose file is missing or has no claim fails after a short grace, naming the file.

## Host table

Support is decided per actor (host, runtime, transport) in `scripts/host-support.mjs`. On Claude Code a
Claude pair and an OpenAI pair are supported. On a Codex host the default route is two native OpenAI
agents, as a trial (`preflight.mjs --host codex --allow-trial`); a Claude pair also runs there as a trial,
only after a session probe (add `--probe-claude-session --yes-paid`). See [Codex](references/hosts/codex.md).
In a Claude pair both seats, the auditor and the verifiers
are Claude models; in an OpenAI pair they are all Codex CLI runs
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

The auditor re-checks every claim, also the ones the other reviewer conceded and the ones both reviewers raised: agreement between two seats is not proof that a finding is right.

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
   then the translate step, the scorecard or `joint-findings.md`, and the manifest.

`scripts/review-run.mjs` runs the phase commands from `run.json`: `phase1`, `phase2` and `audit`,
each with two halves (`--start` and `--wait`; `--prepare` and `--finish`), then `manifest` and
`report`. Each phase call prints at most ten lines and one `next:` line, stops at the first failed step and keeps
every artifact. The phase files say what each step does and checks. In mode `none` it skips Phase 2.
`review-run splice` and `review-run scan` (with `--phase1-dir` and `--forbid-seats`) are the redaction round's tools, `review-run
verifier-brief` builds a falsification verifier's brief, and `review-run recheck` drafts a
re-review packet; `review-run --help` prints every option.

**What to read.** With `review-run`, the Quickstart and your host file are enough; configuration.md is for first-time setup and
review-profiles.md for the packet. Open the phase file for the phase you are running only for a failed step, a replaced seat, a
redaction round, the falsification pass or a re-review. [references/review-protocol.md](references/review-protocol.md)
holds the rules the seats, the auditor and the verifiers follow, and
`review-run` copies them into their briefs: read the sections a phase file
names (its section index gives their lines), not the whole file.

## Run checklist

1. Setup above; resolve both models and confirm they are distinct. Resolve the host (Host table
   above) and run `preflight.mjs --host <host> --cd <target-dir> --run-dir <run-dir>
   --seats <seats.json>`: it checks the dispatcher and the `claude -p --help` flags and writes
   `<run-dir>/run.json`, the seat table every later script reads.
2. [Phase 1](references/phase-1-independent-passes.md): run directory,
   `preflight.mjs`, the frozen task packet, then `review-run phase1 --start`
   (both briefs, both seats at the same time) and `phase1 --wait`.
3. Completion gate: `review-run phase1 --wait` validates both seat files against
   the target and the task packet and passes only when both are valid. A seat file must be in the strict format (`scripts/seat-file.mjs`: claim headings, exactly `## Checks performed` or only `## No findings`, and in that section exactly one `Blocked:` line; every claim has a `Same shape elsewhere:` line); `review-run phase1 --wait` returns a refused file to its seat once to rewrite (a CLI seat is resumed, a native seat gets a message file), and a file refused again makes the review INCOMPLETE (`phase1/format-refused.json`, shown by the manifest and the report). A `## No findings` seat that names a block is incomplete; a seat with claims and a block gets the "may have reviewed blind" caveat.
4. [Phase 2](references/phase-2-cross-examination.md), unless mode is `none`:
   `review-run phase2 --start` (relabel, scan, both delta briefs; a CLI seat is resumed on its
   Phase 1 session, a native seat by the resume action the host file names), then
   `phase2 --wait` (appends both rebuttal files and validates). Extra tasks the user asked for (a
   fix design) run after it (phase 2, Extra tasks after the exchange).
5. [Phase 3](references/phase-3-scorecard.md): `review-run audit --prepare` (coin flip and the
   auditor's staged folder); falsification verifiers only on request; `audit --finish` (the fresh
   auditor, translate, the scorecard, cache and worktree cleanup); `joint-findings.md` in
   collaborate mode.
6. `review-run manifest` and `review-run report`.

## Rules that apply throughout

1. **Keep the orchestrator's context small.** Run Phase 1 and Phase 2 in one
   session (native seats resume only from the session that started them).
   Every call re-sends the whole conversation, so the orchestrator's cost per
   step grows with its context: between reviews, start a new session or
   `/compact` once the context has grown large. Record the session's own cost
   with `review-run manifest --seat-transcript orchestrator=<session .jsonl>@<review start>/<review end>` (or `orchestrator=auto@<start>/<end>`, which finds this session's transcript; when one session runs several reviews, `review-run status` prints each run's first brief time, the latest safe `<start>`)
   (ISO times) on the review's first `review-run manifest`: in a session that runs
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
   and apply the reply with `review-run splice`.
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

This directory is independently installable; neither package imports files from the other. Its
configuration helper, review protocol, review profiles, configuration and model-capability
references, `blind-relabel.mjs`, `build-brief.mjs`, `build-manifest.mjs`, `exchange.mjs`,
`preflight.mjs` and `snapshot-utils.mjs` are bundled with cross-review, and so are
`claude-dispatch.mjs`, `codex-dispatch.mjs`, `detach-utils.mjs`, `worktree-utils.mjs`, `rollout-utils.mjs`,
`run-descriptor.mjs` and `review-run.mjs`, with their tests. Keep those copies identical;
the repository-level `scripts/validate-repository.mjs` (in the SkillArray repository, not in this folder) checks them. The phase references are maintained here. The host
files `references/hosts/claude-code.md` and `references/hosts/codex.md` are not parity files: each
skill's host files differ where its transports differ.
