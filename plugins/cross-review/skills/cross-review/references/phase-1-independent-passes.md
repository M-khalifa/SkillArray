# Phase 1 — Independent passes

> **With `review-run` you do not need this file for the normal path.** SKILL.md's Quickstart lists the commands in order. Read it when a
> step fails, a seat must be replaced or resumed, or a scan or validation stops the run.

## Contents

- Run directory and source snapshot
- Pre-flight evidence and the task packet
- Start both seats concurrently
- Completion gate
- Stalled or unavailable seats

Resolve configuration and complete SKILL.md preflight before this phase.

## Run directory and source snapshot

Create a unique directory under the harness scratchpad or OS temporary directory.
Keep it outside the target (preflight refuses a run folder inside it, also in a git-ignored folder), and
outside the target's git repository unless it sits in a git-ignored folder (preflight refuses that layout
with a Claude CLI seat).
For a run that may last more than a day (a resume after a usage limit, a series
of reviews), put the run directory and any source snapshot outside the OS
temporary directory: a temp cleaner such as Windows Storage Sense can delete
files older than a day mid-run, and in one review series it did.
Use an OS temporary-directory helper or a random run ID, not just the task slug.
Record its absolute path as `<run-dir>`; all later phases reuse it. Keep
`phase1/`, `phase2/`, and `phase3/` results separate. Every CLI-seat call gets its own folder
(`review-run` uses `phase1/B/brief.txt` and `phase2/B/delta-brief.txt`; give a redaction brief
`phase3/redact-B/`): a dispatcher writes `result.json` next to its brief, so two calls sharing a
folder overwrite each other's audit.

Use the same source snapshot, including relevant dirty files, for both seats.
The default review must not edit the target. Give both seats the actual scope,
test commands, execution permissions, findings schema from
[review-protocol.md](review-protocol.md), and the no-source-edit/no-commit rule.
Tests requiring writes must use approved disposable locations; if that is not
possible, mark those checks blocked and report a non-EXECUTED basis instead.

## Pre-flight evidence and the task packet

Run pre-flight ([scripts/preflight.mjs](../scripts/preflight.mjs)) before
dispatching either seat, and include its output in the task packet. Pre-flight prints its WARNING lines on stderr: Windows PowerShell 5.1 shows
them as a NativeCommandError even when the exit code is 0, so judge the run by
its exit code. When Tier 2
runs a test suite, pass `--compact --out <evidence-dir>/preflight.json` with
`<evidence-dir>` next to the run directory, not inside it (the auditor gets
the packet and its log paths), and inline the compact JSON; the full logs and
any GUI captures stay in `<evidence-dir>` for EXECUTED citations. Check each
command's `touchedFiles`: files a test suite wrote into the target must be
cleaned or recorded before dispatch. For a target that is
not a git repository, pre-flight's `snapshotHash` is a content-hash inventory
of every file; record it, and re-run `--check-stale` at the end of the review
to prove the target did not change.

**Pre-flight evidence.** Before dispatching either seat, run
`scripts/preflight.mjs` against the target directory and include its output
in the task packet as a citable evidence source both seats may reference. By
default (no `--exec`) this runs Tier 1 only: `git diff`, `git status`, and the
changed-file list — pure repository-state inspection, never execution of
anything the target defines. Tier 2 (running the target's own test/lint/build
commands) requires the explicit `--exec "<command>"` flag per run; it is never
enabled silently. Every Tier 2 result is bound to a `snapshotHash` of the
target's exact state at capture time (git HEAD + diff + untracked contents for
a repository; a content-hash inventory of every file for a plain directory) —
before either seat cites Tier 2 output as `Basis: EXECUTED` evidence, re-run
`preflight.mjs --cd <target> --check-stale <snapshotHash>` and treat a
`stale: true` result as stale evidence, never citable as current. Pre-flight
output is raw fact only (command text, exit status, stdout/stderr verbatim) —
never interpretive text.

When Tier 2 runs a command with a large output (a full test suite), run
preflight with `--compact --out <evidence-dir>/preflight.json`, where
`<evidence-dir>` is a folder NEXT TO the run directory (for example
`<run-dir>-evidence`; never `<run-dir> 2`, which the auditor guard refuses
because a name continued by a space cannot be told apart from a path back into
the run directory), never inside it: the task packet cites these log paths and the auditor receives the packet, so a
path inside the run directory would point the auditor at real-ID files
(the auditor brief step of `review-run audit --finish` refuses such a packet). The full
stdout and stderr of each command and the Tier 1 diff go to log files, and the
JSON keeps each stream's byte count, sha256, last lines, the test-runner total
line (`summary`), and every fail/error/not-ok line that is not a passing test.
Inline that compact JSON in the task packet and give seats the log paths to
cite for `Basis: EXECUTED`; the sha256 proves a log was not edited. After a
wrong `--exec`, rerun into the same folder: pre-flight first deletes its own
earlier logs there (listed in `clearedEarlierLogs`) and leaves other files. Pasting
full test output into every brief costs roughly 12k-17k tokens per seat per
phase for lines that say "pass".

Scope: with `--cd` pointing at a subfolder of a repository (one app in a
monorepo), `snapshotHash` covers only that folder, so work elsewhere in the
repo does not make the evidence stale. Each Tier 2 command also reports
`touchedFiles` (files under `--cd` it created, changed, or deleted), and tier2
reports `targetChanged`. A test suite that writes into the target (dumps,
caches) is visible there before any seat starts; clean it up or record it in
the packet, or a seat can be blamed for a file the tests wrote. Gitignored
output is not covered.

A command with inner quotes or a path with spaces can be broken by the calling shell before pre-flight sees it
(Windows PowerShell 5.1 drops the inner quotes of a native argument). Put such commands in a file, one per line,
and pass `--exec-file <file>`: each line reaches the shell exactly as written. For another repository use `--exec-in-file <path> <file>` the same way.
On Linux and macOS, pre-flight kills an `--exec` command's process group when the command exits, so a job it left running in
the background stops with it; a process that left the group (`setsid`) is found by the run id it inherits and stopped too. On macOS the run id finds a job that is a non-Apple program (node, Homebrew python); an Apple system program (`/bin/sh`, `/bin/sleep`, `/usr/bin/perl`) hides its environment and is not found, and a process whose arguments hold the run id is matched too. On Windows each command runs in a job object: a background process it started, also one
whose launcher has exited, is stopped when the command ends, named in a WARNING and listed as `leftoversStopped`. Still
end such jobs inside the command itself. The job wrapper starts PowerShell first, which adds seconds to each command
(5 to 7 on a busy machine); `--timeout` counts that time.

With `--out`, pre-flight writes the JSON to the file and prints one summary line (hash, per-command exit codes,
`targetChanged`). The commands are under `tier2.results[]` (`command`, `exitCode`, `timedOut`, `timeoutS`, `touchedFiles`, and
`stdout`/`stderr` with `log`, `sha256`, `tail`, `summary`, `matches` under `--compact`), next to `tier2.snapshotHash`.

**Tests in a second repository.** `--exec-in <path> "<command>"` (repeatable) runs a Tier 2 command with `<path>` as
the working directory. Results for each path are listed under `tier2Repos`, with that repository's own
`snapshotHash`, `snapshotHashAfter`, `targetChanged` and per-command `touchedFiles`. Check each repository for
staleness with its own `preflight.mjs --cd <path> --check-stale <snapshotHash>`; `--exec` results stay bound to `--cd`.
With `--compact`, the command logs continue the `command-N` numbering after `--exec`'s.

**Repository freshness.** A local clone can be far behind its remote: in one
live run a HIGH security finding described code already fixed upstream, and
the clones were 72, 143 and 244 commits behind. Run pre-flight with
`--repo <path>` for every other repository the packet names by path, and
`--fetch` when network access is allowed (without it, the behind counts use
the last fetch; `lastFetchedAt` says when). The `repos` array gives, for
`--cd` and each `--repo`: branch, HEAD, upstream, ahead/behind, `origin/HEAD`
and `behindDefault`. Copy one line per repository into the packet (path,
branch, short HEAD, behind counts). When a count is above 0, say so in the
packet and either update the clone before the review or keep it and let the
seats check upstream (see review-protocol.md's All seats). Pass every file the packet names as
`--watch-file <path>`: `watchedChangedUpstream` then says which of them the
newer commits change (file, upstream branch, commit count), so the packet can
tell the seats exactly where the clone is out of date. Without `--fetch` that list reflects the last fetch only.
A source that is a plain export (`git archive`, a downloaded tarball) has no
git metadata; pass `--source-snapshot <folder>=<repo>@<ref>` instead (for
example `--source-snapshot exports/svc=org/svc@b45981e`; the ref is one commit
or tag, with no spaces), and
`sourceSnapshots` records the stated repo and ref with the folder's content hash.
Copy those lines into the packet too; the manifest's packet hash then covers them.
Python caches in a snapshot are left out of its hash and reported; run Python
there with `-B` so none are written. `py_compile` and `compileall` write `__pycache__`
even with `-B`, so a compile check run with `--exec` reports `targetChanged: true`:
remove that folder before dispatch, or record it in the packet.

Pre-flight also reports `reviewArtifactFiles` for `--cd` and each `--repo`:
files that hold review output with real claim IDs (a past run's findings file
or findings.json). The scan treats target text as safe, so such a file could
hide a real claim-ID leak. Move it out of the target, or list it in the packet
and expect more hard stops to be checked by hand. This check reads every text
file in `--cd` and each `--repo`, so a pre-flight over several large
repositories takes longer (reading six repositories, about 1.2 GB, took 18 s).

**Compute heavy evidence once.** When both seats would otherwise run the same
expensive work (a full test suite, replays over recorded real inputs, an
end-to-end harness), run it once as pre-flight Tier 2 (`--exec`, repeatable,
with `--compact`) and give both seats the log paths as `Basis: EXECUTED`
evidence. Tell the seats in the packet that these results exist and that
re-running them is not needed unless they doubt a result. In one live run this,
together with a narrower scope, cut the slower seat from 27.6 to 7.3 minutes
and the whole run from about 55 to 25 minutes. Seats still run their own
targeted checks.

**Static analysis tools.** A linter, type checker or secret scanner the target already uses runs the same
way, as a Tier 2 command (`--exec`): pre-flight never installs a tool, so name only tools on this host. Run a
secret scanner only in its redacting mode (for example `gitleaks detect --redact`): its log goes into the packet
and every brief, so an unredacted hit would copy the secret there. Tool output is a lead for the seats, not a
finding: a seat still confirms each hit in the code.

**Large targets: say where to start.** For a target of several thousand lines,
list in the packet the files and functions that matter most, in order, with
line ranges when known. A seat that reads whole files again and again pays for
every pass: in one review of a 2,500-line module and a 2,000-line module, the
Codex seat used 9.7 million input tokens, 97% of them re-reads of text it had
already seen. The seat still decides what else to read; the list is a start, not
a limit on scope.

**Context Builder (experimental, opt-in).** `scripts/context-builder.mjs` can
assemble a scoped starting packet — a diff against an explicit `--base`, the
changed-file list, colocated tests found by naming convention, and a
best-effort symbol-reference grep — instead of the default full-repository
free-text scope. Use it only when the task explicitly calls for scoped
context; it is never the default, because its scoped-vs-full recall has not
yet been benchmark-compared (see `bench/run-comparison.mjs`). If used, state
in the task packet that this is a starting point, not the complete relevant
context — both seats retain their full existing ability to read beyond it
(codex via `--cd` filesystem access, pair-review via Read/Grep).
With no `--base` given, or against a non-git target, the builder returns
`{packet: null, reason: "..."}` rather than guessing a scope; treat that the
same as not using it at all.

When the target is your own change against a ticket, list in the packet the
known deviations from its acceptance criteria, or write "none": an undisclosed
deviation is a finding the seats will spend a claim on.

When the target itself names things like a peer label (a design draft calling
its parsers "P0" and "P1"), declare a prefix for them as an outside checklist
(phase-2-cross-examination.md, Outside checklists): write in the packet
"the target's P0 and P1 are cited as DOC-P0 and DOC-P1", and add `DOC` to the
seats file's `flags.checklists` (review-run passes it as `--checklist DOC` to
every step that checks labels; give `review-run scan` the same `--checklist DOC`).
Otherwise every bare "P1" in a seat's own words is a hard stop at audit-prep.

When the target is a fix of an existing component, give the seats the
unchanged release version as a second snapshot, ask for one scenario matrix run
on both versions and compared (review-profiles.md, Code, Differential), and name
the platform behavior to test (for example how Windows share modes treat a file
another process holds open).

For a design document reviewed together with the code it cites, put the
document and each cited repository in the target (an export per repository with
`--source-snapshot`), choose the Architecture and Code lenses together
(review-profiles.md, Choosing and combining), and list the questions the seats
must answer as numbered hypotheses `H1, H2, ...` tagged in claim titles as
`[H1]`, so the scorecard's Hypotheses column maps findings to them.

For a binary document target, freeze the extraction first (review-profiles.md,
Document). If the orchestrator has hypotheses of its own about the target, list
them in the packet as `H1, H2, ...` under a heading that says they are
unverified; both seats must confirm or refute each (review-protocol.md,
Standard seat instructions).

Pick a lens from [review-profiles.md](review-profiles.md) (Code, Architecture,
or Document — inferred from the target, not asked of the user unless genuinely
ambiguous) and give both seats the same choice in the task packet.

## Start both seats concurrently

Both seats write findings under their own `A`/`B` claim numbering per
[review-protocol.md](review-protocol.md)'s Three label layers — never `CL`/`CX`,
never a vendor name in the claim ID. `node "<skill-dir>/scripts/review-run.mjs" phase1
--run-dir "<run-dir>" --start` builds both briefs from `run.json` and the task packet, so each
carries the same verbatim rule blocks (Standard seat instructions, the findings schema, and Web
verification unless `run.json` `flags.repoOnly` is true), plus the repository's REVIEW.md rules
when preflight wrote `<run-dir>/review-rules.md`. The brief step refuses a packet that points into
the run folder.

Seat A: it runs on the selected seat-A model and effort, through the transport the host file
names (a native agent on Claude Code, a Claude CLI seat that `review-run` starts otherwise). It
writes `phase1/A-findings.md` itself and replies only with counts; the orchestrator validates that
file and never re-types a seat's findings from a reply. If it cannot write the file, capture its
reply verbatim and say so in the manifest. Its claims use `A1, A2, ...`. It must not read seat B's
findings during this phase. How to spawn a native seat, and what to keep for the next phase, is in
the host file.

Seat B: its claims use `B1, B2, ...`. It must not read seat A's findings during this phase. It runs
on Codex.

`phase1 --start` starts every CLI seat detached (on Windows through WMI, since a plain detached
child is killed with the shell's job) and prints the brief path of each native seat. A CLI Claude
seat writes only into its own `phase1/seat-<role>/` folder. A Codex seat B runs in Codex's
`read-only` sandbox with web search on unless `flags.repoOnly` is true, and returns its findings as
its final message; the dispatcher writes that message to the findings file itself as UTF-8. Never
re-save `finalMessage` through a shell (Windows PowerShell 5.1 reads UTF-8 as the ANSI code page
and garbles every non-ASCII character), and never retype it. `--wait` waits for every seat, copies
each file-channel CLI seat's own file (`phase1/seat-<role>/`) to the canonical
`phase1/<role>-findings.md`, and runs the completion gate below. Each `--wait` call stops after
`--max-wait` (480 s by default) with exit 3: rerun the same command. A seat has no time limit unless
`run.json` `flags.timeoutS` names one; a seat stopped by that bound writes `status: "timed-out"`.

The brief must still carry the Web verification rules verbatim, since web access alone does not
tell the model when or how to use the capability. The web flag is Codex's global `--search` flag,
placed ahead of the `exec` subcommand (confirmed: `codex exec --search` is rejected as an
unrecognized argument; `codex --search exec ...` works, and was independently verified via real
`web search:` tool-call traces returning genuinely fetched page content, on both a fresh dispatch
and an `exec resume`). A Claude seat already runs as a full-tool agent (Seat A, above) and needs only
the Web verification rules in its brief.

**Cap cost.** The per-fetch cost was measured directly: a single trivial
web-search turn under `codex exec --search` cost 12,758–13,454 tokens across
repeated tests, so five per seat per phase bounds web use to a known,
reportable amount. The report states both counts per seat. A fact-checking
task (a document whose main claims are external facts) may raise the cap in
the task packet; state the new cap there so both seats get the same one. Do
not raise it for an ordinary design or strategy document: in one such review
the seats used 3 to 5 queries and opened no pages under a raised cap of 8.

**Codex extensions are off.** Every Codex call (fresh and resumed) starts with the user's
sub-agents, plugins, apps and skills catalog switched off (result.json `configOverrides`). A seat
with them on started a chain of three agents that used 6.2M input tokens its result.json never
showed. If result.json `childThreads` is not empty, or the run prints a WARNING about spawned agent
threads, the seat did not run as one reviewer: say so in the report; the manifest records them as
`child_threads`.

**Progress while the seats run.** Phase 1 took 7-28 minutes per seat in live
runs, so report status instead of waiting in silence: about every 10 minutes,
or when the user asks, give each seat's elapsed time and state (`review-run status` prints it).
Seat A adds each finding to `phase1/A-findings.md` as it confirms it (its brief asks for this),
so count its `## A<n>` headings for "seat A: 6 findings so far". This is
best-effort: a seat often writes all its findings at the end, so "0 so far"
does not mean it is stuck; report elapsed time instead. A Codex
seat writes nothing until it ends; report it as running with its elapsed time.
A partial `A-findings.md` is not a result: validate it only after the seat
replies "written". Run Phase 2 from this same orchestrator session: a harness
seat can be resumed only from the session that started it (see
phase-2-cross-examination.md). Write down each harness seat's agentId (for
`review-run manifest --seat-transcript`, which sums its real token use from its
transcript) and the clock time when you start it and when it finishes (for
`--seat-usage`; the harness's own duration figure is not reliable, and its
`totalTokens` is only the last call's size; see review-protocol.md's Manifest
and final output). A number you did not record goes in as `unknown`, not a
guess. Accept any seat-written file only after validating it. Never replace evidence with a summary.

**Read-only is enforced two different ways.** A Codex seat's `read-only` sandbox is enforced by
the Codex CLI itself. A CLI Claude seat is read-only another way: `fileTools` are enforced
(its file tools write only into its own folder) and `shell` is prompt-only, with its working
directory a worktree of the snapshot (the target itself when the target is not a git repository). A shell can still read
peer files and write by absolute path, so the report says so, and `touchedFiles` in each seat's
`result.json` is the check; read it after every seat.

## Completion gate

A seat file must be in the strict format (`scripts/seat-file.mjs`: claim headings, exactly `## Checks performed` or only `## No findings`, and in that section exactly one `Blocked:` line; every claim has a `Same shape elsewhere:` line); `review-run phase1 --wait` returns a refused file to its seat once to rewrite (a CLI seat is resumed, a native seat gets a message file), and a file refused again makes the review INCOMPLETE (`phase1/format-refused.json`, shown by the manifest and the report). A `## No findings` seat that names a block is incomplete; a seat with claims and a block gets the "may have reviewed blind" caveat.

Wait for both processes/agents to finish. `review-run phase1 --wait` requires a completed result
for every CLI seat (`status: completed`; a `timed-out` status ends this attempt the same as any
other failed pass — diagnose before retrying, and do not silently drop the timeout on retry), and
then runs `validate` on both seat files. A failed `validate` means at least one claim block is
missing a recognized `Severity:`, `Basis:`, `Evidence strength:`, or non-empty `Evidence:` —
return the affected seat's file to its OWN context for reformatting (restate the required field
lines verbatim, change nothing else), the same procedure as a `scan` redaction round, never a hand
edit. A reviewer following the brief template loosely (e.g. dropping the `Evidence:` label and
going straight to prose) is common enough in practice to gate here rather than discover it only
when Phase 3's translate step refuses much later. Seat B's file must hold an explicit
no-findings statement (`## No findings`) when it has no claims. The resumable session ID from
Phase 1's result (`threadId` for Codex) stays in `result.json`; every later call of that seat
uses this exact ID.

`validate` gets the target folder: it also rejects a claim ID written inside an Evidence fence (a
reviewer cross-referencing its own claim), which would otherwise surface only later as a scan
hard stop, and it skips identifiers that come from the target itself (a hardware ID such as
`20:00:00:25:B5:00:00:0A`, `df -B1`, project phase names like "P1"). List every other repository
the packet names by path in the seats file's `sourceDirs`, so a verbatim quote from one of them is
treated the same way; every later step gets the same list. It also gets the task packet: it then
warns (it does not refuse) when a claim cites a line past the end of the file, such as
`service.py:345` in a 316-line file, and uses the paths the packet names to tell which of several
same-named files a bare `service.py` means. Ask the seat to correct the line in its own file, or
say so in the report, so nobody tickets a wrong line.

When seat B fails, read `result.json`'s `error`: it starts with the CLI's own
failure message (`codex reported: HTTP 401: ...`, also in `codexErrors`) and
leaves out Codex's MCP client log lines (`rmcp::...`), which a broken
connector can fill. The full stderr is in `result.stderr.log` (`stderrLog`).
The detached worker writes its output to `dispatch-worker.log` next to the brief. It keeps this
shell's PATH and CODEX_HOME; other variables a seat needs come from `review-config seats --env`
and must be set for the user (SKILL.md, Quickstart). Read `result.json` as UTF-8 (`Get-Content
-Encoding UTF8` in Windows PowerShell 5.1, or node). Plain `Get-Content` shows a curly quote as
"â€™" even though the file is correct.

**A seat that ended badly.** When a CLI seat's call ended with an error, or its detached worker
died and left `status: "running"` behind (for example the harness stopped a background shell for
low memory), the next `review-run phase1 --wait` dispatches that seat again as a new session in the
same worktree (it does not resume the failed session) and keeps the earlier `result.json` as
`result.attempt-1.json` (then `-2`, ...), so nothing needs renaming by hand. The user can turn the harness's stopping of background shells off
for Claude Code (the Claude Code host file says how). Tell the user; never change their environment
yourself. In the manifest, record the interruption in that reviewer's entry as
`"interrupted_resumes": <n>`.

**A usage limit.** `status: "rate-limited"` means the account hit a usage limit. `review-run
phase1 --wait` then exits 3 with the time in `retryAfter` (Codex's own text, in this machine's local
time) until that time has passed, and dispatches the seat again after it. `retryAfter` can be days
away (one run showed "Oct 3rd, 2026 1:51 PM") and can be pessimistic: when the user says the quota
is back, rerun `--wait`; a second `rate-limited` result means wait. For a wait of an hour or more,
rerun `--wait` in the foreground (it returns within `--max-wait`) rather than as a long loop in a
background shell, which the harness can stop when memory is low; or ask the user to say when the
quota is back. If the user would rather not wait, see A provider becomes unavailable during
Phase 1, under Stalled or unavailable seats below. On a large code target a Codex seat reads 5 to
10 million input tokens per call, mostly cached; in one series of reviews one quota window covered
about three calls, so plan for a wait on long runs.

`review-run phase2 --start` copies both findings files to `phase1/original/` before the exchange,
and nothing touches those copies again. A redaction made BEFORE the exchange is still part of the
independent pass (no peer has seen the file): `phase2 --start` validates the corrected file and
copies it to `original/`. A redaction after the exchange leaves `original/` alone, and the manifest
notes it. Phase 2 appends rebuttals to the working files in `phase1/`, so only the copies still
hold what each seat wrote before it saw its peer; the manifest hashes the copies.

A pass can complete and still be too shallow to exchange (few claims, and its
own `Checks performed` says most checks were not run). Before Phase 2, the
orchestrator may resume the SAME seat once with a coverage brief that names the
unchecked scope; this is still the independent pass (the peer's findings are
not shown), and the manifest records it as `coverage_rounds: 1` for that seat.
Give a coverage round a brief folder of its own (for example `phase1/B-coverage/`), so the
successful Phase 1 result in `phase1/B/` is not renamed to an attempt file, and never let it
overwrite the seat's finished findings file by accident: in one run a duplicate resume nearly
replaced a seat's finished answer.

Both CLI runtimes write the same result.json schema. The manifest step copies
`modelRequested`/`effortRequested`/`modelResolved`/`effortResolved`/`isolated`/
`worktreePath`/`isolationNote`/`webAccess` from each seat's result.json into
that seat's manifest entry verbatim; `selectionNote` becomes the manifest's
`verification_note`. Codex seats always show `isolated: false,
worktreePath: null, isolationNote: null` (its read-only guarantee is a native
CLI flag, not a worktree). For an isolated Claude CLI seat, `isolationNote`
records whether the worktree was reused or rebuilt and names any untracked
nested-git-repo directories that were skipped rather than copied in.

Inspect source-change evidence for both seats. `touchedFiles` is a best-effort git status
difference, or a content-hash inventory difference for a non-git `--cd`, not a sandbox guarantee —
for a Codex seat B this is a secondary check; for a Claude CLI seat it is the check.
Empty does not prove already-dirty files were untouched on the git path; null
means unknown (a git or inventory probe failed). Unexpected edits require inspection
before trusting the pass. Never reset user changes automatically.

Do not enter Phase 2 until both complete independent findings are persisted.
A failed pass ends this attempt as incomplete. Diagnose before any retry;
do not automatically retry indefinitely or discard a requested model option.

## Stalled or unavailable seats

Before replacing a stalled harness seat, resume it once with SendMessage
("continue and write your findings to the file"): a seat the stream watchdog
stopped after writing only its header has resumed and finished that way, and a
seat may be resumed more than once. A findings file that holds only the seat
header is not a result: the completion gate refuses it.

**Replacing a stalled seat.** A harness seat that stops making progress in
Phase 1 (the harness watchdog ends it, or it wrote nothing for a long time)
may be replaced by a new agent given the same Phase 1 brief, but only before
any findings are exchanged: after the exchange a new agent would have to
defend claims it never made. First rename the partial file to
`<seat>-findings.attempt-<n>.md` in the same folder, so the new seat starts
from an empty file and the partial work stays as evidence. Record it in that
reviewer's manifest entry as `"restarts": <n>`. A seat that stalls after the
exchange has started is resumed, or the review is reported incomplete; it is
never replaced. A harness seat is resumed from the orchestrator session that
started it; if that session ended, resume the session first
(phase-2-cross-examination.md, When the orchestrator session ended).
**A provider becomes unavailable during Phase 1** (a usage limit the user will
not wait out, a lost login). Before any findings are exchanged, that seat may
move to another provider under the replacement rule above, and the run may move
to the other skill when only that skill allows the new pairing (two models of one vendor:
pair-review; two vendors: cross-review). Move the unused seat's
folder out of `phase1/` and keep it, and build the new seat's brief with the
skill that now runs the review, from the same task packet. A seat that is
running or finished keeps its pass only when its brief differs from the brief that
skill's `review-run phase1 --start` builds for the same packet and seat in text that is not a
rule (for example a new note on sizing the web cap); say which lines differ in
the report. Any changed rule means that seat starts over too. Record
`skill_versions` per phase and seat, the reason, and `"restarts"` on the
replaced seat. After the exchange has started there is no switch: resume the
seat, or report the review incomplete.
