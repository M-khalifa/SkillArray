# Review profiles

A profile is a lens on top of the shared protocol, not a replacement for it.
Every claim still needs Severity, Basis, Evidence strength, and Evidence per
[review-protocol.md](review-protocol.md); a profile only changes what both
seats are told to look for in Phase 1.

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

## Choosing and combining

A target can span more than one profile (a PR that changes both an
implementation and its protocol doc). In that case, tell each seat to apply
Code lenses to the code files and Document lenses to the doc files in the same
pass, rather than running two full separate reviews — the claim IDs and
phases stay single either way.
