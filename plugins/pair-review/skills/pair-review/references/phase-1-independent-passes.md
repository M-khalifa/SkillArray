# Phase 1 — Independent passes

> **With `review-run` you do not need this file for the normal path.** SKILL.md's Quickstart lists the commands in order. Read it when a
> step fails, a seat must be replaced or resumed, or a scan or validation stops the run.

## Contents

- Run directory and task packet
- Pre-flight evidence
- Start both seats
- Completion gate
- Stalled or unavailable seats

Resolve configuration and validate availability (SKILL.md, Review phases)
before this phase.

## Run directory and task packet

Read the target. Give both seats the same task packet: scope,
current source snapshot, actual test commands, constraints, and expected
output, with the pre-flight output (Pre-flight evidence, below). Pick a lens from
[review-profiles.md](review-profiles.md) (Code,
Architecture, or Document — inferred from the target, not asked of the user
unless genuinely ambiguous) and give both seats the same choice.

Create a unique run directory under the harness scratchpad or OS temporary
directory; for a run that may last more than a day, put it and any source
snapshot outside the temporary directory, since a temp cleaner such as
Windows Storage Sense can delete files older than a day. Assign `<run-dir>/phase1/A-findings.md` and
`<run-dir>/phase1/B-findings.md`; keep artifacts outside the reviewed
source (preflight refuses a run folder inside the target, also in a git-ignored folder), and outside its git
repository unless they sit in a git-ignored folder (preflight refuses that layout with a Claude CLI seat). Include a run ID in both agent names.

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

## Pre-flight evidence

Pre-flight prints its WARNING lines on stderr: Windows PowerShell 5.1 shows
them as a NativeCommandError even when the exit code is 0, so judge the run by
its exit code.

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

## Start both seats

Start both isolated reviewers at the same time, each on its selected model and effort. Pass
the protocol and task explicitly; do not assume subagents inherit this conversation.
`node "<skill-dir>/scripts/review-run.mjs" phase1 --run-dir "<run-dir>" --start` builds both
briefs from `run.json` and the task packet. Each brief copies review-protocol.md's seat rules,
findings schema and web reviewer rules verbatim (plus the repository's REVIEW.md rules when
preflight wrote `<run-dir>/review-rules.md`), and tells the seat to write its findings to its own
file and reply only with counts; the orchestrator never retypes a seat's findings from a reply.
The brief step refuses a packet that points into the run folder. Tell each seat to read its brief
from the file. In Phase 1, neither seat may read the peer's file. Review only; no source edits or
commits. Do not set a time or token limit on a seat: a seat stopped part-way is a failed pass
that has to be rerun, which costs more than letting it finish. Apply a limit only when the user
asks for one, and then treat an exceeded limit as an incomplete review for that seat, never as a
completed one.

`phase1 --start` starts each CLI seat detached (a Claude seat writes only into its own
`phase1/seat-<role>/` folder, except on a Codex host, where it answers in its final message because Claude
Code refuses its file writes there; a Codex seat returns its answer as the final message, which is saved
for it) and prints the brief path of each native seat. Spawn each native seat through the transport
the host file names, with full tools so it keeps web access. `--wait` waits for both, copies each
file-channel CLI seat's file to `phase1/<role>-findings.md`, compares the two resolved model IDs
(Claude: `init`; Codex: the thread rollout; native seats: the requested IDs, recorded as
`family-distinct`) and stops if they are equal, then runs the completion gate below. When a CLI
seat ended badly (an error, or a detached worker that died), the next `--wait` dispatches that seat
again as a new session in the same worktree (the one its failed attempt recorded); it does not
resume the failed session. Both briefs carry review-protocol.md's "Web verification: reviewer
rules" subsection unless `run.json` `flags.repoOnly` is true (`review-config seats --repo-only`) —
both pair-review seats come from one vendor, so this capability is symmetric between seats by
construction. While both run, report status about every 10
minutes or when the user asks: each seat's elapsed time and how many
`## A<n>`/`## B<n>` headings its file holds so far (the brief asks each
seat to add findings as it confirms them). A partial file is not a result;
validate only after the seat replies "written". Record each seat's transcript or result for
`review-run manifest` as the host file says, and its duration for `--seat-usage`.

**Cap cost.** The per-fetch cost was measured directly: a single trivial
web-search turn under `codex exec --search` cost 12,758–13,454 tokens across
repeated tests, so five per seat per phase bounds web use to a known,
reportable amount. The report states both counts per seat. A fact-checking
task (a document whose main claims are external facts) may raise the cap in
the task packet; state the new cap there so both seats get the same one. Do
not raise it for an ordinary design or strategy document: in one such review
the seats used 3 to 5 queries and opened no pages under a raised cap of 8.

## Completion gate

A seat file must be in the strict format (`scripts/seat-file.mjs`: claim headings, exactly `## Checks performed` or only `## No findings`, and in that section exactly one `Blocked:` line; every claim has a `Same shape elsewhere:` line); `review-run phase1 --wait` returns a refused file to its seat once to rewrite (a CLI seat is resumed, a native seat gets a message file), and a file refused again makes the review INCOMPLETE (`phase1/format-refused.json`, shown by the manifest and the report). A `## No findings` seat that names a block is incomplete; a seat with claims and a block gets the "may have reviewed blind" caveat.

Wait for both independent passes to complete. `review-run phase1 --wait` then runs `validate`
on both seat files. It passes the target folder (so it also rejects a claim ID a seat wrote
inside an Evidence fence), every repository in the seats file's `sourceDirs` (list there every
other repository the packet names by path; every later step gets the same list), the task packet
(so it warns about a claim citing a line past the end of the file) and the `flags.checklists`
names. `review-run phase2 --start` copies both files to `<run-dir>/phase1/original/` before the
exchange (the manifest hashes these untouched copies; Phase 2 appends to the working files). A
failed `validate` means at least one claim block is missing a recognized `Severity:`, `Basis:`,
`Evidence strength:`, or non-empty `Evidence:` line — return the affected seat's file to that
seat's OWN context for reformatting (restate the required field lines verbatim, change nothing
else), same procedure as a `scan` redaction round, never a hand edit. A reviewer following the
schema loosely (dropping the `Evidence:` label and going straight to prose) is common enough in
practice to gate here, before it surfaces only much later as a refusal of the translate step in
`audit --finish`. A reviewer may return after
its initial pass; resume it for the exchange. This avoids agents waiting
indefinitely for a peer that has not been released by the orchestrator.
Missing files may be recovered verbatim from a valid final response.

In a Claude pair both seats are Claude subagents with file-writing tools, so no sandbox
stops a source edit. In an OpenAI pair both seats run in Codex's `read-only` sandbox, which is enforced, and `touchedFiles` is still checked. For a Claude CLI seat `fileTools` are enforced and `shell` is prompt-only: a shell can
still read the peer's files and write by absolute path, so the report says so and `touchedFiles` in
each `result.json` is the check. After each phase (Phase 1, the exchange, and the
auditor), `review-run` checks the target against its Phase 1 fingerprint; to check it yourself, run
`scripts/preflight.mjs --cd <target-dir> --check-stale <snapshotHash>` with the hash from pre-flight. `stale: true` means something
changed the target during the review: stop, find the changed files, and
report the run as incomplete; never continue on a changed target.

A pass can complete and still be too shallow to exchange (few claims, and
its own `Checks performed` says most checks were not run). Before the
exchange, you may resume that SAME seat once with a coverage brief naming
the unchecked scope; the peer's findings are not shown, so it is still the
independent pass. Record it in the manifest as `coverage_rounds: 1`.

A redaction made before the exchange (no peer has seen the file yet) is
still part of the independent pass: `review-run phase2 --start` runs `validate` on both files
again and then copies the corrected file to `phase1/original/`. A redaction after the exchange leaves
`original/` alone, and the manifest notes it.

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
(phase-2-cross-examination.md, Resuming each seat).
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
