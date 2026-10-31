# Seat B findings

## B1 — [H3] The "Confirm it is fixed" flip still keys on the packet whenever the first seat ran as a CLI seat: loadRun reads only phase1/brief-A.txt, which review-run writes only for a native first seat
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: DETERMINISTIC
Trigger: any run whose first seat is dispatched through a CLI (Codex, OpenCode, or the claude-dispatch CLI path; every two-OpenAI pair-review run) and whose packet has a hypothesis worded "Confirm it is fixed" without the CONFIRMED definition sentence (a hand-written or template packet). Holds on every platform.
Evidence:
```
review-run.mjs:705
  const brief = cli ? path.join(dispatchDir(desc, 'phase1', role), 'brief.txt') : path.join(desc.runDir, 'phase1', `brief-${role}.txt`);
  (dispatchDir = <run>/phase1/<role>, review-run.mjs:417-419; review-run.test.mjs:904 asserts phase1/A/brief.txt for a CLI seat)

build-report.mjs:1356 (loadRun)
  briefText: existsSync(path.join(dir, 'phase1', 'brief-A.txt')) ? await readOptional(path.join(dir, 'phase1', 'brief-A.txt')) : null,
build-report.mjs:702
  const fixWordedFlips = briefText != null ? !defines(briefText) : !defines(packetText);

$ node -e (buildReport with packet "- [Q1] Previous finding: ... Confirm it is fixed.", both seats "- Q1: CONFIRMED, still broken.", briefText: null)
briefText null: refuted
```
The current brief a CLI seat gets (phase1/A/brief.txt) defines CONFIRMED (review-protocol.md:248), but loadRun never looks there, so both seats' "still broken" is shown as a green REFUTED with a caveat that calls the run a 1.1.0 run. The new test only builds the native layout (phase1/brief-A.txt). Hypothesis tag in the fence renamed to Q1. Both copies: plugins/pair-review/skills/pair-review/scripts/build-report.mjs and plugins/cross-review/skills/cross-review/scripts/build-report.mjs (byte-identical, cmp).
Suggested fix: in loadRun read the first existing of phase1/brief-A.txt and phase1/A/brief.txt (falling back to the other seat's two paths), and add a loadRun test with the CLI layout.
Same shape elsewhere: none found (searched all scripts for brief-A / brief.txt readers; preflight.mjs:1458 RUN_FILE_PROBES only detects a run folder and also lists phase1/A-findings.md)

## B2 — [H1] [H2] whereInChange still resolves an ambiguous partial path (a suffix two changed files share) to the longest path as a full path match: not byName, no caveat, and it decides a "pre-existing" note either way, while the bare file name of the same location is handled as a guess
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat cites a path relative to a sub-folder (src/utils.py:11, scripts/build-report.mjs:806, tests/test_reporter.py:40) and the change diff holds two or more files ending in that suffix whose hunks differ at that line. Common in monorepos with per-package copies (this repo's two skills escape it only because the shared scripts are byte-identical). Holds on every platform.
Evidence:
```
build-report.mjs:631-637
  const byPath = paths.filter((p) => { ... fp.endsWith(`/${file}`) ... });
  ...
  if (byPath.length > 0) found = { tag: tagIn(hunks.get(byPath.reduce((a, b) => (b.length > a.length ? b : a))), n), at: loc };

notes "- Q2: pre-existing", finding HIGH blocker
diff: aa/src/utils.py (longer path) added line 11; b/src/utils.py added line 301
longer has added src/utils.py:11 {"tag":"added lines","at":"src/utils.py:11"} pre: 0 fixNow: 1 caveats: 1
longer has added utils.py:11 {"tag":"unknown","at":"utils.py:11, file name shared by 2 changed files","byName":true,"addedInOne":true} pre: 1 fixNow: 0 caveats: 1
diff: b/src/utils.py added line 11; aa/src/utils.py added line 301
shorter has added src/utils.py:11 {"tag":"changed file","at":"src/utils.py:11"} pre: 1 fixNow: 0 caveats: 0
shorter has added utils.py:11 {"tag":"unknown","at":"utils.py:11, file name shared by 2 changed files","byName":true,"addedInOne":true} pre: 1 fixNow: 0 caveats: 1
```
The round-3 fix gives the agree-or-unknown rule and the caveat only to file-name matches. A partial path matching several diff files is the same guess, but the longest-path pick is reported as an exact match: in the first case it overrides the author's pre-existing note (the blocker stays in Fix now on an arbitrary pick; the one caveat is the "stays where its severity puts it" one, which wrongly says the evidence is on added lines); in the second it moves a blocker whose other candidate sits on added lines into Pre-existing with no caveat. The more specific citation gets the less careful treatment, the inconsistency H2 named, now on the suffix path. Finding ID in the fence renamed to Q2. Both copies: plugins/pair-review/skills/pair-review/scripts/build-report.mjs and plugins/cross-review/skills/cross-review/scripts/build-report.mjs (byte-identical).
Suggested fix: in whereInChange treat byPath.length > 1 the way the name branch does (tags agree, else "unknown", byName: true, addedInOne), and add the two cases above to the "where in the change" test.
Same shape elsewhere: none found (searched build-report.mjs for other path-to-diff matching; build-recheck-packet.mjs evidenceLocation does not match against diffs)

## Checks performed
- H1: ran whereInChange on a snapshot-prefixed and a bare name against two same-named changed files: agreeing hunks give "added lines" marked byName naming both paths; differing hunks give "unknown" with addedInOne, never "outside the change"; buildReport adds the "check it is not the same file" caveat for a pre-existing note. The file-name case is fixed; the same ambiguity remains for a partial path two changed files end with (claim about the suffix path). PARTLY CONFIRMED.
- H2: ran whereInChange with a bare name one changed file in a folder has: byName true now, and groupFindings keeps the author's pre-existing note. A bare name equal to a root diff path is an exact path match, which is correct. The bare-name variant is gone; the inverse inconsistency survives for a partial path (claim about the suffix path). PARTLY CONFIRMED.
- H3: loadRun reads phase1/brief-A.txt and a current brief defines CONFIRMED, so runs with a native first seat are fixed; review-run.mjs:705 puts a CLI seat's brief at phase1/A/brief.txt, which loadRun does not read, and buildReport with briefText null still flips both seats' CONFIRMED to REFUTED (claim about the CLI brief path). PARTLY CONFIRMED.
- H4: built auditorProtocol(review-protocol.md) in memory and grepped the staged text: "(see the skill's own Invocation section)" is gone, no SKILL.md pointer remains, every "see ... above/below" names a staged section (Fresh-context auditor, Falsification pass, Canonical findings, findings.json, Three label layers); the rebuttal-overturn rule is explained inline. The test regex catches only "see ... section" phrasing, but no remaining pointer escapes it. REFUTED.
- H5: build-recheck-packet --help (lines 53-54) and both SKILL.md now name previous-run.json and its purpose (build-recheck-packet.mjs:483-488 matches); nothing reads it (grep of all scripts), but it is now a documented record for the orchestrator; since.diff beside --out is documented too. REFUTED.
- AC-1: read the changed hunks; no new exit-0 path with missing output in them. PARTIAL (rest of the scripts not re-read this round; gap, not a defect).
- AC-2: SKILL.md and --help tell the orchestrator to keep previous-run.json out of the seats' reach; build-brief assertPacketOutsideRunDir still checks the packet text. PARTIAL (no live seat run executed; gap).
- AC-3: the report's Where tag and grouping are wrong for an ambiguous partial path, and the hypothesis verdict is inverted for runs with a CLI first seat. NOT MET (both claims).
- AC-4: not exercised (no process or run-folder code changed since round 2). PARTIAL (not checked this round; gap).
- AC-5: the new --help text and SKILL.md sentence match build-recheck-packet.mjs:483-488 (record next to --out, kept with a warning when contents differ). MET.
- AC-6: a 1.1.0 run without phase1/brief-A.txt falls back to the packet as before (briefText null). MET.
- AC-7: no weight claim; previous-run.json is now documented. MET.
- Copies: cmp shows build-report.mjs and build-recheck-packet.mjs byte-identical between the pair-review and cross-review scripts folders; both claims apply to both copies.
- Coverage: round-2-to-3 diff read fully; build-report.mjs whereInChange, buildReport flip, preOnGuess, groupFindings, loadRun read partly; build-recheck-packet.mjs 366-502 read partly; review-run.mjs 410-430 and 690-721 read partly; blind-relabel.mjs auditorProtocol read partly; rest of scope not read this round.
- Could not run: the test files were not run, because the instructions allow writing only this findings file and the tests create temp folders; every check above ran the shipped functions in memory with node -e from the target's scripts folder.

web: 0 queries, 0 page fetches
Blocked: none
