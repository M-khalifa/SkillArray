# Seat B findings

## B1 [AC-1] [AC-9] [AC-10] [H6] — Repeated list labels hide a blocked reviewer and let Phase 1 finish cleanly
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: On Windows, a No findings file contains an earlier strict `Blocked: none`, then a blocked declaration behind multiple list labels. Deployment frequency unknown; holds independently of platform.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/review-run.mjs:777
The replacement pattern permits only one letter, roman or numeric enumerator.
The removed pattern permitted repeated numeric enumerators.

PowerShell stdin piped to node; imported shipped seatBlockedLine, run and
validateProblems. Filesystem operations used an in-memory map. The validator
runner seam called shipped validateProblems; no physical files were written.

seatBlockedLine(
  "## No findings\nBlocked: none\n## Checks performed\n1. 2. Blocked: reader denied\n"
)
Returned: ""

Actual parser output:
{"prefix":"1. 2. ","value":""}
{"prefix":"1) 2) ","value":""}
{"prefix":"(1) (2) ","value":""}
{"prefix":"1. ","value":"reader denied"}
{"prefix":"iv) ","value":"reader denied"}

Executed shipped run() through phase1 --wait with both native actors declared done.
For all ten repeated-label variants:
  validationProblems = 0
  exit code = 0
  output contains "validate Phase 1: clean"
  next step = phase2 --start

The single-label controls exit 1.

Other reproduced prefixes:
"1. - 2. ", "> 1. > 2. ", "- [ ] 1. 2) ",
"a. b. ", "iv) ii) ", "1. a. ", "a. 1. "

review-run.mjs:852 reads this result.
review-run.mjs:854-858 rejects a No findings file only when the result names a block.
```
Suggested fix: At review-run.mjs:777, allow repeated enumerators interspersed with the existing marker classes; add repeated-label cases to the regression matrix.
Same shape elsewhere: Both byte-identical review-run.mjs copies under plugins/pair-review/skills/pair-review/scripts/ and plugins/cross-review/skills/cross-review/scripts/, at lines 777, 793, 852 and 858. The tests at scripts/tests/review-run.test.mjs:2347-2355 cover single enumerators only.

## B2 [AC-2] [AC-8] [AC-10] [H8] — Compact Markdown blockquotes bypass the relative run-folder guard
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: A packet, rule or finding quotes a folder-led relative traversal immediately after `>`, without a space. This is valid Markdown blockquote syntax. Windows reproduction; deployment frequency unknown.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:250
RELATIVE_UP_RE does not permit ">" immediately before the relative path.

Executed shipped runDirNamedIn, scrubDir and build.
Synthetic target and run directories were existing, separate repository folders:
  target = plugins/cross-review
  run    = plugins/pair-review

Input:
>skills/../../pair-review/skills/pair-review/SKILL.md

The path exists when resolved against the target.
scrubDir count: 0
runDirNamedIn result: null

Actual brief-builder output:
{"input":">skills/../../pair-review/skills/pair-review/SKILL.md","phase1":"accepted path in brief","phase1Control":"refused","auditor":"accepted path in brief","auditorControl":"refused"}

Ten existing traversal shapes were tested, including backslashes, extra "./",
multiple parent traversals and repeated separators.
All ten reached both generated briefs unchanged.
All twenty controls with "> " instead of ">" were refused.

Physical writes: 0; twenty generated briefs captured in memory.

exchange.mjs:229-235 uses the same scrub-and-guard sequence.
blind-relabel.mjs:3109-3112 uses it for auditor input.
build-brief.mjs:157,159,320,324 uses the guard for packets and review rules.
```
Suggested fix: At build-brief.mjs:250, recognize `>` as a token boundary; add compact blockquote and HTML-closing-tag boundary controls.
Same shape elsewhere: Both byte-identical build-brief.mjs copies at lines 250 and 266; both exchange.mjs copies at line 235; both blind-relabel.mjs copies at line 3112, under the two skills’ scripts directories. These are shared callers of the same missed boundary.

## B3 [AC-1] [AC-3] [AC-8] [AC-9] [AC-10] [H1] — A Checks performed heading alone now counts as a completed reviewer pass
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: An interrupted or malformed Phase 1 file reaches its Checks performed heading but contains neither a claim nor No findings, and an audit findings object exists. Reproduced on Windows; the gate is platform-independent.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/build-manifest.mjs:260-261
A seat counts when any unfenced line matches Checks performed OR exact No findings.
No claim/result marker or completed section body is required.

Executed shipped initBody, buildReport and validateProblems with in-memory fixtures.
One reviewer file was valid; the other held each tested malformed shape.

Actual output:
{"input":"## Checks performed","validator":1,"manifest":"completed","report":"COMPLETE","passes":2}
{"input":"## Checks performed\n- reading started","validator":1,"manifest":"completed","report":"COMPLETE","passes":2}
{"input":"## Checks performed\n```\nnever finished","validator":"unterminated fenced code block: cannot safely scan past it, fix the file and re-run","manifest":"completed","report":"COMPLETE","passes":2}
{"input":"## Checks performed\nBlocked: none","validator":1,"manifest":"completed","report":"COMPLETE","passes":2}

All ten tested shapes produced completed / COMPLETE / two passes.
The shipped validator rejected every shape.

The previous gate required a claim-like heading or No findings, so it rejected
a Checks performed-only file.

build-manifest.mjs:277 converts the permissive gate into completed status.
build-report.mjs:727 propagates that status.
build-report.mjs:734 reports both configured reviewers as completed passes.
```
Suggested fix: Reuse structural validation for the original Phase 1 files before counting them; require a valid findings result as well as the completion section.
Same shape elsewhere: Both byte-identical build-manifest.mjs copies at lines 260-277, and both build-report.mjs copies at lines 727 and 734, under the two skills’ scripts directories.

## B4 [AC-1] [AC-4] [AC-10] [H2] — Finite timeouts still discard the exited-with-open-output warning
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: An unanswered CLI exits while output remains open, and its finite timeout expires before the new five-second exit wait. For example, exit shortly after launch with `--timeout 1`. Frequency unknown; code path exists on Windows and POSIX.
Evidence:
```text
Static trace only; no live child-process reproduction.

plugins/pair-review/skills/pair-review/scripts/claude-dispatch.mjs:256-262
When hasExited(child) is true and no answer arrived:
  else stream.timedOut = true;
  cleanup();
  resolve(stream);

cleanup clears the new exit-wait timer.
Neither stopIncomplete nor exitedOutputOpen is set.

claude-dispatch.mjs:325-336
The five-second exit-wait path sets both flags, but cannot do so after cleanup.

claude-dispatch.mjs:523-525
The open-output warning requires exitedOutputOpen.

claude-dispatch.mjs:551
The surviving message says the CLI was killed after exceeding the timeout.

plugins/pair-review/skills/pair-review/scripts/codex-dispatch.mjs:680-687
The equivalent unanswered timeout branch resolves timedOut without either flag.

codex-dispatch.mjs:796-805
The new exit-wait callback checks settled and therefore cannot repair that result.

codex-dispatch.mjs:1267-1269,1299-1306
The warning requires exitedOutputOpen; the timeout record instead says "killed".

The new tests exercise unanswered held-output exits with timeout 0.
The finite-timeout control exercises an already-answered CLI.
```
Suggested fix: Set stopIncomplete and exitedOutputOpen in both unanswered, already-exited timeout branches, and describe the observed exit rather than claiming a kill.
Same shape elsewhere: Both claude-dispatch.mjs copies at lines 256-262 and both codex-dispatch.mjs copies at lines 680-687, under the two skills’ scripts directories. The third dispatcher’s accepted close-only behavior was excluded.

## Checks performed

- AC-1: Executed the Phase 1 wait and manifest/report matrices. B1 and B3 produce false completion; B4 retains a warning gap. NOT MET
- AC-2: Executed ten quoted traversal shapes through both brief modes and the shared scrub/guard functions. B2 bypasses the boundary. NOT MET
- AC-3: Independently checked benchmark outcome/ground-truth counts across ten shapes; those reconcile. B3 reports two passes despite one structurally invalid result. NOT MET
- AC-4: Checked signal guards with ten exited-child shapes; no fake exited child was signalled. B4 remains in finite-timeout metadata. Live process cleanup was not exercised. NOT MET
- AC-5: Repository metadata/parity validator passed. Both packet templates produce zero label warnings; sampled resume instructions agree with delta permissions. Exhaustive command/help and external CLI compatibility were not exercised. PARTIAL
- AC-6: Checked original-file preference, fallback reading, legacy report paths and documented snapshot restart behavior. Complete historical-run compatibility was not executed. PARTIAL
- AC-7: Checked changed exports and instruction blocks; no removable-weight finding established. Remaining implementations were not exhaustively assessed for weight. PARTIAL
- AC-8: Read defect sections across all six feedback reports and checked their principal fix paths and accepted deviations. B2 and B3 leave reported guard/completion classes open. Historical POSIX reproducers were not rerun. NOT MET
- AC-9: The old repeated-numeric-marker pattern handled the prefixes in B1; the replacement misses them. The old seat gate rejected Checks performed-only files; the replacement accepts them, as B3 shows. Shared boundary narrowing agreed across 22 tested suffixes; no regression found there. NOT MET
- AC-10: Five selected shipped tests passed. Existing matrices omit the broken repeated-label and compact-blockquote siblings; completion tests omit Checks performed-only files. The unanswered finite-timeout branch lacks the corresponding control. B1-B4 identify the gaps. NOT MET
- H1: Claim-heading-only and fenced-only examples are rejected now; ten other malformed completion shapes still yield COMPLETE and two passes, as B3 shows. PARTLY CONFIRMED
- H2: The five-second unanswered-exit path addresses unlimited waiting. The earlier finite-timeout path still omits warning flags, as B4 traces. Live process behavior was not reproduced. PARTLY CONFIRMED
- H3: Ten standard path spellings and ten user-variable spellings were detected, including rootless, home-relative, file-URL, doubled-backslash and username forms. Existing aliases also pass through real-path checks. REFUTED
- H4: Ran 22 boundary suffixes through continuesName, scrubDir, runDirNamedIn and rewritePaths; no disagreement. Accepted unusual-character deviations were excluded. REFUTED
- H5: Ran shipped peerLabelLines against both templates; each returned zero warnings. Guidance now describes every reserved letter. REFUTED
- H6: Single letter/roman labels, dash-like markers, definition colons and full-width colons were detected. Ten repeated-label siblings still pass cleanly, as B1 shows. PARTLY CONFIRMED
- H7: Executed ten resumed-transcript shapes. New empty, whitespace and tool-only turns return null; tool-result/meta continuations preserve the preceding reply. REFUTED
- H8: Plain folder-led traversals are detected. Ten compact-blockquote siblings bypass the guard and enter briefs, as B2 shows. PARTLY CONFIRMED
- H9: Executed 330 heading/marker/colon combinations, including emphasized, code-marked and parenthesized-number headings; no missed block. REFUTED
- H10: Compared sequencer resume text and both phase-reference resume variants with delta-brief permissions; task packet, Phase 1 brief and own scratch access now agree. REFUTED
- H11: Exercised ten exited-child shapes through the exported signal handlers; checked the remaining preflight and dispatcher timeout kill sites for hasExited guards. The cited unguarded calls are gone. REFUTED
- Installed copies: all four match repository bytes—100 files in each pair-review copy, 104 in each cross-review copy. No matching review-skill plugin cache copy was found.
- Execution: five selected shipped tests passed, zero failed. Additional matrices imported shipped functions and intercepted filesystem operations in memory. No files, servers or background jobs were created; no command remains running.
- Snapshot: HEAD remains ea0b739; recorded upstream was neither ahead nor behind. Overall snapshot hash differs from frozen preflight, but no scoped size/mtime drift was detected. Excluded host settings were not read.
- Coverage: read fully — since.diff, packet templates, repository validator/install/release scripts and both benchmark sources; read partly — skill documents, lifecycle scripts, tests and six feedback reports; not read — remaining implementation/test bodies, remaining fixtures and out-of-scope material.
- Limits: full suites, mutation runs and live process lifecycle scenarios were omitted under the no-file rule. Frozen preflight contains Tier 1 evidence only; author-reported suite results were not treated as executed evidence.
Blocked: rg search: CommandNotFoundException (native search used); Git global-ignore configuration: Permission denied

web: 0 queries, 0 page fetches