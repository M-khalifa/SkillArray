# Structured internal artifacts — design (not yet implemented)

Status: design only. No code in this document has been built. Do not build
it without a separate, explicit approval — this is Phase D of the
production-readiness pass, kept design-only per that pass's own scope split.

## Problem

Phase 1 (independent findings) and Phase 2 (rebuttals) are currently
authored by reviewer models as Markdown, using a claim-heading convention
(`## A3`, `## P1`) that `blind-relabel.mjs` parses with a hand-written
CommonMark-subset parser (fence detection, inline code-span matching,
backslash-escape handling). Every blinding bypass fixed in 1.3.0 was a bug in
that parser, not in the protocol's actual rules. `findings.json` (the final
Phase 3 output) is already structured JSON, produced by `translate` — this
document proposes extending that same principle one stage earlier, so
Markdown parsing edge cases stop being an identity-blinding attack surface.

## Principle

Models decide semantic judgments (severity, evidence, verdicts, rebuttal
text). Deterministic code owns structure, identity translation, provenance
tracking, hashing, validation, and serialization. Markdown becomes a
rendered human view of a JSON artifact, not the source of truth for it.

## Proposed schemas

### Phase 1 finding

```json
{
  "id": "A3",
  "title": "Off-by-one in pagination cursor",
  "severity": "HIGH",
  "basis": "EXECUTED",
  "evidence_strength": "REPRODUCED",
  "evidence": [
    "ran `curl .../items?cursor=10&limit=5`, got items 11-15 twice across two requests"
  ]
}
```

`severity`, `basis`, `evidence_strength` reuse the exact enums already
defined in `review-protocol.md`'s Phase 1 schema and already validated by
`assertEnum` in `blind-relabel.mjs` — no new vocabulary.

### Phase 2 rebuttal

```json
{
  "claim": "P3",
  "action": "DISPUTE",
  "counter_fact": "cursor is base64(offset), not base64(id); offset=10 is correct for limit=5 on page 3",
  "basis": "EXECUTED",
  "evidence": [
    "decoded the cursor value from the reported request, confirms offset semantics"
  ]
}
```

`claim` uses the peer's anonymous `P<n>` label from Phase 2's blind exchange,
exactly as today. `action` reuses the existing
`CONCEDE`/`DISPUTE`/`ACKNOWLEDGE` enum from review-protocol.md's Interaction
modes.

## What stays Markdown

The final human-readable report (`joint-findings.md` / scorecard) stays
Markdown — it is a rendered view for a person, not a protocol artifact
another script parses. Task packets, the protocol document itself, and
verifier verdict blocks' free-text `Basis:`/`Evidence:` narrative content are
out of scope for this migration; only the claim/rebuttal *structural*
envelope moves to JSON.

## Migration strategy

1. **Additive, not a hard cutover.** Reviewers gain the option to emit a
   `findings.json`-shaped array directly (validated against the schema
   above) alongside or instead of Markdown claim headings. `blind-relabel.mjs
   relabel`/`scan` gain a JSON code path: parse the array, relabel
   `id`/`claim` fields directly (a field rename, not a regex substitution;
   this is where most of the bug class below disappears), and scan every
   string value for identity tokens the same way `scanText` does today.
2. **Human view generation.** A small renderer turns the JSON array into the
   same Markdown claim-heading format reviewers see today, so the diff a
   human reads in `A-findings.md` does not change shape. This also lets
   Phase 2/3 continue showing reviewers a Markdown brief even once the
   underlying artifact is JSON.
3. **Dual-run validation period.** For at least one full minor version, run
   both the legacy Markdown parser and the new JSON path against the same
   real review runs (where reviewers emit both) and diff the resulting
   `findings.json` to catch behavioral drift before removing the Markdown
   path.
4. **Cutover.** Once dual-run shows no drift across a representative set of
   real runs, make JSON the only supported Phase 1/2 artifact format and
   remove the Markdown claim-parsing code path.

## Backwards compatibility

- `findings.json`'s own schema (the Phase 3 output) does not change — this
  migration only affects what Phase 1/2 *produce*, not what Phase 3 emits.
- A saved run directory from before the migration remains readable: the
  Markdown parser is not deleted until step 4, and even after cutover,
  `translate --phase1-dir` could be pointed at an old Markdown-format
  directory under a `--legacy-markdown` flag for one further minor version,
  if replaying an old run is ever needed.
- No change to `manifest.json`'s schema, the coin-flip mechanism, or the
  Falsification pass's verifier-file format (`verification-<id>.md` stays
  Markdown — it is small, fixed-schema, free-text-evidence content, not a
  claims array; converting it buys little and the file is already
  cross-checked field-by-field by `parseVerificationFile`).

## Which current parser functions this affects

From `blind-relabel.mjs` (line numbers as of 1.3.0's final state):

| Function | Fate under JSON Phase 1/2 |
|---|---|
| `parseFenceLines` (line 281) | Retired for the JSON path; still needed for verifier-file Markdown and for legacy-format replay during the dual-run/compat window. |
| `splitLineSpans` (320) | Retired for the JSON path (no inline code spans to split in a JSON string). Still needed for verifier files and legacy replay. |
| `splitProseAndCode` (352) | Same as above. |
| `relabelText` (362) | Rewritten for JSON: becomes a JSON-tree walk substituting `id`/`claim` field values, plus a recursive string-value pass for any embedded identity tokens in `evidence`/`title`/`counter_fact` text. Markedly simpler than the current regex-based line relabeling. |
| `extractClaimHeadings` (604) | Retired for the JSON path — claim IDs are just `.map(f => f.id)`, no heading regex or fence-awareness needed at all. This eliminates the entire bug class the "no fence-awareness" and "code-span-stripped reconstruction" 1.3.0 fixes were patching. |
| `countRelabelTargets` (1091) | Same fate as `extractClaimHeadings` — becomes a straightforward field count. |
| `scanText` (485) | Adapted, not retired: still walks every string value for identity tokens, but no longer needs fence/code-span awareness to know what to skip, since there is no prose/code distinction inside a JSON string value — every string value is scanned in full. |
| `parseVerificationFile` (689) | Unaffected — verifier files stay Markdown (see Backwards compatibility above). |
| `translateFindings` (820) | Unaffected in its core logic (provenance rules, contradiction checks, `auditor_check` handling are semantic, not parsing) — only its Phase 1/2 input-reading step changes from Markdown-heading extraction to JSON-array validation. |

## Bug classes this eliminates

Every 1.3.0 blinding-bypass fix was a variant of "the Markdown parser's model
of what counts as prose vs. code vs. a heading didn't match CommonMark's
actual grammar, or didn't match what a hand-written regex assumed." A JSON
artifact has no fence/code-span/backslash-escape ambiguity to get wrong:

- The fence-indentation bypass (unbounded leading whitespace treated as a
  real fence) — structurally impossible; there is no fence concept in JSON.
- The escaped-backtick bypass (backslash-escape-unaware code-span matching)
  — structurally impossible; no backtick delimiters to misparse.
- `extractClaimHeadings` having no fence-awareness (a `## A99` inside a
  fenced Evidence excerpt fabricating a claim) — structurally impossible; a
  claim ID is a field, not a heading pattern matched against arbitrary text.
- The code-span-stripped-reconstruction bypass (heading/schema-shaped text
  reachable only after stripping a code span) — structurally impossible for
  the same reason.
- The known, currently-undocumented-fixed limitation that multiline code
  spans are fail-safe but can still mutate legitimately-multiline
  evidence/source snippets — eliminated, since a JSON string value has no
  internal Markdown structure to misparse in the first place.

## Test plan

- Every existing `blind-relabel.test.mjs` test targeting a retired function
  (`extractClaimHeadings`, `countRelabelTargets`, the fence/code-span tests
  under `relabelText`/`scanText`) is either deleted (if the underlying bug
  class is structurally impossible under JSON) or rewritten as a JSON-schema
  validation test (a malformed claim ID, an unknown severity value, a
  missing evidence array — the JSON equivalent of a parse failure).
- New tests: JSON schema validation (reject malformed/incomplete finding
  objects), field-level relabeling correctness (an `id` substitution doesn't
  accidentally touch a same-valued string elsewhere in the object graph),
  identity-token scanning across every string value including nested
  `evidence` arrays.
- Dual-run drift tests: given a fixed set of real Phase 1/2 outputs in both
  formats, `translate`'s resulting `findings.json` must be byte-identical
  regardless of which Phase 1/2 format produced it.
- Regression coverage for the compat flag: `--legacy-markdown` on `translate`
  must still produce correct output against an old-format run directory,
  with its own dedicated fixture.

## What this document is not

This is not an approval to implement. The migration touches the parser
surface backing every regression test added across the 1.3.0 hardening
rounds; per the production-readiness pass's Phase A (protocol freeze) and
this repository's standing "verify before design, confirm before implement"
rule, implementation requires a separate, explicit go-ahead after this
design is reviewed.
