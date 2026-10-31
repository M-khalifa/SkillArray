# Seat A findings

## A1 — [AC-1] [AC-10] A declared block is dropped when a later "Blocked: none" follows it: a No findings seat that said it was blocked passes phase1 --wait as clean (exit 0)
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat file with two `Blocked:` lines in its No findings / Checks performed text, a block first and `Blocked: none` after it (for example a block named in the No findings paragraph and `Blocked: none` closing a later Checks performed section). Holds everywhere. Uncommon, since the brief asks for one line, but nothing rejects a second line and the reader keeps only the last.
Evidence:
```
review-run.mjs:762-776 seatBlockedLine: loops over every line and assigns `value` each time a line matches,
  so the LAST matching line wins:  if (m) value = /^none\.?$/i.test(m[1].trim()) ? '' : m[1].trim();
review-run.mjs:815-819: with declared === '' neither StepError is thrown.

Direct call (a scratch probe importing the shipped review-run.mjs):
  seatBlockedLine("## No findings\n\nBlocked: the target folder: EACCES\nBlocked: none\n")  ->  ""

End to end (disposable copy of the skill, review-run.test.mjs setup helper; seat letters in this quote renamed: N = the native seat, C = the CLI seat;
N-findings.md = "## No findings" / "Blocked: every file in the target: EACCES" / "Blocked: none"):
  review-run phase1 --wait --max-wait 1 --native-done A
  PROBE conflict: exit 0
  seat N: output found (native, agent reported done)
  validate Phase 1: clean
  next: run: review-run phase2 --run-dir ... --start
(no warning line for seat N, no seat-warnings-phase1.json record, so no report caveat)
```
Suggested fix: in seatBlockedLine keep the first non-none value (`if (m && value !== null && value !== '') continue;` style: a declared block is never overwritten by a later `none`), or treat two lines with different values as a block.
Same shape elsewhere: the same reader feeds the seats-with-claims branch at review-run.mjs:822-825, so a claims seat with a block line followed by `Blocked: none` loses its "says it was blocked" warning and its seat-warnings-phase1.json record (build-manifest.mjs:254, build-report.mjs:744 caveat); identical copy in plugins/cross-review/skills/cross-review/scripts/review-run.mjs. No other reader of `Blocked:` found (grepped both skills' scripts for "Blocked").

## A2 — [AC-1] [AC-5] On the documented manual route no script reads the `Blocked:` line and the Completion gate does not tell the orchestrator to: a No findings seat that declares a block, or writes no line, passes the completion gate (validate exits 0) and no report caveat is recorded
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: an orchestrator follows SKILL.md "Completion gate" step 3 / phase-1-independent-passes.md "Completion gate" (build-brief + validate by hand, no review-run sequencer). Holds everywhere.
Evidence:
```
Only reader of the line: review-run.mjs assertSeatsRan (called only from phase1 --wait, review-run.mjs:889).
grep "Blocked" in blind-relabel.mjs: no match.

Scratch phase1 dir (seat letters renamed to N and C): N-findings.md = "## No findings" + "Blocked: every file in the target: EACCES";
C-findings.md = "## No findings" + "All good." (no line)
$ node .../scripts/blind-relabel.mjs validate --phase1-dir <scratch>/man/phase1 --target-dir <scratch>/man/target
validate clean: every claim block in both seats has a recognized Severity/Basis/Evidence strength/Evidence, ...
exit 0

SKILL.md:183-184  "3. Completion gate: `blind-relabel.mjs validate --phase1-dir <run-dir>/phase1 --target-dir <target-dir> --packet <task-packet>` exits 0."
phase-1-independent-passes.md "## Completion gate": names validate only; says nothing about the Blocked: line.
review-protocol.md:235-238 tells the seat "The orchestrator reads only this line to tell a full review from a blind one", but no orchestrator-facing step on this route says to read it.
```
Suggested fix: add one sentence to both Completion gate passages (SKILL.md step 3 and phase-1-independent-passes.md) telling the orchestrator to read each seat's last `Blocked:` line and treat a No findings seat with a block or no line as incomplete; or make `validate` apply the same noFindingsOnly/seatBlockedLine rule.
Same shape elsewhere: the identical passages in plugins/cross-review/skills/cross-review/SKILL.md and plugins/cross-review/skills/cross-review/references/phase-1-independent-passes.md (same text); seats with claims on this route also lose the "says it was blocked" warning and the seat-warnings-phase1.json record, so build-report.mjs:744 never shows the caveat.

## A3 — [AC-4] A Codex seat that has printed its final answer but does not exit is held until --timeout, recorded as timed-out, and its finished answer is thrown away by a fresh re-dispatch
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a `codex exec` process that stays alive after its `turn.completed` event (a hook or helper child holding it open). Holds everywhere; how often real Codex does this is unknown here. With the default `--timeout 1800` the seat is held 30 minutes, then started again from nothing.
Evidence:
```
codex-dispatch.mjs:744-752  the run resolves only on child 'close'; 'turn.completed' (line 704) only stores usage.
codex-dispatch.mjs:1215-1224  timedOut -> result.json status 'timed-out', finalMessage kept only inside result.json, exit 1.
review-run.mjs:199-201  endedBadly(): any status other than running/completed -> re-dispatch (line 614-623,
  "previous attempt ended with status ... dispatched again").

Repro: fake `codex` on PATH (scratch fakecodex.cjs via codex.cmd): answers `mcp list` with [], then on exec prints
thread.started, item.completed agent_message "written: 2 claims, 1 HIGH, 1 LOW", turn.completed, and sleeps 600 s.
$ node codex-dispatch.mjs --brief <scratch>/cx/brief.txt --cd <scratch>/cd1 --timeout 15
exit 1 after 18 s
relay: codex exec killed after exceeding --timeout 15s
result.json: status=timed-out finalMessage="written: 2 claims, 1 HIGH, 1 LOW" error="codex exec killed after exceeding --timeout 15s"
tasklist /FI "PID eq <fake pid>": INFO: No tasks are running which match the specified criteria.   (killed at the timeout, not before)
```
Suggested fix: in runCodex, on `turn.completed` after a non-empty agent_message, start a short grace timer (for example 30 s) that kills the tree and resolves with code 0 and the stored finalMessage, so the answer is kept as a completed run.
Same shape elsewhere: claude-dispatch.mjs:265-272 (the `result` event is only stored; the run resolves on close or timeout, read statically, not executed); opencode-dispatch.mjs:599 also resolves on close (not traced further); the probe runner in preflight.mjs codexExecProbe (line ~1530) also resolves only on close, bounded by CODEX_PROBE_TIMEOUT_MS.

## A4 — [AC-9] The new packet path scan drops existing paths written in common Markdown or option shapes that the old scan found (bold, a Markdown link, `--opt=path`, a table cell with no spaces, an encoded-colon file URL), and turns a comma-joined pair into one false "does not exist" path
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a task packet that writes an evidence path as `**C:\x\b.log**`, `[b.log](C:\x\b.log)`, `--log=C:\x\b.log`, `|C:\x\b.log|`, `file:///c%3A/x/b.log` (the encoded form some editors copy), or `a.log,b.log`. Holds everywhere (the Windows drive-less form is Windows only). Only the advisory warnings depend on it: the "does not exist" note, the other-run-folder warning and the Linux reach warning in phase1Start, and the reach probe items.
Evidence:
```
Scratch probe, shipped packetReach from preflight.mjs, existing file <scratch>/ev/b.log (found = outside + otherRuns):
bold               Evidence: **<b>**              {"out":[],"nf":[]}
italic             Evidence: _<b>_                {"out":[],"nf":[]}
mdLink             Evidence: [b.log](<b>)         {"out":[],"nf":[]}
eqOpt              Run with --log=<b>             {"out":[],"nf":[]}
tableCellNoSpace   |<b>|                          {"out":[],"nf":[]}
commaList          <b>,<gone>                     {"out":[],"nf":["ev\b.log,C:\...\ev\gone.log"]}
(control rows found: paren, angle, quoted with :12:3, drive-less, file:/// with %20, backticked, "| x | <b> |")
file:///c%3A/Users/.../ev/b.log                   {"found":0,"nf":[]}
decodeFileUrls("file:///c%3A/Users/a%20b/x.log") -> "/c:/Users/a b/x.log"   (path-utils.mjs:31-34: the "/C:/" fix runs before %3A is decoded)

Old scan (since.diff old lines 356 and 395): the start regex had no anchor at a word start (lookbehind (?<![\w:/\\.~-])),
so "*", "(", "=", "|" before "C:" did not stop it, and the text was cut at /[`'"<>|*?]/ -> "**<b>**", "[x](<b>)",
"--log=<b>" and "|<b>|" each gave <b> (static trace of the deleted lines; the old file was not run).
preflight.mjs:427-428: new wordsOf strips only ^["'(<\[]+ at a word start and ["'.,;:)\]>]+ at its end.
```
Suggested fix: in wordsOf also strip leading `*_|=` and trailing `*_|` and split a word at `](`, `=` and `,`; in decodeFileUrls decode %XX before the `/C:/` rewrite.
Same shape elsewhere: build-brief.mjs runDirNamedIn uses decodeFileUrls too, but its own PATH_START_RE also starts at the `c:/` inside "/c:/Users", so the guard still refuses that form (checked: no gap there); plugins/cross-review copies of preflight.mjs and path-utils.mjs are identical.

## A5 — [AC-2] [AC-5] The new "Project knowledge" paragraph says seats never read the user's memory or skills, but a native seat starts with the user's global instructions, the user's memory index for the target project and the skill list in its context, including earlier review verdicts
Severity: HIGH
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Trigger: every native seat (transport "native", spawned with the orchestrator's agent tool) on a host that loads user-level instructions and per-project memory into sub-agents; seen during this run on this host, for this target. CLI seats started with the dispatcher's `--setting-sources project` are not covered by this claim (not checked).
Evidence:
```
SKILL.md:53 (pair-review; same text in task-packet-template.md:115-121 of the diff):
  "The seats read the target and the project's CLAUDE.md, AGENTS.md and REVIEW.md, but never the user's memory or
   skills (to keep them blind and independent), so the packet is how that knowledge reaches them."

Host behaviour seen during this run (paraphrased, no names copied): a sub-agent spawned with the host's agent tool starts with
  - the user's global instruction file and its imported rule files, including a rule about review-run folders and the
    subagent cap per run;
  - the user's auto-memory index for this repository, with entries that describe earlier review rounds of these two
    skills as "all fixed", name a decision "taken unattended", name a reviewer vendor and its sandbox state, and list
    queued items for the maintainer;
  - the user's list of installed skills, including both review skills.
Nothing in the brief, the packet, references/hosts/*.md "Native seats" or claude-code.md:84-105 tells the orchestrator
that a native seat gets this, or tells the seat to set it aside.
```
Suggested fix: correct the sentence in SKILL.md and task-packet-template.md to say that a native seat inherits the host's user instructions and memory, and add one line to the "All seats" rules telling a seat to treat user memory and earlier verdicts in its context as unverified and never as evidence; where full independence matters, run seats as CLI seats.
Same shape elsewhere: plugins/cross-review/skills/cross-review/SKILL.md and plugins/cross-review/skills/cross-review/references/task-packet-template.md carry the same sentence; the native auditor route (review-protocol.md "Fresh-context auditor") gets the same context, so "fresh-context" holds only for what the run passes it, not for host memory (inference, not observed for an auditor).

## Checks performed

- AC-1: ran phase1 --wait end to end in a disposable copy (native seat, review-run.test.mjs setup helper) with three No findings shapes, and validate on a hand-built phase1 folder. A block followed by `Blocked: none` passes clean; the manual route never reads the line. NOT MET (claims A1, A2).
- AC-2: run-folder guard probed through the shipped build() with 8.3 short name, `\\localhost\C$\` UNC (both slash forms), `\\?\` prefix, `%SystemDrive%`, encoded-colon file URL: all refused; the doc's statement about seat memory is wrong for native seats. NOT MET (claim A5).
- AC-3: not reconciled independently this round beyond the counts printed in the runs above (validate and preflight summaries matched their inputs); a gap not closed for lack of time, not a defect seen. PARTIAL
- AC-4: fake codex that hangs after its answer: dispatcher held to --timeout, answer discarded by re-dispatch; process list (Win32_Process filtered on this scratch folder) empty after every run here. NOT MET (claim A3).
- AC-5: review-protocol.md section index checked line by line in both skills (all match); README, SKILL.md and references grepped for the deleted wording guess, the deleted leftover-path warning and host-ending lists: none left. Manual completion gate and the memory sentence are wrong. NOT MET (claims A2, A5).
- AC-6: read the old-record path: build-report still renders seat_blind_lines from an older seat-warnings record (only the caveat wording changed). MET.
- AC-7: no removable code found worth a claim. MET.
- AC-8: linux-2 items 1, 5 and 7 (path scan, ports, variable spellings) hold on the shipped functions (scratch probe rows); items 2 and 3 deleted by design; items 4 and 6 under Known deviations. mac-2 items 1 and 2 (recheck refusals, diff line 240 and its test), item 3 (guard, matrix test and my probes), item 4 (verification errors now prefixed `--verification-dir:` at blind-relabel.mjs:2068), item 5 (watchUpstreamChanges compares through realPath, preflight.mjs:972-974): fixed. linux-1 and mac-1 read by heading and spot-checked only (native "blocked:" reply check at review-run.mjs:228-235, reach-probe cap with notProbed warning, status truncation fix in runStatus); the sibling packet-path shapes in claim A4 are new, not feedback items. PARTIAL
- AC-9: seatBlockedLine: old reader took `**Blocked:** none` as a block and `Blocked: nothing` as none; new reads them as no line and as a block, both stated in the change. packetPorts: bare dotted names dropped by stated design. packetPaths: bold, Markdown link, `--x=path`, `|path|` regressed (claim A4). build-brief file-URL decode: old stripped the root of `file:///home/...`; new keeps it, no lost input found. PARTIAL (claim A4).
- AC-10: the strict Blocked: test covers shapes but not two lines with different values (the input in claim A1); the DLL test turns red on a broken DLL as written. PARTIAL (claim A1).
- H1: conflicting duplicate lines CONFIRMED end to end (exit 0, "validate Phase 1: clean"); fenced, quoted, `* ` bullet, malformed and missing lines stop the step (exit 1). A `Blocked: none` placed before a "Review incomplete" paragraph also passes, which the deviation (a seat that lies) covers. PARTLY CONFIRMED (claim A1).
- H2: CRLF, trailing spaces, `Blocked: None.`, a BOM and a `### Checks performed` sub-heading all read as none; `**Blocked:** none`, `* Blocked: none`, a tab or two spaces after the colon, and `Blocked: none (reason)` are read as no line or as a block and stop a No findings seat; the seat brief (review-protocol.md:235-238) says "written exactly so, with no emphasis and no list under it" and `Blocked: none`, so these are a seat not following its brief, not a reader defect. REFUTED.
- H3: fake codex printing its final answer then sleeping: held until --timeout, status timed-out, answer kept only in result.json, process killed at the timeout. CONFIRMED (claim A3).
- H4: after the dispatcher timeout run, five concurrent preflight --exec runs and the review-run harness runs, a Win32_Process query for command lines naming this scratch folder returned nothing. Detached-worker and taskkill-child paths not exercised separately. REFUTED.
- H5: five concurrent preflight --exec runs on an empty TEMP: one DLL, no .tmp left, all ran inside the job. TEMP with a space and with Latin-1 characters: DLL built and used. TEMP with CJK characters: compile fails and every command runs on the nojob fallback (WARNING printed, command output intact); the old in-memory Add-Type fails the same way in that TEMP, so not a regression. REFUTED.
- H6: backticked spaced path, quoted path with :12:3 (inside and outside the quotes), parentheses, angle brackets, drive-less root, file:/// with %20 all found; bold, Markdown link, `--x=path`, `|path|`, `file:///c%3A/...` lost; a comma-joined pair yields one false missing path. PARTLY CONFIRMED (claim A4, LOW: advisory only).
- H7: Git Bash form and junction covered by the shipped matrix test; my probes (8.3 short name, UNC admin share, `\\?\`, `%SystemDrive%`, encoded-colon file URL) all refused. Only a `%CD%\..\` spelling passed, which no packet would carry. REFUTED.
- H8: grepped SKILL.md, references/, README and script help in both skills for project or vendor-domain terms (collector, Reporter.py, device names, ticket systems): none outside CHANGELOG (out of scope) and test fixtures; no text describes the deleted wording guess or leftover-path warning. The memory sentence tells the orchestrator something the host does not do (claim A5). PARTLY CONFIRMED (claim A5).
- Installed copies: `diff -rq` of both skills against ~/.claude/skills and ~/.agents/skills: no difference. review-run.mjs pair vs cross copy: identical.
- Coverage: since.diff read fully; review-run.mjs assertSeatsRan, seatBlockedLine, native wait read fully; preflight.mjs packetPaths, packetReach, packetPorts, JOB_WRAPPER/execSpawn read partly; build-brief.mjs runDirNamedIn read fully; codex-dispatch.mjs runCodex and result writing read fully; claude-dispatch.mjs run loop read partly; feedback files: linux-2 and mac-2 read fully, linux-1 and mac-1 read partly (headings and spot checks); bench/, release-check, install-check, validate-repository, exchange, detach-utils not read.
Blocked: none

web: 0 queries, 0 page fetches
