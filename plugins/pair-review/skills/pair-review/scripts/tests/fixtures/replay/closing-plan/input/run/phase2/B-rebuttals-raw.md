### P1
Claim: P1
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
plugins/cross-review/skills/cross-review/scripts/preflight.mjs:1744-1759
The ignore-coverage check enumerates runDir, its audit-input sibling and the
optional worktree sibling. New reviewer working directories are not covered.

plugins/cross-review/skills/cross-review/scripts/run-descriptor.mjs:251-267
Protected reviewer folders are constructed beneath runDir. External grants are
not walked for forbidden reviewer files.

These paths require coordinated migration before sibling working directories are
safe. The defect is conditional on the new directories being inside the repository
and not ignored; it is not inevitable for every sibling layout.

HIGH is warranted for the snapshot/independence failure. The suggested OS-temp
placement still needs a native-host reachability gate; moving there alone is not
a portable fix.
```

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Read closing-r1 through closing-r5/run/phase3/findings.json and run/run.json
with an in-memory Node tabulation. Counted findings whose peer_responses were
all conceded, comparing severity with severity_audited.

All five auditDepth values: full
Agreed findings: 45
Agreed MEDIUM/LOW: 29
Changed MEDIUM/LOW: 3
Agreed HIGH/CRITICAL: 16
Changed HIGH/CRITICAL: 6

Changes among agreed MEDIUM findings:
round 3, item 7: MEDIUM -> LOW
round 3, item 10: MEDIUM -> LOW
round 4, item 6: MEDIUM -> HIGH

The denominator is 29, not 30; unchanged MEDIUM/LOW findings number 26.
The substantive defect survives: refutation counts omit consequential severity
corrections. The proposed new audit-depth value is one possible implementation,
not something these observations establish as necessary.
```

### P3
Claim: P3
Action: CONCEDE
Basis: EXECUTED
Evidence strength: SUPPORTED
Evidence:
```text
Independent in-memory tabulation of the five stored findings files produced:
round 1: observed 9, reviewer totals 5 and 5, overlap 1
round 2: observed 8, reviewer totals 5 and 4, overlap 1
round 3: observed 11, reviewer totals 7 and 8, overlap 4
round 4: observed 11, reviewer totals 7 and 7, overlap 3
round 5: observed 8, reviewer totals 6 and 4, overlap 2

The pooled count independently reproduced in Phase 1 was:
47 observed, reviewer totals 30 and 28, overlap 11.
30*28/11 gives an observed share of approximately 61.55%, not an upper
bound of one half.

Small overlap and unspecified merging make the proposed report number poorly
calibrated. However, the 19 later findings do not establish that round 3 missed
19 existing defects: intervening fixes changed the population.

Concession concerns the unsupported estimator and stopping trend, not endorsement
of the suggested replacement trigger rule or the unexplained threshold of five.
```

### P4
Claim: P4
Action: DISPUTE
Counter-fact: The plan expressly allows explained output differences and does not require replay through the sequencer; several pipeline stages already expose callable functions.
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:37-39:
"Feed each one's seat files and results through the pipeline ... byte for byte
(or with listed, explained differences)."

Existing callable seams:
plugins/cross-review/skills/cross-review/scripts/build-brief.mjs:431 exports build.
plugins/cross-review/skills/cross-review/scripts/blind-relabel.mjs:3485-3510
exports runAuditPrep, translateFindings, validateProblems and scorecardMarkdown.
plugins/cross-review/skills/cross-review/scripts/build-manifest.mjs:1053 exports run.
plugins/cross-review/skills/cross-review/scripts/build-report.mjs:671,1000,1263
exports buildReport, renderMarkdown and renderChat.

Therefore CLI deletion does not inherently destroy replay, and replay need not
encounter the sequencer's fingerprint gate. Random values require normalization,
which the plan already permits.

A concrete normalization contract and strict-format fixture migration remain
missing details. They support a narrower gate-specification finding, not the
claim that replay cannot work as proposed. The supplied strict counter also
implements additional rejection rules beyond the plan's brief grammar.
```

### P5
Claim: P5
Action: CONCEDE
Basis: EXECUTED
Evidence strength: SUPPORTED
Evidence:
```text
The supplied strict-format-count.mjs was executed during Phase 1:
older runs: files 173, fit 0, noBlockedOnly 157, other 16
closing rounds: files 10, fit 4, other 6

A fresh read of seatfiles2.txt counted 173 entries; adding the ten closing
files gives 183, not 177.

C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:126
The gate says only to measure how many files would be asked again; it gives
no acceptance condition or required terminal behavior after a failed rewrite.

The gate needs explicit rejection, retry, failure-status and usage assertions.
Historical noncompliance is not an estimate of future generic-target retry rates.

The plan does not adopt last-line-wins, so recurrence of that older defect is a
risk to prohibit, not a demonstrated instruction in this plan. Neither the
suggested new status value nor a one-in-ten retry threshold follows from the data.
```

### P6
Claim: P6
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
plugins/cross-review/skills/cross-review/references/review-protocol.md:268-274
Already requires a same-shape sweep before publishing each finding.

plugins/cross-review/skills/cross-review/scripts/blind-relabel.mjs:1929-1941
Every translated origin must have a Phase 1 claim heading.

The same file:2277-2278
independently_discovered is derived solely from whether origins span both reviewers.

The plan simultaneously keeps translation unchanged and introduces claims after
peer exposure. Separate new origins would be rejected; inserting them into the
old origin set risks false independent-corroboration accounting.

The proposed extra discovery therefore needs provenance changes that the plan
omits. Existing Phase 1 sweeping is the smaller initial intervention.
Requiring a textual sweep declaration alone cannot prove the search happened.
```

### P7
Claim: P7
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
plugins/cross-review/skills/cross-review/SKILL.md:65
Explicitly documents manual dispatch for environment passthrough because
review-run supplies no list.

Phase 1 executed an in-memory call to buildChildEnv from:
plugins/cross-review/skills/cross-review/scripts/claude-dispatch.mjs

Filtered source environment contained:
CLAUDE_CODE_USE_BEDROCK="1", AWS_REGION="us-east-1".

Without explicit passthrough:
{"bedrock":null,"region":null}

With both names explicitly allowed:
{"bedrock":"1","region":"us-east-1"}

Corrected severity: HIGH under this packet's rubric, because removing the only
documented route loses a kept deployment capability.

Preserve explicit opt-ins and detached-environment behavior. Saving configuration
must not imply persisting secret values into job records.
```

### P8
Claim: P8
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
plugins/cross-review/skills/cross-review/scripts/detach-utils.mjs:170-184
A detached worker is launched as a program with --job; WMI has a plain-process
fallback. A callable pipeline still needs this process bootstrap.

plugins/cross-review/skills/cross-review/scripts/review-run.mjs:150-159
The current runner maps subprocess errors and unacceptable exit statuses into
StepError and preserves diagnostics.

plugins/cross-review/skills/cross-review/scripts/claude-dispatch.mjs:406-414
The dispatch implementation contains a process.exit error path requiring
separation from an in-process library entry.

The migration needs explicit worker, failure-boundary and injected-step gates.
However, review-run.mjs:533 belongs to the runtime explicitly being removed,
so that particular branch is not evidence of a retained requirement.

The suggested global ban on process.exit outside two files is broader than needed:
remaining configuration/preflight executable wrappers may legitimately exit.
The essential restriction is no process exit from imported pipeline paths.
```

### P9
Claim: P9
Action: DISPUTE
Counter-fact: The proposed deletion removes documented reachability capabilities, and plain substring replacement demonstrably loses an existing path-boundary fix.
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
plugins/cross-review/skills/cross-review/SKILL.md:67
Documents --probe-reach --yes-paid to check the reviewer's ability to access
packet paths and ports.

plugins/cross-review/skills/cross-review/scripts/preflight.mjs:1596-1623
The probe checks READ paths, WRITE temp and NET endpoints. An orchestrator-side
absolute-path existence warning is not equivalent.

Executed in memory using the shipped rewritePaths function:
input: /mnt/backup/home/u/proj/file.md
mapping: /home/u/proj -> /new/proj

Existing rewritePaths output:
/mnt/backup/home/u/proj/file.md

Plain exact-string replaceAll output:
/mnt/backup/new/proj/file.md

The latter changes a distinct backup path, reproducing the defect the boundary
rule prevents.

preflight.mjs:602-675 does contain a reusable job wrapper. Reuse is worthwhile,
but the plan already proposes replacing process-handling copies with one module.
That does not justify removing retained reachability features or boundary checks.
```

### P10
Claim: P10
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
scripts/validate-repository.mjs:280,344,366
Repository validation enforces shared-script and shared-fixture parity across
the two packages.

Phase 1 independently compared the 24 shared script files byte-for-byte:
24 identical; zero different.

C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:124-132
Per-step gates name replay, dispatch, blinding and documentation checks, but
do not explicitly require repository parity or both packages' suites.
Release checking appears only at the final step.

A two-package parity gate is required before calling intermediate steps shippable.
The plan does not explicitly say to test only one suite; the defect is the missing
enforceable per-step requirement, rather than an instruction to ignore one package.
```

### P11
Claim: P11
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
plugins/cross-review/skills/cross-review/scripts/preflight.mjs:630-635,658-675
The existing wrapper creates and joins the job, retains the handle, reports
nojob on setup failure, waits for the command and handles remaining members.

plugins/cross-review/skills/cross-review/scripts/detach-utils.mjs:170-184
The worker launches independently through WMI or plain detachment.
A child job beneath that worker need not invalidate its launch mechanism.

The plan does not specify handle ownership, wrapper process identity, fallback
observability or native-actor scope. Those deserve explicit lifecycle tests.

The current job permits breakaway, as preflight.mjs:602-604 also states.
Consequently, the gate must distinguish inherited descendants from processes
explicitly breaking away; reuse does not prove universal descendant containment.
No live Windows job or sandbox compatibility result is claimed here.
```

### P12
Claim: P12
Action: CONCEDE
Basis: EXECUTED
Evidence strength: SUPPORTED
Evidence:
```text
Executed read-only Node counts over top-level script source files, using:
distinct /--[a-z][a-z0-9-]+/ matches per script, summed;
the union of those matches;
lines beginning with whitespace followed by such a token.

cross-review:
sumDistinctPerScript=440
distinctTokens=208
optionLeadingLines=145

pair-review:
sumDistinctPerScript=417
distinctTokens=206
optionLeadingLines=126

seatfiles2.txt entries=173; plus ten closing files=183.

The plan's 318 baseline has no reproducible counting definition, and 177 does
not match this named corpus. LOW is appropriate for the measurement-definition
defect.

Source-token counts are not necessarily accepted CLI-option counts: comments,
examples and invoked programs contribute matches. Likewise, the proposed 28/47
text-reading classification needs an explicit item list before it replaces the
plan's percentage as an objective baseline.
```

web: 0 queries, 0 page fetches