# Seat A findings

## A1 [H2] [AC-1] — A finite --timeout that falls due within 5 s of an unanswered CLI exit still records "killed after exceeding --timeout" with no stopIncomplete and no warning, while the process holding the output keeps running
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat CLI (codex or claude) exits with no answer while a process it started holds its stdout, and the dispatcher's finite timeout (direct dispatcher use defaults to 1800 s; review-run passes run.json flags.timeoutS when set) falls due inside the new 5 s exit wait. Rare in a full run (the window is 5 s), deterministic when it happens. Holds on every platform; executed on Windows.
Evidence:
```
codex-dispatch.mjs:676-689 (timer, exited branch, no answer):
  else resolve({ code: null, ..., timedOut: (timedOut = true), codexErrors, webCalls });
  -- no stopIncomplete, no exitedOutputOpen, exitWait not cleared
claude-dispatch.mjs:254-264 (same branch):
  if (answered) Object.assign(stream, { ... stopIncomplete: true ... });
  else stream.timedOut = true;

Repro (scratch script silent-timeout.mjs; fake codex.cmd behind a narrowed PATH, the same fake as
dispatch-integration.test.mjs "orphan silent": prints thread.started + turn.completed, starts a detached
child that inherits stdout, exits 0 at once), shipped pair-review codex-dispatch.mjs, --timeout 3:
  relay: codex exec killed after exceeding --timeout 3s
  --timeout 3: exit 1 in 3952 ms; status=timed-out stopIncomplete=undefined error=codex exec killed after exceeding --timeout 3s
  stderr WARNING lines: (none)
  orphan pid 36352 alive after dispatcher returned: true
Same fake, --timeout 0:
  relay: WARNING: codex exec exited without an answer, but its output stayed open: ...
  --timeout 0: exit 1 in 6421 ms; status=error stopIncomplete=true
```
The record says the CLI was killed (nothing was: it had exited 2 s earlier), and the warning and stopIncomplete flag that the new exit wait adds for exactly this state are lost, so review-run never writes stop-incomplete.json and the report shows no caveat for a process that is still running. Previous finding F2's "finite timeout" variant is therefore closed only when the exit happens more than 5 s before the timeout.
Suggested fix: in both timer callbacks' exited-and-unanswered branch, set stopIncomplete and exitedOutputOpen (as the exit wait does) and clear exitWait/grace.
Same shape elsewhere: claude-dispatch.mjs:254-264 (same branch, static trace, same fix); opencode-dispatch.mjs is close-only (known deviation).

## A2 [AC-9] [H1] — build-manifest's new seat-file gate marks a finished seat "missing" and the whole run incomplete when its Checks performed heading is a level-3, numbered or emphasized heading that review-run's own reader accepts
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat with claims writes its section as `### Checks performed`, `## 4. Checks performed`, `## (1) Checks performed`, `## **Checks performed**` or `# Checks performed` (the shapes this round widened review-run's SEAT_SECTION_RE to accept because seats write them). Everywhere.
Evidence:
```
build-manifest.mjs:261
  if (!own.some((l) => /^##\s+Checks performed\b/i.test(l) || /^##\s+No findings$/i.test(l))) missingSeatFiles.push(role);
review-run.mjs:776
  const SEAT_SECTION_RE = /^(#{1,6})\s+(?:\(?\d+[.)]?\s*)?(?:Checks performed|No findings)\b/i;   (tested with * _ ` removed)

Scratch harness manifest-matrix.mjs: shipped initBody and seatBlockedLine, seat A healthy, seat B = one claim + <heading> + "- AC-1: ok. MET" + "Blocked: none"
"## Checks performed"        manifest missing: []     status: completed   review-run section read: yes
"## Checks performed:"       manifest missing: []     status: completed   review-run section read: yes
"### Checks performed"       manifest missing: ["B"]  status: incomplete  review-run section read: yes
"#### Checks performed"      manifest missing: ["B"]  status: incomplete  review-run section read: yes
"## 4. Checks performed"     manifest missing: ["B"]  status: incomplete  review-run section read: yes
"## (1) Checks performed"    manifest missing: ["B"]  status: incomplete  review-run section read: yes
"## **Checks performed**"    manifest missing: ["B"]  status: incomplete  review-run section read: yes
"## `Checks performed`"      manifest missing: ["B"]  status: incomplete  review-run section read: yes
"# Checks performed"         manifest missing: ["B"]  status: incomplete  review-run section read: yes
"## No findings."            manifest missing: ["B"]  status: incomplete  review-run section read: yes
"### No findings"            manifest missing: ["B"]  status: incomplete  review-run section read: yes
"    ## Checks performed" (4-space indented code block)  manifest missing: []  status: completed  review-run section read: no
```
Before this change the same seat B file (it holds `## <claim> — c`) passed the gate and the run was completed (AC-9: the old line accepted any claim heading). Now phase1 --wait passes the seat, reads its Blocked line, and the run goes on to audit and report, but the manifest records `missing_seat_files: ["B"]` and `status: incomplete`, so the reader is told a seat produced no file. The two readers of the same section disagree in the same round that was meant to make them agree. The last row is the opposite slip (an indented code block counts), LOW on its own.
Suggested fix: build-manifest.mjs:261 test each unfenced line, with * _ ` removed, against review-run's SEAT_SECTION_RE (move it to a shared module), instead of the narrower literal pattern.
Same shape elsewhere: build-report.mjs:270 reads tag lines only under an exact `## Checks performed` (older, same narrow heading; tag lines under the variants are reported NOT VERIFIED); review-run.mjs:758 NO_FINDINGS_RE requires an exact `## No findings`.

## A3 [H8] [AC-2] — The new relative `..` guard misses a run-folder path written in bold or italics, or right after a table bar or a quote mark with no space, so it reaches the peer view and the auditor
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat writes a target-relative path that walks up into the run folder as `**docs/../../<runs>/run1/...**`, `*...*`, `~~...~~`, `|docs/../..` (a table cell with no space) or `>docs/../..`. Markdown emphasis on a path is common in seat prose; how often a seat cites the run folder this way at all is unknown. Everywhere (the token class is platform-independent; executed on Windows).
Evidence:
```
build-brief.mjs:250
  const RELATIVE_UP_RE = /(?<=^|[\s"'`(\[<=,;])(?![A-Za-z]:|[\/~])[^\s"'`<>|*\/]+[\/](?=...)/gm;
  -- the look-behind set has no * ~ > |, and the token class itself excludes * and |, so no match can start there

Scratch harness relup.mjs: shipped runDirNamedIn(text, <tmp>/reviews/run1, <tmp>/proj), both folders exist,
r = docs/../../reviews/run1/phase1/B-findings.md (28 shapes; 22 caught, the misses below)
caught   "see docs/../../reviews/run1/phase1/B-findings.md"
caught   "(docs/../../reviews/run1/phase1/B-findings.md)"
caught   "`docs/../../reviews/run1/phase1/B-findings.md`"
caught   "_docs/../../reviews/run1/phase1/B-findings.md_"
caught   "{docs/../../reviews/run1/phase1/B-findings.md}"
caught   "“docs/../../reviews/run1/phase1/B-findings.md”"
caught   "see docs\..\..\reviews\run1\phase1\B-findings.md"
MISSED   "**docs/../../reviews/run1/phase1/B-findings.md**"
MISSED   "*docs/../../reviews/run1/phase1/B-findings.md*"
MISSED   "~~docs/../../reviews/run1/phase1/B-findings.md~~"
MISSED   ">docs/../../reviews/run1/phase1/B-findings.md"
MISSED   "**docs\..\..\reviews\run1\phase1\B-findings.md**"
MISSED   "a|docs/../../reviews/run1/phase1/B-findings.md"
```
runDirNamedIn returning null is the whole check at exchange.mjs:234 (peer view, after scrubDir, which does not resolve relative paths) and blind-relabel.mjs:3112 (audit-prep), and assertOutsideRunDir (build-brief.mjs:284) for the packet and rules. The fix for previous finding F8 holds for the reported spelling and for quotes, brackets and backticks, but not for these sibling wrappings, so F8 is partly open.
Suggested fix: build-brief.mjs:250 add * ~ > | to the look-behind set (`(?<=^|[\s"'`(\[<=,;*~>|])`).
Same shape elsewhere: none found beyond the three callers named above (searched build-brief.mjs, exchange.mjs, blind-relabel.mjs, build-recheck-packet.mjs for RELATIVE_UP_RE and runDirNamedIn).

## A4 [H4] — The re-review packet's path rewrite has no start boundary: on Linux and macOS a longer path that ends with the old target or run path ("/mnt/backup/home/u/proj/a.js") is rewritten into a wrong path
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Linux or macOS (a POSIX old path with no drive letter, so nothing anchors its start); the old packet names a backup, mount or container copy whose path ends with the old target or the old run folder (`/mnt/backup/home/u/proj/...`, `/data/home/u/proj/...`). Uncommon; deterministic when met. Windows is not affected: pathSpellingsOf gives only drive-rooted spellings there (executed: `D:\backup\Users\bob\proj\a.js` and `\nas\c$\Users\bob\proj\a.js` are kept).
Evidence:
```
build-recheck-packet.mjs:323
  const re = new RegExp('(' + keys.map(escapeRe).join('|') + ')(?!' + NAME_CONTINUES + ')', ...);
  -- an end boundary only; scrubDir (path-utils.mjs) has a start boundary, (?<![\p{L}\p{N}_])

Scratch harness bound.mjs: shipped rewritePaths(text, [['/home/u/proj', '/srv/new']])
"see /home/u/proj/a.js"             -> "see /srv/new/a.js"               (intended)
"see /mnt/backup/home/u/proj/a.js"  -> "see /mnt/backup/srv/new/a.js"    (wrong path)
"see /data/home/u/proj/a.js"        -> "see /data/srv/new/a.js"          (wrong path)
"see x/home/u/proj/a.js"            -> "see x/srv/new/a.js"              (wrong path)
Same harness, Windows run folder C:\Users\bob\reviews\run, 20 end-boundary suffixes (2 -old .bak é (2) are siblings;
\x . : ) # ~1 $ ! & 's ’s %20 = , are the folder): guard, scrubDir and rewritePaths agree on every row.
```
The end boundary that previous finding F4 named now agrees across the three users (20 shapes checked, all agree). The start boundary does not: the rewrite turns a path the old packet gave for another folder into a path that does not exist, in the packet the next round's seats read. (Pre-existing: the old regex had no start boundary either; this round rewrote the line without adding one.)
Suggested fix: build-recheck-packet.mjs:323 prefix the group with the same look-behind scrubDir uses for a key that starts with a separator, e.g. `(?<![\p{L}\p{N}_.~/\-])`.
Same shape elsewhere: build-brief.mjs mentionsDir (lines 231-237) also has no start check; there a longer path ending with the run folder is refused, not rewritten (a false stop, the safe direction, LOW per the known deviation).

## A5 [H3] [AC-2] — On Windows `$USER`, `%USER%` and `$env:USER` inside a run-folder path are not expanded (USER is unset there), so the guard passes them to the peer view and the auditor
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Windows; a seat writes the run folder with the POSIX-habit user variable (`/c/Users/$USER/<runs>/...`, `C:\Users\%USER%\...`, `C:\Users\$env:USER\...`). Uncommon (the variable is empty in Git Bash and PowerShell on this host, so it comes from a seat writing a path by habit or from a Linux-born template), deterministic when met.
Evidence:
```
path-utils.mjs:23-24 (expandPathVars)
  const value = pair ? (...) : env[name] ?? (name === 'HOME' ? os.homedir() : null);
  if (!value) return all;          -- USER has no fallback, so the text stays as written

Host: Git Bash  USER=[] USERNAME=[dev];  node: env USERNAME= dev USER= undefined
Scratch harness uservar.mjs: shipped runDirNamedIn(text, <existing run folder under the user profile>, null)
caught   C:\Users\%USERNAME%\<tail>\x
caught   C:\Users\$env:USERNAME\<tail>\x
caught   C:\Users\${env:USERNAME}\<tail>\x
caught   C:/Users/$USERNAME/<tail>/x
caught   /c/Users/$USERNAME/<tail>/x
caught   /c/Users/${USERNAME}/<tail>/x
caught   C:\Users\%username%\<tail>\x
MISSED   /c/Users/$USER/<tail>/x
MISSED   C:\Users\$env:USER\<tail>\x
MISSED   C:\Users\%USER%\<tail>\x
(<tail> stands for the rest of the run-folder path, shortened here; placeholder spellings such as
C:\Users\<user>\<tail> were also missed but fall under the known "shortened in prose" deviation)
```
The fix for previous finding F3 holds for USERNAME in every spelling tried, but its sibling USER (added in the same line, and tested only with platform 'linux') does not resolve on Windows, so F3 is partly open. The same text on Linux or macOS is caught (USER is set there).
Suggested fix: path-utils.mjs:23 fall back between the two names: `env[name] ?? (name === 'USER' ? env.USERNAME : name === 'USERNAME' ? env.USER : null) ?? (name === 'HOME' ? os.homedir() : null)`, or `os.userInfo().username` for both.
Same shape elsewhere: every caller of expandPathVars (build-brief.mjs runDirNamedIn for the packet, rules, peer view and audit-prep; preflight.mjs packet reach) shares the one function; no other expansion site found (searched the scripts for expandPathVars and PATH_VAR).

## A6 [H10] [AC-5] — The corrected Phase 2 resume message (and the Phase 1 one) still forbid reading the seat's own output, which the brief it points to allows
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
build-brief.mjs:200 (delta brief)
  Read nothing in the review's run folder except this brief, your Phase 1 brief, the task packet, your own output and your scratch folder
review-run.mjs:265 (PROMPTS.phase2) and phase-2-cross-examination.md:274 (pair-review), :436 (cross-review)
  Do not read any other file in the run folder except the delta brief, your Phase 1 brief, the task packet and your own scratch folder.
phase-2-cross-examination.md:288 (pair-review), :450 (cross-review), the dispatched-seat resume text
  ... except the brief, your Phase 1 brief, the task packet and your own scratch folder.
review-run.mjs:264 (PROMPTS.phase1)
  Write your findings to ${output}, adding each finding to the file as you confirm it. ...
  Do not read any other file in the run folder except the brief, the task packet it names and your own scratch folder.
  -- the Phase 1 brief's rule lists "your brief, the task packet, your own output and scratch folder"
```
The fix for previous finding F10 added the Phase 1 brief, the packet and the scratch folder but not "your own output", so the message the seat's agent receives still contradicts its brief on one file. In Phase 1 the prompt also asks the seat to add each finding to its file as it goes, which an edit tool that must read a file before changing it cannot do without reading it. A strict seat reports a block or stops asking; a loose one ignores the prompt. F10 is partly open.
Suggested fix: add "your own output" (Phase 1: "your own findings file") to the read list in review-run.mjs:264-265 and in the four resume texts in both phase-2-cross-examination.md files.
Same shape elsewhere: review-run.mjs:264 (Phase 1 prompt), phase-2-cross-examination.md:274,288 (pair-review) and :436,450 (cross-review); the review-run.mjs copy in cross-review is identical.

## Checks performed
- AC-1: ran the shipped codex-dispatch.mjs with the test suite's "orphan silent" fake at --timeout 0 (warning and stopIncomplete present) and --timeout 3 (both lost, record says killed); traced the same branch in claude-dispatch.mjs. NOT MET (claim A1).
- AC-2: matrices against the shipped runDirNamedIn: 28 relative `..` wrappings (6 missed), 14 user-name spellings (3 missed on Windows), 25 end and start boundary shapes (all agree). NOT MET (claims A3, A5).
- AC-3: no count printed by a changed script was found to differ; not checked against a full run folder end to end (no live run in this review). PARTIAL
- AC-4: read every killTree call in preflight.mjs (all through the hasExited wrapper; POSIX groups are still killed on exit by killGroupOnExit) and in opencode-dispatch.mjs (lines 85, 366, 539 guarded); no live process-list check across a full run (no live run). PARTIAL
- AC-5: compared the Phase 1 and Phase 2 prompts and resume texts with the briefs they point to; the task-packet template has 0 label lines under the shipped peerLabelLines. NOT MET (claim A6).
- AC-6: an old seat file with claims and a numbered or level-3 Checks performed heading now renders incomplete. PARTIAL (claim A2).
- AC-7: no removable code or doc paragraph found worth a claim. MET
- AC-8: read the fix lists of linux-3-selfreview.md and macos-3-selfreview.md and spot-checked their items in code (the run-folder guard at exchange and audit-prep, the preflight exit grace, the exited-CLI "still running" text, the win32-only test skip, the review-config plural note, the catalog entry for the missing model, the read ban now in the briefs, the H-dash-P-number hypothesis tags now warned by preflight and forbidden by the template); the four older reports were not read in full. PARTIAL
- AC-9: build-manifest gate narrowed (heading variants it now rejects: claim A2); rewritePaths and mentionsDir end boundary: 20 suffixes give the same answer as the old patterns for `.`, `:`, `)`, `,` and the siblings; LOOSE_BLOCKED_RE still takes the old `(1) `, `1. `, `- [x] ` prefixes (matrix below). NOT MET (claim A2).
- AC-10: the changed test files pass here (native-agent 10, build-manifest 71, path-utils 30 + 2 skipped, build-brief 27, build-recheck-packet 29; 0 fail), but the RELATIVE_UP_RE test covers 3 wrappings while 6 siblings fail, the exit-wait tests use only --timeout 0, and the manifest gate test uses only the exact heading. NOT MET (claims A1, A2, A3).
- H1: initBody now refuses empty, cut-off-before-checks and fenced-only files (test file passes; matrix confirms); build-report reads the manifest status, so the old false COMPLETE is gone. The reverse slip (a complete seat counted missing) is claim A2. REFUTED
- H2: --timeout 0 case fixed (executed, ends in 6.4 s with the warning); a finite timeout due within 5 s of the exit still records a kill with no stopIncomplete. PARTLY CONFIRMED (claim A1).
- H3: %USERNAME%, $env:USERNAME, ${env:USERNAME}, $USERNAME, ${USERNAME} are caught on Windows; $USER, %USER%, $env:USER are not. Abbreviated and placeholder spellings fall under the known deviation. PARTLY CONFIRMED (claim A5).
- H4: guard, scrubDir and rewritePaths agree on all 20 end-boundary suffixes tried; the start boundary of rewritePaths still differs on POSIX keys. PARTLY CONFIRMED (claim A4).
- H5: shipped peerLabelLines finds 0 lines in either template (byte-identical); the template names all five letters. REFUTED
- H6: the named shapes (`a.`, `iv)`, dash markers, full-width colon, emphasized label) are read after an earlier "blocked line: none" under the plain heading (matrix of 16 line shapes x 12 headings, 70 of 192 read). Leftover misses (nested `1. a)` labels, `1.2`, `Blocked (partly):`, `Blocked -`, small-form colon) fall under the LOW "contradicts itself" known deviation. REFUTED
- H7: read agentLastReply and isNewPrompt; a new user prompt resets the reply, tool results and meta entries do not; native-agent tests pass. REFUTED
- H8: the reported spelling and quotes, brackets, backticks, underscores and backslashes are caught; bold, italic, strike, `>` and `|`-joined spellings are not. PARTLY CONFIRMED (claim A3).
- H9: `## **Checks performed**`, `` ## `Checks performed` ``, `## (1) Checks performed`, `## 1. Checks performed` are recognised (matrix). `## IV.`, `## A.`, `## 4 -`, an emoji or `Step 4:` before the heading text are not; they fall under the same LOW known deviation. REFUTED
- H10: the resume texts now allow the Phase 1 brief, packet and scratch folder, but not the seat's own output that the brief allows. PARTLY CONFIRMED (claim A6).
- H11: every preflight killTree call goes through the hasExited wrapper (preflight.mjs:39); opencode-dispatch.mjs:85, :366 and :539 check hasExited before any kill; the stopOnSignal test in preflight.test.mjs covers it. REFUTED
- Installed copies: ~/.claude/skills and ~/.agents/skills copies of both skills are byte-identical to the repository (diff -rq); no copy of either skill under the plugin cache.
- Target untouched: git status of the target shows the same 113 entries before and after the test runs (TEMP pointed at the scratch folder).
- Coverage: since.diff read fully; review-run.mjs seatBlockedLine and assertSeatsRan, claude-dispatch.mjs runClaude, codex-dispatch.mjs runCodex timer and exit paths, build-manifest.mjs initBody, build-brief.mjs runDirNamedIn and mentionsDir, path-utils.mjs expandPathVars, NAME_CONTINUES and scrubDir, build-recheck-packet.mjs rewritePaths and its caller, native-agent.mjs agentLastReply, preflight.mjs stopOnSignal and runWithTimeout, spawn-utils.mjs kill helpers read fully; exchange.mjs and blind-relabel.mjs guard call sites, the opencode-dispatch.mjs kill paths and the two newest field reports read partly; the other scripts, SKILL.md files, README, the bench scripts and the four older field reports not read.
Blocked: none
web: 0 queries, 0 page fetches
