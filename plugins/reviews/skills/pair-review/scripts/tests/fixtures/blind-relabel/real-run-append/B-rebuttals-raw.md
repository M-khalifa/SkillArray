### P1
Claim: P1
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
blind-relabel.mjs:586-590 recursively reads every entry under targetDir and checks each path. No exclusion applies to .git or ignored directories.
```

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
scanText('The author is affable.', null) returned one identity hit. blind-relabel.mjs:653-662 uses substring matching.
```

### P3
Claim: P3
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
extractClaimBlocks on a complete fenced Evidence block followed by “Suggested fix: parse guard.” returned evidence "one\nSuggested fix: parse guard." The captured evidence includes post-fence advice.
```

### P4
Claim: P4
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
extractClaimBlocks on two adjacent fenced blocks returned "one\n```\n```\ntwo". The closing and opening delimiters entered the evidence.
```

### P5
Claim: P5
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
blind-relabel.mjs:694-715 replaces every X/Y-number token in every string except a key named evidence. It does not check whether the token is a known origin.
```

### P6
Claim: P6
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
scanText('identified in P12', null) returned no hits; relabelText with A-to-X left the text unchanged. The known-ID scan checks A/B heading sets only.
```

### P7
Claim: P7
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
review-protocol.md:322-326 specifies rebuttal fields without an entry-heading level. blind-relabel.mjs:816-860 treats a “## P71” line as a malformed claim heading; runValidate directs reformatting by findings-file owner.
```

### P8
Claim: P8
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-2-cross-examination.md:121-132 requires translated rebuttals to be appended. blind-relabel.mjs has no append-rebuttals subcommand, and relabel leaves fenced text untouched.
```

### P9
Claim: P9
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-3-scorecard.md:12-13 writes the mapping into phase3/; :38-41 writes half-relabeled temporary files there; :128-129 says the auditor reads “this same directory.” review-protocol.md:700-701 calls the auditor pathless. Exposing that directory would break the blind.
```

### P10
Claim: P10
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Both dispatchers’ parseArgs returned timeout=1800 when --timeout was omitted. phase-1-independent-passes.md:68-71 calls omission “no limit.”
```

### P11
Claim: P11
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
SKILL.md’s required choice list omits three IDs present in provider-catalog.mjs and the updated configuration references. Corrected severity: MEDIUM; setup can present an incomplete catalog.
```

### P12
Claim: P12
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
node scripts/validate-repository.mjs exited 1:
CHANGELOG.md's top released header is 1.5.0, but plugin.json's version is 1.4.0
```

### P13
Claim: P13
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
build-manifest.mjs:87-92 assigns each hash to entries[path.basename(p)]. A later path with the same basename overwrites the earlier hash without an error.
```

### P14
Claim: P14
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
The canonical schema in review-protocol.md:543-575 has no title or suggested_fix. blind-relabel.mjs:702-715 retains and ID-rewrites unknown string fields.
```

### P15
Claim: P15
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
The supplied preflight.json is 66,868 bytes. preflight.mjs:315-318 stores stdout and stderr verbatim; review-protocol.md:44-46 instructs the orchestrator to include the output in the task packet.
```

### P16
Claim: P16
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
phase-1-independent-passes.md instructs reviewers to return full findings and the orchestrator to persist them verbatim. phase-3-scorecard.md:258-259 requires saving returned auditor JSON. Direct artifact writing needs an explicit fallback where the reviewer’s filesystem is read-only.
```

### P17
Claim: P17
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-2-cross-examination.md:7-15 requires resuming the exact agent ID and forbids forking, but gives no concrete resume call. This is an orchestration ambiguity, not a dispatcher defect.
```

### P18
Claim: P18
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
preflight.mjs:150-156 returns gitRepo:false with no file inventory. codex-dispatch.mjs:670-677 records touchedFiles as unknown for a non-git target.
```

### P19
Claim: P19
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
review-profiles.md defines a Document lens, but the phase references define no extraction command or frozen text, image-order, and link artifacts for document formats.
```

### P20
Claim: P20
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
review-protocol.md:186-191 caps “fetches” and asks for an actual count. It does not specify how individual searches within a batched request count.
```

### P21
Claim: P21
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
review-protocol.md:199-211 prohibits fetching target-embedded URLs; :236-237 explicitly states that scan-side URL enforcement was not built.
```

### P22
Claim: P22
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
The three phase references require multiple instruction blocks in reviewer and auditor briefs. No bundled script constructs those briefs from the frozen packet.
```

### P23
Claim: P23
Action: CONCEDE
Basis: INFERENCE
Evidence strength: PLAUSIBLE
Evidence:
```text
SKILL.md directs the orchestrator to read configuration, model capabilities, protocol, and phase references. The peer measured 112,070 bytes across those docs. The proposed 30–40% saving is an estimate, not a measured result.
```

### P24
Claim: P24
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
```text
The Document profile has no image-resolution guidance. Downscaling could obscure small labels, so originals must remain available for claims needing pixel-level inspection.
```

### P25
Claim: P25
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-1-independent-passes.md:33-36 forbids seat identity in prose but does not mention created or cited paths. blind-relabel.mjs:525-526 matches seat-letter text in those paths when they appear in a response.
```

### P26
Claim: P26
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-2-cross-examination.md:61-65 specifies an inline, scanned peer view for the CLI seat’s delta brief. No equivalent byte-preservation instruction specifies the other seat’s resume message.
```

### P27
Claim: P27
Action: CONCEDE
Basis: INFERENCE
Evidence strength: PLAUSIBLE
Evidence:
```text
The protocol treats source and peer material as evidence, but does not define optional, explicitly unverified orchestrator hypotheses or a separate namespace for them. This is an optional quality improvement.
```

### P28
Claim: P28
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
review-protocol.md defines Severity as impact if real, then lists four values without thresholds or examples for acceptance-risk claims.
```

### P29
Claim: P29
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
review-profiles.md’s Security lens covers secrets but does not explicitly cover identifying data in captures, fixtures, or logs.
```

### P30
Claim: P30
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
The protocol requires qualified_claims and verifiers_run counts. It does not require a breakdown explaining why qualified_claims is zero.
```

### P31
Claim: P31
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-3-scorecard.md:31-41 requires four hand-substituted relabel commands. Lines 71-76 instruct the orchestrator to interpret one nonzero exit as an expected zero-rebuttal case.
```

### P32
Claim: P32
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: PLAUSIBLE
Evidence:
```text
The standard brief lacks a targeted-read instruction. phase-2-cross-examination.md:53-57 returns the original file for redaction. A flagged-lines-only edit would still need reviewer authorship and full-file validation afterward; its claimed savings are unmeasured here.
```

### P33
Claim: P33
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
phase-3-scorecard.md:44-48 says Phase 2 appends rebuttals directly to Phase 1 findings files. The manifest hashes those paths at report time, after the append, so their hashes do not preserve the original independent-pass bytes.
```
