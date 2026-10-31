# Seat A findings

## A1 — [AC-5] [AC-6] Step 3 (seat folders beside the run folder) breaks the fingerprint and the worktree snapshot on the CLI-dispatch host's documented layout, and moves the seat's own folder path out of the run-folder guard
Severity: HIGH
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: Step 3 as written, on any run whose run folder sits inside the target repository: the CLI-dispatch host's page (references/hosts/codex.md) tells the user to put it there (git-ignored by name), and preflight only checks the run folder and its audit-input sibling for ignore coverage. Also every run in which a seat pastes its own working-folder path (the brief forbids it, but the field runs show seats doing it).
Evidence:
```
references/hosts/codex.md:55  Put the run folder inside the folder Codex was started in (the native agent inherits the Codex sandbox, so its
references/hosts/codex.md:57  git-ignores: the Claude CLI seat's worktree snapshots the whole repository, so preflight refuses a run folder

scripts/preflight.mjs:1749  for (const dir of [runDir, `${runDir}-audit-input`, ...(opencode ? [`${runDir}-worktree`] : [])]) {
scripts/preflight.mjs:1917  const inRepo = await runFolderInRepo(cdAbs, runDir, seats);
scripts/preflight.mjs:1918  if (inRepo) throw new RelayError(`host ${host} refused: "${inRepo}" is inside the git repository that holds --cd and is not git-ignored; ... would break the Phase 2 resume and be copied into the seat's snapshot ...`);

(the snapshot hash and the seat worktree both take every untracked, not-ignored file)
scripts/preflight.mjs:523  const untrackedRes = await gitOut(['ls-files', '--others', '--exclude-standard', '-z'], cd);
scripts/worktree-utils.mjs:67-80   git ls-files --others --exclude-standard  ->  untracked[] (path, sha)
scripts/worktree-utils.mjs:295     await copyEntry(entryPath(targetDir, entry), dest);

(the guard that rewrites a seat's own folder path is keyed to the run folder only)
scripts/run-descriptor.mjs:179  return path.join(desc.runDir, phase, `seat-${role}`);
scripts/build-brief.mjs:165     const scratch = base && path.join(base, `scratch-<hash>`)   // base = dirname(outputPath) = <run>/phase1/seat-<letter>
scripts/exchange.mjs:229        const scrubbed = scrubDir(await fs.readFile(out, 'utf8'), args.runDir);
scripts/blind-relabel.mjs:3114  scrubDir(relabeled, path.dirname(path.resolve(args.phase1Dir)))   // audit-prep: the run folder
```
Today a seat's scratch path is inside the run folder, so a pasted path is rewritten to the placeholder before the peer or the auditor sees it. Under step 3 the same path (`<parent>/seat-<letter>/scratch-.../x`) is outside the run folder: the scrub and the guard pass it through, so the seat letter in the folder name reaches the relabelled peer view and the auditor (an identity leak the relabel cannot undo). On that host's layout the sibling folders are not covered by the user's ignore rule for the run folder, so every seat write changes the target's snapshot hash (a false drift stop at phase 2 and at the audit) and the other seat's folder, findings file included, is copied into the worktree-isolated CLI seat's snapshot (independence leak). The plan's risk row for step 3 names only "native agents, Codex sandbox".
Suggested fix: Step 3: each seat's working folder is a fresh folder with a random name and no seat letter, created where the seat's disposable worktree already lives (the OS temp folder), named in the brief; the sequencer copies the findings file into the run folder when the seat replies, and the guard rewrites the run folder and every seat working folder; gate: preflight's in-repo probe and the fingerprint exclude the working folders, the blinding test pastes a working-folder path into a seat file and asserts the peer view and the audit folder hold neither the path nor the letter, run on a run folder inside the repository (the hosts/codex.md layout) and outside it.
Same shape elsewhere: scripts/preflight.mjs:1528 and :1534 (the packet reach check exempts only the run folder and its audit-input sibling: a working folder named in a packet would be reported as a reach problem); scripts/run-descriptor.mjs:259 (the peer's forbidden folders are listed by the `seat-<letter>` pattern and must follow the move).

## A2 — [AC-4] Decision B's "no measured loss" is not supported: the five closing rounds (all full audits) show the auditor changing the severity of 3 of 30 agreed MEDIUM/LOW claims, one raised to HIGH, and the 466-claim figure cannot say how many agreed claims an auditor ever checked
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: SUPPORTED
Trigger: every run under Decision B whose agreed MEDIUM claim the full audit would have raised or whose severity the report then prints unaudited; in the closing rounds that is 1 run in 5 (round 4).
Evidence:
```
$ python -I -c "<tabulate severity, severity_audited and peer_responses per finding in closing-r1..r5/run/phase3/findings.json>"
(round, item, independently_discovered, severity, severity_audited, final_state, peer responses); items renamed from their letter-digit labels
(1, item 1, False, 'HIGH', 'LOW', 'settled-agree', ['conceded'])
(3, item 7, True, 'MEDIUM', 'LOW', 'settled-agree', ['conceded', 'conceded'])
(3, item 8, False, 'HIGH', 'LOW', 'settled-agree', ['conceded'])
(3, item 9, False, 'HIGH', 'MEDIUM', 'settled-agree', ['conceded'])
(3, item 10, False, 'MEDIUM', 'LOW', 'settled-agree', ['conceded'])
(4, item 6, False, 'MEDIUM', 'HIGH', 'settled-agree', ['conceded'])
(4, item 8, False, 'HIGH', 'MEDIUM', 'settled-agree', ['conceded'])
(4, item 11, False, 'HIGH', 'MEDIUM', 'settled-agree', ['conceded'])
(5, item 8, False, 'HIGH', 'MEDIUM', 'settled-agree', ['conceded'])
Counter: agreed MEDIUM/LOW unchanged 27, agreed MEDIUM changed 3 (two lowered, one raised to HIGH); agreed HIGH changed 6 of 16
run.json flags in all five rounds: {'auditDepth': 'full', ...}

references/review-protocol.md:981-987  Audit depth: light. The default. ... Do not re-check a finding whose every origin was
  conceded by the peer, or one both reviewers found independently ... record it NOT_CHECKED
```
"0 of 466 agreed claims refuted" measures refutations only. In a light audit (today's default) an agreed claim is recorded NOT_CHECKED, so the look-back can only count refutations from the runs that used a full audit, and the plan does not say how many of the 466 were checked at all. The full audits that exist corrected severity on 9 of 45 agreed claims, including one MEDIUM raised to HIGH that Decision B would have let through unaudited. The packet adds that most of the 45 runs reviewed these skills or a few field targets.
Suggested fix: Decision B: default audit = every disputed claim, every sweep claim, every agreed HIGH or CRITICAL, plus a severity check (not a re-check) of every agreed MEDIUM: the auditor reads the claim and its evidence and may change the severity only; the manifest records `audit_depth: standard` and the report says which claims were severity-checked only; evidence line in the plan: "in rounds 1-5 (full audits) the auditor changed the severity of 9 of 45 agreed claims; the 466 figure counts refutations in full audits only (N runs)".
Same shape elsewhere: section 1 row "Look-back over 45 runs: claims both seats agreed on, later refuted 0 of 466" and section 5 "agreed claims stay near 0% wrong" repeat the same measure without the audit-depth caveat.

## A3 — [AC-4] The "estimated missed" line in section 5 is dominated by noise at the overlap sizes real rounds have (1 to 4 claims), and in round 3 it would have read "about 3" while the next two rounds found 19
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: SUPPORTED
Trigger: every report; worst when the two seats share 1 or 2 claims (rounds 1 and 2 of the closing series) or after Decision A adds sweep claims that are counted as overlap.
Evidence:
```
$ python -I -c "<per round in closing-r1..r5/run/phase3/findings.json: count origins by seat, Lincoln-Petersen n1*n2/m, Chapman (n1+1)(n2+1)/(m+1)-1>"
round 1: found 9, seat one 5, seat two 5, both 1; Lincoln-Petersen N=25.0 missed=16.0; Chapman N=17.0 missed=8.0
round 2: found 8, seat one 5, seat two 4, both 1; Lincoln-Petersen N=20.0 missed=12.0; Chapman N=14.0 missed=6.0
round 3: found 11, seat one 7, seat two 8, both 4; Lincoln-Petersen N=14.0 missed=3.0; Chapman N=13.4 missed=2.4
round 4: found 11, seat one 7, seat two 7, both 3; Lincoln-Petersen N=16.3 missed=5.3; Chapman N=15.0 missed=4.0
round 5: found 8, seat one 6, seat two 4, both 2; Lincoln-Petersen N=12.0 missed=4.0; Chapman N=10.7 missed=2.7
pooled (findings-rounds-1-5.md totals): seat one 30, seat two 28, both 11 -> N=76, found 47 (62%), missed 29
```
The plan's section 1 line "about half, at most" does not follow from the pooled figure (62% found); the caveat about dependence is a direction, not a number. Per run the estimator uses m of 1 to 4: one merge decision by the orchestrator (two claims joined into one finding, or not) moves "missed" by a factor of two, and the two estimators disagree by a factor of two at m=1. Round 3's "about 3 missed" preceded 19 findings in rounds 4 and 5 (some new from fixes, many old: the guard spellings, the Blocked shapes, the heading gate). A number this unstable, printed in the report next to "falls run by run" as a target, will steer a stop decision the wrong way.
Suggested fix: Section 5: drop the "estimated missed: about N" line; the report prints the raw overlap (found by one seat only / by both) and the sentence "two seats sharing k of n claims is weak evidence of completeness when k is under 5"; the stop rule stays the trigger rule plus "no finding only one seat raised on changed code" (SKILL.md's existing round rule); Decision A's sweep claims are never counted as overlap.
Same shape elsewhere: section 1 row "Estimated share of defects one round finds (from the overlap) about half, at most" (the same estimator; the data gives 62% before the dependence correction).

## A4 — [AC-5] Step 0's replay test cannot be byte-for-byte, cannot run through the sequencer on a stored run, is built on the entry points step 4 removes, and is refused by step 2's strict format for 6 of the 10 stored seat files
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: step 0 as written, on every stored run folder; then again at step 2 and step 4.
Evidence:
```
scripts/build-manifest.mjs:989   const stamped = { ...manifest, run_id: randomUUID(), hashes };
scripts/build-manifest.mjs:716   // The transcript keeps the usage snapshot from the start of each reply ... (orchestrator usage from the live session transcript)
scripts/build-report.mjs:1333    const end = await stat(findingsFile).then((s) => s.mtime.toISOString(), () => null);
scripts/build-report.mjs:1334    return { start: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null, end };
closing-r5/run/manifest.json: reviewers[0].worktreePath = C:\...\Temp\rv-682b3251, usage.*, duration_ms, run_id

scripts/review-run.mjs:353-380   assertNoDrift: the target no longer matches the fingerprint recorded for Phase 1 -> StepError unless --accept-drift
scripts/review-run.mjs:150-151   function runScript(step, name, argv ...) { spawnSync(process.execPath, [scriptPath(name), ...argv] ...) }
scripts/review-run.mjs:950,983,1036,1130,1138,1204,1386,1411  validate / exchange prepare / finish / flip / audit-prep / scan / translate / scorecard run as child node programs

fmt-count.mjs (the author's counter, imported from this worktree): closing rounds 1-5 {"files":10,"fit":4,"other":6}
```
A stored run cannot be re-fingerprinted (its target was a dirty tree that no longer exists), so a replay through `review-run` stops at the drift check or carries a drift caveat the original manifest lacks. The varying fields (run id, orchestrator usage, worktree paths, start/end times, durations) need a stated mask. The only entry to the pipeline steps today is each script's command line, which step 4 deletes, so the safety net built in step 0 breaks at step 4 unless it is written against one seam. And after step 2, the strict parser refuses 6 of the 10 stored seat files, so for those runs the replay ends at validate and no longer covers exchange, audit-prep, translate, manifest or report.
Suggested fix: Step 0: the replay harness calls the pipeline through one function `runPipeline({ runDir, seatFiles, auditFile, clock, ids })` added now as a thin wrapper over today's runScript calls (the only place step 4 changes); expected output = today's manifest and report with run_id, usage, worktreePath, duration_ms, start/end masked by a listed normalizer, the fingerprint check stubbed through run.json's existing null fingerprint; gate: the masked diff is empty for every stored run; Step 2 adds, per stored seat file the strict parser refuses, a fixture pair (the original and its one-line corrected copy) so the downstream replay keeps running on the corrected copy and the refusal reason is asserted on the original.
Same shape elsewhere: scripts/exchange.mjs:133 (exchange also spawns blind-relabel and build-brief as child programs; the same seam is needed there).

## A5 — [AC-5] [AC-2] Step 2's gate "sweep of the 177 real seat files" has no pass threshold, the older corpus cannot measure the Blocked part at all, and the author's 9-of-10 variant ("last exact Blocked line wins") reopens round 1's second finding
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: step 2 as written; every seat whose Checks performed section quotes a `Blocked:` line outside a fence or writes a variant section heading (6 of 10 in the closing rounds, which reviewed the Blocked reader itself).
Evidence:
```
$ node fmt-count.mjs   (the packet's strict-format-count.mjs, pointed at this worktree's copy of the scripts)
older runs {"files":173,"fit":0,"noBlockedOnly":157,"other":16} {"n exact Blocked lines":16,"n other blocked-like lines":2,"n variant section headings":8,"no exact \"## Checks performed\"":6}
closing rounds 1-5 (current brief) {"files":10,"fit":4,"noBlockedOnly":0,"other":6} {"n other blocked-like lines":5,"n variant section headings":5}
older files with a Blocked-like line: 2; fit strict: 0; fit last-line rule: 0
older files readable: 173 of 173     (173 + 10 = 183 files, not 177)

findings-rounds-1-5.md, round 1, second item (HIGH): "When a seat writes a block line and then a later 'Blocked: none', the reader keeps only the last line, so a blocked No findings seat passes phase1 --wait as clean"
closing-list.md, Known gaps: "In round 5, seat A needed one format fix before the exchange ... That call's cost is not in the manifest."
```
Only 2 of the 173 older files contain any `Blocked:` text (the rule did not exist), so the sweep can measure the heading rules on them (16 of 173 refused, 9%) but not the Blocked rule; the Blocked rule is measurable on 10 files only, where it refuses 6. The plan's step 2 gate records a number and passes regardless. The "last exact line of the section" variant the packet offers fits 9 of 10 but is exactly the defect round 1 fixed. The plan also leaves open what happens when the one rewrite is refused again, and the rewrite call's usage still goes unrecorded.
Suggested fix: Step 2: the strict grammar is "exactly one line starting `Blocked:` outside fences in the Checks performed or No findings section, and no other `Blocked:` text outside a fence anywhere in the file" (never last-line-wins); gate: on the 10 closing files plus the 16 older files with variant headings, every refusal reason is one the brief states in words, the ask-again rate on the next real run on a generic target is at most 1 seat in 10, and a seat refused twice is recorded in the manifest as `format_refused` (run INCOMPLETE, never "blind" or "missing") with the rewrite call's usage added to that seat's usage.
Same shape elsewhere: closing-list.md Known gaps (the `--native-done` and `validate` exact `## No findings` rule is the same grammar; step 2 should name it as the one place the rule lives).

## A6 — [AC-4] [AC-3] Decision A brings no data, duplicates the class sweep Phase 1 already requires, adds a new claim section to the parser the plan is shrinking, and its sweep claims would inflate the overlap estimate unless excluded
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Trigger: every run under Decision A; the estimate interaction triggers whenever a sweep claim is merged with a peer claim into one finding.
Evidence:
```
references/review-protocol.md:268-270  - Class sweep: when you confirm a defect, search the target for every other place with the same shape ... before
  you write the finding, and end the finding with `Same shape elsewhere: <file:line, ...>` or `Same shape elsewhere: none found (searched <what>)`
references/phase-2-cross-examination.md:357-359  Both reviewers get the same Rebuttal instruction ... one `### P<n>` block per peer claim, `Action`
  exactly `CONCEDE` or `DISPUTE`, referring to peer claims only by `P` IDs.
scripts/blind-relabel.mjs:2612  const REBUTTAL_HEADING_EXACT_RE = /^## Rebuttals \(from ([AB])\) of ([AB]) claims$/;
scripts/blind-relabel.mjs:2122  async function translateFindings(...) { 330 lines }   (origins, independently_discovered, peer_responses are derived from Phase 1 claim blocks + rebuttal sections only)
closing-list.md: "every round 5 finding was a missed sibling input in a fix made the same night"
```
The plan says the sweep "targets exactly what the closing rounds kept finding", but the closing list attributes round 5 to fix-side siblings (Decision C's territory), and the Phase 1 brief already demands a sibling search per confirmed defect. A Phase 2 sweep claim is a new claim written after reading the peer: it needs a new section grammar in validate, relabel, append-rebuttals, audit-prep, translate, scorecard and the manifest, it must carry `independently_discovered: false`, it must be excluded from the overlap count, and Decision B must never treat it as agreed. None of this is in the plan.
Suggested fix: Decision A: not adopted in step 5; instead the Phase 1 class-sweep rule gets a gate: validate refuses a claim without a `Same shape elsewhere:` line (already parsed at blind-relabel.mjs:1647) and the report lists per finding what the sweep searched; one measured trial of a Phase 2 sweep is allowed only after step 7, with sweep claims in a separate `## Sweep claims` section that translate marks `sweep: true`, excludes from overlap and never skips in the audit.
Same shape elsewhere: section 5 "Estimated missed defects" (consumes the overlap the sweep would change).

## A7 — [AC-1] Dropping the per-script command lines loses the seat environment controls (`--env-mode`, `--env-passthrough`) that only the dispatchers expose and that a Bedrock or proxy setup needs; review-run has no path for them
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: step 4, for any user whose CLI seat authenticates through a provider variable the filtered default drops (the dispatcher help names CLAUDE_CODE_USE_BEDROCK); today such a user runs the dispatcher by hand, the route the plan removes.
Evidence:
```
scripts/claude-dispatch.mjs:64-71
--env-mode defaults to filtered: OS basics, proxy/certificate variables and the user's
CLAUDE_CONFIG_DIR. Inherit removes every CLAUDE* and CODEX_* variable. ...
A CLAUDE* or CODEX_* variable named in --env-passthrough is the exception: it reaches the
seat in both modes (for example CLAUDE_CODE_USE_BEDROCK for a Bedrock setup).
Detached jobs save only PATH and CLAUDE_CONFIG_DIR; other passthrough variables,
including an opted-in API key, must exist in the worker's launch environment.

scripts/env-filter.mjs:13-17   WIN32_BASE_ENV_ALLOWLIST / POSIX_BASE_ENV_ALLOWLIST (no AWS_*, no CLAUDE_CODE_USE_*)
$ grep -nE "env-mode|envMode|envPassthrough|env-passthrough" review-run.mjs run-descriptor.mjs review-config.mjs
(no output)
```
The packet's own check agrees ("`--env-passthrough` has no review-run path today"). The plan's section 3 lists what is removed and what is kept and names neither option; AC-1 counts each script's help as documentation.
Suggested fix: Step 4 adds to run.json (written by `review-config seats`, validated by run-descriptor) an optional `env: { mode: "filtered"|"inherit", passthrough: [names] }` per seat and for the auditor, passed by the seat runner to the process module and saved into the detached job record; gate: a dispatch test with a fake CLI asserts a passthrough variable reaches the seat both foreground and detached, and the docs-vs-script check lists `env` in configuration.md.
Same shape elsewhere: scripts/claude-dispatch.mjs `--use-api-key` (same hand-only route; the same run.json field should carry it); scripts/codex-dispatch.mjs:146-151 and :191 (same options, same loss).

## A8 — [AC-5] "Steps become function calls" needs three things the plan does not list: the detached worker stays a separate program, library paths stop calling process.exit, and the sequencer's script-substitution test seam is replaced
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: step 4 as written; the first failing step is a seat start on Windows (the worker is launched by command line through WMI) and the first wrong exit is any library error path that exits the whole sequencer.
Evidence:
```
scripts/detach-utils.mjs:174  const child = spawn(process.execPath, [script, '--job', jobPath], { cwd, detached: true, stdio: 'ignore', windowsHide: true });
scripts/detach-utils.mjs:192  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(commandLine)}' ...
scripts/review-run.mjs:533    const child = spawn(process.execPath, [scriptPath(name), ...argv], { detached: true, stdio: ['ignore', log, log], windowsHide: true });

$ for f in *.mjs; do grep -c "process\.exit" $f; done   (occurrences per script)
18 opencode-dispatch.mjs  17 codex-dispatch.mjs  11 preflight.mjs  6 claude-dispatch.mjs  6 blind-relabel.mjs
4 detach-utils.mjs  4 build-manifest.mjs  4 build-brief.mjs  3 context-builder.mjs  2 review-run.mjs  2 exchange.mjs

scripts/review-run.mjs:58   Test hook: REVIEW_RUN_SCRIPTS_DIR names a folder whose files replace same-named scripts.
tests/review-run.test.mjs: 8 uses of REVIEW_RUN_SCRIPTS_DIR/runnerOverride across 146 tests
tests/blind-relabel.test.mjs: 104 spawns of a script command line across 237 tests; build-recheck-packet 28/30; detach-utils 33/26; dispatch-integration 45/34
```
What the separate processes give today and the plan must keep by name: the worker's own command line (WMI starts a command line, not a function), the per-step exit codes the sequencer maps (`allow: [0, 3]` for a wait still running), and a crash that cannot take the sequencer down. The counts show how many tests are command-line tests the plan's step 0 wording ("keep the behaviour tests that call functions") does not cover.
Suggested fix: Step 4: keep exactly two program entries, `review-run` and the internal worker entry (`--job <file>`, undocumented), make every step function return `{ code, lines }` and throw only StepError (a sweep removes process.exit from every file except the two entries; a test asserts `grep -c process.exit` is 0 elsewhere), and replace REVIEW_RUN_SCRIPTS_DIR with an injected `steps` object; gate: review-run tests pass with fake steps injected, the detached dispatch test runs once through WMI and once in plain mode on Windows, and the kill-path tests 5 times.
Same shape elsewhere: scripts/preflight.mjs:717 runWithTimeout and :553 stopOnSignal (exit through an `exit` parameter: the same conversion), scripts/codex-dispatch.mjs:1568 codexExecProbe (same).

## A9 — [AC-7] Two simplifications the plan misses: preflight's advisory packet path scan and reach probe (about 190 lines, source of 5 LOW text-guessing findings) and the Windows job object that preflight already implements
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Trigger: step 1 (process module) and the "size target" in section 3; every host preflight and every phase1 --start runs the packet scan.
Evidence:
```
scripts/preflight.mjs (functions by size, lines 1435-1630):
1447 packetPaths 48 | 1440 packetCandidate 7 | 1435 PACKET_PATH_START_RE 5 | 1495 looksLikeMissingFile 12 | 1507 enclosingRun 15
1522 packetReach 17 | 1539 reportReachProbe 17 | 1556-1559 port regexes + packetPorts 8 | 1568 codexExecProbe 28 | 1596 codexReachProbe 34
scripts/review-run.mjs:724  const reach = await packetReach(await fs.readFile(task, 'utf8').catch(() => ''), { cdAbs: desc.targetDir, runDir: desc.runDir });

findings-rounds-1-5.md: round 1 items 4, 5, 6 and round 2 item 6 (packet path scan shapes, port 1-9) all "Only the advisory warnings depend on it"; closing-list.md Linux item 11 (reach warning) LOW

scripts/preflight.mjs:602-603  On Windows each --exec command runs inside a job object ... A PowerShell wrapper puts itself in a new job
scripts/preflight.mjs:656-660  compiled once into a DLL named after this source's hash; [PreflightJob]::Enter(); nojob fallback writes "nojob <reason>"
scripts/preflight.mjs:697      export function jobLeftovers(report, ...)
```
The packet path scan is the same free-text guessing the plan says "never ends" (five findings in five rounds, all advisory). The plan's section 3 keeps preflight unchanged except for process handling. The job object the plan adds to the process module exists in preflight with the three properties the seat case needs (the wrapper holds the handle, a compiled helper cached by hash, a no-job fallback that still runs the command), so the plan's "Windows job object" is a move, not new code.
Suggested fix: Section 3 "Removed" adds: preflight's packet path scan and endpoint reach probe (packetPaths, packetReach, codexReachProbe and the review-run call); the packet check that stays is "every absolute path in the packet exists" with no shape rules, as a warning; Step 1 names preflight's JOB_WRAPPER and jobLeftovers as the job-object implementation the process module takes over, used by --exec and by the seat CLIs alike; gate: preflight-host tests minus the scan cases, and the existing --exec job test passing through the shared module.
Same shape elsewhere: scripts/preflight.mjs:1819 peerLabelLines (the label warning: keep, it is one regex); scripts/build-recheck-packet.mjs:487-489 (the path rewrite with its boundary rules, round 5 item 5: the same spelling hunt in the recheck packet; make it a plain "old path = new path" replacement on exact strings).

## A10 — [AC-5] The plan has no step or gate for the second skill: the shared scripts must stay byte-identical in pair-review and cross-review, and every step's docs, references and tests exist twice
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Trigger: every step from 1 on; the first break is step 1 (the dropped runtime's removal touches cross-review's SKILL.md, hosts pages and the shared scripts' help text that pair-review carries byte for byte).
Evidence:
```
$ wc -l plugins/pair-review/skills/pair-review/scripts/*.mjs | tail -1     16023 total   (24 files: the plan's "one skill" numbers)
$ wc -l plugins/cross-review/skills/cross-review/scripts/*.mjs | tail -1   17047 total   (25 files, with opencode-dispatch.mjs 1024)
scripts/validate-repository.mjs:280  // SKILL.md's Maintenance section names these as shared; parity is enforced, not assumed.
scripts/validate-repository.mjs:344  // Every pair-review script also ships in cross-review, byte for byte, so a new shared module needs no list entry.
plugins/cross-review/skills/cross-review/SKILL.md:309-312  Shared scripts, identical in both skills and checked by the repository-level scripts/validate-repository.mjs ...
```
The plan's section 1 measures one skill, section 3 names one architecture and section 6 gates each step with tests of one suite; nothing says the step is applied to both skills, that the repository validator runs in the gate, or that the two phase references (maintained in cross-review) and the two SKILL.md files are trimmed together. A step that passes one skill's suite and leaves the other's copy behind ships two different review protocols.
Suggested fix: Section 6: every step's gate ends with `node scripts/validate-repository.mjs` and both skills' suites; the step list names the files per skill it touches (shared scripts once, SKILL.md and references twice); step 7 measures both skills.
Same shape elsewhere: section 2 (replay fixtures from pair-review runs and cross-review runs both exist in the stored folders; the harness must run under both skill folders).

## A11 — [AC-6] The plan's "Windows job object" names neither who holds the job handle, what pid the dispatcher records, the no-job fallback, nor that native seats are outside it; the WMI-started worker itself is unaffected
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Trigger: step 1 on Windows: a job created by the sequencer process (which exits after phase1 --start) closes with that process and kills the seats when the kill-on-close limit is set, or leaks when it is not; inside a sandbox that refuses the compile, a seat without a job; every native seat.
Evidence:
```
scripts/detach-utils.mjs:167-169  REVIEW_DETACH_MODE: auto (default) starts the worker through WMI on Windows, which leaves the host's job object,
  and falls back to a plain detached process when WMI is refused (as it is inside a Codex sandbox)
scripts/preflight.mjs:632-635  e.Basic.LimitFlags = 0x2000 | 0x800;  (KILL_ON_JOB_CLOSE | BREAKAWAY_OK) ... AssignProcessToJobObject(job, GetCurrentProcess())
scripts/preflight.mjs:672-676  } catch { [IO.File]::WriteAllText($report, "nojob " + $_.Exception.Message) }   (the command still runs)
scripts/claude-dispatch.mjs:492  // A detached worker records its child so that a worker killed with SIGKILL does not leave the seat running unseen.
scripts/codex-dispatch.mjs:1138  // A detached worker records the codex child's pid ...
closing-list.md decision 2: "The fix is a job object: about 5 to 7 s more per seat. Today the run warns (stopIncomplete, report caveat)."
```
A job object only helps while a process holds its handle; the holder must be inside the seat's own worker tree (the WMI-started worker or its wrapper), never the sequencer. With a wrapper the recorded child pid becomes the wrapper's, so the "never signal an exited process" guard and the pid start-token must follow it. The fallback must keep today's stopIncomplete warning when the job cannot be created (a sandbox refusing the compile), and the plan should say that a native seat (not a process the skill starts) keeps the warning-only behaviour. The hypothesis that the job breaks the WMI worker is not supported: the job sits below the worker, and the worker's escape from the host's job is unchanged.
Suggested fix: Step 1: the process module starts a Windows CLI seat through the job wrapper (preflight's JOB_WRAPPER, compiled once per hash), the wrapper holds the job with kill-on-close, the job record stores the wrapper pid plus start token, timeout and stop terminate the job, and a "nojob" report keeps the stopIncomplete path; native seats: unchanged, stated in the plan; gate: a fake CLI that starts a grandchild holding stdout open, run foreground, detached through WMI and detached plain: the grandchild is gone after the seat answers, and the "nojob" path still records the warning.
Same shape elsewhere: none found (searched detach-utils.mjs, spawn-utils.mjs, claude-dispatch.mjs, codex-dispatch.mjs, preflight.mjs for job and WMI handling).

## A12 — [AC-3] Section 1's measures do not follow from the code or the findings file: the option count, the "about 70% text guessing" share and the "177 files" corpus
Severity: LOW
Basis: EXECUTED
Evidence strength: SUPPORTED
Trigger: step 7 compares against these numbers; a reader judging the size target starts from them.
Evidence:
```
$ (distinct --options per script, summed)      cross-review 440, pair-review 417
$ grep -ohE -- "--[a-z][a-z0-9-]+" *.mjs | sort -u | wc -l      208 distinct option names
$ grep -hE "^\s*--[a-z][a-z0-9-]+" *.mjs | wc -l                 145 option lines in help texts
(the plan: "about 318"; no counting rule is given)

findings-rounds-1-5.md, counted by hand as text reading (Blocked reader, heading reader, path scan, run-folder guard, scrub, label warning, recheck rewrite):
round 1: 5 of 9 | round 2: 3 of 8 | round 3: 7 of 11 | round 4: 7 of 11 | round 5: 6 of 8  ->  28 of 47 = 60% (the plan: about 70%)
seatfiles2.txt: 173 lines, 173 readable; plus 10 closing files = 183 (the plan: 177)
```
Suggested fix: Section 1: replace the three rows with the counting rule and the number it gives ("distinct option names: 208; option lines in help: 145"; "findings that read free text: 28 of 47"; "seat files: 183"), and let step 7 rerun the same commands.
Same shape elsewhere: section 1 "Findings a normal run would meet: about 12 of 47" (no rule given; not recounted here).

## Checks performed
- AC-1: features checked against SKILL.md, the references and each script's help: review-config seats/show/checklists and the per-run overrides; preflight Tier 1/Tier 2 (--exec, --exec-in, --repo, --fetch, --check-stale, --watch-file, --probe-*, --allow-trial, --review-rules); review-run phase1/phase2/audit with --start/--wait/--native-agent/--native-done/--local/--accept-drift/--audit-depth/--accept-missing-verifiers/--max-wait; build-manifest --init/--seat-transcript/--seat-usage/--extra-artifact; build-report --format chat/text, --all, --out, --html, --json, --change-diff, --notes; build-recheck-packet (--from-run, --since-dirs, --repo-target, --round); the falsification (verifier) pass; the blind exchange (relabel, scan, flip, audit-prep, translate, scorecard, splice, clear-cache); the detached worker (WMI and plain); worktree isolation; the env filter. Kept by the plan or under Known deviations except the seat environment controls (claim A7) and the recheck packet step (not named in section 3; assumed kept under "prepare"). PARTIAL (claim A7).
- AC-2: each of the 47 findings mapped to the plan: the 13 Blocked/heading-reader fixes are replaced by the strict format (deviation); the 10 run-folder guard fixes are kept as "the path check stays"; the 10 process-handling fixes rely on step 1's dispatch and kill-path tests; the 3 native-transcript fixes and the 3 manifest gate fixes rely on replay (which cannot cover the live wait path, claim A4); the closing list's known gaps: the rewrite call's unrecorded usage stays open (claim A5). PARTIAL (claims A4, A5).
- AC-3: module list: every kept module maps to a feature; new code: Decision A's sweep section (claim A6), a run.json env field (claim A7, needed); preflight's advisory scan and the duplicated job object are removable (claim A9); the numbers in section 1 do not follow from the code (claim A12). NOT MET (claims A6, A9, A12).
- AC-4: Decision A has no data and conflicts with the overlap estimate (claim A6); Decision B's data does not measure what the decision loses (claim A2); the estimate line is noise at real overlap sizes (claim A3); Decision C restates the existing recheck route (SKILL.md:287-291, build-recheck-packet, build-report --change-diff) and adds no mode: consistent, no defect. NOT MET (claims A2, A3, A6).
- AC-5: step 0's safety net is built on the entry points step 4 removes and is refused by step 2 (claim A4); step 2's gate has no threshold (claim A5); step 3's gate does not name the in-repo layout or the guard (claim A1); step 4's conversion needs three unlisted changes (claim A8); no gate for the second skill (claim A10). NOT MET (claims A1, A4, A5, A8, A10).
- AC-6: step 3 on the CLI-dispatch host's layout (claim A1); the job object on Windows (claim A11); the WMI worker is unaffected; macOS and Linux paths of steps 1 to 4 traced (process group kill, detached:true) with no plan-specific defect found. NOT MET (claims A1, A11).
- AC-7: preflight's packet scan and reach probe and the duplicated job object (claim A9); the recheck packet's path rewrite (listed under the same claim). NOT MET (claim A9).
- H1: traced build-manifest (random run_id, usage from the live transcript), build-report (times from brief writes and the findings file's mtime), the sequencer's drift check and its child-process entry points; ran the strict counter on the 10 stored seat files. CONFIRMED (claim A4).
- H2: traced review-run and exchange (child node programs, allow-listed exit codes, the REVIEW_RUN_SCRIPTS_DIR seam), the detached worker's command-line start, process.exit counts per file; the fingerprint and drift checks are function calls already and are not lost; crash isolation and a clean module state are not needed if every step returns a result and throws StepError. PARTLY CONFIRMED (claim A8).
- H3: traced build-brief (the brief names the output path and the scratch folder under <run>/phase1/seat-<letter>), the exchange and audit-prep scrubs (keyed to the run folder), preflight's in-repo probe and reach exemptions; the evidence paths are the orchestrator's choice and the audit-input folder already shares the run folder's parent, so the plan's "never learn the location" is not achievable by siblings, and the sibling layout moves the seat's own path out of the guard. CONFIRMED (claim A1).
- H4: ran the packet's counter against this worktree: 6 of 10 closing seat files refused under the plan's rule, 0 of 10 under the "last line" rule's extra condition (it fits 9), older corpus 2 of 173 have any Blocked text; a rewrite round exists (closing-r5 redact folder). PARTLY CONFIRMED: common in the closing rounds (which reviewed the Blocked reader), unmeasurable for generic targets (claim A5).
- H5: read the Phase 1 class-sweep rule and the Phase 2 reply rule; independence of the Phase 1 passes is unchanged, blinding holds if sweep claims use P ids, the cost falls on the parser and the overlap estimate, and the gain has no data. PARTLY CONFIRMED (claim A6).
- H6: tabulated the five closing rounds' findings.json (all full audits): 9 of 45 agreed claims had their severity changed, 1 agreed MEDIUM raised to HIGH; the light audit records agreed claims NOT_CHECKED, so the 466 figure cannot count unaudited claims; the packet says most of the 45 runs were self-reviews. CONFIRMED (claim A2).
- H7: computed per-round capture-recapture from the stored findings: missed 16, 12, 3, 5, 4 with overlaps of 1 to 4; round 3's "3" preceded 19 findings; two estimators differ by 2x at overlap 1. CONFIRMED (claim A3).
- H8: grep of review-run, run-descriptor and review-config for env-mode/env-passthrough: none; the dispatcher help names the Bedrock case; --exec-in and --repo stay in preflight; the detached worker's command line stays needed (claim A8). CONFIRMED for the environment controls (claim A7).
- H9: sized preflight's packet scan and reach probe (about 190 lines, five advisory findings) and found the job object already implemented in preflight; blind-relabel's largest non-reader part is translateFindings (330 lines, kept logic) and auditorProtocol; build-report's diff mapping (about 100 lines) backs --change-diff, a kept feature. CONFIRMED (claim A9).
- H10: traced detach-utils (WMI start, plain fallback) and preflight's wrapper (kill-on-close plus breakaway-ok, no-job fallback): the job sits below the worker, so the WMI escape is unaffected; the holder, the recorded pid, the fallback and native seats are unaddressed; a CLI seat's own sandbox was not executed here. PARTLY CONFIRMED (claim A11).
- Coverage: read fully: restructure-plan-v2.md, findings-rounds-1-5.md, closing-list.md, strict-format-count.mjs, env-filter.mjs, validate-package.mjs, detach-utils.mjs (lines 160-230), preflight.mjs (lines 512-716, 1435-1630, 1725-1770), build-brief.mjs (lines 156-200, 256-330), review-run.mjs (targeted ranges), the hosts/codex.md and SKILL.md command sections, the audit-depth and Phase 2 reply sections of the references; read partly: blind-relabel.mjs, build-manifest.mjs, build-report.mjs, codex-dispatch.mjs, claude-dispatch.mjs, worktree-utils.mjs, the stored run folders closing-r1 to r5 (run.json, manifest.json, phase3/findings.json, phase1/original); not read: opencode-dispatch.mjs, the test files beyond counts, bench/, docs/design/.
- Could not run: no live seat CLI, no WMI or job-object execution, no full test suite (read-only review in a worktree); the strict-format counter and the findings tabulations were executed.
Blocked: none

web: 0 queries, 0 page fetches
