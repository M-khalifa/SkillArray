# Seat A findings

## A1 [AC-2] [AC-8] — The `<run-dir>` rewrite (`scrubDir`) misses the home-relative, variable, drive-less, dotted, 8.3 and line-wrapped spellings of the run folder, and the scan that follows it passes them to the peer and the auditor
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat pastes the run-folder path in a form other than absolute-with-drive or `/c/`, `/mnt/c/`: `~/...` or `~\...` (Git Bash prompts and many tool messages shorten home this way), `%USERPROFILE%\...` or `$HOME/...`, a drive-less `\Users\...`, a `.\` segment, a Windows 8.3 short name, or a path wrapped onto a second line. Uncommon per run, but the Linux field report (linux-3-selfreview) exists because seats do paste run-folder paths. Holds everywhere for the `~` and variable forms; the 8.3 and drive-less forms are Windows.
Evidence:
```
path-utils.mjs scrubDir builds its alternatives only from pathSpellingsOf(dir) (typed path + realpath),
each split on separators; it never adds "~", %VAR%/$VAR, drive-less, "."-segment or 8.3 forms.
The run-folder guard in build-brief.mjs (runDirNamedIn) does expand variables, "~" and ".." for briefs,
so the two checks disagree on what "names the run folder" means.

blind-relabel.mjs:2500-2503 collectScanHits adds the run folder and its parent to maskDirs, and has no
run-folder check of its own, so nothing after scrubDir stops these spellings.

scrub.mjs (scratch): shipped scrubDir(text, 'C:\Users\<user>\cross-review-runs\closing-r3\run'),
23 shapes; replaced count per input:
1 C:\Users\...\run\phase1\x.md          1 c:/users/<USER>/.../run/phase2 (case)
1 JSON-escaped \\                       1 /c/Users/...                1 /mnt/c/Users/...
1 file:///C:/...                        1 \\?\C:\...                  1 "see <run>." (sentence end)
0 ~/cross-review-runs/closing-r3/run/phase1
0 ~\cross-review-runs\closing-r3\run
0 %USERPROFILE%\cross-review-runs\closing-r3\run
0 $HOME/cross-review-runs/closing-r3/run
0 ${env:USERPROFILE}\cross-review-runs\closing-r3\run
0 C:\Users\DEVUSE~1\cross-review-runs\closing-r3\run      (8.3 form)
0 \Users\<user>\cross-review-runs\closing-r3\run          (drive-less)
0 C:/Users/<user>/cross-review-runs/closing-r3/./run/x
0 C:\Users\<user>\cross-review-runs\closing-r3\<newline>run\x
0 C%3A%5CUsers%5C...%5Crun (percent-encoded)
(siblings run-evidence, run.bak and the parent were correctly left alone)

sc.mjs (scratch): scrubDir, then the shipped "blind-relabel.mjs scan --in <view> --target-dir ...
--phase1-dir ... --forbid-seats A" exactly as exchange.mjs prepare runs it, run folder
C:\Users\<user>\cross-review-runs\demo-r1\run, 8 spellings in one claim:
scrubbed 1 of 8
scan exit 0 scan clean: 0 identity matches, 0 target-derived reported, 0 trust-boundary URL(s) reported
- ~/cross-review-runs/demo-r1/run\phase2\notes.json
- ~\cross-review-runs\demo-r1\run\phase2\notes.json
- %USERPROFILE%\cross-review-runs\demo-r1\run\phase2\notes.json
- $HOME/cross-review-runs/demo-r1/run\phase2\notes.json
- \Users\<user>\cross-review-runs\demo-r1\run\phase2\notes.json
- C:\Users\<user>\cross-review-runs\demo-r1\.\run\phase2\notes.json
- C:\Users\<user>\cross-review-runs\demo-r1\<newline>run\phase2\notes.json
- <run-dir>\phase2\notes.json
(user name redacted as <user>)
```
Suggested fix: in scrubDir, add the alternatives runDirNamedIn already knows (home `~`, `%USERPROFILE%`/`$HOME`/`${env:...}` prefixes, the drive-less form on Windows, the 8.3 spelling from `fs.realpathSync.native` of the short name) and let `sep` also match `[\\/]+(?:\.[\\/]+)*` and a separator followed by a line break; or have exchange prepare and audit-prep refuse (not mask) any line runDirNamedIn still matches after the rewrite.
Same shape elsewhere: blind-relabel.mjs:3109 (audit-prep, same scrubDir call, same gaps; audit-prep's scan masks the run folder the same way, blind-relabel.mjs:2501-2502); exchange.mjs prepare scrub of each peer view (same function). The same spelling gaps apply to both callers; one fix in path-utils.mjs scrubDir closes both.

## A2 [AC-1] [AC-8] — The `Blocked:` reader misses a block written as a heading, a `•` bullet, a parenthesised number, a task box or a table row, and reads a healthy `Blocked: none (...)` as a block
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat writes its block line in one of the shapes below. The heading and table shapes are common seat habits in Checks performed sections; holds everywhere.
Evidence:
```
review-run.mjs:770-789 seatBlockedLine: the loose pattern, after removing * _ and backticks, is
  /^[\s>+\-\d.)]*blocked\s*:\s*(.*)$/i
so a leading "#", "•", "(", "[" or "|" stops it; the strict pattern /^(?:- )?Blocked: (\S.*)$/ makes
any text after "none" a block.

blk.mjs (scratch) imports the shipped seatBlockedLine; each input is the last line of a
"## Checks performed" section after "## No findings":
"Blocked: shell: EPERM"                       => "shell: EPERM"
"  > Blocked: x"                              => "x"
"1) Blocked: x"                               => "x"
"### Blocked: shell: EPERM"                   => null
"#### Blocked: x"                             => null
"• Blocked: x"                                => null
"(1) Blocked: x"                              => null
"[x] Blocked: x"                              => null
"| Blocked: x |"                              => null
"Blocked： x" (full-width colon)               => null
"Blocked: none (all reads succeeded)"         => "none (all reads succeeded)"
"Blocked: none; every command ran"            => "none; every command ran"
"Blocked: none!"                              => "none!"
"**Blocked:** none (ok)"                      => "none (ok)"
heading variants: "## Checks Performed (summary)" read; "## 5. Checks performed",
"### Checks performed", "# Checks performed" => null (the whole section is not read)

review-run.mjs:841-855 assertSeatsRan: null means "no Blocked: line" (only a warning when the seat
has claims), so a real block in the shapes above never reaches seat-warnings-phase1.json, the
manifest's seat_blind_lines or the report's "may have reviewed blind" caveat.
A No-findings seat that writes "Blocked: none (all reads succeeded)" is refused with
'wrote "No findings" but says it was blocked ... run the seat again in a new run', although
review-protocol.md:244 says "Blocked: none" in any other shape counts as missing, not as a block;
"**Blocked:** none (ok)" in the loose shape is read as "none (ok)" too, but "**Blocked:** none!" is not.
```
Suggested fix: in review-run.mjs:784 widen the leading class to `[\s>#+\-\d.)(\[\]|•·]*` (with `x` allowed only inside `[ ]`) (and accept `：`), read the section heading at any level with an optional number (`/^#{1,6}\s+(?:\d+[.)]\s*)?(?:Checks performed|No findings)\b/i`), and treat a line whose value starts with `none` followed by a non-word character as "no line" (missing), as the protocol says.
Same shape elsewhere: none found (searched review-run.mjs, build-report.mjs, build-manifest.mjs, blind-relabel.mjs for other "blocked" readers; build-report.mjs:747 only renders what seat-warnings-phase1.json carries)

## A3 [AC-1] [AC-8] — The packet-label warning in the host preflight checks only the letter P; a packet tag made of a seat letter (A or B) and a digit gets no warning, then stops audit-prep when a seat quotes it in inline code and is silently renamed to an audit label when quoted in prose
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a task packet that labels its items with the letter A or B, or X or Y, followed by digits (bug lists, field-report items, design options: a common way to number things); holds everywhere.
Evidence:
```
preflight.mjs:1815-1819 peerLabelLines: lines matching /\bP\d+\b/ only; hostPreflight (preflight.mjs:2040-2043)
uses it for the packet warning.

lbl.mjs (scratch) imports the shipped peerLabelLines (checklists ['CHK']) on "- <tag>: a criterion",
tokens shown here as <letter-digit>:
"<P-digit>" warns: true        "CHK-<P-digit>" warns: false (declared, right)   "FOO-<P-digit>" warns: true
"[<P-digit>]" warns: true      "<P-digit>1" warns: true
"<X-digit>" warns: false       "<Y-digit>" warns: false       "<A-digit>" warns: false
"<B-digit>" warns: false       "R-<B-digit>" warns: false     "(<B-digit>)" warns: false
"H1" warns: false (legal)      "AC-2" warns: false (legal)

Then the shipped "blind-relabel.mjs audit-prep" on a two-seat fake run (seat B has one claim, numbered 1),
seat A's claim text "Packet criterion <tag> is not met.":
tag = seat letter B + digit, in inline code => audit-prep exit 1: claim ID "<B-digit>" inside inline code
  -- relabel never rewrites code ... return to seat A
tag = seat letter B + digit, in prose => exit 0, the auditor sees "Packet criterion <X-digit> is not met."
  (the packet's own tag rewritten into the audit label of seat B's claim)
tag = audit letter Y + digit, in prose => exit 0, the auditor sees "Packet criterion <Y-digit> is not met."
  (indistinguishable from the audit label of seat A's first claim under this mapping)
```
Suggested fix: in preflight.mjs:1818 test `/\b[PXYAB]\d+\b/` (keeping the declared-checklist mask for each letter), and say in the warning that seat and audit letters are rewritten or refused too. (The template, references/task-packet-template.md:32, already names all five letters and says the pre-flight warns only about the P shape, so the docs match; the gap is the check, and the silent rewrite in prose, which no doc mentions.)
Same shape elsewhere: preflight.mjs:2036 (the REVIEW.md label warning uses the same peerLabelLines, same gap)

## A4 [AC-4] — On Windows a seat CLI that exits after its answer while a process it started holds its output open leaves that process running: the dispatchers only warn, though preflight stops the same shape on this host
Severity: HIGH
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Trigger: a seat's tool command starts a background process (a dev server, a watcher, `start /b`, a detached node child) that inherits the CLI's output, and the CLI then answers and exits. The seat brief forbids it, but the macOS and Linux field reports show seats doing it; every such run leaves the process alive until someone kills it. Windows (the Linux/macOS form is a Known deviation; the Windows form is not listed there).
Evidence:
```
claude-dispatch.mjs:280-289 (after-answer timer, CLI already exited):
  if (child.exitCode !== null || child.signalCode !== null) {
    settled = true; stream.code = 0; stream.exitedBeforeStop = true; stream.stopIncomplete = true;
    cleanup(); resolve(stream); return;
  }
codex-dispatch.mjs:721-727: the same branch, no kill.
killGroupOnExit (spawn-utils.mjs:59-60) returns at once on win32, and neither dispatcher uses a job
object or a parent-pid sweep, so nothing stops the process on Windows.

tests/fixtures/fake-claude.mjs:41-46: the orphan is spawn(node, ..., { detached: true, stdio: [ignore,
inherit, inherit] }) and lives forever (setInterval); claude-dispatch.test.mjs:654 and :666 kill it
themselves in a finally block, after the dispatcher has returned "completed".
Ran here: node --test --test-name-pattern="still running after a successful answer is stopped"
  scripts/tests/claude-dispatch.test.mjs
  -> pass 1 (34.8 s): the orphan path executes on Windows and the dispatcher returns with it alive.

Same shape, preflight on this host (preflight --exec-file in scratch, 4 commands):
  node -e "spawn(process.execPath,[...],{detached:true,stdio:'inherit'}).unref()"
  -> preflight: WARNING: the command left 1 process(es) running (pid 36000); they were stopped.
  ping.exe and node.exe process lists before and after: unchanged (nothing left).
So a Windows route that stops it already exists (job object, stopLeftovers at preflight.mjs:572).
```
Suggested fix: on win32, in the exited branch of both dispatchers (and the after-stop branch), call the existing preflight `stopLeftovers(child.pid, startMs)` sweep (parent pid plus creation time, so a reused pid is never hit) before resolving, and record what it stopped.
Same shape elsewhere: codex-dispatch.mjs:721-727; claude-dispatch.mjs:291-301 and codex-dispatch.mjs:728-737 (the "stopped, output stayed open" branch: taskkill /T from the CLI pid cannot reach a descendant whose parent already died); opencode-dispatch.mjs:498 (close-only completion, a Known deviation, not counted here)

## A5 [AC-5] — The Phase 2 delta brief's new stay-out line contradicts the protocol rule the same resumed seat already holds: it forbids the task packet and the seat's scratch folder
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
build-brief.mjs:200 (delta brief): "Read nothing in the review's run folder except this brief and your own
output: the other reviewer's files, the run's records and its logs are not yours to read."
references/review-protocol.md:214-215 (copied into every Phase 1 brief, "All seats"): "Read nothing in the
review's run folder except the files your brief names (your brief, the task packet, your own output and
scratch folder)".
references/phase-2-cross-examination.md:21-29: Phase 2 resumes the Phase 1 session with the delta brief,
so both rules are in the seat's context, and the scratch folder it needs to re-run a check for a
Counter-fact sits in the run folder (build-brief.mjs:164-165).
```
Suggested fix: build-brief.mjs:200: "... except this brief, your Phase 1 brief, the task packet, your own output and your scratch folder: ..."
Same shape elsewhere: none found (searched build-brief.mjs buildPhase1, buildDelta and the auditor brief for "Read nothing")

## A6 [AC-9] — `scrubDir` always matches case-insensitively, so on Linux a sibling folder that differs from the run folder only in letter case is rewritten to `<run-dir>`, against the case rule the same round set for the guard
Severity: LOW
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
path-utils.mjs:100  new RegExp(`(?<![A-Za-z0-9_])(?:${[...alts].join('|')})(?![A-Za-z0-9_-]|...)`, 'gi')
build-brief.mjs foldsCase: platform === 'win32' || platform === 'darwin'  (Linux: "r" next to "R" is another folder)
tests/path-utils.test.mjs:436 asserts run.toLowerCase() is rewritten on every platform, so the test pins
the Linux behaviour.
Executed here (scrub.mjs): "c:/users/<USER>/cross-review-runs/closing-r3/run/phase2" -> "<run-dir>/phase2"
(case folded; right on Windows).
```
Suggested fix: path-utils.mjs:100 use `foldsCase(process.platform) ? 'gi' : 'g'` (move foldsCase to path-utils and import it in build-brief), and make the test row at path-utils.test.mjs:436 platform-dependent.
Same shape elsewhere: none found (searched path-utils.mjs, build-brief.mjs and blind-relabel.mjs for case-folded path matching)

## A7 [AC-8] — On Linux and macOS a path written with three or more leading slashes is not a path start in the run-folder guard or the packet scan, though POSIX reads it as the root path: the sibling of the two-slash fix
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
psr.mjs (scratch) runs the shipped pathStartRe(platform) per platform:
linux  "//root/x"   0://        linux  "///root/x"  -
darwin "//root/x"   0://        darwin "///root/x"  -
build-brief.mjs:250  \/{1,2}(?!\/) after (?<![\w:/\\.~-]): with three slashes no position can start.
A literal "///tmp/run" still contains "/tmp/run" and is caught as written; the miss is the resolved
pass (runDirNamedIn), for example "///tmp/a/../run" when the run folder is /tmp/run.
preflight.mjs:1434 PACKET_PATH_START_RE has the same \/{1,2}(?!\/).
```
Suggested fix: build-brief.mjs:250 and preflight.mjs:1434: `\/+(?=[^\/])` in place of `\/{1,2}(?!\/)` on the POSIX branch.
Same shape elsewhere: preflight.mjs:1434

## Checks performed
- AC-1: ran seatBlockedLine on 21 line shapes and 4 heading shapes, the packet-label warning on 15 tag shapes, blind-relabel validate on an empty seat file (refused, exit 1, names B-findings.md), and preflight --exec with 4 commands (exit codes 0, 0, 0, 3 recorded right). A block is missed in some shapes and a healthy "none (...)" line is read as a block. NOT MET (claims A2, A3).
- AC-2: ran shipped scrubDir on 23 spellings and the shipped scan after it as exchange prepare runs it; 7 of 8 non-absolute spellings reach the peer view with scan exit 0; the delta, Phase 1 and auditor briefs all carry a stay-out line. NOT MET (claim A1).
- AC-3: read the new counts (scrubDir count, packetLabels "N more", stop_incomplete keys); each comes from the same list it prints. No mismatch found. MET.
- AC-4: preflight --exec on Windows: a start /b ping and a detached node child were stopped (leftoversStopped), the ping.exe and node.exe process lists were the same before and after, and the after-answer claude-dispatch test ran alone (pass). Dispatchers leave a Windows orphan running. NOT MET (claim A4).
- AC-5: checked preflight --help (exec text), claude/codex-dispatch help (stopIncomplete), task-packet-template.md:32 (tag rule names all five letters and that only the P shape is warned about), review-protocol.md:214 against build-brief.mjs:200. PARTIAL (claim A5).
- AC-6: read initBody (missing_seat_files only when a phase1 seat file is absent, and dropped on a rebuild, build-manifest.mjs:223) and the build-report hypothesis verdict change (found plus PARTLY stays "partly"). An old complete run with both seat files keeps "completed". MET.
- AC-7: no removable code or doc paragraph found in the diff worth a claim. MET.
- AC-8: read the fix lists of linux-3-selfreview.md and macos-3-selfreview.md in full, and the summary tables of linux-2-report.md and mac-2-round5-report.md; linux-1-BUGS.md and mac-1-findings-for-dev.md not re-read (covered by earlier full rounds). Linux item 1 is closed only for absolute spellings (claim A1); Linux item 4's sibling with three slashes is open (claim A7); Linux item 6 and macOS item 5 are closed for the P letter only (claim A3); Linux items 2, 7, 9, 10, 12, 13, 14 and macOS items 1-4, 6, 8 hold on the code as read or run; Linux items 3, 5, 8 and 11 are Known deviations. PARTIAL (claims A1, A3, A7).
- AC-9: old and new loose blocked line: patterns compared: every shape the old pattern matched ("* blocked line:", "__blocked line:__", "> blocked line:") the new one still matches; mentionsDir's [A-Za-z] change is identical on Windows (text lower-cased first); packetPaths now splits on ";" and "&", but the whole word is looked up first, so "C:\R&D\a.md" is still found. scrubDir's case-folding on Linux is the one regression found (claim A6). A possible false "does not exist" note for a bare "//" in a POSIX packet was not run. PARTIAL (claim A6).
- AC-10: path-utils.test.mjs:426-447 checks only absolute, JSON-escaped, mixed and /c/, /mnt/c/ spellings (the gaps in claim A1 are untested), and :436 pins case folding everywhere (claim A6); claude-dispatch.test.mjs:654,666 clean up the orphan themselves, so no test checks that it is stopped (claim A4). NOT MET (claims A1, A4, A6).
- H1: preflight --exec on Windows with a start /b child, a detached node child, and a late-output exit 3: no block, right exit codes, output kept ("late"), leftovers stopped; read the held-grace timer (preflight.mjs:768-781): it is skipped once timedOut or guard.stopping is set and cleared by close. REFUTED.
- H2: read buildPhase1 (protocol "All seats" with the stay-out line), buildDelta (line 200) and the auditor brief; every reader is told, but the delta wording contradicts the Phase 1 rule. PARTLY CONFIRMED (claim A5).
- H3: read killGroupOnExit (spawn-utils.mjs:59-67): one kill(-pid) inside the exit event, onKilled only on success, the group id cannot be reused while a member remains. POSIX branch not executed here (Windows host). REFUTED.
- H4: read initBody (stat of both phase1 files) and ran validate on an empty seat file: an empty file stops audit-prep before findings.json can exist, so it cannot end "completed" on the supported route; an old run with both files is unchanged. REFUTED.
- H5: ran peerLabelLines on 15 shapes and audit-prep on 3 packet-tag cases: tags made of the X, Y, A or B letter and digits are never warned about; a seat-letter tag in inline code stops audit-prep; in prose it is silently renamed. Legal H and AC tags and a declared checklist are not warned about. CONFIRMED (claim A3).
- H6: ran foldsCase per platform (linux false, darwin and win32 true) and read runDirNamedIn (prints path.resolve(runDirArg), the folder as given). REFUTED.
- H7: ran scrubDir on 23 shapes and the scan after it: home-relative, variable, drive-less, dotted, 8.3, percent-encoded and line-wrapped spellings reach the peer; siblings run-evidence and run.bak, the parent and the sentence-end period are handled right; on Linux the rewrite folds case (claim A6). CONFIRMED (claims A1, A6).
- H8: ran pathStartRe for linux, darwin and win32 on 12 shapes: two slashes start a path on POSIX only, "//server/share" is not read on Windows; three slashes are missed on POSIX. PARTLY CONFIRMED (claim A7).
- H9: read the exited branches (claude-dispatch.mjs:280-289, codex-dispatch.mjs:721-727): no kill, settled is set before close, so close returns early; the warning says it exited (the process left running on Windows is a separate defect, claim A4). REFUTED.
- H10: ran 21 line shapes and 4 heading shapes; missed shapes and the false block for "none (...)" are claim A2; a later "blocked line: none" never clears a block (ran "none" then a block, and a block then "none"). CONFIRMED (claim A2).
- H11: read codexState, agentLastReply and checkFinalReply: a last turn_aborted gives "aborted" and is refused; a later task_started then task_complete gives "done"; a later turn that ends with no last_agent_message gives reply null, which passes with no warning, as it did before this change (the earlier turn's "written" was read then). A finished agent is not refused. REFUTED.
- H12: traced noteAnswerStop calls for phase 1 and phase 2 (waitSeats), the CLI auditor (dispatchAuditor) and a --wait rerun (idempotent key in stop-incomplete.json), then build-manifest stop_incomplete and the build-report caveat. REFUTED.
- H13: see AC-8: Linux item 1 (partly, claim A1), Linux item 4 (sibling, claim A7), Linux item 6 and macOS item 5 (P only, claim A3) are not fully fixed and not listed under Known deviations. CONFIRMED (claims A1, A3, A7).
- Installed copies: byte diff of the four installed skill folders against the repository: no difference; no plugin copy of these skills under the plugin cache.
- Coverage: since.diff read fully (script and test hunks; doc hunks partly); review-run.mjs, preflight.mjs, blind-relabel.mjs, build-brief.mjs, claude-dispatch.mjs read partly (changed regions and their callers); native-agent.mjs, path-utils.mjs scrubDir read fully; linux-3 and macos-3 read fully, linux-2 and mac-2 partly, linux-1 and mac-1 not read; bench/, validate-repository, release-check, install-check not read.
Blocked: none

web: 0 queries, 0 page fetches
