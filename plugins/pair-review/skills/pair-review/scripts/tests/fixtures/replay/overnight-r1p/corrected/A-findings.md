# Seat A findings

## A1 [AC-1] [H2] A finding the notes call "pre-existing" leaves "Fix now" even when its evidence is on lines the change added
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: report-notes `## Finding status` line starting `pre-existing` (or containing the word) for a finding whose evidence file:line is an added line in `since.diff`; a hand-written notes file, met on every re-review round where the author triages quickly. Holds everywhere (no platform dependence).
Evidence:
```
copy of field run contoso-2026-10-16-r3 (scratch; finding ids renamed to the shape Q1 in this quote), notes line for the first finding changed to start "pre-existing:"
node build-report.mjs --run-dir <copy>\run --format chat
| Fix now | none | 0 |
| Fix next | none | 0 |
| Pre-existing | Q4 Q1 Q5 Q6 Q3 | 5 |
PRE-EXISTING 5 not caused by this change: Q4 Q1 Q5 Q6 Q3
same run, unmodified report: "Q1 ... Where: added lines (Reporter.py:60)"
build-report.mjs:1120  else if (kinds.pre && report.changeDiffs?.length > 0) groups.preExisting.push(f);
```
The report already computes `f.where` (line 653) but groupFindings never reads it, so the change diff only gates "is there a diff", not "is this finding outside the diff". A finding on added lines is by definition not pre-existing, and the report moves it out of Fix now with no caveat.
Suggested fix: in groupFindings keep a finding out of preExisting when `f.where?.tag === 'added lines'` and push a caveat naming it (same place as the preMarked caveat, build-report.mjs:775).
Same shape elsewhere: none found (searched groupFindings and buildReport for other note-derived group moves; "fixed" and the canWait outcome words are author statements about the future, not claims about the diff).

## A2 [AC-2] [H1] [H3] A re-review packet now names the previous run folder by full path, so every seat and the auditor are pointed at the earlier seats' files and the manifest with model names
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: any `build-recheck-packet.mjs --from-run <old run>` packet used for round 2 or later (every re-review). Holds on every platform. Impact if real: a seat or the auditor of the new round can read the earlier round's two seat files, labels and the manifest that names each seat's provider and model, which the protocol hides from them.
Evidence:
```
node build-recheck-packet.mjs --from-run <field run contoso-2026-10-16-r3>\run --out <scratch>\p1\p.md --since-diff <its since.diff> --repo-target <old>=<old>
sed -n 10p p.md
This is a re-review of the previous review (C:\Users\dev\cross-review-runs\overnight-r1\evidence\field-runs\contoso-2026-10-16-r3\run). Those findings are listed below as hypotheses only. ...
that run folder holds (by listing): phase1\A-findings.md, phase1\B-findings.md, phase1\B, manifest.json (reviewers[].provider and model_resolved set for both seats), phase3-private\seat-to-audit-label.json
build-recheck-packet.mjs:461,471,474  marker '{{previous-run-path}}' ... .split(marker).join(run)
at ea0b739 the intro was "the review in <basename>" (build-recheck-packet.mjs:284, no path)
tests/build-recheck-packet.test.mjs:210-212  "Only the intro names the previous run, on purpose" - the old assertion that the whole text never includes the old run path now skips the intro line
```
Only the phase1 start prints a warning (review-run.mjs phase1Start via packetReach, worded "fine for a re-review that means to"); the auditor brief (build-brief.mjs assertPacketOutsideRunDir) checks only the new run folder, so the auditor gets the path with no warning. A re-review usually keeps the same two models, so the seat learns the peer's model from the manifest.
Suggested fix: write `the review in <basename>` again (drop the marker at build-recheck-packet.mjs:461-474) and keep the assertion on the whole text; if the path is wanted, add it only to the orchestrator-facing stdout.
Same shape elsewhere: none found (searched the other packet-writing paths in build-recheck-packet.mjs and the template for a second place that writes a run path).

## Checks performed
- AC-1: ran build-report on five field runs (all exit 0, counts match); found a pre-existing note that is accepted for a finding on added lines. PARTIAL (claim A1).
- AC-2: read build-brief and recheck-packet changes and ran the packet script; no claim id, seat letter or model name in the generated packet text; the run-folder path is named. NOT MET (claim A2). Auditor fix prompt id mapping (review-run.mjs translate refusal) read: it maps A/B ids to blind labels; other translate messages carry no seat letters. Not executed.
- AC-3: counted severities and blockers from each field run findings.json (18/6/14/9/1 findings; 16, 1, 7, 5, 0 blockers) against build-report output; equal. MET.
- AC-4: read spawn-utils, codex-dispatch runCapture timeout, detach-utils, review-run diff; swept every spawn site for windowsHide (only POSIX ps calls lack it). Process-list before/after not run. PARTIAL (no defect found, not executed).
- AC-5: compared the new flags with SKILL.md, references and preflight --help; --review-rules, --review-rules-only, --since-only, --round appear in --help only, not in SKILL.md or references. PARTIAL (gap, not a wrong statement).
- AC-6: old build-report (ea0b739) and new build-report give the same finding count and blockers on all five field runs; northwind run has no since.diff and renders. MET.
- AC-7: no weight claim made. MET.
- H1: read the deleted test lines list; one changed assertion fits new behaviour (claim A2). PARTLY CONFIRMED.
- H2: ran the pre-existing note case (claim A1); SEAT_CHOICE_RE and the lower-bound usage read, not executed. PARTLY CONFIRMED.
- H3: packet text checked for claim ids, seat letters, model names (none) and run path (present, claim A2); REVIEW.md rules, Trigger lines and trimmed auditor protocol not examined. PARTLY CONFIRMED.
- H4: ran build-report on all five field runs and build-recheck-packet on one; no parse failure or count mismatch. REFUTED.
- H5: five field runs render with equal counts to the old script. REFUTED.
- H6: sweep of spawn sites, read killGroupOnExit (POSIX only), runCapture timeout and signal handlers; no defect found, no process run. REFUTED (static only).
- H7: flags checked for --help versus docs only; no wrong statement found, gaps noted under AC-5. REFUTED.
- H8: read the audit-depth stop (review-run.mjs auditPrepare); an old exchange-result.json without the conceded-high count skips the stop (NaN compare), by design for old runs; not executed. REFUTED (not executed).
- Coverage: read fully: review-run and build-brief diffs, build-manifest diff, build-report lines 540-800 and 1040-1260, small-script diffs. Read partly: build-recheck-packet, codex-dispatch. Not read: preflight.mjs diff (REVIEW.md reading, reach probe), blind-relabel.mjs diff, worktree-utils tests, SKILL.md and reference prose, bench scripts, validate-repository, README.
- Not run: the node test suites (pre-flight logs cited instead), live dispatch.

web: 0 queries, 0 page fetches
Blocked: none
