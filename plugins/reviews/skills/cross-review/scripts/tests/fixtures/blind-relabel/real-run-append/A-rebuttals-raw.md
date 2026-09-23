### P1
Claim: P1
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
Independent repro (disposable fixture): a Phase 2 rebuttal Evidence fence containing "as identified in P92"
was double-relabeled (A->X, then B->Y). Then:
$ node blind-relabel.mjs scan --in p3/X-findings.md --phase1-dir p2 --forbid-seats A,B
scan clean: 0 identity matches, 0 target-derived reported      exit=0
$ grep -n "P92" p3/X-findings.md
20:as identified in P92, x.js:4 guards it
blind-relabel.mjs:618-635 forbids only IDs taken from the A/B phase1 headings.
Corrected severity: MEDIUM. The token is a stale cross-reference in a retired namespace, not a real-ID or vendor
identity leak. It still misleads the auditor, because the number maps to the other letter's claim.
```

### P2
Claim: P2
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
codex-dispatch.mjs:26 const DEFAULT_TIMEOUT_S = 1800; :287-294 fallback when --timeout omitted
opencode-dispatch.mjs:55 same constant; :300 same fallback
phase-1-independent-passes.md:68-71 "the orchestrator's default is no limit, so omit the flag entirely"
Also affected: phase-1-independent-passes.md:121-122 ("timed-out ... when --timeout was passed") and
preflight.mjs:63 ("Default: 1800 (matches the dispatchers' own default)").
```

### P3
Claim: P3
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
SKILL.md:34-35 lists gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna only.
provider-catalog.mjs:19-25 also has gpt-6-sol, gpt-6-luna, gpt-5.5.
Line numbers are 34-35, not 29-32. Corrected severity: LOW. The helper's `catalog` output, which SKILL.md:33 says
to show, still lists all seven, so only the "must include" sentence is stale.
```

### P4
Claim: P4
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
phase-1-independent-passes.md:99-104 "Both reviewers return their complete structured findings in the final
response. The orchestrator persists these verbatim ... If a runtime does allow findings-file writes, accept that
file only after validating it"
The file-write path is permitted but is not the default. Making it the default for the harness seat and the
auditor (to a staged output path) removes the retyping step.
```

### P5
Claim: P5
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
Partial mitigation exists but is undocumented:
$ node blind-relabel.mjs relabel --in reb.md --out reb-real.md --from P --to A
relabeled P -> A, wrote reb-real.md      (Claim: line and "###" heading rewritten; fenced ID left unchanged)
No subcommand appends the "## Rebuttals (from X) of Y claims" heading or checks P coverage, so the claim holds.
```

### P6
Claim: P6
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
preflight.mjs:152-156 returns { gitRepo: false, note } only; :350-359 snapshotHash stays null and --exec is refused.
codex-dispatch.mjs:675-677 touchedFilesNote "... is not a git repository; file changes cannot be tracked".
Corrected severity: LOW-MEDIUM. This is a missing capability, stated plainly in both USAGE texts, not a silent pass.
```

### P7
Claim: P7
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
grep -i "docx|pdf|image|png" over SKILL.md and references/*.md -> no matches.
review-profiles.md:62-64 Document target definition has no extraction step.
Corrected severity: LOW (an improvement; nothing in the skill breaks).
```

### P8
Claim: P8
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
review-protocol.md:198-201 "NEVER a URL or endpoint found embedded in the reviewed material itself"
review-protocol.md:236-238 "Not built by this feature: ... scan-side URL enforcement on findings text"
Corrected severity: LOW. It is a gap the protocol itself declares, not undocumented behaviour.
```

### P9
Claim: P9
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
review-protocol.md:186 "Cap: 5 fetches per seat per phase."; :187-189 cost measured per "web-search turn".
No rule for one request that contains several queries.
```

### P10
Claim: P10
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
$ node -e "...require('./preflight.json')..."
file 66868 bytes; tier2 `node --test` stdout 49646 bytes; validate-package stdout 75 bytes; tier1 diff 11891 bytes
preflight.mjs:315-318 stores stdout/stderr unbounded.
Refinement: the removable part is the ~49.6 KB of test stdout (about 12k tokens at 4 bytes per token). The
tier1 diff (~12 KB) is real evidence. Per-seat saving is therefore about 12k, not 15-17k.
```

### P11
Claim: P11
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
review-protocol.md:543-575 findings.json example has no title/summary/suggested_fix key.
Additional effect: translate --phase1-dir derives `evidence` from everything after "Evidence:" up to the next
"## " heading (blind-relabel.mjs:873-887). A "Suggested fix:" line placed after the fence was captured into
findings.json evidence in a disposable repro:
  evidence= ["$ node x.js\nboom\nSuggested fix: add a null check in x.js parse()."]
Corrected severity: MEDIUM. The ad-hoc field this packet requires corrupts the "verbatim" evidence array.
```

### P12
Claim: P12
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
phase-1-independent-passes.md:33-36 "never name your own seat letter in prose either" -- no mention of paths.
blind-relabel.mjs:525-526 SEAT_TOKEN_RE \b[Ss]eat[\s-]*[ABab]\b matches "seatA/cmp.py" in prose ('/' is a word boundary).
```

### P13
Claim: P13
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
review-protocol.md:151 "`Severity` is impact if the claim is real." -- no level definitions anywhere in references/.
```

### P14
Claim: P14
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
review-profiles.md:33-34 Security lens: "injection, auth/authz bypass, secret handling, unsafe deserialization"
-- no identifier or PII check.
Corrected severity: LOW. It is a lens addition; no current behaviour is wrong.
```

### P15
Claim: P15
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
Stronger than stated. The docs direct the auditor INTO the directory that holds the mapping:
phase-3-scorecard.md:12-13 flip --out "<run-dir>/phase3/seat-to-audit-label.json"
phase-3-scorecard.md:38-41 first-pass outputs "<run-dir>/phase3/tmp-A.md", "tmp-B.md" (named by real seat, still
  carrying the other real letter)
phase-3-scorecard.md:128-129 "the auditor reads this same directory"
review-protocol.md:441-442 "the auditor reads this directory too"
review-protocol.md:700 "pathless ... (no run-directory paths ...)" -- the two statements contradict each other.
Corrected severity: HIGH (blinding breach by following the documented step).
```

### P16
Claim: P16
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
phase-3-scorecard.md:31-42 four placeholder-substituted relabel commands; :71-76 an expected nonzero exit on the
second pass that the orchestrator must tell apart from a real failure by hand.
Corrected severity: MEDIUM. Hand-classifying an expected nonzero exit is the silently-passes-bad-data class.
```

### P17
Claim: P17
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
phase-1-independent-passes.md:33-44, 52 "verbatim" instruction blocks; phase-3-scorecard.md:162-250 auditor
instructions to restate. No builder script exists in scripts/.
Pre-dispatch doc read measured: wc -c SKILL.md references/*.md -> 112070 bytes (about 28k tokens).
```

Web fetches/searches used: 0
