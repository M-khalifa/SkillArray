# Phase 1 — Independent passes

## Contents

- Run directory and source snapshot
- Pre-flight evidence and the task packet
- Start both seats concurrently
- Completion gate
- Stalled or unavailable seats

Resolve configuration and complete SKILL.md preflight before this phase.

## Run directory and source snapshot

Create a unique directory under the harness scratchpad or OS temporary directory.
For a run that may last more than a day (a resume after a usage limit, a series
of reviews), put the run directory and any source snapshot outside the OS
temporary directory: a temp cleaner such as Windows Storage Sense can delete
files older than a day mid-run, and in one review series it did.
Use an OS temporary-directory helper or a random run ID, not just the task slug.
Record its absolute path as `<run-dir>`; all later phases reuse it. Keep
`phase1/`, `phase2/`, and `phase3/` results separate, and give every CLI-seat
dispatch its own folder (`phase1/B/brief.txt`, `phase2/B/delta-brief.txt`, a
redaction brief in `phase3/redact-B/`): a dispatcher writes `result.json` next
to its brief, so two dispatches sharing a folder overwrite each other's audit.

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
(`build-brief.mjs --mode auditor --run-dir` refuses such a packet). The full
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
there with `-B` so none are written.

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

**Large targets: say where to start.** For a target of several thousand lines,
list in the packet the files and functions that matter most, in order, with
line ranges when known. A seat that reads whole files again and again pays for
every pass: in one review of a 2,500-line collector and a 2,000-line parser, the
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
(codex/opencode via `--cd` filesystem access, pair-review via Read/Grep).
With no `--base` given, or against a non-git target, the builder returns
`{packet: null, reason: "..."}` rather than guessing a scope; treat that the
same as not using it at all.

When the target is your own change against a ticket, list in the packet the
known deviations from its acceptance criteria, or write "none": an undisclosed
deviation is a finding the seats will spend a claim on.

When the target itself names things like a peer label (a design draft calling
its parsers "P0" and "P1"), declare a prefix for them as an outside checklist
(phase-2-cross-examination.md, Outside checklists): write in the packet
"the target's P0 and P1 are cited as DOC-P0 and DOC-P1", and pass `--checklist
DOC` to every `scan`, `append-rebuttals`, `audit-prep` and `translate`.
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
never a vendor name in the claim ID. Build both briefs with
[scripts/build-brief.mjs](../scripts/build-brief.mjs) so each carries the same
verbatim rule blocks (Standard seat instructions, Model identity, the findings
schema, and Web verification unless the task says "repo-only review"):

```text
node "<skill-dir>/scripts/build-brief.mjs" --mode phase1 --packet "<run-dir>/task-packet.md" --seat A --out "<run-dir>/phase1/brief-A.txt" --output-path "<run-dir>/phase1/A-findings.md"
node "<skill-dir>/scripts/build-brief.mjs" --mode phase1 --packet "<run-dir>/task-packet.md" --seat B --out "<run-dir>/phase1/B/brief.txt"
```

A hand-written brief is allowed only when the script cannot run; it must then
copy those sections verbatim.

Claude (seat A): use the selected seat-A model and supported effort mechanism.
Spawn it as a general-purpose agent (`Tools: *`), not a restricted-toolset
subagent type — this is what gives it WebFetch/WebSearch for the Web
verification rules in [review-protocol.md](review-protocol.md) and the
file-writing tool it needs for `--output-path`; naming a more restricted spawn
type silently loses both without any error to catch it. Tell it to read its
brief from the file and to write its findings to `phase1/A-findings.md`
itself, replying only with counts. The orchestrator then validates that file;
it never re-types a seat's findings from a reply, which doubles the token cost
of every finding and adds transcription risk. If the agent cannot write the
file, capture its reply verbatim instead and say so in the manifest. Give the
agent a unique name and keep its agent ID for the next phase. Its claims use
`A1, A2, ...`. It must not read seat B's findings during this phase.

Seat B: the brief from `build-brief.mjs` above, in its own folder.
Its claims use `B1, B2, ...`. It must not read seat A's findings during this
phase. Dispatch through whichever runtime was resolved for seat B — Codex or
OpenCode — never both, and never guess which one based on the provider name
alone; use the saved/resolved `runtime` field.

For a Codex seat B (quote substituted paths in shell):

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --brief "<run-dir>/phase1/B/brief.txt" --cd "<target-dir>" --sandbox read-only --model SELECTED_MODEL --web --final-message-out "<run-dir>/phase1/B-findings.md"
```

Append `--effort SELECTED_LEVEL` only for a non-default effort. Timeout: when
`--timeout` is omitted, both dispatchers stop the seat after 1800 seconds (30
minutes) and write `status: "timed-out"`. Pass `--timeout SECONDS` for a
different bound the user chose, or `--timeout 0` for no limit (a large target
at high effort can run longer than 30 minutes). Keep the same choice on every
dispatch of the run. `--web` enables Codex's native web search per Web verification in
review-protocol.md — always pass it unless the task text disabled web
verification ("repo-only review"); the brief must still carry the Web
verification rules verbatim regardless of this flag, since the flag alone
does not tell the model when or how to use the capability.

**Cap cost.** The per-fetch cost was measured directly: a single trivial
web-search turn under `codex exec --search` cost 12,758–13,454 tokens across
repeated tests, so five per seat per phase bounds web use to a known,
reportable amount. The report states both counts per seat. A fact-checking
task (a document whose main claims are external facts) may raise the cap in
the task packet; state the new cap there so both seats get the same one. Do
not raise it for an ordinary design or strategy document: in one such review
the seats used 3 to 5 queries and opened no pages under a raised cap of 8.

**Dispatch.** A Codex seat gets `codex-dispatch.mjs --web`, which prepends
Codex's global `--search` flag ahead of the `exec` subcommand (confirmed:
`codex exec --search` is rejected as an unrecognized argument; `codex
--search exec ...` works, and was independently verified via real `web
search:` tool-call traces returning genuinely fetched page content, on both
a fresh dispatch and an `exec resume`). A Claude seat already runs as a
full-tool agent (see Claude (seat A), above)
and needs only the Web verification rules in its brief, no dispatch-flag change. An
OpenCode seat has no web-capable flag on its CLI surface at all
(`opencode run --help` was checked directly) — `opencode-dispatch.mjs
--web` is accepted for call-site parity but does nothing, and its
result.json always records `webAccess: false`; this is a real capability
gap for an OpenCode seat, not silently routed through Codex or any other
runtime as a workaround.

The dispatcher starts every Codex call (fresh and resumed) with the user's
sub-agents, plugins, apps and skills catalog switched off (result.json
`configOverrides`). A seat with them on started a chain of three agents that
used 6.2M input tokens its result.json never showed. If result.json
`childThreads` is not empty, or the dispatcher prints a WARNING about spawned
agent threads, the seat did not run as one reviewer: say so in the report, and
`build-manifest --reviewer-result` records them as `child_threads`. Pass
`--keep-user-extensions` only when the user asks for their Codex extensions in
the seat.

For an OpenCode seat B:

```text
node "<skill-dir>/scripts/opencode-dispatch.mjs" --brief "<run-dir>/phase1/B/brief.txt" --cd "<target-dir>" --model SELECTED_MODEL --isolate --worktree "<run-dir>-worktree" --web --final-message-out "<run-dir>/phase1/B-findings.md"
```

Pass the same `--worktree "<run-dir>-worktree"` on every OpenCode dispatch of
the run: the Phase 1 and Phase 2 briefs are in different folders, so without it
each phase would build its own worktree and the reuse and drift check between
phases would never run. The folder sits next to the run directory, not inside
it, because the auditor later reads the worktree as the target snapshot.

`--web` is accepted here for call-site parity only — OpenCode has no
web-capable CLI flag, so this seat's `webAccess` is always `false` regardless
(see Web verification in review-protocol.md). Still include the Web
verification rules in its brief so it reports the gap explicitly rather than
silently reasoning without web access when a claim would have needed it.

(the saved `model` value already includes the `provider/` prefix, e.g. `google/gemini-x` — do not prepend the provider again.)

Append `--effort SELECTED_LEVEL` (accepted as an alias for OpenCode's own
`--variant` flag) only for a non-default effort. Append `--timeout`, same
condition as the Codex template. Always pass `--isolate` for a seat-B OpenCode
dispatch — it is what makes the read-only guarantee below real instead of
detection-only; see the read-only caveat for what happens when it fails.

Start the dispatcher as a background process while the Claude seat runs.

**Progress while the seats run.** Phase 1 took 7-28 minutes per seat in live
runs, so report status instead of waiting in silence: about every 10 minutes,
or when the user asks, give each seat's elapsed time and state. Seat A adds each
finding to `phase1/A-findings.md` as it confirms it (its brief asks for this),
so count its `## A<n>` headings for "seat A: 6 findings so far". This is
best-effort: a seat often writes all its findings at the end, so "0 so far"
does not mean it is stuck; report elapsed time instead. A Codex or OpenCode
seat writes nothing until it ends; report it as running with its elapsed time.
A partial `A-findings.md` is not a result: validate it only after the seat
replies "written". Run Phase 2 from this same orchestrator session: a harness
seat can be resumed only from the session that started it (see
phase-2-cross-examination.md). Write down each harness seat's agentId (for
`build-manifest --seat-transcript`, which sums its real token use from its
transcript) and the clock time when you start it and when it finishes (for
`--seat-usage`; the harness's own duration figure is not reliable, and its
`totalTokens` is only the last call's size; see review-protocol.md's Manifest
and final output). A number you did not record goes in as `unknown`, not a
guess.

Seat A writes `phase1/A-findings.md` itself (above). Seat B, in a read-only
sandbox, returns its complete findings as the final response; the orchestrator
does not save it: `--final-message-out` makes the dispatcher write
`phase1/B-findings.md` itself as UTF-8. Never re-save `finalMessage` through a
shell (Windows PowerShell 5.1 reads UTF-8 as the ANSI code page and garbles
every non-ASCII character), and never retype it. Accept any seat-written file only after validating it.
Never replace evidence with a summary.

**Read-only is enforced two different ways.** `codex-dispatch.mjs`'s `--sandbox
read-only` is enforced by the Codex CLI itself. `opencode-dispatch.mjs` has no
equivalent CLI flag, so `--isolate` instead redirects seat B into a disposable
`git worktree` copy of the target: edits land there, never in `<target-dir>`.
When `--isolate` was passed, the dispatcher itself refuses to run OpenCode at
all if isolation cannot be set up (target is not a git repo, or worktree setup
fails) — it exits non-zero with `status: "error"` rather than falling back to
running against the real target. Seat B's result.json therefore always shows
`isolated: true` on a completed run; a nonzero exit here is a failed pass like
any other, not a warning to note and continue past. `touchedFiles` remains a
secondary detection check, not the primary guarantee for OpenCode anymore.

## Completion gate

Wait for both processes/agents to finish. Require a zero dispatcher exit and
`status: completed` (a `timed-out` status, when `--timeout` was passed, ends
this attempt the same as any other failed pass — diagnose before retrying, do
not silently drop the timeout on retry), AND `scripts/blind-relabel.mjs
validate --phase1-dir <run-dir>/phase1` exits zero. A nonzero `validate` exit
means at least one claim block is missing a recognized `Severity:`, `Basis:`,
`Evidence strength:`, or non-empty `Evidence:` — return the affected seat's
file to its OWN context for reformatting (restate the required field lines
verbatim, change nothing else), the same procedure as a `scan` redaction
round, never a hand edit. A reviewer following the brief template loosely
(e.g. dropping the `Evidence:` label and going straight to prose) is common
enough in practice to gate here rather than discover it only when Phase 3's
`translate --phase1-dir` refuses much later. Validate seat B's `finalMessage`,
including an explicit no-findings statement if applicable. Preserve the
resumable session ID from Phase 1's result (`threadId` for Codex, `sessionId`
for OpenCode) in the run manifest; later dispatches must use this exact ID.
When `--isolate` was used, also preserve `worktreePath` from seat B's
result.json — Phase 2's resume dispatch reuses it, and Phase 3 removes it.

When seat B fails, read `result.json`'s `error`: it starts with the CLI's own
failure message (`codex reported: HTTP 401: ...`, also in `codexErrors`) and
leaves out Codex's MCP client log lines (`rmcp::...`), which a broken
connector can fill. The full stderr is in `result.stderr.log` (`stderrLog`).
**Long Codex seats on a machine low on memory.** The harness can stop a
background shell, and everything started in it, when memory runs low. Add
`--detach` to the dispatch: it starts the dispatcher as a separate worker (on
Windows through WMI, since a plain detached child is killed with the shell's
job) and returns at once. Then wait with
`node "<skill-dir>/scripts/codex-dispatch.mjs" --wait "<run-dir>/phase1/B/result.json"`,
which exits 0 when the seat completed and only reads files, so a stopped
`--wait` is simply run again. Exit 3 means the seat is still running after
`--max-wait` (540 s by default): run `--wait` again, as often as needed. Exit 1
means the seat failed or its worker is gone (the threadId to resume is
printed). The worker writes its output to
`dispatch-worker.log` next to the brief. It keeps this shell's PATH and
CODEX_HOME; other `--env-passthrough` variables must be set for the user.
The user can also turn this stopping off by starting Claude Code with
`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` in its environment (Claude Code's
own notice when it stopped a shell says so; setting it from a shell command inside
the session has no effect). Tell the user; never change their environment yourself.
Do not start Phase 1 over when the Codex thread still exists; resume it:

- `status: "running"` left behind means the dispatcher was killed (for
  example the harness stopped a background shell for low memory). The file
  already holds the `threadId`, written as soon as Codex started.
- `status: "rate-limited"` means the account hit a usage limit; wait until
  `retryAfter` (Codex's own text, in this machine's local time) with
  `node "<skill-dir>/scripts/codex-dispatch.mjs" --wait-retry "<result.json>"`,
  which exits 0 when that time has passed and 3 when it needs running again,
  like `--wait`. `retryAfter` can be days away (one run showed "Oct 3rd, 2026
  1:51 PM", which `--wait-retry` refuses as not a plain clock time) and can be
  pessimistic: when the user says the quota is back, resume once right away; a
  second `rate-limited` result means wait. For a wait of an hour or more, run
  `--wait-retry` in the foreground (it returns within `--max-wait`) and run it
  again, rather than as a long loop in a background shell, which the harness can
  stop when memory is low; or ask the user to say when the quota is back. If the
  user would rather not wait, see A provider becomes unavailable during Phase 1,
  under Stalled or unavailable seats below.
  On a large code target a Codex seat reads 5 to 10 million input tokens per call,
  mostly cached; in one series of reviews one quota window covered about three
  calls, so plan for a resume on long runs.

In both cases resume that thread in the same folder, with a short brief such
as "Continue the review and return your complete findings in the required
format" (same `--model`, same `--final-message-out`):

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --session <threadId> --cd "<target-dir>" --brief "<run-dir>/phase1/B/continue-brief.txt" --model SELECTED_MODEL --web --final-message-out "<run-dir>/phase1/B-findings.md"
```

Pass `--previous-result` with the interrupted call's result.json either way. When
that call recorded usage (a rate-limited call can, as one did), the resumed call's
`usage_delta` is its own cost; when it recorded none (a killed `running` file),
`usage_delta` says unavailable. In both cases the resumed call's `usage` is the
whole thread's. Only a dispatch that failed before
Codex named a thread (no `threadId`) is rerun from the start. Retry in the same folder: the dispatcher keeps each
earlier file as `result.attempt-1.json` (then `-2`, ...), so nothing needs
renaming by hand. In the manifest, pass only the completed call to
`--reviewer-result` (a Codex thread's usage is cumulative, so it covers the
interrupted work; build-manifest refuses a `running` file), and record the
interruption in that reviewer's entry as `"interrupted_resumes": <n>`.

Read `result.json` as UTF-8 (`Get-Content -Encoding UTF8` in Windows
PowerShell 5.1, or node). Plain `Get-Content` shows a curly quote as "â€™"
even though the file is correct. While seat B is still running or
being retried, `validate --phase1-dir <run-dir>/phase1 --seat A` checks seat
A's file on its own; the full two-seat `validate` still runs before the
exchange.

Run `validate` with `--target-dir "<target-dir>"`: it also rejects a claim ID
written inside an Evidence fence (a reviewer cross-referencing its own claim),
which would otherwise surface only later as a scan hard stop, and it skips
identifiers that come from the target itself (a hardware ID such as
`20:00:00:25:B5:00:00:0A`, `df -B1`, project phase names like "P1"). Add
`--source-dir "<repo>"` for every other repository the packet names by path, so
a verbatim quote from one of them is treated the same way. Use the same
`--source-dir` list on every `scan`, `append-rebuttals` and `audit-prep` in
this run. Add `--packet "<run-dir>/task-packet.md"` to `validate` too: it then warns
(it does not refuse) when a claim cites a line past the end of the file, such as
`Parser.py:345` in a 316-line file, and uses the paths the packet names to tell
which of several same-named files a bare `Parser.py` means. `exchange.mjs
prepare` passes it itself. Ask the seat to correct the line in its own file, or
say so in the report, so nobody tickets a wrong line.

After `validate` passes, copy both findings files to `phase1/original/`
(`exchange.mjs prepare` in Phase 2 does this) and never touch those copies again. A redaction made BEFORE the exchange is still
part of the independent pass (no peer has seen the file), so after it
re-validate and replace the `original/` copy; a redaction after the exchange
leaves `original/` alone, and the manifest notes it. Phase 2 appends rebuttals to the working files
in `phase1/`, so only the copies still hold what each seat wrote before it saw
its peer; `build-manifest.mjs --phase1` hashes the copies.

A pass can complete and still be too shallow to exchange (few claims, and its
own `Checks performed` says most checks were not run). Before Phase 2, the
orchestrator may resume the SAME seat once with a coverage brief that names the
unchecked scope; this is still the independent pass (the peer's findings are
not shown), and the manifest records it as `coverage_rounds: 1` for that seat.
Give a Codex/OpenCode coverage round its own brief folder (for example
`phase1/B-coverage/`): in `phase1/B/` the dispatcher would rename the
successful Phase 1 result to `result.attempt-1.json`, a name that reads as a
failed attempt. When the coverage round writes the seat's findings file again
through `--final-message-out`, add `--replace-completed`: both dispatchers
refuse to overwrite an existing `--final-message-out` file without it. In one
run a duplicate resume nearly replaced a seat's finished answer that way.

Both dispatchers write the same result.json schema (`codex-dispatch.mjs` and
`opencode-dispatch.mjs`'s own USAGE blocks list every field). Copy
`modelRequested`/`effortRequested`/`modelResolved`/`effortResolved`/`isolated`/
`worktreePath`/`isolationNote`/`webAccess` from each seat's result.json into
that seat's manifest entry verbatim (`build-manifest --reviewer-result
B=<result.json>` does this copy); `selectionNote` becomes the manifest's
`verification_note`. Codex seats always show `isolated: false,
worktreePath: null, isolationNote: null` (its read-only guarantee is a native
CLI flag, not a worktree). For an isolated OpenCode seat, `isolationNote`
records whether the worktree was reused or rebuilt and names any untracked
nested-git-repo directories that were skipped rather than copied in.

Inspect source-change evidence for both seats. `touchedFiles` (from either
dispatcher) is a best-effort git status difference, or a content-hash
inventory difference for a non-git `--cd`, not a sandbox guarantee —
for a Codex seat B or an isolated OpenCode seat B this is a secondary check;
for an OpenCode seat B that fell back to non-isolated (should not happen given
the hard stop above, but if it somehow did) this would be the only protection.
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
header is not a result: `validate --seat <A|B>` fails on it.

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
to the other skill when only that skill allows the new pairing (two Claude
models: pair-review; a non-Claude seat: cross-review). Move the unused seat's
folder out of `phase1/` and keep it, and build the new seat's brief with the
skill that now runs the review, from the same task packet. A seat that is
running or finished keeps its pass only when its brief differs from that
skill's `build-brief` output for the same packet and seat in text that is not a
rule (for example a new note on sizing the web cap); say which lines differ in
the report. Any changed rule means that seat starts over too. Record
`skill_versions` per phase and seat, the reason, and `"restarts"` on the
replaced seat. After the exchange has started there is no switch: resume the
seat, or report the review incomplete.
