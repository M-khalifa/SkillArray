# Seat A findings

## A1 — whereInChange treats a partial path that is a suffix of two or more changed files as an exact path match: arbitrary file's tag, not marked byName, so a pre-existing note regroups a blocker (code risk, report grouping)
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a seat cites a folder-qualified partial path such as `scripts/build-report.mjs:700`. In this repository every shared script exists in two changed copies (`plugins/pair-review/skills/pair-review/scripts/` and `plugins/cross-review/skills/cross-review/scripts/`), so any such citation is ambiguous on every review of this repo with a change diff; holds on every platform.
Evidence:
```
diff paths: plugins/a/scripts/x.mjs (added line 11), plugins/b/scripts/x.mjs (added line 501)
whereInChange(['scripts/x.mjs:11'])   -> {"tag":"added lines","at":"scripts/x.mjs:11"}              (no byName)
whereInChange(['scripts/x.mjs:501'])  -> {"tag":"changed file","at":"scripts/x.mjs:501"}           (line 501 IS added in the b copy; no byName)
whereInChange(['x.mjs:11'])           -> {"tag":"unknown","at":"x.mjs:11, file name shared by 2 changed files","byName":true,"addedInOne":true}
build-report.mjs byPath filter (about line 634): fp.endsWith(`/${file}`) keeps both files; reduce() then keeps the longest path, ties go to the first.
```
The two spellings of the same guess get different treatment: the bare name is "unknown" with a caveat, the folder-qualified suffix is a confident path match on whichever diff file sorts first. Because byName is absent, groupFindings (`!(f.where?.tag === 'added lines' && !f.where.byName)`) and preOnAdded treat the first case as certain, and the second case with line 501 reads "changed file", so a pre-existing note moves a blocker that sits on added lines out of Fix now with no caveat. This is the previous medium finding on same-named files, still present for the suffix route.
Suggested fix: in whereInChange, when byPath holds more than one file and they are not the same path, treat it like the shared-name case (tags agree -> that tag with byName true, else "unknown" with byName and addedInOne) instead of reducing to the longest.
Same shape elsewhere: build-report.mjs:634-639 only (the byPath branch); the same code is in plugins/cross-review/skills/cross-review/scripts/build-report.mjs (identical copy). build-recheck-packet.mjs does no diff matching.

## A2 — build-report reads the seat brief only at phase1/brief-A.txt; a run whose seat A is a CLI seat keeps its brief at phase1/A/brief.txt, so the packet fallback and the wrong "Confirm it is fixed" flip stay (misleading report; code risk)
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a current-run review where seat A is a CLI seat (for example a Codex seat A in a cross-vendor run, a normal setup) and the task packet words a hypothesis "Confirm it is fixed" without the sentence defining CONFIRMED (a hand-written packet; build-recheck-packet drafts carry the definition). Seats then answer for the defect, and the report prints their CONFIRMED as a green REFUTED plus a caveat that calls the run a 1.1.0 run. Platform-independent.
Evidence:
```
review-run.mjs:705  const brief = cli ? path.join(dispatchDir(desc, 'phase1', role), 'brief.txt') : path.join(desc.runDir, 'phase1', `brief-${role}.txt`);
build-report.mjs:1356  briefText: existsSync(path.join(dir, 'phase1', 'brief-A.txt')) ? ... : null

fixture: task-packet.md "- [H1] Confirm it is fixed: ..." (no definition); both seat files say "- H1: ... CONFIRMED."
seat brief defines "CONFIRMED (the defect it names exists)"; loadRun over two run folders:
brief at phase1/brief-A.txt   -> {"fixWorded":false,"outcomes":{"A":"CONFIRMED","B":"CONFIRMED"},"verdict":"confirmed"}  caveats about "Confirm it is fixed": 0
brief at phase1/A/brief.txt   -> {"fixWorded":true,"outcomes":{"A":"REFUTED","B":"REFUTED"},"verdict":"refuted"}      caveats about "Confirm it is fixed": 1
```
So the previous finding on packet-keyed polarity is fixed only for runs where seat A is a native seat; with a CLI seat A the brief is never found and the packet text decides again. The check also looks at seat A only, so a seat B brief is never consulted.
Suggested fix: in loadRun, try phase1/brief-A.txt, then phase1/A/brief.txt, then the same two names for seat B, and use the first that exists.
Same shape elsewhere: build-report.mjs:1356 only (a second reader of a seat brief path). preflight.mjs:1458 lists phase1/brief-A.txt only as a probe name, not as a reader. Identical copy in plugins/cross-review/skills/cross-review/scripts/build-report.mjs.

## A3 — [AC-7] previous-run.json is still written, documented and tested, but nothing reads it and the stdout line already prints the same path (weight, LOW)
Severity: LOW
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
grep previous-run over plugins/pair-review and plugins/cross-review: build-recheck-packet.mjs:53 (help), :483-489 (write, kept-with-warning branch), its test, SKILL.md:244 in both skills; no reader.
build-recheck-packet.mjs:491 stdout: "previous run <path> (recorded in <record>; not in the packet: seats must not read that folder)"
chainRound (round counting) reads old packets and run.json, not this file.
```
The round-2 change only added the missing documentation; the file itself remains a write-only record of a path that the console already shows. It also sits in the folder of the packet that the seats read, next to a manifest path the seats must not follow, which the docs answer with "give the seats no path to it".
Suggested fix: drop the file and its kept/warning branch (lines 483-489) and the two doc sentences, or make chainRound read it so it earns its place.
Same shape elsewhere: since.diff beside --out (build-recheck-packet.mjs:493-500) is read by build-report, so it is not the same shape.

## Checks performed
- AC-1: read the changed hunks of build-report and build-recheck-packet; no step found that exits 0 on missing output in them. Not re-audited outside the changed files. MET.
- AC-2: read auditorProtocol output (staged text has no pointer to SKILL.md or Invocation, no vendor names in the label table); previous-run.json is written beside the packet, documented as to be kept from the seats, and the run folder already holds files seats must not read. MET.
- AC-3: ran whereInChange on suffix, bare, snapshot-prefixed and root-file citations; the folder-qualified suffix case gives a wrong Where tag. PARTIAL (claim A1).
- AC-4: no process-handling file changed since round 2; spawn-utils, detach-utils and the dispatchers were not re-read this round. PARTIAL: gap I could not close, not a defect.
- AC-5: help text, SKILL.md and protocol sentences for previous-run.json, review round and since.diff match the code; the brief-A.txt path assumption in build-report does not match review-run (claim A2). PARTIAL (claim A2).
- AC-6: loadRun without any brief file falls back to the packet text, and a run folder with no since.diff or notes renders (read, and ran the no-brief fixture). MET.
- AC-7: one weight claim (claim A3). MET for the criterion's own cap.
- H1: ran bare name, snapshot prefix and two same-named files: "unknown"/agreed tag with byName, and the pre-existing caveat (preOnGuess) fires. The folder-qualified suffix of two files is still resolved to one arbitrary file without byName. PARTLY CONFIRMED (claim A1).
- H2: ran a bare name matching one changed file in a folder: now "matched by file name", byName true, pre-existing note produces the caveat; the folder-qualified spelling is treated the same. REFUTED.
- H3: ran two fixture runs: with the brief at phase1/brief-A.txt the polarity is correct; with the brief at phase1/A/brief.txt (CLI seat A) the packet decides and the outcome is still flipped. PARTLY CONFIRMED (claim A2).
- H4: generated the auditor's staged protocol with auditorProtocol and searched it for Invocation, SKILL.md, references/ and "see ... section": the Invocation pointer is gone and every remaining pointer names a staged heading. REFUTED.
- H5: file still unread; docs and --help now name it; since.diff beside --out is read by build-report. PARTLY CONFIRMED (claim A3).
- Tests run in a disposable copy with TEMP redirected: build-report.test.mjs 99 of 99 pass, build-recheck-packet.test.mjs 27 of 27 pass. Other test files not run (memory limit).
- Coverage: read fully: since.diff build-report and test hunks, build-recheck-packet main. Read partly: review-run.mjs (brief paths), blind-relabel.mjs (auditorProtocol), build-brief.mjs (assertPacketOutsideRunDir). Not read: preflight, dispatchers, spawn-utils, detach-utils, exchange, bench, validate scripts, manifests.

web: 0 queries, 0 page fetches
