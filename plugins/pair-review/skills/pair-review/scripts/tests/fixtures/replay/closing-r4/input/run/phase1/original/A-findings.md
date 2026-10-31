# Seat A findings

## A1 [H9] [AC-1] — The new seat-file gate in initBody counts a file cut off after its first claim heading, or holding any letter-digit heading, as a complete seat, so the manifest reads completed and the report COMPLETE
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a Phase 1 seat file that stops after one or more claim headings, or a file whose only level-two heading is a letter plus digits (a hypothesis heading, for example). It happens when a seat is killed or cut off mid-write (the brief tells seats to add each finding as soon as they confirm it), or when a file is truncated before the manifest is rebuilt. Holds everywhere (no platform branch).
Evidence:
```
build-manifest.mjs:254-258 (both skills, byte-identical):
  const seatText = await readFile(path.join(runDir, 'phase1', `${role}-findings.md`), 'utf8').catch(() => '');
  if (!/^##\s+(?:[A-Z]\d+\b|No findings)/im.test(seatText)) missingSeatFiles.push(role);

Harness in my scratch folder (manifest.mjs) imports the shipped initBody from the target, writes a complete first
seat file, a phase3/findings.json, and each seat-B shape below, then prints status and missing_seat_files.
(Claim-shaped ids in the fixture text are shown renamed as Q1 / q1.)

empty                  incomplete ["B"]
headerOnly             incomplete ["B"]
cutAfterClaimHeading   completed []      <- "# Seat B findings\n\n## Q1 — the retry loop"  (file ends there)
cutMidEvidence         completed []      <- ends inside an open Evidence fence
claimsNoChecks         completed []      <- one claim, no Checks performed, no Blocked line, no web line
lowerClaim             completed []      <- "## q1 — x" (the i flag lets [A-Z] match lower case)
noFindingsYet          completed []      <- "## No findings yet, still working" (no boundary after "No findings")
hypHeading             completed []      <- "## H1 notes" only
fencedOnly             completed []      <- the only claim heading sits inside a code fence
tripleHash             incomplete ["B"]
complete               completed []
```
The fix closes the empty and header-only inputs. Every cut-off shape that already holds one claim heading still passes. With findings.json present, build-report.mjs:727 then prints COMPLETE (status === 'completed'). The test at tests/build-manifest.test.mjs:1445 checks only the empty and before-any-claim cases, so the sibling input (a file cut off after a claim) is untested (AC-10).
Suggested fix: in build-manifest.mjs:257, require the seat's closing section rather than any claim heading: `/^##\s+(?:Checks performed|No findings)\b/im`, read outside fences. The brief requires one of the two in every seat file.
Same shape elsewhere: none found (searched build-report.mjs:700-760 and review-run.mjs assertSeatsRan for a second completeness gate; review-run only warns about a missing Blocked line for a seat with claims)

## A2 [AC-1] [AC-4] — When a seat CLI exits without a successful answer and a process it started still holds its output, claude-dispatch hangs forever under review-run's default --timeout 0; with a finite timeout the run is recorded as "killed" and gets no stopIncomplete warning
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: the seat CLI ends without a success result (an error or rate-limit result, a crash) after a tool command started a background process that inherits stdout/stderr. review-run passes `--timeout 0` by default (review-run.mjs:421, `desc.flags.timeoutS ?? 0`), so the step never ends. This is rare because it needs a leftover process holding the output, but any end without a success answer can trigger it, not only a crash. Shown on Windows. On Linux and macOS, killGroupOnExit SIGKILLs the process group on exit, so only a holder that left the group triggers it there.
Evidence:
```
Harness noanswer.mjs (scratch) copies the repo's tests/fixtures/fake-claude.mjs and a claude.cmd shim into the
scratch folder and runs the shipped claude-dispatch.mjs with brief {"noResult":true,"orphanAfterResult":true}
(the fake prints no result event, exits 0, and leaves a detached child holding stdout/stderr).

--timeout 4:
wall ms 4645 status 1 spawnSync error null
stderr: relay: claude -p killed after exceeding --timeout 4s
result.json {"status":"timed-out","error":"claude -p killed after exceeding --timeout 4s"}
orphan 27232 alive after dispatcher: true

--timeout 0 (review-run's default), bounded by my harness at 20 s:
wall ms 20014 status null spawnSync error ETIMEDOUT
result.json {"status":"running"}
orphan 34080 alive after dispatcher: true

node process list before vs after (PowerShell Get-Process node; I stopped the harness and both orphans): identical.

claude-dispatch.mjs:256-263 (new): when the timer fires on an exited child with no answer, it sets
stream.timedOut and resolves without killing anything and without stopIncomplete; claude-dispatch.mjs:532 then
prints "claude -p killed after exceeding --timeout". With no timer, only child.on('close') (line 323) can end the
run, and close waits for the holder.
```
The known deviation about background jobs says "The run warns (stopIncomplete, a report caveat)". That holds only after a successful answer. Here, with --timeout 0, the dispatcher never writes a final result.json and the review step never ends. With a finite timeout the record says "killed" although nothing was signalled, and the "a process it started may still be running" warning is missing.
Suggested fix: in runClaude and runCodex, add a `child.once('exit')` handler. When no success answer has arrived, start the same bounded wait for close that the answered path uses (answerGraceMs), then resolve with the exit code, `stopIncomplete: true` and the "output still open" warning. At line 532, write "timed out" instead of "killed" when hasExited(child) was already true.
Same shape elsewhere: codex-dispatch.mjs:680-689 (a timeout on an exited, unanswered CLI resolves timedOut with no kill and no stopIncomplete) and codex-dispatch.mjs:793 (only close ends a run without an answer); cross-review opencode-dispatch.mjs:599 is close-only, which the known deviation accepts.

## A3 [H1] [AC-2] — The run-folder guard after the rewrite misses abbreviated and placeholder spellings ("C:\Users\…\<rest>", "C:\Users\%USERNAME%\<rest>", a tail with no root), so they reach the peer view and the auditor
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat shortens a long path in prose with "..." or "…", writes `<user>`, `%USERNAME%` or `$env:USERNAME` in place of the user folder, or cites the path from below the user folder ("cross-review-runs\...\run\phase1\seat-B"). How often seats do this is unknown; shortening long paths is common in prose. Shown on Windows. The auditor is the reader who learns something new: a peer seat already knows the run folder from its own scratch-folder path, but the auditor is told no run-folder path.
Evidence:
```
Harness g2.mjs (scratch) imports the shipped scrubDir (path-utils.mjs) and runDirNamedIn (build-brief.mjs),
builds a run folder <scratch>\home\longfoldername-runs\r4\run (USERPROFILE pointed at <scratch>\home), and
runs what exchange.mjs:229-235 and blind-relabel.mjs:3109-3112 run: scrubDir, then runDirNamedIn(target).
<tail> = cross-review-runs\closing-r4\run\phase1\<seat folder>\<scratch>\home\longfoldername-runs\r4\run

ellipsis3   scrub 0 guard pass      C:\Users\...\<tail>\phase1
ellipsisU   scrub 0 guard pass      C:\Users\…\<tail>\phase1
userPh      scrub 0 guard pass      C:\Users\<user>\<tail>\phase1
envUser     scrub 0 guard pass      C:\Users\$env:USERNAME\<tail>
pctUser     scrub 0 guard pass      C:\Users\%USERNAME%\<tail>
partial     scrub 0 guard pass      <tail>\phase1\seat-B
partialFwd  scrub 0 guard pass      <tail with />/phase1

The 26-shape matrix (guard.mjs) for the spellings H1 names is clean. Rewritten: absolute, forward-slash, /c/,
/mnt/c/, file:///, JSON-doubled, mixed separators, upper case, \\?\. Blocked: ~, %USERPROFILE%, $HOME,
$env:USERPROFILE, drive-less \Users\..., percent-encoded, 8.3 short name (LONGFO~1), relative ../ from the
target, \\localhost\c$, CJK-adjacent paths.
```
runDirNamedIn (build-brief.mjs:257-277) needs either an exact spelling of the run folder or a path that exists on disk once resolved. A path with an unknown middle segment never exists, and a tail has no root to resolve from, so both pass.
Suggested fix: in runDirNamedIn, also refuse text that holds the run folder's last two or three segments joined by any separator (for example `closing-r4[\\/]run(?![\p{L}\p{N}_.-])`), with case folded where foldsCase says so. A match on a tail only refuses, which is the safe direction.
Same shape elsewhere: build-brief.mjs:284 assertOutsideRunDir (the packet and rules check: same function, same gap); exchange.mjs:235; blind-relabel.mjs:3112

## A4 [H10] [AC-2] [AC-9] — scrubDir and the run-folder guard now disagree on where the folder name ends. The paths scrubDir newly leaves unrewritten (a sibling whose name continues with + @ ( or a non-ASCII letter, or a path glued to a non-ASCII word) are refused by the guard as the run folder, which stops the hand-off for a redaction round
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat cites a sibling folder such as `<parent>\run(2)` or `<parent>\run+1`, or writes the run path glued to non-ASCII prose (Chinese or Japanese text with no space, "在C:\...\run\phase1里"). Rare. The direction is safe (no leak). The cost is a stopped exchange or audit-prep, a paid redaction round, and a message that names the run folder for a path outside it. Holds everywhere.
Evidence:
```
guard.mjs matrix (shipped scrubDir then shipped runDirNamedIn, same order as exchange.mjs:229-235):
siblingParen scrub 0 guard BLOCK | x <home>\longfoldername-runs\r4\run(2)\x y
siblingPlus  scrub 0 guard BLOCK | x <home>\longfoldername-runs\r4\run+1\x y
cjk          scrub 0 guard BLOCK | x 在<home>\longfoldername-runs\r4\run\phase1里 y
cjkTrail     scrub 0 guard BLOCK | x 目录<home>\longfoldername-runs\r4\run中 y
sibling2     scrub 0 guard pass  | x <home>\longfoldername-runs\r4\run2\x y

path-utils.mjs:101-105 (new): lookbehind (?<![\p{L}\p{N}_]) and lookahead (?![\p{L}\p{N}_+@(-]|\.[\p{L}\p{N}_]);
comment: "is another folder, as in the run-folder guard".
build-brief.mjs:236-238 mentionsDir: only [A-Za-z0-9._-] after the name means another folder; anything else,
including + @ ( and é, counts as the run folder.
```
AC-9: the old scrub lookbehind `(?<![A-Za-z0-9_])` rewrote a run path glued to a CJK word, and the old lookahead rewrote `run+1`. Now the scrub skips both, and the guard stops the seat. The problem the hypothesis names (a sibling rewritten to `<run-dir>`) is gone, so the hypothesis is refuted as worded. But the comment's "as in the run-folder guard" is false: the guard refuses the very inputs the scrub chose to leave alone.
Suggested fix: use one boundary in both places. Give mentionsDir the scrub's continuation set (`[\p{L}\p{N}_+@(.-]`), and drop `\p{L}\p{N}` from the scrub's lookbehind, going back to the ASCII set that the guard's pathStartRe uses.
Same shape elsewhere: blind-relabel.mjs:3109-3112 (audit-prep makes the same pair of calls)

## A5 [AC-5] — The task-packet template's own guidance lines now trip the widened pre-flight label warning, and the template still says pre-flight warns only about the peer letter
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: every packet that keeps the template's Acceptance-criteria guidance lines (the template says to fill every slot and delete one only when it truly does not apply). Holds everywhere.
Evidence:
```
tmpl.mjs (scratch): the shipped peerLabelLines over the template's markdown block (56 lines).
Letter-plus-digit labels in the quoted lines are shown renamed as Q3, Q4, ... (the originals use the seat, audit
and peer letters).

template block lines 56 old warn 1 new warn 2
> A seat marks a claim with the tag in its heading, for example `## Q3 [AC-2] ...`; the scorecard then
> Each seat also writes one line per tag it checked under `## Checks performed`, starting with the tag

references/task-packet-template.md:32 (both skills): "... no other name in the packet may look like `Q1`, `Q2`,
`Q3`, `Q4` or `Q5` ... (the host pre-flight warns about `<peer letter><n>`)."
preflight.mjs:1820 now matches /\b[ABPXY]\d+\b/, and its warning names all five letters.
```
A packet built from the template now gets two "holds a label like ..." warnings about the template's own text; before this round it got one. The template line that documents the warning still names only the peer letter.
Suggested fix: write the template's examples as `## <seat letter><n> [AC-2]`, or move both guidance lines above the markdown fence. Change "warns about" to name all five letters followed by digits, as preflight.mjs:2038 now does.
Same shape elsewhere: plugins/cross-review/skills/cross-review/references/task-packet-template.md:31-32 (identical lines)

## A6 [H2] [AC-1] — After an earlier "Blocked: none", a block written after a letter or roman list marker, a dash-like marker, a definition colon or a full-width colon is still not read, so a blocked No findings seat passes as clean
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a No findings seat writes "Blocked: none" and later, in the same section, states a block behind one of these markers. The seat has to contradict itself first, so this is uncommon. Holds everywhere.
Evidence:
```
blocked.mjs (scratch) runs the shipped seatBlockedLine on
"## No findings ... <section heading>\n- read all\nBlocked: none\n<line>\n" for 25 shapes.
Read (the block is returned): ### heading, - [ ], •, (1), | table |, ### section, ## 1. section, **bold**, >, 1),
*, + [x], * [ ], tab-indented list, a no-break space after the colon, a ### subsection under the section.
Not read ("" is returned: "Blocked: none" wins):
letterList     ""      a) Blocked: npm test: EACCES
roman          ""      ii. Blocked: npm test: EACCES
numDash        ""      1 - Blocked: npm test: EACCES
dl             ""      : Blocked: npm test: EACCES
emDash         ""      — Blocked: npm test: EACCES
fullwidth      ""      Blocked：npm test: EACCES
review-run.mjs:852-855: declared === '' on a No findings seat passes the gate (only null or a non-empty value stops it).
```
The shapes the hypothesis names (heading, task box, bullet dot, parenthesised number, table row, non-level-two section) are fixed, so the hypothesis is refuted for them. But the marker class in `LOOSE_BLOCKED_RE` (review-run.mjs:774) is still a list of known markers. The six siblings above fall through it, so the earlier "Blocked: none" stands.
Suggested fix: in seatBlockedLine, read a line as a block when, after emphasis and code marks are removed, it matches `/^[^\p{L}\p{N}]*(?:(?:\p{L}{1,4}|\d+)[.)]\s+[^\p{L}\p{N}]*)?blocked\s*[:：]/iu` (any run of non-word characters, then an optional short letter, roman or number label). Keep a mid-sentence "blocked:" unread.
Same shape elsewhere: none found (searched review-run.mjs, build-manifest.mjs and blind-relabel.mjs for a second Blocked reader)

## A7 [H8] [AC-1] — For a native Claude agent, the final-reply check still reads an earlier turn's reply: a Phase 2 (or redaction) turn that ends with no text inherits the Phase 1 "written", so the new no-reply warning never fires
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a native Claude seat or auditor is resumed for a later turn, and that turn's last assistant message ends it with no text (only a tool call, thinking, or blank text). Holds everywhere.
Evidence:
```
reply.mjs (scratch) writes transcripts and calls the shipped agentState and agentLastReply (native-agent.mjs).
Turn 1 ends with the text "3 claims: 1 HIGH, 2 LOW. written"; a new user prompt starts turn 2:
claudeNoTextLast   state done reply "3 claims: 1 HIGH, 2 LOW. written"   (turn 2 ends with empty content)
claudeThinkingOnly state done reply "3 claims: 1 HIGH, 2 LOW. written"   (turn 2 ends with thinking only)
claudeEmptyText    state done reply "3 claims: 1 HIGH, 2 LOW. written"   (turn 2 ends with blank text)

native-agent.mjs:125-135: reply is reset only on a Codex task_started; a Claude user prompt (isNewPrompt)
does not reset it. review-run.mjs:242-243 then sees "written" and adds no warning.
```
The previous round's fix (review-run.mjs:243, a warning when reply === null) covers Codex transcripts. A Claude transcript of the same resumed agent never yields null once any earlier turn has replied.
Suggested fix: in agentLastReply, set `reply = null` on each Claude `user` entry for which isNewPrompt(entry) is true, as claudeState already does for its state.
Same shape elsewhere: review-run.mjs:682 (both reviewer phases) and review-run.mjs:1365 (the auditor) call the same function

## Checks performed
- AC-1: ran initBody, seatBlockedLine, agentLastReply and claude-dispatch (fake CLI) over input matrices; a cut-off seat file reads completed, a CLI that exits without an answer hangs under --timeout 0, some block shapes after a none are unread, and an earlier turn's reply counts for the current turn. NOT MET (claims A1, A2, A6, A7).
- AC-2: ran the shipped scrubDir and runDirNamedIn over 33 run-folder spellings on Windows; abbreviated, placeholder and tail spellings pass both, and the two disagree on the folder-name boundary. NOT MET (claims A3, A4).
- AC-3: did not recount numbers that scripts print against their source files this round (no build-report or translate count checked); a gap in coverage, not a defect. PARTIAL
- AC-4: audit-prep's rename retry and staging cleanup read in the code (blind-relabel.mjs:3148-3158) and in the test; spawnCli sets windowsHide; node process list identical before and after my dispatcher runs; a dispatcher stays alive when the CLI exits without an answer. NOT MET (claim A2).
- AC-5: dispatcher --help names stopIncomplete (claude-dispatch.mjs:59-63); the CHANGELOG lines match the diff; the template contradicts the widened warning. NOT MET (claim A5).
- AC-6: read initBody's new gate against the seat-file shapes the protocol has used (claim headings, "## No findings"); no run folder from before these changes was available on this host to render. PARTIAL (no old run folder here, so no live rerun)
- AC-7: looked for removable code in the diff; none worth a claim. MET
- AC-8: checked linux-3-selfreview items 1-14 and macos-3-selfreview items 1-8 against the code. Fixed or covered by a Known deviation: Linux 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14 and macOS 1, 2, 3, 6, 8. Linux 6 and macOS 5 and 7 are handled by the template rule and the pre-flight warning. Linux 1 is fixed for the spellings it names (the abbreviated and tail siblings are claim A3). macOS 4 is fixed only for a missing or empty file (claim A1). From the four older reports I spot-checked the home-relative and $HOME guard (mac-1 item 6, mac-2 F3: blocked), the partial-file "blocked:" reply (mac-1 item 2: throws), the shallow-seat warning (linux-1 F2) and the version note (Known deviation); the other older items were not re-executed. PARTIAL (claims A1, A3; older reports only spot-checked)
- AC-9: for each narrowed or changed line in the diff: scrubDir lookbehind and lookahead (an input the old line handled and the new one refuses: a CJK-glued run path and `run+1`, claim A4); LOOSE_BLOCKED_RE (the old `[\s>+\-\d.)]*` accepted "1.2.3 Blocked:", the new one does not; no realistic seat writes that); the section end at a same-or-higher heading (an old ## heading ended the section, a new ### one does not, so the new reader accepts more); initBody's file-exists test replaced by a heading test (a seat file of an old run with "## <letter><n>" headings or "## No findings" still counts; no older heading shape was found in the references); pathStartRe `\/{1,2}` to `\/+` (strictly wider); peerLabelLines widened (more warnings, claim A5). NOT MET (claim A4).
- AC-10: build-manifest's test covers only the empty and header-only seat files (claim A1); the claude-dispatch signal-on-exited path is tested only through the codex copy of installSignalForwarding (codex-dispatch.test.mjs:448), and no test covers the timeout on an exited CLI with no answer (claim A2). NOT MET (claims A1, A2).
- H1: 26-spelling and 7-spelling matrices run through the shipped scrub and guard; the named spellings (home-relative, variable, drive-less, dot-segment, percent-encoded) are now rewritten or blocked; the abbreviated, %USERNAME% and tail siblings pass. PARTLY CONFIRMED (claim A3)
- H2: ran seatBlockedLine over 25 shapes; the named shapes are all read, but the letter, roman, dash, definition-colon and full-width-colon siblings are not. PARTLY CONFIRMED (claim A6)
- H3: ran peerLabelLines; the seat, audit and peer letters followed by digits are all named, and `CHK-P1` is exempt; REVIEW.md and the packet both use the same helper (preflight.mjs:2038, 2043). REFUTED
- H5: build-brief.mjs:200 now allows the Phase 1 brief, the task packet, the seat's output and its scratch folder, matching review-protocol.md:214. REFUTED
- H6: scrubDir's flags are 'giu' only when foldsCase() is true (path-utils.mjs:104); the Linux branch read statically, since process.platform cannot be injected there. REFUTED
- H7: pathStartRe on Linux/macOS and PACKET_PATH_START_RE (preflight.mjs:1434) both accept `\/+(?!\/)`; read statically, and the build-brief test at build-brief.test.mjs:210 covers the "///x" case. REFUTED
- H8: the reply === null warning is in place (review-run.mjs:243) and the Codex no-message turn returns null; the Claude-transcript sibling still inherits an earlier reply. PARTLY CONFIRMED (claim A7)
- H9: ran initBody over 11 seat-file shapes; empty and header-only files are caught, but a file cut off after a claim heading is not. PARTLY CONFIRMED (claim A1)
- H10: siblings continued by space, +, @, ( or é are no longer rewritten to the placeholder, but the guard now refuses them instead (claim A4, the safe direction). REFUTED
- H11: the timeout and signal paths check hasExited before killTree in both dispatchers (claude-dispatch.mjs:217, 256; codex-dispatch.mjs:81, 680); a timeout after a successful answer on an exited CLI ends as answered. REFUTED
- Installed copies: diff -rq of both skills against ~/.claude/skills and ~/.agents/skills printed nothing; no SkillArray copy exists under the plugin cache.
- Test suites: not run by me (author-reported only); every check above imports the shipped modules from the target.
- Coverage: read fully: the since.diff, linux-3-selfreview.md, macos-3-selfreview.md, path-utils.mjs scrubDir, the build-brief guard, runAuditPrep, seatBlockedLine and assertSeatsRan, initBody, the claude-dispatch runClaude and signal paths, spawn-utils kill helpers. Read partly: codex-dispatch, preflight (peerLabelLines, runWithTimeout), native-agent, build-report, build-manifest, the template, the tests named above, the four older field reports (fix lists only). Not read: opencode-dispatch, detach-utils, run-descriptor, build-recheck-packet, review-config, validate-repository, release-check, install-check, bench/.
Blocked: none

web: 0 queries, 0 page fetches
