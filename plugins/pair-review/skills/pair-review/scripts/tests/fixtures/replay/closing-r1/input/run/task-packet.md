# Task packet: end-to-end self-review of the two review skills (Windows host), closing round
Review round: 8

Profile: Code + Document (Node.js scripts, tests and markdown protocol files). Target: @@TARGET@@, branch main, HEAD ea0b739, working tree DIRTY: every change since ea0b739 is uncommitted and is the subject of this review.
Read-only review: do not edit, create or delete any file in the target; do not commit.

This is the closing round. Since the last full review, the author stopped patching free-text guesses and replaced them with structured inputs: a strict `Blocked:` line written by each seat, backtick-quoted evidence paths, and explicit endpoints. Each of those changes got its own narrow check. This round has three jobs. (1) Find every real defect in the two skills, end to end, with the changed code as the most likely place. (2) Confirm or refute each hypothesis below from the code as it is now. (3) Confirm that the field-feedback findings in the four feedback files stay fixed (AC-8). Run the input against the shipped functions or scripts, not a reconstruction of them.

## Scope
- In scope: `plugins/pair-review/skills/pair-review/` and `plugins/cross-review/skills/cross-review/` (SKILL.md, references/, scripts/, scripts/tests/), the plugin manifests, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `scripts/validate-repository.mjs`, `scripts/release-check.mjs`, `scripts/install-check.mjs`, `bench/outcomes.mjs`, `bench/case-from-run.mjs` and their tests in `bench/tests/`, `README.md`. The shared scripts are byte-identical in both skills (validate-repository enforces it): review one copy, and name the sibling only for a skill-specific finding (`opencode-dispatch.mjs` and `dispatch-integration.test.mjs` exist only in cross-review).
- Also in scope: the installed copies `C:\Users\dev\.claude\skills\pair-review`, `C:\Users\dev\.claude\skills\cross-review`, `C:\Users\dev\.agents\skills\pair-review` and `C:\Users\dev\.agents\skills\cross-review`. A byte difference between a repository skill file and its installed copy is a finding.
- Out of scope: `plugins/shared-brain/`, the rest of `bench/`, `docs/design/`, the target's `.claude/` folder (host settings), CHANGELOG wording, style, naming, formatting, refactors for taste.
- The skills must be generic: they review any code base, design or document. Text in the skills that ties them to one project, vendor domain or file layout is a finding (AC-5).
- Host: Windows 11, PowerShell 5.1, Node 24, git for Windows. A claim names the platform fact it depends on (Windows, Linux, macOS) or says it holds everywhere. A Linux- or macOS-only claim stays at most MEDIUM unless the code path is shown executing. Many shipped functions take a `platform` or `env` argument (for example `expandPathVars(text, { env, platform })` in path-utils.mjs): call them with `platform: 'linux'` or `'darwin'` to execute a POSIX path on this host. A directory junction (`mklink /J`) can stand in for a link.

## What changed since the previous full review
The full diff: `C:/Users/dev/cross-review-runs/closing-r1/evidence/since.diff` (1469 lines, 19 files; pair-review copies only, the cross-review copies of each shared script are identical).
- `Blocked:` line, strict (review-run.mjs `seatBlockedLine`, `noFindingsOnly`, `assertSeatsRan`): the line is `Blocked: none` or `Blocked: <text>`, an optional leading "- " allowed; any other shape counts as no line. The wording guess (`seatBlindLines`, `seatRanNothing`, the `SEAT_*_RE` lists) is deleted. In Phase 1 a `## No findings` seat stops the step when it has no valid line, when it declares a block, or when its stderr shows command failures; a seat with claims and no line gets a warning; a declared block on a seat with claims gets a warning and a `seat-warnings-phase1.json` record. build-report's caveat says "may have reviewed blind: it reported a blocked read or command". review-protocol.md "All seats" states the rule.
- Packet path scan (preflight.mjs `packetPaths`): a backticked item is taken whole (spaces allowed); a bare word ends at the first whitespace, leading quotes and brackets stripped, trailing punctuation trimmed; a backticked item holding an option word (` -x`, ` --name`) is a command and read word by word.
- Endpoint scan (preflight.mjs `packetPorts`): URLs, IPv4, `[IPv6]` (at least 2 colons) and `localhost` only; the file-type and host-ending lists are deleted.
- Run-folder guard (build-brief.mjs `runDirNamedIn`, `assertOutsideRunDir`): file URLs decoded, a Git Bash `/c/...` spelling read as `C:/...` on Windows, the packet and `--rules` checked in both phase1 and auditor modes. path-utils.mjs `expandPathVars` and `decodeFileUrls`.
- build-recheck-packet.mjs: the leftover-old-path warning is deleted and replaced by a fixed reminder printed when `--target` or `--repo-target` is given; the location picker prefers a changed file.
- Windows `--exec` job wrapper (preflight.mjs `JOB_WRAPPER`, `execSpawn`): the C# job helper is compiled once into a cached DLL in the OS temp folder (named by a hash of the wrapper), loaded with `[Reflection.Assembly]::LoadFrom`; a DLL that cannot load is deleted and the wrapper falls back to the leftover-process scan; the DLL path variable is removed before the command runs.
- Docs: SKILL.md "Project knowledge" paragraph (the orchestrator copies project knowledge into the packet; seats never read the user's memory or skills); task-packet template asks for evidence paths in backticks and endpoints as URLs; neutral examples.

## Acceptance criteria (tag each one so claims can cite it)
- [AC-1] Never clean when it is not: every step that cannot do its job exits non-zero with a message naming the file or flag; no step exits 0 with a missing, empty or stale output; no `--wait` reports done while a seat wrote nothing or read nothing; no warning is silenced for a case it exists for.
- [AC-2] Blinding holds both ways: no seat or auditor can read, or is told, the peer's identity, files or labels, or a vendor or model name, before the protocol allows it; the identity scan does not block on text derived from the target or the run's own folders.
- [AC-3] Numbers reconcile: every count a script prints equals an independent count from the files it came from.
- [AC-4] Recoverable, repeatable and clean: after any refused or interrupted step the run folder can be resumed or cleanly refused; nothing half-written; no child process survives a finished, failed, timed-out or stopped step, and no seat process keeps running after its answer is complete; no console window opens per child on Windows; an unrelated process is never signalled.
- [AC-5] Docs match scripts: every command, flag, default, exit code, file name and message in SKILL.md, references/, README, the task-packet template and each script's --help holds as written; nothing ties the skills to one project.
- [AC-6] Old runs still work: a run folder, manifest, notes file or packet written before these changes renders, rechecks and validates as before, except where a change says otherwise.
- [AC-7] Weight: code, flags, files or doc paragraphs that can be removed with no loss. At most 3 claims per seat.
- [AC-8] Field feedback fixed: every finding in the four feedback files is fixed on the code as it is now, or is listed under Known deviations with a reason that still holds. A fix that closes the reported input but leaves a sibling input of the same shape open is PARTLY CONFIRMED.
- [AC-9] No regression from a fix: every narrowed pattern, deleted check or removed line in the diff keeps accepting what it accepted before, unless the change says otherwise. For each such change you checked, name one real input the old line handled and the new line mishandles (a finding), or say no such input exists and why.
- [AC-10] Tests prove the fixes: a test that still passes with its fix reverted, or that checks only the input the fix was written for while a sibling input of the same shape is untested, is a finding (LOW, or MEDIUM when the untested input is broken).

## Known deviations from the criteria
Accepted, not to be reported again unless the description below is no longer accurate:
- Deleted by design: the blind-seat wording guess. A seat that writes findings with no valid `Blocked:` line gets only a warning; a seat that lies in its `Blocked:` line is not detected. A defect in how the line is read, or a protocol path where a seat is not told to write it, is not covered by this deviation.
- Decided by the maintainer: a bare (unquoted) path with a space in it is read only up to the space; the template says to put such paths in backticks. A missed or false ADVISORY warning from the packet path scan, the reach probe or the missing-`Blocked:`-line warning is LOW.
- An endpoint written as `name.ending:port` (no URL scheme, not an IP or localhost) is not probed: write it as a URL.
- On Windows each preflight `--exec` command costs about 5 to 7 seconds more on a busy machine (PowerShell start-up of the job wrapper); `--timeout` counts that time. A process that asks to break away from the job is allowed to and is then not stopped. Dispatchers still stop a seat's process tree by its parent chain.
- The plugin version stays 1.1.0 for this content: the bump is the maintainer's release decision.
- The shallow-seat warning compares claims and web use, not run duration.
- `exchange.mjs prepare`: when it stops half-way, its message gives the manual recovery steps instead of resuming by itself.
- A read-only seat cannot run the test suite itself: the documented route is the preflight evidence logs.
- Output tokens of native Claude agents are unknown; the round count follows one chain of re-reviews; a REVIEW.md only the branch added is named and not used; Codex text in result.json is UTF-8.
- Known flaky under load, not a finding by itself: the detach tests "five consecutive workers" and "--detach returns at once", claude-dispatch "an isolated seat writing the real target by absolute path", the codex mcp-hang test and the opencode `--isolate` test; a failure that also happens when the file runs alone is a finding.
- By design: a finding marked "wrong" leaves every count and list; a file-name or ambiguous partial-path Where match never regroups a finding; the scratch folder is named in the brief but created by the seat.
- Platform: this host cannot run macOS or Linux. Hypotheses that need them say so; end those lines "PARTLY CONFIRMED" only for a defect you showed, otherwise REFUTED with the emulation you used, or "not executable here" in the line text plus REFUTED or CONFIRMED from the static trace.

## Start here
1. `C:/Users/dev/cross-review-runs/closing-r1/evidence/since.diff`: read every hunk. Newest first: preflight.mjs `JOB_WRAPPER` and `execSpawn`; preflight.mjs `packetPaths` and `packetPorts`; review-run.mjs `seatBlockedLine`, `noFindingsOnly` and `assertSeatsRan`; build-brief.mjs `runDirNamedIn`; build-recheck-packet.mjs.
2. The four feedback files in `C:/Users/dev/cross-review-runs/closing-r1/evidence/feedback/`: linux-1-BUGS.md, mac-1-findings-for-dev.md, mac-2-round5-report.md, linux-2-report.md.
3. The run lifecycle: review-config seats -> preflight -> review-run (phase1, phase2, audit) -> build-manifest -> build-report; then build-recheck-packet for the next round. Trust boundaries: build-brief, blind-relabel (scan, audit-prep, translate), exchange, run-descriptor, spawn-utils, detach-utils, codex-dispatch, claude-dispatch.
4. `git diff ea0b739 -- plugins/pair-review` holds everything uncommitted.
This is a start, not a limit.

## Evidence both seats may cite
Pre-flight `C:/Users/dev/cross-review-runs/closing-r1/evidence/preflight.json` (Tier 1 only, no test run): HEAD ea0b739, snapshotHash 4d1d60d557af4287a41a4b08563701f9fa2d30a5e9cbb5da04c9381fe9879cd8, 107 changed files (7 untracked; `.claude/` is the host's local settings folder and out of scope). Its warning about 16 files holding review output names the skills' own test fixtures: expected.
A seat that can write runs single test files itself; a seat that cannot cites STATIC_TRACE.

## Author-reported evidence (not reproducible; do not cite as EXECUTED)
- Quick-install, both skills: every test file for the changed scripts passes (0 fail, 3 skipped); the four installed copies match the repository byte for byte.
- Mutation check: each change in the closing pass has a mutant that turns a test red (23 rows, all red).
- Real data: the packet path and endpoint scans on 43 real packets lose no path or endpoint compared with the scans before the closing pass.
- The full release check has not been run since the closing pass started.

## Hypotheses to test
In `## Checks performed`, end each hypothesis line with CONFIRMED (the defect is there), REFUTED (it is not) or PARTLY CONFIRMED.
- [H1] A seat can finish Phase 1 as clean zero findings while it read nothing: a `## No findings` file whose `Blocked:` line is malformed, in a code fence, in a quote block, duplicated with conflicting values, or placed before the end, passes `phase1 --wait` with exit 0.
- [H2] The strict `Blocked:` reader rejects a well-formed line a seat would really write (CRLF endings, trailing spaces, `**Blocked:** none`, `Blocked: None.`), so a healthy seat is stopped or warned.
- [H3] A Codex seat that has written its final answer but whose process does not exit (it can hang after its Stop hook) is held until `--timeout` (default 1800 s) and then reported as timed out, its answer lost, and its processes keep using memory meanwhile (codex-dispatch.mjs waits for the process `close` event).
- [H4] A finished, failed, timed-out or stopped `review-run` step leaves a child process running (a detached worker, a seat CLI, a `taskkill` child, a PowerShell job wrapper, a `codex-command-runner`). Show the process list before and after.
- [H5] The cached job-helper DLL can be used when it should not: two commands starting at once with no DLL yet, a TEMP path with spaces or non-ASCII characters, or a DLL from another version, end in a crash or a command that never runs instead of the `nojob` fallback.
- [H6] The packet path scan loses a path a real packet names (a backticked path with spaces, a quoted path with a line suffix like `file.mjs:12:3`, a path in parentheses or angle brackets, a drive-less `\Users\...` path, a `file:///` URL with `%20`) or reads a command as a path.
- [H7] The run-folder guard misses a spelling of the run folder that a packet or `--rules` file can carry (a Git Bash `/c/...` path, a junction, a `~` or variable spelling, a `file:///` URL, `..` segments), so a seat is pointed at the peer's files.
- [H8] A doc or brief still ties the skills to one project or vendor domain, or tells the orchestrator or a seat something the scripts no longer do (for example the deleted wording guess or the deleted leftover-path warning).

## Checks
- Run tests and repros only in a disposable copy outside the target, or by importing the shipped module from the target without writing into it, with TMPDIR/TEMP pointed at your own scratch folder.
- Evidence rules: execute before you claim (a HIGH needs the input, command and output); prove reachability from a supported route; sweep the class and list every site; for every narrowed or removed line (AC-9) say what it used to accept; for a process claim show the process list before and after.
- For each hypothesis, try at least one sibling input of the same shape besides the one named.
- Coverage line in `## Checks performed`: read fully / read partly / not read.
- Proposals: the smallest change that closes the defect, lines named; no new flag, mode, file or dependency unless the defect needs it; no style claims.
Run single test files (`node --test scripts/tests/<name>.test.mjs`) in the foreground, not the whole suite at once.

## Severity note
HIGH: a blocked or blind reviewer reported as clean, a blinding leak, a lost or overwritten run, worktree or target file, a process left running after a step or a run, a console window per child, a kill of an unrelated process, a wrong number in a report a reader acts on. MEDIUM: a step that exits 0 when it should stop, a wrong result or count, a doc that misleads, a portability problem that blocks a normal user on a common setup. LOW: a missed or false ADVISORY warning (the packet-path "does not exist" note, a reach-probe item, the missing-`Blocked:`-line warning), an AC-7 weight claim, anything minor. A field-feedback fix that does not hold for the reported input is at least the feedback's own severity. Every HIGH and CRITICAL claim states its Trigger (what input or state makes it happen, and how often a real run meets it). The reader is the maintainer deciding what to fix before the next release.

## Output
Findings in the required schema in your own findings file. A `## Checks performed` section: one line per AC and per H tag, ending in MET / PARTIAL / NOT MET or CONFIRMED / REFUTED / PARTLY CONFIRMED, plus the Coverage line, and last the `Blocked:` line your brief describes.
Web verification is off (repo-only review). Close with one line: `web: 0 queries, 0 page fetches`.
