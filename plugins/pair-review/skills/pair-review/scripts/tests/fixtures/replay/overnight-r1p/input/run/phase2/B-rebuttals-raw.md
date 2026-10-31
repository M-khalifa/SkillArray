### P1
Claim: P1
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```
build-report.mjs:32 (--help): "Each finding gets a "Where" hint ... It never moves a finding."
build-report.mjs:653  where: changeDiffs.length > 0 ? whereInChange(f.evidence, hunks) : null
groupFindings: else if (kinds.pre && report.changeDiffs?.length > 0) groups.preExisting.push(f);   (f.where not read)
--format chat without --all prints only the ids in the Pre-existing row, so the "Where: added lines" line is not in front of the reader.
```
Concede at MEDIUM: the author's word silently overrides a computed "added lines" tag and the default chat output does not show the conflict. Only the caveat half of the suggested fix fits the documented rule (the help says the Where tag never moves a finding, and a moved or reformatted block shows as added lines while being older code); keeping the finding out of Pre-existing should not be done. Note also that the Where tag itself can be wrong when an evidence path carries a snapshot prefix (my claim about whereInChange), so a caveat is safer than a move.

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
node build-recheck-packet.mjs --from-run <field run app-client-pr6064-2026-10-16-r3>\run --out <scratch>\p.md --since-diff <its since.diff>
p.md:8: This is a re-review of the previous review (C:\Users\dev\cross-review-runs\overnight-r1\evidence\field-runs\app-client-pr6064-2026-10-16-r3\run). ...
node build-brief.mjs --mode phase1 --packet <scratch>\p.md --seat A --out <scratch>\newrun\brief-A.txt --run-dir <scratch>\newrun   -> exit 0, the path is in the brief
blind-relabel.mjs scan --in <scratch>\p.md -> does not flag the path line
that run's manifest.json: one provider and one model_requested per seat letter
```
Same defect as my own claim on the previous-run path. Concede the defect; corrected severity HIGH, per the packet's severity note ("a blinding leak ... is HIGH"): the pointer reaches the auditor brief with no warning (build-brief.mjs assertPacketOutsideRunDir checks only the current run folder), and the previous run's manifest maps each seat letter to its vendor and model.

web: 0 queries, 0 page fetches
