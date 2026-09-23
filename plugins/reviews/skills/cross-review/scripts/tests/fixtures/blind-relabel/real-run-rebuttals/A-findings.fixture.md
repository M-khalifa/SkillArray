# Seat A findings

Disposable fixtures were built under `%TEMP%\rv-fixtures-lqymZB` (outside the repository). Fixture claim numbers deliberately start at 71 so they can never collide with this file's own claim IDs.

## A1 — [BUG] scan's target-derived exemption walks `.git/` and ignored dirs, so a branch name silently whitelists a third-person vendor identity leak
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
blind-relabel.mjs:586  entries = await fs.readdir(targetDir, { recursive: true });
blind-relabel.mjs:590  for (const e of entries) check(e);      // every path, incl. .git/refs/heads/*, node_modules/*

$ mkdir tgt2 && cd tgt2 && git init -q && git checkout -q -b codex/topic && (commit one file) && cd ..
$ printf '# Peer findings\n\n## P1 — thing\nThe Codex reviewer found this first.\n' > f2.md
$ node blind-relabel.mjs scan --in f2.md --target-dir tgt2
blind-relabel: report line 4 (target-derived): The Codex reviewer found this first.
scan clean: 0 identity matches, 1 target-derived reported
exit=0
$ node blind-relabel.mjs scan --in f2.md --target-dir tgt3      # same repo shape, default branch name
blind-relabel: IDENTITY line 4: The Codex reviewer found this first.
exit=1
~~~~
The USAGE text says a token is target-derived when it appears in "that directory's own file names, SKILL.md, or references/*.md". In practice `.git/refs/heads/<branch>`, `.git/logs/...`, and gitignored trees such as `node_modules/` also count. A `claude/...` or `codex/...` branch, or an installed `openai` or `@anthropic-ai` package, is enough to turn a hard stop into exit 0.
Suggested fix: blind-relabel.mjs `targetDerivedTokens`: when the target is a git repo, list names with `git ls-files --cached --others --exclude-standard`. Otherwise skip `.git/` and `node_modules/` in the recursive walk. Add a test that uses a `codex/x` branch.

## A2 — [BUG] vendor-token detection is substring-based, so ordinary English words hard-stop the exchange (`affable` → `fable`)
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
blind-relabel.mjs:653-654  const lower = line.toLowerCase();
                           const hasVendorToken = allTokens.some((t) => lower.includes(t));
blind-relabel.mjs:661-662  matchedTokens = allTokens.filter((t) => lower.includes(t)); vendorLeak = ...

$ node blind-relabel.mjs scan --in f1.md --target-dir tgt1     # f1.md prose line: "The author is affable."
blind-relabel: IDENTITY line 11: The author is affable.
blind-relabel: 0 self-identification match(es), 1 other non-target-derived identity match(es), 0 real claim-ID leak(es); return this file for redaction, do not forward
exit=1
~~~~
The self-ID regex (`VENDOR_TOKEN_ALT`, line 521) already uses `\b` boundaries, but the identity tier does not. Other words hit the same way, for example "octopus" (`opus`) and "fables". The protocol allows only one redaction round, so a document review that quotes such a word can end the run.
Suggested fix: blind-relabel.mjs `scanText` (and `targetDerivedTokens.check` for symmetry): test with the same word-boundary alternation as `VENDOR_TOKEN_ALT` and `buildExtraTokenAlt`, not `String.includes`. Add regression cases for `affable` and `octopus`.

## A3 — [BUG][FEEDBACK-O12] translate's mechanical evidence capture swallows the trailing `Suggested fix:` line (any post-fence prose) into findings.json `evidence`
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
$ cat p1/A-findings.md   (excerpt)
## A71 — first
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
$ node x.js
boom
```
Suggested fix: add a null check in x.js parse().

$ node blind-relabel.mjs translate --in audit.json --out out.json --mapping map.json --phase1-dir p1
translated 2 finding(s), wrote out.json
F1 evidence= ["$ node x.js\nboom\nSuggested fix: add a null check in x.js parse()."]

review-protocol.md:602-604 "`evidence` becomes one verbatim entry per origin ... extracted from each origin's own Evidence fence."
blind-relabel.mjs:873-887 evidenceLines keeps accumulating every non-heading, non-break line after "Evidence:" until the next "## " heading.
~~~~
This task packet, and the O12 run, require a `Suggested fix:` line after every Evidence fence. That means every derived `evidence` entry in findings.json mixes the reviewer's recommendation into what the protocol calls verbatim captured output. `validate` still passes.
Suggested fix: blind-relabel.mjs `extractClaimBlocks`: when "Evidence:" is followed by a fence, end the evidence body at that fence's closing line. Capture a `Suggested fix:` line into its own `suggested_fix` field (see A14) and keep it out of `evidence`.

## A4 — [BUG] back-to-back Evidence fences leak their own delimiter lines into derived evidence
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
fixture claim block (second claim):
Evidence:
```
a.js:1 one
```
```
b.js:2 two
```

translate output: F2 evidence= ["a.js:1 one\n```\n```\nb.js:2 two"]

blind-relabel.mjs:880-884
  const isOpener = !prevInFence && FENCE_OPEN_RE.test(line);   // prev line was the first fence's closer (inFence=true) -> false
  const isCloser = !isOpener && !nextInFence;                   // next line is the second opener (inFence=true) -> false
~~~~
Two fences with no blank line between them are common, for example a command block followed by an output block. The first fence's closer and the second fence's opener are then kept as evidence content.
Suggested fix: blind-relabel.mjs: have `parseFenceLines` mark each line as `{isOpen, isClose}` when it toggles state, and use those flags in `extractClaimBlocks` instead of guessing from the neighbours' `inFence`.

## A5 — [BUG] translate rewrites every X<n>/Y<n> token in prose fields, fabricating real claim IDs that do not exist
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
audit.json finding: "title":"X75 forwarding crash in X71", origins ["X71"]
$ node blind-relabel.mjs translate ... --phase1-dir p1
F1 title= "A75 forwarding crash in A71"

blind-relabel.mjs:694  const AUDIT_ID_RE = /\b([XY])(\d+)\b/g;
blind-relabel.mjs:703-706  every string except key "evidence" is rewritten
~~~~
The phase1 files have no heading for the rewritten ID, yet translate reports success. A literal such as X11 (forwarding) in a title, summary, or recommended_fix becomes a fake real claim ID in findings.json and the scorecard. The only protection is the `evidence` key exemption.
Suggested fix: blind-relabel.mjs `translateFindings`: build the set of valid anonymous IDs from all `origins` and from the phase1 headings, and have `translateValue` rewrite only tokens in that set.

## A6 — [BUG][FEEDBACK-O3] stale Phase 2 `P<n>` labels survive into the Phase 3 X/Y files and nothing detects them
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
p2/A-findings.md rebuttal section (from the peer) contains, inside its Evidence fence:
  as identified in P92, x.js:4 guards it
$ relabel --from A --to X ; relabel --from B --to Y  -> p3/X-findings.md
$ node blind-relabel.mjs scan --in p3/X-findings.md --phase1-dir p2 --forbid-seats A,B
scan clean: 0 identity matches, 0 target-derived reported
exit=0
$ grep -n "P92\|Rebuttals\|Claim" p3/X-findings.md
12:## Rebuttals (from Y) of X claims
15:Claim: X71
20:as identified in P92, x.js:4 guards it
~~~~
In the Phase 2 namespace, each P number equals the real number, because relabel keeps numbers. So a surviving `P92` tells the auditor that it points at claim 92 of the other letter. It is a stale cross-reference in a namespace that should not exist in Phase 3 ("MUST NOT reuse Phase 2's P labels", phase-3-scorecard.md:55). `--forbid-seats` accepts only A and B heading sets.
Suggested fix: blind-relabel.mjs `scan`: add `--forbid-p` (or allow `P` in `--forbid-seats`). It would forbid `\bP\d+\b` for the numbers present in the peer-view files, fence content included, on every Phase 3 scan. Document it in phase-3-scorecard.md.

## A7 — [DOC][FEEDBACK-G3] rebuttal entry heading level is unspecified; any `##`-level entry heading fails validate, and the error sends the file to the wrong seat
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
$ # rebuttal entry heading line = '## P71'; node blind-relabel.mjs validate --phase1-dir p2
blind-relabel: A-findings.md:14: heading "## P71" looks like an attempted claim ID ("P71") but does not match the required "## A<n>" form -- ...
blind-relabel: 1 claim block problem(s); return the affected seat's file to its own context for reformatting ...
exit=1
$ # rebuttal entry heading line = '## A71' (after P->real translation)
blind-relabel: A-findings.md:14: claim "A71" heading appears more than once -- ...
exit=1
$ # rebuttal entry heading line = '### A71'
validate clean: ...
exit=0

review-protocol.md:322-326 rebuttal schema defines only "Claim:/Action:/Counter-fact:" lines, no heading form.
~~~~
Only `###` or deeper entry headings pass. The error names `A-findings.md` and says to return "the affected seat's file to its own context". But the malformed lines were written by the rebutting peer, not by the file's owner.
Suggested fix: review-protocol.md Interaction modes: require rebuttal entries to use `### <P-id>` headings, or no heading at all. blind-relabel.mjs `runValidate`: when a malformed or duplicate heading sits below a `## Rebuttals (from X) of Y claims` line, name seat X as the one to return it to.

## A8 — [IMPROVE][FEEDBACK-O2] no helper appends translated rebuttals; the P-to-real step is manual even though `relabel --from P` already does it
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
$ node blind-relabel.mjs relabel --in reb.md --out reb-real.md --from P --to A
relabeled P -> A, wrote reb-real.md
### A71
Claim: A71
Action: CONCEDE
Evidence:
```
see P71 above
```

phase-2-cross-examination.md:121-132 "Persist their returned rebuttals by translating each rebuttal's P ID back ... appending a section" -- no command given.
~~~~
relabel keeps numbers (`\b${from}(\d+)\b` becomes `${to}$1`), so the P-to-real mapping is the identity on numbers. The docs never say so. The fenced `P71` is left alone, which is the same gap as A6. Orchestrators currently use sed or ad-hoc regex for this step.
Suggested fix: add `blind-relabel.mjs append-rebuttals --in <rebuttal.md> --onto <peer-findings.md> --from-seat <X> --peer <Y>`. It should run the P-to-peer relabel, fail on any fenced P-ID, normalize entry headings to `###` (A7), append the exact `## Rebuttals (from X) of Y claims` heading, and then run `validate`.

## A9 — [DOC][FEEDBACK-G11] the auditor is told to "read" phase3/, which also holds the coin-flip mapping and the real-letter-named half-relabeled tmp files
Severity: HIGH
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
~~~~
phase-3-scorecard.md:12-13  flip --out "<run-dir>/phase3/seat-to-audit-label.json"
phase-3-scorecard.md:38-41  relabel ... --out "<run-dir>/phase3/tmp-A.md" (first pass only: still carries the peer's real letter)
phase-3-scorecard.md:125-129 "Save each verdict as <run-dir>/phase3/verification-<X|Y-id>.md ... MUST NOT save it under the real ID — the auditor reads this same directory."
review-protocol.md:441-442 "the auditor reads this directory too"
review-protocol.md:700 "pathless ... (no run-directory paths ...)"
~~~~
Two instructions conflict: the auditor "reads this directory" and the auditor is "pathless". An orchestrator that follows the first gives a full-tool subagent the path of a folder containing `seat-to-audit-label.json` and `tmp-A.md`/`tmp-B.md`, which exposes the whole blind. Nothing mechanical stages a clean input set.
Suggested fix: phase-3-scorecard.md: write relabel temps and the flip file to `<run-dir>/phase3-private/`. Stage only `<label>-findings.md` and `verification-*.md` into a fresh `<run-dir>/audit-input/`. Give the auditor that folder, or inline its content. Remove "the auditor reads this same directory" from both docs. Optionally, have `blind-relabel.mjs` refuse to write `flip --out` into a folder that holds `*-findings.md`.

## A10 — [DOC][FEEDBACK-O8] "no limit, omit --timeout" contradicts the 1800 s default in both dispatchers
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
~~~~
phase-1-independent-passes.md:68-71 "Append --timeout ... only when the user opted into a bound for this run; the orchestrator's default is no limit, so omit the flag entirely otherwise."
phase-1-independent-passes.md:121-122 "a timed-out status, when --timeout was passed, ends this attempt"
codex-dispatch.mjs:26      const DEFAULT_TIMEOUT_S = 1800;
codex-dispatch.mjs:287-294 else { ... args.timeout = DEFAULT_TIMEOUT_S; }
opencode-dispatch.mjs:55   const DEFAULT_TIMEOUT_S = 1800;   (:300 same fallback)
preflight.mjs:63           "Default: 1800 (matches the dispatchers' own default)."
~~~~
Omitting the flag gives a 30-minute kill, not "no limit". A timed-out status can also happen when `--timeout` was never passed. A slow high-effort seat (the G13 run took 18 min) can hit it.
Suggested fix: phase-1-independent-passes.md: say "omitted = 1800 s default; pass `--timeout 0` for unlimited". Or change both dispatchers' default to 0 so they match the doc, and update the preflight USAGE wording.

## A11 — [DOC][FEEDBACK-O9] SKILL.md's required Codex choice list is stale against the catalog
Severity: LOW
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
~~~~
SKILL.md:34-35 "Codex choices must include `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`"
provider-catalog.mjs:19-25 ids: gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5
git diff (uncommitted): README.md, configuration.md, model-capabilities.md updated; SKILL.md not.
~~~~
Suggested fix: SKILL.md Start here: point to `review-config.mjs catalog` as the source of truth and remove the literal list, so the catalog does not drift again. Otherwise add `gpt-6-sol`, `gpt-6-luna`, and `gpt-5.5`.

## A12 — [DOC] 1.5.0 was released without a version bump; the repository's own validator fails at HEAD
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
$ node scripts/validate-repository.mjs
CHANGELOG.md's top released header is 1.5.0, but plugin.json's version is 1.4.0
exit=1

plugins/reviews/.claude-plugin/plugin.json:4  "version": "1.4.0",
cross-review/SKILL.md:15 and pair-review/SKILL.md:14  version: 1.4.0
commit 8a0d417 subject: "feat(reviews): release 1.5.0 ..."; body: "Tested with real env: full release-check.mjs gate, 725/0, all steps passed."
~~~~
Observation: the release gate fails on the committed tree. Inference: installed copies report 1.4.0, so a version-keyed plugin update may not deliver the 1.5.0 CRLF blinding fix.
Suggested fix: bump plugin.json and both SKILL.md `metadata.version` values to 1.5.0 (or the next release), then rerun `scripts/release-check.mjs` before tagging.

## A13 — [BUG] build-manifest keys repeated `--phase1/--phase2/--verification` hashes by basename and silently drops collisions
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
$ node build-manifest.mjs --in man.json --out man-out.json --phase1 m1/A-findings.md --phase1 m2/A-findings.md
$ node -e "console.log(JSON.stringify(require('./man-out.json').hashes))"
{"phase1":{"A-findings.md":"27dd8ed4...a5a"}}
build-manifest.mjs:90  entries[path.basename(p)] = await hashFile(p);
~~~~
Two artifacts go in and one hash comes out, with exit 0. This can happen whenever a redo or redaction copy keeps the same filename (every dispatcher writes `result.json`).
Suggested fix: build-manifest.mjs `hashFileList`: refuse duplicate basenames, or key by the path relative to a `--run-dir` root.

## A14 — [DOC][FEEDBACK-O12] findings.json schema has no human-readable claim text or fix field; auditor extras pass through undocumented and get ID-rewritten
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
~~~~
review-protocol.md:543-575 findings.json example keys: id, origins, independently_discovered, severity, basis, evidence_strength, basis_from, peer_responses, auditor_check, final_state, evidence, verifications -- no title/summary/suggested_fix
phase-3-scorecard.md:283-288 scorecard built "from the translated findings.json" -- table has no claim-text column
blind-relabel.mjs:702-716 translateValue walks every unknown key (e.g. "summary", "recommended_fix") and rewrites X/Y tokens in it
~~~~
The ID-rewriting of these extra keys is the defect shown in A5.
The report needs a claim statement for each finding, but the only machine-readable artifact has no field for one. So auditors invent keys, and orchestrators fall back to re-reading the raw files.
Suggested fix: review-protocol.md findings.json: add required `title` (one line) and optional `suggested_fix`. Add `Suggested fix:` to the reviewer schema. blind-relabel.mjs: derive `suggested_fix` from the origin blocks (A3). Either reject unknown keys, or list which keys are passed through and which are translated.

## A15 — [TOKENS][FEEDBACK-O15] preflight embeds full Tier 2 stdout; the protocol says to inline it into every seat brief
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
~~~~
$ node -e "...require('./preflight.json')..."   (this run's preflight.json)
file size 66868 bytes
tier2: [ 'cd plugins/reviews/skills/cross-review && node --test', 0, 49646 (stdout bytes), 0 ]
       [ '... node scripts/validate-package.mjs', 0, 75, 0 ]
preflight.mjs:315-318 stdout: result.stdout, stderr: result.stderr  (unbounded)
review-protocol.md:44-46 "include its output in the task packet"
~~~~
Estimate: 49,646 bytes / ~4 bytes per token ≈ 12k tokens for each inclusion. That is ×2 seats in Phase 1, plus any delta brief that re-inlines it, so about 25–50k tokens per run for passing-test lines. Quality effect: none, as long as the full output stays in the file, bound to `snapshotHash`, for any claim that needs to cite it.
Suggested fix: preflight.mjs: add `--inline-tail <N lines>`. Emit `stdoutSha256`, `stdoutBytes`, and the last N lines (plus any line that matches `fail|error|not ok`) inline, and write the full stdout to `<out>.tier2-<i>.log`. review-protocol.md: say to inline the compact form and cite the log path.

## A16 — [TOKENS][FEEDBACK-O1] harness-seat and auditor outputs are hand-backs the orchestrator must re-emit verbatim; make "write your own file" the default
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
~~~~
phase-1-independent-passes.md:99-104 "Both reviewers return their complete structured findings in the final response. The orchestrator persists these verbatim to A-findings.md and B-findings.md ... If a runtime does allow findings-file writes, accept that file only after validating it"
phase-3-scorecard.md:258-259 "Save the auditor's raw returned JSON as <run-dir>/phase3/findings.audit.json"
~~~~
A full-tool harness agent can write files, and this very review is being written that way. Making that the default removes the retyping step that the protocol itself calls "unreviewed code" for findings.json. Estimate: ~30 KB of findings plus ~35 KB of audit JSON ≈ 16k output tokens re-emitted per run, plus Phase 2 rebuttals and redaction rounds. Quality: better, because there is no retyping-error surface. This also covers G2.
Suggested fix: phase-1/phase-2 docs: the harness seat writes `<run-dir>/phase1/A-findings.md` (Phase 2: `phase2/A-rebuttals.md`) and returns only counts, and the orchestrator runs `validate` on the file. For the auditor, keep the "pathless" rule (A9): give it a single write-only output path outside `audit-input/`, for example `<run-dir>/phase3-out/findings.audit.json`.

## A17 — [DOC][FEEDBACK-O14] "resume the Claude agent by its exact ID" gives no mechanism
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
~~~~
phase-2-cross-examination.md:7-15 "Resume the Claude agent by its exact ID ... Never resume seat A by forking ... Resume the exact Phase 1 agent ID only."
phase-1-independent-passes.md:53 "Give the agent a unique name and keep its agent ID for the next phase."
(no mention of SendMessage or any concrete call anywhere in SKILL.md/references)
~~~~
The docs name the forbidden route (fork) but not the allowed one.
Suggested fix: phase-2-cross-examination.md: state the concrete call, for example "SendMessage to the Phase 1 agent ID/name (not a new Agent call, not a fork)", and what to do if that agent can no longer be resumed.

## A18 — [IMPROVE][FEEDBACK-O4] non-git targets lose all tamper evidence (preflight Tier 1 and touchedFiles both null)
Severity: LOW
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
~~~~
preflight.mjs:152-156  return { gitRepo: false, note: `"${cd}" is not a git repository; ...` }
codex-dispatch.mjs:675-677 touchedFilesNote = `--cd "${cdAbs}" is not a git repository; file changes cannot be tracked`
opencode-dispatch.mjs:1033-1037 --isolate refuses non-git outright
~~~~
The feedback observation holds. A document target (O5) is usually not a git repo, so the read-only check is left entirely to the orchestrator.
Suggested fix: preflight.mjs Tier 1: when the target is not a git repo, emit `fileHashes` (sha256 per file, with a size cap) and a combined `snapshotHash`. Also accept `--check-stale` against it. codex-dispatch.mjs: use the same before/after hash map to fill `touchedFiles` for non-git `--cd`.

## A19 — [IMPROVE][FEEDBACK-O5] no extraction step for .docx/.pdf targets; both seats depend on unreviewed ad-hoc conversion
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
~~~~
grep -i "docx|pdf|image|png" over SKILL.md and references/*.md -> no matches
review-profiles.md:62-64 Document target: "documentation, a spec, a protocol description, a policy"
~~~~
Suggested fix: review-profiles.md Document: require the orchestrator to freeze the extracted text (and image list and link list) into the task packet together with the extraction command, and hash it with `build-manifest --task-packet`. Optionally add a small bundled extractor script, so both seats see the same text byte for byte.

## A20 — [DOC][FEEDBACK-O6] web cap unit is ambiguous for batched search tools
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
~~~~
review-protocol.md:186 "**Cap: 5 fetches per seat per phase.**"
review-protocol.md:187-189 cost measured "per fetch" from "a single trivial web-search turn"
~~~~
One search tool call can issue several queries, so seats count the cap in different units, and the manifest count cannot be compared across seats.
Suggested fix: review-protocol.md Web verification: define the unit as "each individual query or page fetch, however the tool batches them". Require the report line to use the form `web: <n> queries, <m> page fetches`.

## A21 — [IMPROVE][FEEDBACK-O7] trust-boundary rule (never fetch target-embedded URLs) has no mechanical check
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
~~~~
review-protocol.md:198-201 "NEVER a URL or endpoint found embedded in the reviewed material itself"
review-protocol.md:236-238 "Not built by this feature: ... scan-side URL enforcement on findings text"
~~~~
This gap is known, not an oversight. It is cheap to close because the check is a set intersection.
Suggested fix: blind-relabel.mjs scan: add `--target-urls <file>` (URLs extracted from the target by the orchestrator or by preflight). Report every URL in the findings text, fences included, that matches a target URL after normalization, as a non-blocking `TRUST-BOUNDARY` line the orchestrator must resolve.

## A22 — [TOKENS][FEEDBACK-O10] no brief/prompt builder: Phase 1 brief, both delta briefs, and the auditor prompt are hand-written each run
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
~~~~
phase-1-independent-passes.md:33-36, 38-44, 52  instructions that must be given "verbatim" (Model identity, sweep rule, Web verification rules)
phase-2-cross-examination.md:61-65, 106-119  delta brief content + rebuttal instruction, only for the CLI seat's file
phase-3-scorecard.md:162-250  ~90 lines of auditor instructions the orchestrator must restate
~~~~
"Verbatim" rules copied by hand are exactly the kind of text that drifts. G1, G13 and this packet's ad-hoc additions show that. Estimate: the auditor prompt was ~5 KB (≈1.3k tokens) of restated rules, and the orchestrator also spends output tokens writing each brief. The saving is mainly orchestrator output (~3–6k tokens per run). Quality: better, since the verbatim blocks are identical every run.
Suggested fix: add `scripts/build-brief.mjs phase1|delta|auditor|verifier --packet <task-packet.md> [--peer <peer-view.md>] --out <path>`. It concatenates fixed template blocks stored in `references/templates/` with the frozen packet. Docs then point to the command instead of restating the rules.

## A23 — [TOKENS][FEEDBACK-O11] the orchestrator must read ~112 KB of docs before dispatch, much of it runtime-conditional
Severity: LOW
Basis: EXECUTED
Evidence strength: SUPPORTED
Evidence:
~~~~
$ wc -l SKILL.md references/*.md | tail -1      -> 1957 total
$ wc -c SKILL.md references/*.md | tail -1      -> 112070 total
$ grep -c -i "opencode|isolate|worktree" ...    -> model-capabilities 32, review-protocol 26, phase-1 24, phase-3 14, configuration 12, SKILL 8, phase-2 7
~~~~
Estimate: 112 KB / 4 ≈ 28k input tokens. Most of the rationale prose in review-protocol.md, including the Blind exchange limitations and the translate refusal list (which is repeated in blind-relabel USAGE and phase-3 lines 205-228), is for maintainers and not orchestration steps. Quality: none, if the moved text stays in the repo and the mechanical checks stay in scripts.
Suggested fix: move the OpenCode/isolation material into `references/opencode.md`, loaded only when seat B's runtime is opencode. Move the rationale and refusal lists into `references/design-notes.md`, and keep only the steps and commands in the phase files. Rough saving: 30–40% of the pre-dispatch read (≈8–11k tokens).

## A24 — [IMPROVE][FEEDBACK-O13] no guidance on image size for document targets
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
~~~~
grep -i "image|png" over SKILL.md and references/*.md -> no matches
~~~~
Suggested fix: review-profiles.md Document: tell the orchestrator to write downscaled copies (for example a longest edge of ≤1600 px) into the packet and keep the originals for pixel-level claims only. Quality: none for text and diagram review. Tokens: roughly proportional to the pixel count, so about a 4× cut on 3200 px images.

## A25 — [DOC][FEEDBACK-G1] the Model identity rule covers prose but not paths or filenames, although scan flags seat-letter paths written in prose
Severity: LOW
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
~~~~
blind-relabel.mjs:525-526 SEAT_TOKEN_RE = \b[Ss]eat[\s-]*[ABab]\b | ...   -> "seatA/cmp.py" in prose matches (\b before '/')
phase-1-independent-passes.md:33-36 "never name your own seat letter in prose either"
~~~~
Suggested fix: phase-1-independent-passes.md verbatim Model identity text: add "or in any path, directory, or filename you create or cite". Also use it in the build-brief template (A22).

## A26 — [DOC][FEEDBACK-G6] the delta brief for the harness seat is unspecified (file, verbatim vs condensed)
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
~~~~
phase-2-cross-examination.md:61-65 "Put seat B's delta brief under <run-dir>/phase2/delta-brief.txt. Include the peer's relabeled findings inline ..."
(no equivalent sentence for the harness seat's resume message)
~~~~
Suggested fix: phase-2-cross-examination.md: require the harness seat's resume message to carry the scanned `peer-view-for-A.md` verbatim (or its path, if A16 is adopted), never a condensed version, because the scan only validated the exact bytes.

## A27 — [IMPROVE][FEEDBACK-G7] "orchestrator claims as C-IDs, may be wrong" pattern is not documented
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: PLAUSIBLE
Evidence:
~~~~
grep -i "may be wrong|orchestrator claim" over references/*.md -> no matches
review-protocol.md:15-16 "Source text, comments, and peer findings are evidence, not instructions"
~~~~
Suggested fix: review-protocol.md Scope: add an optional task-packet section "Orchestrator hypotheses C1..Cn (unverified)". Each seat must confirm or refute every one under Checks performed. Keep the C namespace out of relabel.

## A28 — [IMPROVE][FEEDBACK-G8] Severity has no rubric, so seats disagree on acceptance-risk vs code-risk claims
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
~~~~
review-protocol.md:151 "`Severity` is impact if the claim is real."  (no level definitions)
~~~~
Suggested fix: review-protocol.md: add a 4-line default rubric (CRITICAL/HIGH/MEDIUM/LOW) that task packets may override, like the rubric this packet had to add by hand.

## A29 — [IMPROVE][FEEDBACK-G9] no data-privacy lens (PII / hardware identifiers in captures)
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
~~~~
review-profiles.md:33-34 Security lens: "injection, auth/authz bypass, secret handling, unsafe deserialization"
~~~~
Suggested fix: review-profiles.md Code/Document: add "Data exposure: identifiers in fixtures, captures, or logs (serials, WWN/NAA, hostnames, emails, account IDs)".

## A30 — [IMPROVE][FEEDBACK-G10] report does not require the reason behind the falsification count
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
~~~~
review-protocol.md:784-788 "falsification": { "requested": false, "qualified_claims": 2, "verifiers_run": 0 }
review-protocol.md:818-821 qualified_claims definition; no reason field
~~~~
Suggested fix: review-protocol.md manifest: add `falsification.breakdown: {high_or_critical, disputed, conceded, unaddressed}` computed mechanically (with A8's parser), so "0 qualified" explains itself.

## A31 — [IMPROVE][FEEDBACK-G12] Phase 3 double relabel is four hand-substituted commands with a known naming trap and an expected nonzero exit
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
~~~~
phase-3-scorecard.md:31-35 "MUST read seat_to_audit_label from the manifest FIRST and substitute both the --to values and the --out filenames"
phase-3-scorecard.md:37-42 four relabel commands with <label-A>/<label-B> placeholders
phase-3-scorecard.md:71-76 second pass "exits nonzero ... this is expected, not a failure. Copy tmp-A.md/tmp-B.md ..."
~~~~
An orchestrator has to tell an expected nonzero exit from a real failure by hand. That is the "silently passes bad data" risk this toolkit otherwise removes with scripts.
Suggested fix: add `blind-relabel.mjs audit-prep --phase1-dir <p1> --mapping <flip.json> --out-dir <audit-input> --tokens <...>`. It should read the flip file, run both passes per seat with the names derived from the mapping, handle the zero-rebuttal case internally, run scan with `--forbid-seats A,B` (plus A6's P check), and write only the two final files into `--out-dir` (which also fixes A9).

## A32 — [TOKENS][FEEDBACK-G13] no "targeted reads" hint in the standard brief; redaction rounds re-send whole files
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: PLAUSIBLE
Evidence:
~~~~
grep -i "targeted|whole-file|line range" over references/*.md -> no matches
phase-2-cross-examination.md:53-57 "return the ORIGINAL (un-relabeled) findings file to the reviewer's own context for redaction"
~~~~
Estimate: the G13 run used 4.47M input tokens, mostly cached re-reads of large files. The hint's saving cannot be measured from here (unverified). A redaction round currently costs the full file (~30 KB) twice, while a flagged-lines-only request costs ~1 KB. Quality: none, since the scan re-runs on the full rewritten file either way.
Suggested fix: add "prefer grep and line-range reads over whole-file reads of files >500 lines" to the brief template (A22). For redaction, send only the scan's flagged lines. The seat returns (or, with A16, rewrites in place) just those lines, and the scan re-runs on the whole file.

## A33 — [IMPROVE] Phase 2 appends rebuttals into phase1/*.md in place, so the pure Phase 1 bytes are never preserved or hashed
Severity: LOW
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
~~~~
phase-3-scorecard.md:44-48 "Phase 2 appends each seat's rebuttal onto the PEER'S Phase 1 file ... rather than writing new ones."
SKILL.md:94 "exchange completed findings once, preserving both original passes."
review-protocol.md:792-795 manifest hashes { "phase1": {...}, "phase2": {...} } -- stamped at report time, after the append
~~~~
The "phase1" hash in the manifest covers the Phase 1 content plus the appended rebuttals, not the independent pass itself.
Suggested fix: phase-1-independent-passes.md completion gate: after `validate` passes, copy both files to `phase1/original/` (read-only) and pass those to `build-manifest --phase1`. The appended files stay the input for relabel and translate.

## Checks performed

- Shared-file parity (cross-review vs pair-review), compared with `cmp`: `.gitattributes`, `.github/workflows/test.yml`, `.gitignore`, LICENSE, references/{configuration, model-capabilities, review-profiles, review-protocol}.md, scripts/{blind-relabel, build-manifest, context-builder, env-filter, preflight, provider-catalog, review-config, spawn-utils, validate-package}.mjs, and shared tests/*.test.mjs are all byte-identical. Only README.md and SKILL.md differ, which is expected. No drift.
- Uncommitted diff: only catalog/model-list edits (README, configuration, model-capabilities, provider-catalog, review-config test) in both packages. These match the preflight Tier 1 summary. `git status --short` at the end of the review is unchanged: I made no repository writes.
- Tests: preflight.json Tier 2 records `node --test` exit 0 and `validate-package.mjs` exit 0 (not re-run). The repo-level `scripts/validate-repository.mjs` fails (A12).
- codex-dispatch.mjs: arg parsing, `--search` placed before `exec` on fresh and resume runs, session-identity fail-closed, touchedFiles porcelain -z parsing, and every result.json writer carries `webAccess`. No defect found beyond A10 and A18.
- opencode-dispatch.mjs: the `--isolate` subdirectory/submodule refusal, the fingerprint/marker reuse logic, `stdin: ignore`, and `webAccess: false` on every writer were checked by static read. No defect found.
- review-config.mjs / provider-catalog.mjs: seat layout enforcement, provider/runtime reset on change, and OpenCode provider-prefix check. No defect found. (The catalog labels add version suffixes; I did not verify them, and did not raise them.)
- env-filter.mjs / spawn-utils.mjs: win32 case-insensitive allowlist, cmd.exe unsafe-character refusal, taskkill absolute path. No defect found.
- context-builder.mjs: `--cd . --base HEAD~1` returned a packet (28 changed files). With no `--base` it returned `{packet:null, reason:"no --base given ..."}` with exit 0, as documented.
- preflight.mjs: Tier 1/Tier 2 and `snapshotHash` flow read. Noted but not raised: in a repo with no commits, `computeSnapshotHash` throws, so even Tier 1 exits 1. This is minor.
- FEEDBACK-G4 refuted: phase-1-independent-passes.md:9-11 already requires separate `phase1/`, `phase2/`, `phase3/` directories "so no result.json overwrites an earlier phase's audit". phase-2-cross-examination.md:61 places the delta brief at `phase2/delta-brief.txt`, so result.json lands in `phase2/`. The overwrite only happens if the orchestrator departs from the documented layout. (Only the location of a redaction-round brief is unspecified, which is minor.)
- FEEDBACK-G5 refuted as a skill defect: model-capabilities.md:14-19 already says the Agent tool may not accept effort and tells the orchestrator to "state the limitation and ask the user to choose default effort or another supported runtime. Do not drop the requested effort." The observed behaviour was an orchestrator deviation, not missing guidance.
- FEEDBACK-O1..O15 and G1..G13: all others hold and are raised above. O1 and G2 are one claim (A16). O2 is A8. O3 is A6. O12 is split into A3 (evidence pollution) and A14 (schema).
- Stray `scripts/result.json` (a gitignored artifact dated Sep 12 from a manual run) is cosmetic and not raised.

Web fetches/searches used: 0

## Rebuttals (from B) of A claims

### A1
Claim: A1
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
blind-relabel.mjs:586-590 recursively reads every entry under targetDir and checks each path. No exclusion applies to .git or ignored directories.
```

### A2
Claim: A2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
scanText('The author is affable.', null) returned one identity hit. blind-relabel.mjs:653-662 uses substring matching.
```

### A3
Claim: A3
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
extractClaimBlocks on a complete fenced Evidence block followed by “Suggested fix: parse guard.” returned evidence "one\nSuggested fix: parse guard." The captured evidence includes post-fence advice.
```

### A4
Claim: A4
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
extractClaimBlocks on two adjacent fenced blocks returned "one\n```\n```\ntwo". The closing and opening delimiters entered the evidence.
```

### A5
Claim: A5
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
blind-relabel.mjs:694-715 replaces every X/Y-number token in every string except a key named evidence. It does not check whether the token is a known origin.
```

### A6
Claim: A6
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
scanText('identified in P12', null) returned no hits; relabelText with A-to-X left the text unchanged. The known-ID scan checks A/B heading sets only.
```

### A7
Claim: A7
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
review-protocol.md:322-326 specifies rebuttal fields without an entry-heading level. blind-relabel.mjs:816-860 treats a “## P71” line as a malformed claim heading; runValidate directs reformatting by findings-file owner.
```

### A8
Claim: A8
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-2-cross-examination.md:121-132 requires translated rebuttals to be appended. blind-relabel.mjs has no append-rebuttals subcommand, and relabel leaves fenced text untouched.
```

### A9
Claim: A9
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-3-scorecard.md:12-13 writes the mapping into phase3/; :38-41 writes half-relabeled temporary files there; :128-129 says the auditor reads “this same directory.” review-protocol.md:700-701 calls the auditor pathless. Exposing that directory would break the blind.
```

### A10
Claim: A10
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Both dispatchers’ parseArgs returned timeout=1800 when --timeout was omitted. phase-1-independent-passes.md:68-71 calls omission “no limit.”
```

### A11
Claim: A11
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
SKILL.md’s required choice list omits three IDs present in provider-catalog.mjs and the updated configuration references. Corrected severity: MEDIUM; setup can present an incomplete catalog.
```

### A12
Claim: A12
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
node scripts/validate-repository.mjs exited 1:
CHANGELOG.md's top released header is 1.5.0, but plugin.json's version is 1.4.0
```

### A13
Claim: A13
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
build-manifest.mjs:87-92 assigns each hash to entries[path.basename(p)]. A later path with the same basename overwrites the earlier hash without an error.
```

### A14
Claim: A14
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
The canonical schema in review-protocol.md:543-575 has no title or suggested_fix. blind-relabel.mjs:702-715 retains and ID-rewrites unknown string fields.
```

### A15
Claim: A15
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
The supplied preflight.json is 66,868 bytes. preflight.mjs:315-318 stores stdout and stderr verbatim; review-protocol.md:44-46 instructs the orchestrator to include the output in the task packet.
```

### A16
Claim: A16
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
phase-1-independent-passes.md instructs reviewers to return full findings and the orchestrator to persist them verbatim. phase-3-scorecard.md:258-259 requires saving returned auditor JSON. Direct artifact writing needs an explicit fallback where the reviewer’s filesystem is read-only.
```

### A17
Claim: A17
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-2-cross-examination.md:7-15 requires resuming the exact agent ID and forbids forking, but gives no concrete resume call. This is an orchestration ambiguity, not a dispatcher defect.
```

### A18
Claim: A18
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
preflight.mjs:150-156 returns gitRepo:false with no file inventory. codex-dispatch.mjs:670-677 records touchedFiles as unknown for a non-git target.
```

### A19
Claim: A19
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
review-profiles.md defines a Document lens, but the phase references define no extraction command or frozen text, image-order, and link artifacts for document formats.
```

### A20
Claim: A20
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
review-protocol.md:186-191 caps “fetches” and asks for an actual count. It does not specify how individual searches within a batched request count.
```

### A21
Claim: A21
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
review-protocol.md:199-211 prohibits fetching target-embedded URLs; :236-237 explicitly states that scan-side URL enforcement was not built.
```

### A22
Claim: A22
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
The three phase references require multiple instruction blocks in reviewer and auditor briefs. No bundled script constructs those briefs from the frozen packet.
```

### A23
Claim: A23
Action: CONCEDE
Basis: INFERENCE
Evidence strength: PLAUSIBLE
Evidence:
```text
SKILL.md directs the orchestrator to read configuration, model capabilities, protocol, and phase references. The peer measured 112,070 bytes across those docs. The proposed 30–40% saving is an estimate, not a measured result.
```

### A24
Claim: A24
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
The Document profile has no image-resolution guidance. Downscaling could obscure small labels, so originals must remain available for claims needing pixel-level inspection.
```

### A25
Claim: A25
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-1-independent-passes.md:33-36 forbids seat identity in prose but does not mention created or cited paths. blind-relabel.mjs:525-526 matches seat-letter text in those paths when they appear in a response.
```

### A26
Claim: A26
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-2-cross-examination.md:61-65 specifies an inline, scanned peer view for the CLI seat’s delta brief. No equivalent byte-preservation instruction specifies the other seat’s resume message.
```

### A27
Claim: A27
Action: CONCEDE
Basis: INFERENCE
Evidence strength: PLAUSIBLE
Evidence:
```text
The protocol treats source and peer material as evidence, but does not define optional, explicitly unverified orchestrator hypotheses or a separate namespace for them. This is an optional quality improvement.
```

### A28
Claim: A28
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
review-protocol.md defines Severity as impact if real, then lists four values without thresholds or examples for acceptance-risk claims.
```

### A29
Claim: A29
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
review-profiles.md’s Security lens covers secrets but does not explicitly cover identifying data in captures, fixtures, or logs.
```

### A30
Claim: A30
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
The protocol requires qualified_claims and verifiers_run counts. It does not require a breakdown explaining why qualified_claims is zero.
```

### A31
Claim: A31
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-3-scorecard.md:31-41 requires four hand-substituted relabel commands. Lines 71-76 instruct the orchestrator to interpret one nonzero exit as an expected zero-rebuttal case.
```

### A32
Claim: A32
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: PLAUSIBLE
Evidence:
```text
The standard brief lacks a targeted-read instruction. phase-2-cross-examination.md:53-57 returns the original file for redaction. A flagged-lines-only edit would still need reviewer authorship and full-file validation afterward; its claimed savings are unmeasured here.
```

### A33
Claim: A33
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-3-scorecard.md:44-48 says Phase 2 appends rebuttals directly to Phase 1 findings files. The manifest hashes those paths at report time, after the append, so their hashes do not preserve the original independent-pass bytes.
```
