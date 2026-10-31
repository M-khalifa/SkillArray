### P1
Claim: P1
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
restructure-plan-v2.md section 5: "a finding blocks the release only when its trigger happens in a normal run of the documented
commands. A hand-built input is LOW, whatever its effect."
scripts/build-report.mjs:37-38  Blockers  findings whose final_state is unresolved-high-stakes, plus every finding whose final severity
            (severity_audited, else severity) is HIGH or CRITICAL ...
findings-rounds-1-5.md, round 3 item 9 (HIGH): "a manifest rebuilt after a seat file was emptied or truncated still reads completed and the report COMPLETE"
  -> its trigger (a seat killed mid-write) happens in a normal run; its reproduction is a hand-built file.
```
Conceded: the rule's second sentence judges the reproduction, not the trigger, so a fixture-reproduced false-COMPLETE would be filed LOW. Corrected severity: MEDIUM. The defect is one ambiguous sentence in a release rule (a gate that does not catch what it says), not a code step; the fix is the sentence the peer proposes ("severity by impact; a hand-built reproduction of a state a normal run can reach still blocks").

### P2
Claim: P2
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
scripts/review-run.mjs:742  const brief = cli ? path.join(dispatchDir(desc, 'phase1', role), 'brief.txt') : path.join(desc.runDir, 'phase1', `brief-${role}.txt`);
scripts/review-run.mjs:752  const prompt = await writePrompt(desc, 'phase1', role, brief, canonicalPath(desc, 'phase1', role));
scripts/review-run.mjs:270  const file = path.join(desc.runDir, kind === 'auditor' ? 'phase3' : kind, `prompt-${role}.txt`);
scripts/build-brief.mjs:164-165  base = dirname(outputPath); scratch = <base>/scratch-<hash>   (today base = <run>/phase1/seat-<letter>)
scripts/run-descriptor.mjs:179  return path.join(desc.runDir, phase, `seat-${role}`);
```
Conceded at HIGH. The native brief, the prompt file and the output path all sit under the run folder and the plan's step 3 moves only the "working folders"; the seat's own folder path, once beside the run folder, also leaves the run-folder scrub (exchange.mjs:229, blind-relabel.mjs:3114 are keyed to the run folder only), so the seat letter in `seat-<letter>` would reach the peer view and the auditor. Same defect as my own step 3 claim; the peer's fix (stage every seat-visible file outside the private tree, keep the path rejection at its current severity, gate with sentinel paths in prompts and diagnostics) and mine (a random-named temp folder per seat, outputs copied inward) are compatible.

### P3
Claim: P3
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
scripts/blind-relabel.mjs:1936-1940  if (!bySeat[seat].has(id)) { throw new RelabelError(`translated origin "${id}" has no Phase 1 claim heading ...`)
scripts/blind-relabel.mjs:2277-2278  const seatLetters = new Set(finding.origins.map((id) => id[0]));
                                      finding.independently_discovered = seatLetters.size === 2;
references/review-protocol.md:268-270  Class sweep: when you confirm a defect, search the target for every other place with the same shape ...
references/phase-2-cross-examination.md:357-359  one `### P<n>` block per peer claim, `Action` exactly `CONCEDE` or `DISPUTE`
```
Conceded at HIGH. With translate "kept as is" a sweep origin is refused outright; the only way to make it pass without changing translate is to put it into the Phase 1 claim set, and then a post-exposure claim counts as independent discovery (two seat letters), which corrupts the overlap figure the plan's section 5 prints. Same cause as my Decision A claim; I rated it MEDIUM because the plan does not say how sweep claims are carried, but the peer is right that every option the plan leaves open either refuses the claim or breaks the independence accounting, so HIGH stands.

### P4
Claim: P4
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
SKILL.md:65  `--env-passthrough` (for example `CLAUDE_CODE_USE_BEDROCK` and the `AWS_*` variables of a Bedrock seat) is a flag of the
  dispatchers you run by hand; `review-run` passes no such list, so a seat that needs one is dispatched by hand (phase files, manual dispatch).
scripts/env-filter.mjs:13-17  base allowlists hold OS variables only (no AWS_*, no CLAUDE_CODE_USE_*)
$ grep -nE "env-mode|envMode|envPassthrough|env-passthrough" review-run.mjs run-descriptor.mjs review-config.mjs   -> no output
```
Conceded at HIGH: the entry page documents the hand-dispatch route as the only way to run such a seat, and the plan deletes that route with no replacement field. Same defect as my environment-controls claim (rated MEDIUM there; the packet's rubric makes a lost documented feature HIGH, so the peer's severity is the right one). The peer's gate (fake reviewer verifying allowed variables arrive and others do not, foreground, resumed and detached) is the one to adopt.

### P5
Claim: P5
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```
tests/claude-dispatch.test.mjs:72  const launch = (argv, extraEnv = {}) => spawnSync(process.execPath, [script, ...argv], {
tests/review-run.test.mjs:285  test('the sequencer stops at the first failed step, names it, runs nothing after it and keeps every artifact', ...
tests/review-run.test.mjs:336  test('a native seat whose Phase 1 file holds only the header is still running: exit 3, no validate', ...
scripts/build-manifest.mjs:989  const stamped = { ...manifest, run_id: randomUUID(), hashes };
counts per test file (spawns of a script command line / tests): blind-relabel 104/237, detach-utils 33/26, dispatch-integration 45/34, preflight 15/63
```
Conceded at MEDIUM. The behaviour the process and native-turn fixes protect is exercised only by launching a CLI or the sequencer, which a replay of stored results never does, and the plan rebuilds the mutants at step 6 after steps 1 to 4 have already removed the code strings they point at. Same cause as my replay claim and my in-process claim; the peer adds the right ordering fix (port each assertion and its mutant before deleting that module's entry point).

### P6
Claim: P6
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
findings-rounds-1-5.md totals: 47 findings; both 11; first seat only 19; second seat only 17  -> seat totals 30 and 28
30 * 28 / 11 = 76.4 estimated; 47 / 76.4 = 62% found (the plan: "about half, at most")
per round from closing-r1..r5 phase3/findings.json origins: found 9, 8, 11, 11, 8; both 1, 1, 4, 3, 2;
Lincoln-Petersen "missed" 16, 12, 3, 5, 4; Chapman 8, 6, 2, 4, 3   (round 3's "3" preceded 19 findings in rounds 4 and 5)
```
Conceded at MEDIUM, with the same numbers reproduced independently. The peer's fix (print observed counts only, never infer unseen defects or use overlap as a threshold, gate the zero-overlap and merged-origin cases) matches mine.

### P7
Claim: P7
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
references/review-protocol.md:979-989  Audit depth: light. The default. ... Do not re-check a finding whose every origin was conceded by the peer,
  or one both reviewers found independently ... record it NOT_CHECKED
SKILL.md:147  `review-run audit --prepare` stops until you name the depth with `--audit-depth full` or `--audit-depth light` when a conceded claim is HIGH or CRITICAL
closing-r1..r5 run.json flags: auditDepth "full" in all five rounds
closing-r1..r5 findings.json: the full audit changed the severity of 9 of 45 agreed claims; 1 agreed MEDIUM raised to HIGH (round 4, item 6)
```
Conceded at MEDIUM. Against today's default (light) Decision B adds work, so "less audit cost" holds only against a full audit, which the plan does not say; the look-back figure cannot distinguish agreed claims an auditor checked from ones recorded NOT_CHECKED. One nuance for the maintainer: on this target every closing round ran full, because the sequencer forces a choice whenever a conceded claim is HIGH, so the saving the plan has in mind is real for those runs; the rationale still needs the baseline named and the severity-change data (which my own claim adds) considered.

### P8
Claim: P8
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
restructure-plan-v2.md, Decision C: "one fresh reviewer, on the fix diff only, who must give a command and its output for each finding (docs recipe; no new mode)"
SKILL.md:289  ... spawn one fresh agent (never a fork) with it, ask it to return its findings as text in its reply ..., and require a command and its output for every finding.
references/review-protocol.md:495-500  An architecture claim ... or a document claim ... has nothing to execute; SOURCE_CITATION, STATIC_TRACE, or an explicit
  constraint/contradiction trace is the verifier's real independent check
```
Conceded, corrected severity LOW. The gap is real: the plan's recipe names only a command and its output and the protocol's own rule for designs and documents is the right wording. It is a wording gap rather than a lost result: the recipe the plan restates already exists at SKILL.md:289, and for a document fix the reviewer can satisfy it with the diff or a search of the corrected passage, so no fix-check finding is refused by it; the plan text should adopt the protocol's "evidence appropriate to the target" sentence.

web: 0 queries, 0 page fetches
