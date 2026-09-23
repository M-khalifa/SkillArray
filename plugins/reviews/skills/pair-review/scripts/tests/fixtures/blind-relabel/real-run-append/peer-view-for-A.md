# Peer findings

## P1 — [BUG] Phase 2 claim labels can leak into the auditor’s findings
Severity: HIGH  
Basis: EXECUTED  
Evidence strength: REPRODUCED  
Evidence:
```text
scanText('identified in P12', null) returned no hits.
relabelText('identified in P12', 'A', 'X') returned 'identified in P12'.
translateFindings preserved "summary":"A1 follows P12" after translating X1 to A1.
blind-relabel.mjs:618-635 checks only known A/B IDs; :694-715 translates only X/Y IDs.
```
Suggested fix: In `scripts/blind-relabel.mjs`, reject `P<n>` tokens in Phase 3 input and auditor prose fields before translation; exempt captured evidence only where its provenance is explicit.

## P2 — [BUG] Omitting `--timeout` imposes an undocumented 30-minute limit
Severity: MEDIUM  
Basis: EXECUTED  
Evidence strength: REPRODUCED  
Evidence:
```text
parseArgs(['--brief','x','--cd','.']).timeout returned 1800 for both dispatchers.
codex-dispatch.mjs:282-293 and opencode-dispatch.mjs:293-300 set that default.
phase-1-independent-passes.md says the default is “no limit” and to omit --timeout.
```
Suggested fix: In both dispatchers’ `parseArgs`, make an omitted timeout unlimited; retain an explicit positive timeout as the bounded option.

## P3 — [FEEDBACK-O9] Setup instructions omit three current catalog choices
Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:
```text
SKILL.md:29-32 requires gpt-6-astra and gpt-5.6 variants.
provider-catalog.mjs includes gpt-6-sol, gpt-6-luna, and gpt-5.5.
configuration.md and model-capabilities.md include those additions.
```
Suggested fix: Update `SKILL.md`’s “Start here” model list to match `provider-catalog.mjs`.

## P4 — [FEEDBACK-O1] Large agent handbacks require manual artifact transcription
Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: SUPPORTED  
Evidence:
```text
phase-1-independent-passes.md:92-100 instructs reviewers to return full findings in their final response and the orchestrator to persist them verbatim.
phase-3-scorecard.md:258 instructs the orchestrator to save the auditor’s returned JSON.
No bundled helper captures either handback into the run artifacts.
```
Suggested fix: Add a capture helper or an artifact-writing path to the phase instructions, followed by byte count/hash validation before relabel or translate. This also addresses G2.

## P5 — [FEEDBACK-O2] Rebuttal translation and append remain manual
Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:
```text
phase-2-cross-examination.md:121-130 requires translating each P ID and appending an exact rebuttal heading.
blind-relabel.mjs subcommands are relabel, scan, flip, translate, validate; translate handles auditor JSON, not Phase 2 rebuttals.
```
Suggested fix: Add a Phase 2 rebuttal parser to `scripts/blind-relabel.mjs` that validates `P<n>` coverage, maps IDs using the direction’s source file, normalizes headings, and appends the section. This also addresses G3 and G6.

## P6 — [FEEDBACK-O4] Non-git targets lack snapshot and source-change evidence
Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:
```text
preflight.mjs:150-156 returns only gitRepo:false and a note for a non-git directory.
preflight.mjs:348-358 leaves snapshotHash null and rejects Tier 2 execution.
codex-dispatch.mjs:670-677 sets touchedFiles to null outside git.
```
Suggested fix: Add an opt-in, size-bounded file hash inventory for non-git targets to `preflight.mjs`, and compare it after each pass.

## P7 — [FEEDBACK-O5] Document review has no defined extraction artifact
Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: SUPPORTED  
Evidence:
```text
review-profiles.md defines a Document lens.
phase-1-independent-passes.md:16-24 requires the same source snapshot and task packet for both seats.
No phase reference or bundled script defines extraction of document text, image order, or hyperlinks.
```
Suggested fix: Add a document extraction step that records tool/version, text, hyperlinks, image order, and hashes as a reviewable artifact. Include bounded image previews with originals available for disputed details; this also addresses O13.

## P8 — [FEEDBACK-O7] The URL trust boundary has no mechanical check
Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:
```text
review-protocol.md:199-211 prohibits fetching target-embedded URLs.
review-protocol.md:236-237 explicitly says scan-side URL enforcement is not built.
blind-relabel.mjs scan checks identity tokens and known claim IDs, not URLs.
```
Suggested fix: Add a pre-handoff check that extracts target URLs and flags matching cited URLs for review. The historical cited-link incident itself was not independently verifiable from this working tree.

## P9 — [FEEDBACK-O6] The web limit does not define how search batches count
Severity: LOW  
Basis: SOURCE_CITATION  
Evidence strength: SUPPORTED  
Evidence:
```text
review-protocol.md:186-191 says “5 fetches per seat per phase” and requires an actual count.
It gives no counting rule for one tool request containing several searches.
```
Suggested fix: In `references/review-protocol.md`, define separate counts for fetches and individual search queries, including batched requests.

## P10 — [TOKENS] Raw preflight output is costly to repeat in briefs
Severity: LOW  
Basis: EXECUTED  
Evidence strength: REPRODUCED  
Evidence:
```text
The supplied preflight.json is 66,868 bytes. Its Tier 2 test result contains hundreds of passing-test lines.
review-protocol.md:44-58 and phase-1-independent-passes.md:25-28 say to include preflight output in the task packet, while permitting an explicitly flagged summary.
```
Suggested fix: Add a `preflight.mjs` brief-summary output with command, exit code, test totals, snapshot hash, and a path/hash for the unchanged raw artifact. Expected quality effect: none if seats retain raw-artifact access; roughly 15–17k tokens saved per seat each time the full 66 KB artifact would otherwise be inlined, estimated at about four bytes per token. This addresses O15.

## P11 — [FEEDBACK-O12] Finding schema has no actionable fix field
Severity: LOW  
Basis: EXECUTED  
Evidence strength: REPRODUCED  
Evidence:
```text
review-protocol.md:129-141 defines Severity, Basis, Evidence strength, and Evidence, with no Suggested fix.
translateFindings accepted an extra summary field and retained it in findings.json.
```
Suggested fix: Add an optional `suggested_fix` field to the claim and canonical finding schemas, and validate permitted extra fields in `translateFindings`.

## P12 — [FEEDBACK-G1] The identity brief omits paths and filenames
Severity: LOW  
Basis: STATIC_TRACE  
Evidence strength: SUPPORTED  
Evidence:
```text
phase-1-independent-passes.md:35-40 forbids naming one’s seat in prose.
blind-relabel.mjs:638-670 scans returned text, including paths mentioned there, but the brief never specifically warns against seat-bearing scratch paths or filenames.
```
Suggested fix: Add “do not put your seat letter in scratch paths or filenames” to the Phase 1 brief instruction.

## P13 — [FEEDBACK-G8] Severity guidance leaves acceptance risk ambiguous
Severity: LOW  
Basis: SOURCE_CITATION  
Evidence strength: SUPPORTED  
Evidence:
```text
review-protocol.md:153 defines severity only as “impact if the claim is real.”
The schema lists severity values but gives no rule for unmet acceptance criteria versus runtime failure.
```
Suggested fix: Add a short severity rubric to `references/review-protocol.md` covering acceptance, operational, security, and evidence-integrity impact.

## P14 — [FEEDBACK-G9] Profiles omit data privacy in sanitized captures
Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: SUPPORTED  
Evidence:
```text
review-profiles.md:25-34 lists Code security topics, including secrets, but does not ask whether supposedly anonymized captures retain hardware or infrastructure identifiers.
```
Suggested fix: Add a data privacy check to the Code and Document lenses for serials, WWNs/NAAs, addresses, tenant identifiers, and similar identifiers when a target claims anonymization.

## P15 — [FEEDBACK-G11] Fresh-auditor inputs lack an access-isolation step
Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: SUPPORTED  
Evidence:
```text
phase-3-scorecard.md:140-160 says to give the auditor ONLY X/Y material, yet defines no staged input directory or check that real-ID run artifacts are outside its accessible paths.
```
Suggested fix: Stage only X/Y files and the target snapshot in a separate auditor input directory; give the auditor that directory and check it for A/B files and mapping artifacts before dispatch.

## P16 — [FEEDBACK-G12] Four manual relabel commands depend on correct flipped filenames
Severity: LOW  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:
```text
phase-3-scorecard.md:31-41 requires the orchestrator to read the flip and substitute both labels into four relabel commands and two output names.
```
Suggested fix: Add one `blind-relabel.mjs` command that reads the mapping and Phase 1 files, performs both passes, scans both outputs, and derives output filenames.

## P17 — [TOKENS] Brief construction repeats protocol text without a generated template
Severity: LOW  
Basis: STATIC_TRACE  
Evidence strength: SUPPORTED  
Evidence:
```text
phase-1-independent-passes.md:35-46 and :51-67 require verbatim identity and web rules in each brief.
phase-3-scorecard.md:162-243 lists auditor instructions to restate.
No bundled script builds those briefs from the frozen task packet and selected rules.
```
Suggested fix: Add phase brief builders that include the relevant rule blocks once and point to hashed full references. Expected quality effect: better consistency; likely several thousand tokens saved per run by eliminating repeated hand-written rule text. Estimate is based on the repeated multi-page phase instructions, not measured model usage. This addresses O10, O11, and G13.

## Checks performed

- **Refuted G4:** `phase-1-independent-passes.md:8-11` already requires separate `phase1/` and `phase2/` directories; both dispatchers write `result.json` beside the brief. Following the documented layout prevents overwrite.
- **Refuted G5 as a current defect:** The skill already says to pass effort only when supported and explicitly selected (`SKILL.md:88-94`). The claimed harness limitation is external to this repository and was not established by its code or docs.
- **Refuted G7 as a defect:** Peer complementarity and a particular run’s false-positive rate are outcomes, not missing behavior. The packet can already include tentative orchestrator claims as task material; no source requirement forbids it.
- **Refuted O14 as a code defect:** `phase-2-cross-examination.md:7-15` requires the exact agent ID and prohibits forking. The transport-specific method is harness dependent; no contradictory instruction was found.
- **Refuted G10 as an omission:** `phase-3-scorecard.md:90-94` requires counting qualified claims even when no falsification pass runs, and `:332-335` requires reporting that count.
- **O1/G2, O2/G3/G6, O3, O4, O5/O13, O6, O7, O8, O9, O10/O11/G13, O12, O15, G1, G8, G9, G11, and G12:** addressed in findings above. The live-run details themselves were treated as unverified unless reproduced or supported by current source.
- **Shared-file drift:** Compared 33 same-path files across the two packages by hash. Only `README.md` and `SKILL.md` differ; all shared scripts and references checked are identical.
- **Preflight evidence:** Read the supplied raw artifact: snapshot hash `1e77a6e402e4d3a3a8739d5867224d00a0a09d29582f23b6fc8910b2444b957d`, 384 tests passed, package validation exited 0. These results do not cover the reproduced label and timeout gaps.
- **Repository changes:** None.

Web fetch/search count: 0.
