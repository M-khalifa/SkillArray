### P1
Claim: P1
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
Independent fixture, two run folders with the same packet ("Confirm it is fixed", no definition) and both seats answering CONFIRMED:
brief at phase1/brief-A.txt  -> verdict confirmed, no flip caveat
brief at phase1/A/brief.txt  -> fixWorded true, outcomes REFUTED, one "Confirm it is fixed" caveat
review-run.mjs:705 puts a CLI seat's brief at phase1/A/brief.txt; build-report.mjs:1356 reads only phase1/brief-A.txt.
Severity MEDIUM is right: narrow trigger (hand-written packet), but the report shows a defect as refuted.
```

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
Independent fixture with two changed files that end in the same folder-qualified suffix:
partial path citation on line 11 -> "added lines", no byName flag (picked from one file only)
partial path citation on line 501 (added in the other file) -> "changed file", no byName flag
bare name of the same location -> "unknown", byName true, addedInOne true
build-report.mjs byPath branch keeps the longest path (ties to the first) instead of the agree-or-unknown rule of the name branch.
The peer's added detail on the pre-existing note (note overridden in one order, blocker moved with no caveat in the other) follows from the missing byName flag and agrees with the trace. Severity MEDIUM is right.
```

web: 0 queries, 0 page fetches
