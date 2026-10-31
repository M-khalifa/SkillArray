# Seat B findings

## B1 [AC-1] — Where tag still says "outside the change" for a bare or snapshot file name that two diff files share (the identical-copy case of this repo), so a "pre-existing" note moves a HIGH blocker on added lines out of Fix now
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a finding cites `build-report.mjs:11` or `REVIEW/head/build-report.mjs:11` (bare name or snapshot prefix) while the change diff has two files with that name; true for every shared script of this repo (both skills' copies are byte-identical and both are in every diff), and for any multi-package repo with same-named files. Platform: everywhere.
Evidence:
```
$ node where.mjs   (disposable copy of the pair-review skill; diff has pair-review and cross-review copies of scripts/build-report.mjs, both adding line 11)
build-report.mjs:11 => {"tag":"outside the change","at":"build-report.mjs:11"}
REVIEW/head/build-report.mjs:11 => {"tag":"outside the change","at":"REVIEW/head/build-report.mjs:11"}
scripts/build-report.mjs:11 => {"tag":"added lines","at":"scripts/build-report.mjs:11"}

$ node grp.mjs   (same diff; HIGH finding, evidence build-report.mjs:11, notes "- Q1: pre-existing")
where {"tag":"outside the change","at":"build-report.mjs:11"}
fixNow [] preExisting [ 'Q1' ] blockers [ 'Q1' ]
> **REVIEW COMPLETE · 1 blocker (Q1 marked pre-existing in the report notes, not fix now) · 1 finding**

build-report.mjs:635-638 (pair-review copy): plainName / byName require exactly one same-named diff file;
  const usable = byPath.length > 0 || hits.length === 1 ? hits : [];
  const tag = !entry ? 'outside the change' ...
build-report.mjs:1149 groupFindings: preExisting is only blocked when where.tag === 'added lines'; the preOnAdded caveat (build-report.mjs:802) has the same test, so no caveat is printed.
```
(Fixture ids in the quoted output are renamed to Q1 and Q2.) The round-1 hypothesis named this exact same-shape site (bare name shared by two diff files gives "outside the change" instead of "unknown"); the fix only added the single-match snapshot case. A wrong Where value is shown to the maintainer in md/text/HTML and decides the Pre-existing grouping.
Suggested fix: in whereInChange, when 2+ same-named diff files match, use the tag they all agree on (identical copies have identical hunks) and otherwise return 'unknown' instead of 'outside the change'; treat 'unknown' like 'added lines' in the preOnAdded/groupFindings guard (build-report.mjs:802, :1149).
Same shape elsewhere: build-report.mjs:635 (byName, snapshot prefix with two same-named files) and :636 (plainName, bare name); build-report.mjs:802 and :1149 consume the result. build-recheck-packet.mjs evidenceLocation does not match diffs (not affected). Both skills' copies identical: plugins/pair-review/skills/pair-review/scripts/build-report.mjs and plugins/cross-review/skills/cross-review/scripts/build-report.mjs.

## B2 [AC-1] — The "Confirm it is fixed" flip is keyed on the packet text, not on the brief the seats got, so in a current run a fix-worded hypothesis the seats answered CONFIRMED (defect still there, as today's brief tells them) is shown as a green REFUTED with "no blockers"
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a packet run with the current skill that has a hypothesis containing "Confirm it is fixed" and lacks the exact build-recheck-packet definition sentence: a hand-written packet from references/task-packet-template.md (its guidance line does not match the regex), or a round-N packet drafted by the 1.1.0 build-recheck-packet and run after the upgrade. Frequency unknown; less common than a regenerated packet. Platform: everywhere.
Evidence:
```
build-report.mjs:700 (pair-review copy)
  const fixWordedFlips = !/CONFIRMED \(the (?:previous )?defect (?:is still there|it names exists)\)/.test(packetText);
build-report.mjs:484
  const fixWorded = fixWordedFlips && hypothesis && /\bconfirm it is fixed\b/i.test(text);
references/review-protocol.md:248 (the brief every current seat gets)
  a hypothesis line with CONFIRMED (the defect it names exists), REFUTED
  (it does not) or PARTLY CONFIRMED; read a hypothesis worded the other way round as its defect.

$ node flip.mjs   (disposable copy; packet = template guidance line + "- [Q2] The round-1 cache fix: the cache is never cleared on reload. Confirm it is fixed."; both seats "- Q2: reload path still skips clear(). CONFIRMED.")
verdict refuted outcomes {"A":"REFUTED","B":"REFUTED"} confirmed 0
> **REVIEW COMPLETE · no blockers · no findings**
+ REFUTED      Q2
> Caveat: Q2 was worded "Confirm it is fixed" in a packet that does not define CONFIRMED (a 1.1.0 packet), so a seat's CONFIRMED there meant fixed: ...
```
The packet text only says how the packet was written; the meaning of a seat's CONFIRMED comes from the brief the seat read. Since the current protocol defines CONFIRMED as "the defect it names exists" and tells seats to read a fix-worded hypothesis as its defect, every current run answers on the defect side, and the flip inverts it. The caveat says the opposite of what happened, so it does not let the reader catch it.
Suggested fix: decide the flip from the run's brief (phase1/brief-*.txt contains "CONFIRMED (the defect it names exists)" in every current run) or from the run's skill version, not from packetText; flip only when the brief lacks that definition.
Same shape elsewhere: none found (searched every fixWorded/fixWordedFlips use in build-report.mjs: :484, :700, :769 caveat; renderText, renderHtml and chat read the already flipped outcomes). Both skills' copies identical: plugins/pair-review/skills/pair-review/scripts/build-report.mjs and plugins/cross-review/skills/cross-review/scripts/build-report.mjs.

## Checks performed
- AC-1: ran whereInChange/groupFindings and the hypothesis flip on fixtures in a disposable copy; a pre-existing note moves a HIGH blocker on added lines out of Fix now with no caveat, and a defect-side CONFIRMED is shown as a clean REFUTED. NOT MET (claims B1, B2).
- AC-2: read the build-recheck-packet change: the packet no longer names the previous run folder; previous-run.json sits in the new run folder beside the other files seats are told not to read, and holds a path only (no vendor or model text). Rest of the blinding surface not re-checked this round, a coverage gap, not a defect. PARTIAL
- AC-3: ran build-manifest tests (68 pass) and traced mergedUsage/mergeUsable: failed calls are left out before the merge rule is chosen and counted in calls_without_usage; other printed counts not re-derived this round (coverage gap). PARTIAL
- AC-4: not exercised this round (no process, interrupt or resume test run); coverage gap, not a defect. PARTIAL
- AC-5: checked the --round help text against buildRecheckPacket (round = new round) and the review-protocol rewording; full doc sweep not done (coverage gap). PARTIAL
- AC-6: a 1.1.0 packet (hypotheses "Confirm it is fixed", no CONFIRMED definition, verified with git show ea0b739 of build-recheck-packet.mjs:145 and :198) re-renders with the flip and its caveat; the build-report test for it passes. The reverse case for current runs is the claim about the flip gate, not an old-run regression. MET
- AC-7: no weight claim found in the changed hunks. MET
- H1: packet text has no previous-run path (test asserts written.includes(run) is false, passes); the path goes to previous-run.json next to the packet and to stdout only; nothing else in the scripts reads or stages it (grep previous-run). REFUTED
- H2: for 1.1.0 packets, fix-worded outcomes are flipped in chat, text and HTML (build-report.mjs:484-485, :700); test passes. The inverse case (current run, fix-worded line, no definition line in the packet) is a new defect, reported as the claim about the flip gate. REFUTED
- H3: authorWithdrawn findings leave blockers, severity counts (standing filter), criterion/ticket lines (criteriaInput settled-refuted, ticket loop skip) and the SEVERITY/auditor chat lines; build-report tests for outcome words and for criterion lines pass. REFUTED
- H4: mergedUsage now filters calls without usage before choosing the merge; the rate-limited last call on a cumulative thread keeps the last reported total (its build-manifest test passes, 68/68). The legacy finals.set same-shape site is fixed too, because finals only see usable results. REFUTED
- H5: the single-match snapshot case is fixed (REVIEW/head/Reporter.py:11 with one Reporter.py in the diff gives "added lines, matched by file name"), but the named same-shape site remains: a bare or snapshot name shared by two diff files still gives "outside the change", not "unknown" (claim B1). PARTLY CONFIRMED
- H6: with a single path match the pre-existing note no longer overrules "added lines" (test passes); with a shared name the Where tag is wrong and the note still moves the blocker (claim B1). PARTLY CONFIRMED
- H7: all-settled case now says "all N previous finding(s) were settled"; decided lines say "of round N-1" (build-recheck-packet.mjs:260); 27/27 build-recheck-packet tests pass. REFUTED
- H8: the three reworded passages no longer point to sections the auditor copy lacks; the widened pointer test (every heading and bold label) passes in a disposable copy. REFUTED
- Also checked: whereInChange tags HITACHI_DEVICE/Reporter.py:11 as "added lines, matched by file name to CONTOSO_V4_DEVICE/Reporter.py" when only the other package changed; this is the designed, labelled behaviour (a build-report test asserts it) and it no longer moves grouping (byName guard), so not claimed.
- Tests run in a disposable copy with TEMP/TMPDIR pointed at a scratch folder: build-manifest 68/68, build-report 98/98, build-recheck-packet 27/27, blind-relabel audit-prep --packet test 1/1. Full blind-relabel and other suites not run (memory limit).
- Coverage: read fully: the round-1-to-round-2 diff (since.diff, pair-review copy, byte-identical cross-review copy), mergedUsage/mergeUsable, whereInChange; read partly: build-report.mjs, build-recheck-packet.mjs, review-protocol.md, task-packet-template.md; not read: dispatchers, spawn/detach utils, preflight, review-run, bench, repo scripts, README.

web: 0 queries, 0 page fetches
Blocked: none
