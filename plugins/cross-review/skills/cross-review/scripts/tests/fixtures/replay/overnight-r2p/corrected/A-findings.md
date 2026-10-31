# Seat A findings

## A1 — A bare file name that one changed file shares overrules the author's "pre-existing" note and is tagged "added lines" with no name-match flag (acceptance risk: wrong group in the report, MEDIUM)
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: A seat cites evidence by bare file name (for example `Reporter.py:11`, which seats do often), the change diff holds exactly one file with that base name inside a folder (one device package), the repository has other files with the same name, and the author marked the finding pre-existing in the report notes. VSI-style repositories have one Reporter.py per device package, so the shape is common there.
Evidence:
```
build-report.mjs:636  const plainName = file.includes('/') ? [] : paths.filter((p) => fold(p).split('/').pop() === file);
build-report.mjs:643  const byNameOnly = Boolean(entry) && byPath.length === 0 && file.includes('/');
        -> a bare name never sets byNameOnly, so no byName flag and no "matched by file name" text.
build-report.mjs:802 and :1149 only skip the notes override when where.byName is set.

Run (disposable copy, one HIGH finding, notes line "- <id>: pre-existing", diff changes CONTOSO_V4_DEVICE/Reporter.py line 11):
evidence Reporter.py:11            where={"tag":"added lines","at":"Reporter.py:11"}  fixNow 1  preExisting 0  caveats-about-pre-existing 1
evidence HITACHI_DEVICE/Reporter.py:11  where={"tag":"added lines","at":"HITACHI_DEVICE/Reporter.py:11, matched by file name to CONTOSO_V4_DEVICE/Reporter.py","byName":true}  fixNow 0  preExisting 1
```
The folder-qualified spelling of the same guess is demoted to a name guess and respects the note; the bare spelling is not, and the Where line prints "added lines" as if the path matched. This is the part of the earlier "pre-existing silently moves a finding" fix that is still open for bare names.
Suggested fix: set byNameOnly whenever the match came from a base name and the matched diff path differs from the cited path (drop the `file.includes('/')` test at line 643, keep exact path equality as a real match).
Same shape elsewhere: build-report.mjs:802 and :1149 (both read where.byName); build-recheck-packet.mjs evidenceLocation does no matching, not affected.

## A2 — Evidence that cannot be placed uniquely is reported as "outside the change" instead of "unknown" (shown to the reader; display only, MEDIUM)
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Evidence cited through a snapshot or review-copy prefix (or a bare name) when the diff holds a same-named file at the repository root, or two same-named files in different folders. Two changed device packages that both have a Reporter.py is enough.
Evidence:
```
build-report.mjs:634-639  sameName/byName/usable: ambiguous or root-only matches leave usable empty, so entry is null
build-report.mjs:640      const tag = !entry ? 'outside the change' : ...

Run, whereInChange on a diff that adds line 11 of the named file:
["Reporter.py:11"]            diff A/Reporter.py + B/Reporter.py -> {"tag":"outside the change"}
["REVIEW/head/Reporter.py:11"] diff A/Reporter.py + B/Reporter.py -> {"tag":"outside the change"}
["REVIEW/head/Reporter.py:11"] diff Reporter.py (root)            -> {"tag":"outside the change"}
["x/README.md:11"]            diff README.md (root)               -> {"tag":"outside the change"}
```
In all four rows the change did add that line (or may have), so "outside the change" is a confident wrong statement; the tag is printed in text, markdown and chat --all for the maintainer, who may read it as "not caused by this change". "unknown" is the tag the code already has for no location. The tests assert the current output as intended ("two same-named files: no guess", "a root diff file never claims a file in a folder"), so this is a design choice that still gives a wrong label.
Suggested fix: when a location matched no diff file by path and at least one diff file shares its base name, return `{ tag: 'unknown', at: loc }` (build-report.mjs:640) and keep "outside the change" for names no diff file has.
Same shape elsewhere: none found (searched every whereInChange and evidenceLocations caller: build-report.mjs:667 only; the Where tag has no other consumer except the pre-existing override in claim one).

## A3 — The auditor's staged protocol still points at a section it does not get ("the skill's own Invocation section"), and the new pointer test cannot see that shape (LOW)
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
auditorProtocol(review-protocol.md) staged text, line 240:
  disputed high-severity findings" (see the skill's own Invocation section).
Staged headings missing from the copy: Scope and independence | Model identity | Standard seat instructions | All seats |
  Rebuttal instruction | Web verification | Web verification: orchestrator notes | Blind exchange | Manifest and final output
blind-relabel.test.mjs (CLI audit-prep --packet test): pointsTo = /\b(?:see|per) (?:the )?<heading of the full protocol>\b/
  - "Invocation" is a heading of SKILL.md, not of the protocol, so the test never looks for it
  - "review-protocol.md's Web verification section" and "per review-protocol.md's Synthesis section" use another shape
```
The two passages the earlier finding named were reworded, so that finding is closed for them. One pointer to a file the auditor never receives remains, and the quoted phrase is already inline, so the cost is a wasted lookup.
Suggested fix: delete the parenthesis at the Falsification pass paragraph (it is the only pointer outside the protocol); optionally widen the test regex to `(?:see|per|in) (?:the |review-protocol.md's )?`.
Same shape elsewhere: none found (searched the staged text for see, per, section, above, below, SKILL.md, references/; the "Web verification" pointers resolve to the staged "Web verification: reviewer rules").

## A4 — The new previous-run.json is written but nothing reads it and no doc names it (weight and docs, LOW)
Severity: LOW
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
build-recheck-packet.mjs:481-486 writes <dir of --out>/previous-run.json {previousRun, round} and prints the same path on stdout.
grep -rn "previous-run" over the repository, outside tests: only build-recheck-packet.mjs in each plugin copy (no reader, no doc).
--help (build-recheck-packet.mjs:14-54), SKILL.md and references/phase-3-scorecard.md:379 do not mention the file.
```
It is an extra artifact the orchestrator is told nothing about; the stdout line already carries the information. If --out is placed in a folder the seats can read (the folder is not required to be the run folder), the file hands them the previous run path and so re-opens the leak the change closed in the packet text. A short `--help` sentence would at least tell the operator to keep the file out of seat reach; dropping the file and keeping the stdout line removes the risk.
Suggested fix: remove the record file and keep the stdout line, or document it in --help with "keep it out of the seats' reach".
Same shape elsewhere: build-recheck-packet.mjs:489-494 (since.diff beside --out is documented in --help and in the stdout note).

## Checks performed
- AC-1: ran the new recheck CLI on a fixture (record kept, record differing, packet never overwritten), read the exit paths of the changed code; no clean-when-not case found in the changed files. MET.
- AC-2: grepped the packet written by the recheck CLI for the previous run folder (absent), listed the staged auditor protocol for vendor and model names (none; seat letters in examples are pre-existing). MET.
- AC-3: built a report with two findings marked wrong with a reason and a blocker kept; total, severity counts, blocker count, WITHDRAWN row and auditor line agree in text, markdown and chat. MET.
- AC-4: read detach-utils and spawn-utils kill and windowsHide paths; no process was started, so process lists before and after were not taken; a gap in this review, not a defect. PARTIAL (not exercised).
- AC-5: help text and docs omit the new record file and say the round default is 2 where the code counts the chain of re-reviews first. PARTIAL (claims about the record file and the staged pointer).
- AC-6: ran build-manifest, build-recheck-packet, build-report and blind-relabel test files in a disposable copy: 98 report tests, 234 findings-script tests pass, the other two files exit 0; old-format intro and old round-less packets still go through the chain count. MET.
- AC-7: one weight claim (claim A4). PARTIAL (claim A4).
- H1: ran the recheck CLI on a fixture; the packet intro no longer carries the run path, rewritePaths still maps any old run path in carried text to the new folder, brief checks refuse a packet naming the run folder. The record file is a residual (claim A4). REFUTED.
- H2: read buildCriteria flip and fixWordedFlips, ran the tests and a 1.1.0-wording packet; REFUTED outcomes flip only for packets that do not define CONFIRMED, chat, text and html read r.outcomes and r.verdict. Residual: a hand-written packet whose hypothesis text quotes the phrase and defines no CONFIRMED would be flipped, with a caveat printed. REFUTED.
- H3: ran a report with findings marked wrong; counts, blockers, SEVERITY and auditor lines, criterion and hypothesis rows leave them. REFUTED.
- H4: read mergedUsage and mergeUsable, ran the manifest tests including the rate-limited last call and the two-thread case; the lower bound with calls_without_usage applies. REFUTED.
- H5: ran whereInChange on 8 cases; snapshot-prefixed unique names now match by name, but ambiguous names still print "outside the change". PARTLY CONFIRMED (claim A2).
- H6: ran the note override with bare and folder-qualified evidence; the folder-qualified guess respects the note, the bare one does not. PARTLY CONFIRMED (claim A1).
- H7: ran the settled-all case; the text says all N were settled and decided lines name the round; carried lines from older packets stay bare (not a new defect). REFUTED.
- H8: listed the staged protocol and its pointers; the two named passages are fixed, one other pointer remains. PARTLY CONFIRMED (claim A3).
- Not run: the whole suites at once and the dispatch-integration test (memory); scratch folder deleted before the reply.
- Coverage: read fully build-recheck-packet.mjs, the changed hunks of build-report.mjs and build-manifest.mjs and the whole since diff, detach-utils.mjs lines 14-215; read partly build-report.mjs renderers, blind-relabel.mjs, build-brief.mjs; not read preflight.mjs, review-run.mjs, codex-dispatch.mjs, exchange.mjs, the validate and install scripts, bench.

web: 0 queries, 0 page fetches
Blocked: none
