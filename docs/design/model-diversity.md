# Model and reviewer-lens diversity — design (not yet implemented)

Status: design only. No code in this document has been built. Do not build
it without a separate, explicit approval — this is Phase K of the
production-readiness pass, kept design-only per that pass's own scope split.

## Terminology collision found during verification

The production-readiness prompt that motivated this document proposed a
"shared mandatory rubric (correctness, requirements, regression, security,
evidence)" plus "optional complementary secondary lenses." Checking against
the actual protocol surfaces two problems with reusing that language
directly:

1. `review-protocol.md`'s actual shared Phase 1 schema fields are `Severity`,
   `Basis`, `Evidence strength`, `Evidence` — not
   correctness/requirements/regression/security as named rubric items. Those
   four words (minus "requirements") already exist, but as
   `review-profiles.md`'s **Code** profile's own named "secondary lenses"
   (Correctness, Security, Regression, Test coverage), not as a
   protocol-wide mandatory rubric.
2. `review-profiles.md` already uses the word "lens" for exactly this
   concept — a profile's own secondary rubric ("A profile is a lens on top
   of the shared protocol... Secondary lenses, in addition to the shared
   rubric"). Introducing a second, differently-scoped "lens" concept under
   the same name would collide with existing terminology and confuse which
   one a reviewer is being asked to apply.

This document therefore does not propose a new mandatory rubric — the
existing `Severity`/`Basis`/`Evidence strength`/`Evidence` schema already is
the shared mandatory rubric, and changing it is out of scope (Phase A froze
the protocol). What follows re-scopes the prompt's actual goal — testing
whether provider diversity produces useful complementary coverage — onto
existing machinery, using a different name than "lens" to avoid the
collision above.

## What "profile" already covers, and what it doesn't

A profile (`review-profiles.md`: Code, Architecture, Document) answers "what
KIND of target is this," and is chosen once per run based on the target
type — not randomized, not something both reviewers could sensibly differ
on for the same target. It does not vary independently of which provider
fills which seat; it varies with what's being reviewed.

What the prompt is actually asking for is a second, independent axis: "what
ANGLE does a given reviewer take on this target, regardless of what kind of
target it is." Call this a **rotation**, not a lens, to avoid the naming
collision above.

## The core risk this addresses

If seat A is always told "focus on control flow and state" and seat B is
always told "focus on API boundaries and failure modes," and seat A is
always Claude while seat B is always Codex, then any observed difference in
findings between the two seats is confounded: it could come from the model,
from the assigned rotation, or both, with no way to separate them after the
fact. A benchmark run comparing "Claude found more X-class issues" is
meaningless under a permanent Claude=rotation-1/Codex=rotation-2 assignment.

## Proposed design

**Shared rubric**: unchanged from today — every claim still carries
`Severity`/`Basis`/`Evidence strength`/`Evidence` per review-protocol.md.
Nothing new here; this is not a protocol change.

**Rotation candidates** (illustrative, not exhaustive — the specific set is
a decision for whoever runs the actual experiment, informed by what a
seeded-defect benchmark corpus can actually distinguish):

- Rotation A: control flow, state transitions, data integrity, test coverage.
- Rotation B: API boundaries, failure modes, operational risk, stated
  assumptions.

A rotation is an *additional* instruction layered on top of the profile's
own secondary lenses for that run, given to a reviewer alongside its normal
task packet — it does not replace the profile, and it does not change the
finding schema.

**Independence rule**: rotation assignment MUST be randomized or rotated
independently of which provider fills seat A vs. seat B, specifically so
that across a benchmark's runs, "provider" and "rotation" are separable
variables. Concretely: never let a fixed rule like "seat A always gets
Rotation A" hold across every run of a benchmark — vary which seat/provider
gets which rotation from run to run, and record both independently in the
run's manifest/results so post-hoc analysis can regress on either variable
separately.

**Scoring**: how rotation vs. provider effects actually get measured is the
benchmark harness's job — see `docs/design/benchmark-harness.md` for the
scoring design this hands off to. This document only specifies what to
randomize and why; it does not specify the statistics.

## Why this does not violate the frozen protocol

Phase A of the production-readiness pass forbids adding a Phase 4, another
mandatory reviewer, voting councils, recursive debate, extra model rounds,
or generic confidence scores to the protocol without written justification
and regression coverage. A rotation is none of those: it is an optional,
additional instruction a reviewer already receives as part of its existing
Phase 1 task packet, exactly the way a profile's secondary lenses are
already delivered today. It adds no new phase, no new mandatory agent, and
no change to the findings schema, the blind-exchange mechanism, or the
adjudication rules. It is scoped identically to how `review-profiles.md`
already varies Phase 1 instructions per target type — this varies them per
reviewer-rotation-slot instead, using the same delivery mechanism.

## What this document is not

This is not an approval to implement, and it is not a claim that rotation
diversity produces better reviews — that claim requires the benchmark data
this document explicitly defers to `docs/design/benchmark-harness.md`. Per
this repository's standing "verify before design, confirm before implement"
rule, building the rotation mechanism (even though it doesn't touch the
frozen protocol) still needs explicit user confirmation before
implementation, since it changes what instructions reviewers receive.
