# Seat B findings

## B1 — [AC-2] [AC-5] The stop rule can waive regressions that produce falsely clean reviews
Severity: HIGH
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Trigger: Step 8 finds a serious regression through a constructed fixture, such as accepting stale native output or publishing COMPLETE from truncated findings.
Evidence:
```text
C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:107-108:
"a finding blocks the release only when its trigger happens in a normal run of the documented
commands. A hand-built input is LOW, whatever its effect."

C:/Users/dev/cross-review-runs/closing-plan/evidence/findings-rounds-1-5.md:
Round 2 describes an aborted native turn accepting partial output.
Round 3 describes empty or truncated reviewer files producing a completed manifest.
Round 4 describes malformed reviewer files producing COMPLETE reports.

Those are behavior defects exercised through constructed inputs. Constructing the
reproduction does not prevent the same state arising through interruption or failure.

plugins/cross-review/skills/cross-review/scripts/build-report.mjs:36-38
plugins/pair-review/skills/pair-review/scripts/build-report.mjs:36-38
Current report blockers include unresolved high-stakes findings and surviving
HIGH/CRITICAL findings; fixture origin is not a severity override.
```
Suggested fix: Replace section 5’s stop rule: “Keep severity based on impact; record trigger likelihood separately. Constructed reproductions remain release-blocking when they demonstrate loss of a kept feature, false completion, broken blinding, or unsafe process handling. In the report module, retain those blockers; gate Step 8 with regression fixtures for each class and record any explicit acceptance separately.”
Same shape elsewhere: restructure-plan-v2.md:70 downgrades every missed run-path leak to LOW; :132 applies the weakened release gate.

## B2 — [AC-1] [AC-2] [AC-6] Moving working folders does not establish the promised run-path secrecy
Severity: HIGH
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Trigger: Step 3 relocates working folders while a native prompt, output destination, resumed brief, or diagnostic still contains a canonical run path.
Evidence:
```text
C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:70:
"Seats never learn the run folder's location: their working folders sit next to it,
and the brief never names it"
The same row makes any remaining path-check miss LOW.

plugins/cross-review/skills/cross-review/scripts/review-run.mjs:264-272,742-753
plugins/pair-review/skills/pair-review/scripts/review-run.mjs:264-272,742-753
Native prompts interpolate both brief and output paths. Native briefs currently
reside beneath runDir, and native output uses canonicalPath.

plugins/cross-review/skills/cross-review/scripts/build-brief.mjs:164-176
plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:164-176
Scratch paths derive from the output destination, not independently from cwd.

plugins/cross-review/skills/cross-review/references/phase-3-scorecard.md:578-581:
The shell can still read peer files; touchedFiles checks recorded writes.
Consequently, the proposed touched-files gate cannot prove absence of reads
or disclosure.
```
Suggested fix: Replace Step 3: “In review-run, build-brief and run-descriptor, stage every seat-visible brief, output, scratch directory and resume instruction outside the private run tree; copy completed outputs inward. Preserve run-path rejection and its existing severity. Gate initial and resumed CLI/native flows with sentinel run paths in prompts, diagnostics and exchanged evidence; verify access boundaries separately from write inventories.”
Same shape elsewhere: Both copies of review-run.mjs:265,1008,1363 cover resumed reviewers and the auditor; both copies of build-brief.mjs:200,307-325 handle delta instructions and auditor paths.

## B3 — [AC-3] [AC-4] [AC-7] Phase 2 sweep claims conflict with unchanged translation and independence accounting
Severity: HIGH
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: Step 5 introduces a new sweep claim after peer exposure while retaining audit-prep and translate unchanged as section 3 promises.
Evidence:
```text
C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:71:
audit-prep and translate are "Kept as is", with "logic unchanged".
At :81-83, reviewers may add new claims after reading peer findings.

plugins/cross-review/skills/cross-review/scripts/blind-relabel.mjs:1929-1941,2165-2167
plugins/pair-review/skills/pair-review/scripts/blind-relabel.mjs:1929-1941,2165-2167
Translation requires every origin to exist in the Phase 1 claim set.

Both copies:2277-2278:
const seatLetters = new Set(finding.origins.map((id) => id[0]));
finding.independently_discovered = seatLetters.size === 2;

A separate Phase 2 origin is rejected. Inserting it into the Phase 1 set instead
would allow post-exposure corroboration to count as independent discovery.

plugins/cross-review/skills/cross-review/references/review-protocol.md:268-274:
Current instructions already require a same-shape sweep before publishing a finding.
```
Suggested fix: Replace Decision A initially: “Keep exchange rebuttal-only and enforce the existing Phase 1 class sweep through build-brief and review-protocol. Gate with sibling-variant fixtures and verify that every independent origin predates exchange. Trial additional Phase 2 discovery separately; adopt it only with explicit phase provenance, separate coverage validation and exclusion from independent-overlap counts.”
Same shape elsewhere: Both copies of blind-relabel.mjs:1951-1964 enforce Phase 1 coverage; :2957-2978 validate rebuttals against existing peer claims. Both copies of build-brief.mjs:199-205 prescribe rebuttal-only output.

## B4 — [AC-1] [AC-6] Removing manual dispatch strands documented environment-dependent configurations
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Step 4 removes dispatcher commands for a deployment that requires explicit environment passthrough, such as a Bedrock reviewer.
Evidence:
```text
plugins/cross-review/skills/cross-review/SKILL.md:65:
"--env-passthrough ... is a flag of the dispatchers you run by hand;
review-run passes no such list, so a seat that needs one is dispatched by hand"

plugins/cross-review/skills/cross-review/scripts/claude-dispatch.mjs:166-179
plugins/pair-review/skills/pair-review/scripts/claude-dispatch.mjs:166-179

Executed an in-memory import of buildChildEnv with filtered mode and sourceEnv
containing PATH, CLAUDE_CODE_USE_BEDROCK="1", AWS_REGION="us-east-1".
No files were written.

Without envPassthrough:
{"bedrock":null,"region":null}

With envPassthrough naming those two variables:
{"bedrock":"1","region":"us-east-1"}

Search of review-run.mjs found no envPassthrough or --env-passthrough forwarding.
The plan specifies no replacement configuration path before deleting the old one.
```
Suggested fix: Add before Step 4: “Carry explicit per-actor environment-name allowlists through review-config, run-descriptor and the process module, preserving current filtering and secret-handling rules. Gate foreground, resume and detached launches with a fake reviewer that verifies allowed variables arrive and unrequested variables do not; remove dispatcher commands only after this passes.”
Same shape elsewhere: Both copies of claude-dispatch.mjs:64-70 document API-key opt-in and detached launch-environment requirements; both copies of env-filter.mjs:30-53 implement the shared allowlist behavior.

## B5 — [AC-2] [AC-5] Replay cannot replace behavioral tests, and mutation coverage arrives too late
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:35:
"When those command lines go, those tests go too."
At :40-41, preservation explicitly covers behavior tests that call functions.
At :128, command lines disappear; at :130, mutant checks are rebuilt.

plugins/cross-review/skills/cross-review/scripts/tests/claude-dispatch.test.mjs:72,630-709
plugins/pair-review/skills/pair-review/scripts/tests/claude-dispatch.test.mjs:72,630-709
Behavioral regressions are also tested through subprocess launches: answered and
unanswered exits, inherited output, timeout races and stopIncomplete warnings.

plugins/cross-review/skills/cross-review/scripts/tests/review-run.test.mjs:285,336-349
plugins/pair-review/skills/pair-review/scripts/tests/review-run.test.mjs:285,336-349
Existing tests cover first-failure stopping and incomplete native output.

Replaying stored results does not execute the process or native-turn behavior
that originally produced them.

Both copies of scripts/build-manifest.mjs:901,989 also read transcript usage and
stamp randomUUID(), so replay equality needs an explicit normalization contract.
```
Suggested fix: Replace Step 0 and remove deferred Step 6: “Inventory every retained defect class and its behavioral assertion, regardless of whether the existing test invokes a CLI or function. Port each assertion and its mutant before deleting that module’s old entry point. Replay frozen transcripts/results with an explicit normalization allowlist; never normalize completion, warnings, provenance or findings. Gate every step with those assertions, error/exit propagation, drift checks and its updated mutants.”
Same shape elsewhere: Step 2’s parser replacement also needs retained malformed/truncated-input assertions; Step 4’s in-process migration needs failure-boundary tests. Both copies of review-run.mjs:150-159 currently enforce subprocess status failures.

## B6 — [AC-4] The overlap estimate is unsupported as a missed-defect count or stopping trend
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:21:
"Estimated share of defects one round finds ... about half, at most"
At :109-115, the report gains an estimated-missed count and a declining-count target.

Executed a count of finding rows in:
C:/Users/dev/cross-review-runs/closing-plan/evidence/findings-rounds-1-5.md

{"total":47,"both":11,"firstOnly":19,"secondOnly":17}

Thus the observed reviewer totals are 30 and 28.
In-memory arithmetic:
30 * 28 / 11 = 76.3636 estimated total; observed share = 61.55%.
Chapman correction = 73.9167 estimated total; observed share = 63.59%.

Neither calculation establishes "half, at most". These are illustrative estimators,
not validated estimates: the data pools changing targets across five fix rounds,
and canonical merging and shared inputs affect overlap. The plan specifies neither
an estimator nor handling for zero overlap or zero findings.
```
Suggested fix: Replace the estimate with: “The report module prints observed Phase 1 counts: unique findings per reviewer and independently overlapping findings. Do not infer unseen defects or use overlap as a release threshold. Gate with zero-overlap, zero-finding and merged-origin fixtures; evaluate method changes on the same frozen target and report confirmed unique findings, false findings and cost.”
Same shape elsewhere: restructure-plan-v2.md:101 and :129 compare changed methods against round 5 without specifying a matched snapshot; :111-112 assert an uncalibrated direction of estimation error.

## B7 — [AC-4] Decision B claims savings against a policy that already skips agreed claims
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:88-91:
The proposed default checks disputed, sweep and agreed HIGH/CRITICAL claims,
skips agreed MEDIUM/LOW, and claims "less audit cost and time".

plugins/cross-review/skills/cross-review/references/review-protocol.md:979-989:
The existing default light audit already skips findings conceded by every origin's
peer or independently found by both reviewers. It explicitly warns that a full audit
is needed to catch incorrect agreement.

The proposed policy adds mandatory agreed-high and sweep checks to that baseline.
Savings would require comparison against full audit, not the current default.

The packet labels the 466-agreement look-back author-reported and not reproducible.
It supplies no audit-depth or severity breakdown establishing how many agreed claims
received an independent check.
```
Suggested fix: Replace Decision B’s rationale: “Describe this as stronger default coverage than current light audit, with additional cost. Retain full audit. In the audit module, gate the selection matrix for disputes, agreements, severity and sweep provenance. Measure accuracy and cost against both existing light and full audit on frozen, independently adjudicated fixtures; treat the reported agreement sample as unvalidated background.”
Same shape elsewhere: restructure-plan-v2.md:28 states agreement reliability without qualification; :114 makes near-zero wrong agreements a target without defining how unchecked agreements are evaluated.

## B8 — [AC-1] [AC-4] Decision C requires executable evidence for targets that are not executable
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
C:/Users/dev/cross-review-runs/closing-plan/evidence/restructure-plan-v2.md:95-96:
"one fresh reviewer, on the fix diff only, who must give a command and its output
for each finding"

The task packet requires both skills to remain generic for code, designs and documents.

plugins/cross-review/skills/cross-review/references/review-protocol.md:495-500:
Verification evidence must be appropriate to the target; a constraint or contradiction
trace is an accepted independent check for designs and documents.

A corrected architectural contradiction or factual document passage may have no
command whose output proves the correction. The proposed mandatory recipe offers
no source-citation alternative.
```
Suggested fix: Replace Decision C’s evidence rule: “In review-protocol and the fix-check brief, require evidence appropriate to the finding: command and output when executable, otherwise cited before/after passages and a constraint trace. Permit inspection of unchanged sibling paths needed to verify the whole class. Gate the recipe with code, design and document fixtures, preserving explicit execution limitations.”
Same shape elsewhere: restructure-plan-v2.md:97 promises prevention of subsequent findings without a gate that checks newly introduced or unchanged sibling behavior.

## Checks performed

- AC-1: Checked documented native/CLI transport, resume, environment filtering, multiple repositories and per-repository tests, drift acceptance, exchange modes, full/light audit, deep verification, recheck packets, report outputs and cost accounting. Environment migration and generic fix-check coverage are missing; see B4 and B8. NOT MET
- AC-2: Read all 47 prior findings and closing-list gaps; traced completion, blocked-output parsing, path guards, native-turn handling and shutdown tests. Stop-rule downgrades and delayed regression preservation fail the requirement; see B1, B2 and B5. NOT MET
- AC-3: Counted 16,023 script lines across 24 files in one package and 17,047 across 25 in the other; verified all 24 shared scripts byte-identical. Existing Phase 1 sweeping provides a smaller initial alternative to new exchange provenance machinery; see B3. NOT MET
- AC-4: Recounted overlap, inspected existing audit policy and checked all three method decisions. Unsupported estimates, incorrect audit-cost baseline and missing sweep provenance remain; see B3 and B6–B8. NOT MET
- AC-5: Traced subprocess failure propagation and snapshot checks; compared step order with existing behavioral tests. Replay cannot substitute for preserved fault tests and per-step mutants; see B5. NOT MET
- AC-6: Traced native prompts, detached WMI launch and plain fallback, environment filtering and POSIX process handling. Identified migration gaps in B2 and B4; cross-platform execution was not performed under the no-write constraint. PARTIAL
- AC-7: Checked proposed module responsibilities against existing Phase 1 sweep instructions. Deferring Phase 2 discovery avoids translation, provenance and coverage changes until benefit is demonstrated; see B3. NOT MET
- H1: Confirmed random manifest identifiers and transcript-derived usage. The plan already permits explained differences, so replay is feasible, but normalization and fault coverage remain unspecified; see B5. PARTLY CONFIRMED
- H2: Traced runScript exit-status handling, dispatcher process exits and sequencer fingerprint checks. In-process calls need explicit error boundaries; fingerprint loss is not inherent because checks already reside in the sequencer. PARTLY CONFIRMED
- H3: Traced initial/resumed native prompts, output destinations and scratch derivation. Relocating working folders alone does not eliminate disclosures; see B2. CONFIRMED
- H4: Ran the supplied read-only counter: older files 0/173 accepted, including 157 missing only the newer declaration; closing files 4/10 accepted. Independently found an exact Checks heading and final exact declaration in all 10 closing files. Extra quoted/variant content affects the counter; routine future retry cost is not established. PARTLY CONFIRMED
- H5: Phase 1 independence need not change, but unchanged translation cannot safely accommodate post-exposure origins. Auditor cost and discovery gain remain unmeasured; see B3. PARTLY CONFIRMED
- H6: Compared the proposed audit policy with current light/full rules. The supplied look-back lacks auditable coverage and severity strata; its claimed cost advantage also uses the wrong baseline; see B7. CONFIRMED
- H7: Recounted overlap and calculated illustrative estimators; neither establishes the stated upper bound or a calibrated stopping trend. See B6. CONFIRMED
- H8: Executed environment filtering in memory and traced missing sequencer forwarding. Multiple repositories and per-repository tests currently belong to preflight; no loss was proved for those capabilities. Environment-dependent dispatch would lose its documented route; see B4. CONFIRMED
- H9: Found the smaller existing Phase 1 sweep alternative, avoiding new exchange/translation machinery. No larger quantified deletion in preflight or report was established. PARTLY CONFIRMED
- H10: Read WMI launch and plain fallback paths. A CLI job owned by the detached worker does not inherently break WMI or native actors. Nested-job and sandbox compatibility still require implementation tests; no inevitable incompatibility was established. REFUTED
- Coverage: Read plan, prior-findings list, closing list and strict counter fully. Read entry documents and protocol selectively; traced relevant ranges across orchestration, blinding, manifests, reports, dispatch, detachment and tests. Did not read every test/help section. No writing suites, paid calls, edits or background workers were started.
Blocked: rg: command not recognized; equivalent searches completed with read-only PowerShell and Node.
web: 0 queries, 0 page fetches