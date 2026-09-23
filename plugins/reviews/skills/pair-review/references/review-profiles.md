# Review profiles

A profile is a lens on top of the shared protocol, not a replacement for it.
Every claim still needs Severity, Basis, Evidence strength, and Evidence per
[review-protocol.md](review-protocol.md); a profile only changes what both
seats are told to look for in Phase 1.

Under any profile, a confirmed defect pattern is reported at every location it
actually occurs, not only the first instance found — once a seat confirms a
pattern (a lens question above answered "no" with real evidence), it sweeps
the rest of the target for the same pattern and reports each occurrence as
its own claim.

Selecting a profile is orchestrator judgment based on the target, stated once
at dispatch (e.g. in the task packet both seats receive), not asked of the
user unless the target type is genuinely ambiguous. Code is not a superset of
the other two — its Correctness/Security/Regression/Test-coverage lenses do
not ask an Architecture review's failure-domain or reversibility questions, or
a Document review's internal-contradiction question. If the target type is
genuinely ambiguous, infer from the dominant artifact (the file types making
up most of the diff, or the kind of document under review); if still unclear,
apply the shared rubric plus every profile whose lens plausibly applies (see
Choosing and combining below) rather than defaulting to one lens.

## Code

Target: a diff, a file set, or a whole package where behavior can be executed.

Secondary lenses, in addition to the shared rubric:

- **Correctness** — does it do what it claims, on the actual inputs it will see
  (not just the happy path exercised by existing tests).
- **Security** — injection, auth/authz bypass, secret handling, unsafe
  deserialization; anything on the OWASP-adjacent list for this language/stack.
- **Regression** — does this break an existing caller, contract, or test that
  the diff didn't touch.
- **Test coverage** — is the new behavior actually exercised, or only the
  branch the author was thinking about.
- **Data exposure** — identifiers that must not ship in fixtures, captures,
  logs, or test data: serial numbers, WWN/NAA/EUI IDs, hostnames, IP and MAC
  addresses, email addresses, tenant/account/subscription IDs, customer names.
  Check hardest where the target claims a capture is anonymized.

## Architecture

Target: a design doc, an RFC, a module boundary, or a cross-cutting change
with no single diff to execute against.

Secondary lenses:

- **Assumptions** — what does this design require to be true that isn't
  stated outright (ordering guarantees, single-writer, network reliability).
- **Failure domains** — what happens to the rest of the system when this one
  component is slow, down, or returns garbage.
- **Scaling boundary** — the point (data volume, request rate, team size)
  where this design's core assumption stops holding.
- **Reversibility** — how expensive is it to undo this decision once other
  things depend on it.

Basis is usually `STATIC_TRACE`, `SOURCE_CITATION`, or `INFERENCE` here, not
`EXECUTED` — there is nothing to run. Say so plainly in the claim rather than
treating an all-non-executed review as a gap; a design review with zero
`EXECUTED` claims is complete, not deficient.

## Document

Target: documentation, a spec, a protocol description, a policy — text whose
correctness is internal consistency and completeness, not runtime behavior.

Secondary lenses:

- **Internal contradictions** — two sections that can't both be true, e.g. a
  protocol doc's own header version disagreeing with its package manifest, or
  a rule stated one way in one section and the opposite way in another.
- **Missing requirements** — a rule referenced elsewhere in the doc, or implied
  by a worked example, that is never actually stated as a rule.
- **Staleness** — a claim (a version string, a test count, a file path) that
  was true when written and is checkable against current state.
- **Ambiguity for the actual reader** — a step an implementer would need to
  guess at, not because it's wrong, but because it's underspecified.
- **Data exposure** — the same identifiers as the Code profile's lens, in
  screenshots, examples, and quoted output.

For a binary document (`.docx`, `.pdf`, `.pptx`), both seats must read the same
extraction, so the orchestrator freezes it before dispatch:

1. Extract the text in reading order to a Markdown file, with a marker such as
   `[IMAGE 3: images/image3.png]` where each figure sits, the images themselves,
   and a list of the document's hyperlinks. Keep the original file next to them.
2. Put downscaled copies of large images in the packet (longest edge about
   1600 px); keep the originals only for claims that need pixel detail. A
   3200 px screenshot costs each seat far more tokens and adds nothing a reader
   can check at normal size.
3. Record the extraction command and tool version in the task packet, and hash
   the extracted files with the task packet (`build-manifest.mjs --task-packet`
   plus the Phase 1 pre-flight inventory of the target folder), so a later
   reader can tell which bytes the seats reviewed.
4. Give the hyperlink list to `scan --target-urls` (see review-protocol.md's Web
   verification).

## Choosing and combining

A target can span more than one profile (a PR that changes both an
implementation and its protocol doc). In that case, tell each seat to apply
Code lenses to the code files and Document lenses to the doc files in the same
pass, rather than running two full separate reviews — the claim IDs and
phases stay single either way.
