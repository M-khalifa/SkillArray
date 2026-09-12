---
name: shared-brain
argument-hint: "[search|capture|migrate]"
description: >-
  Read from or write to a shared, cross-project engineering knowledge store,
  via three modes — search existing knowledge before starting work, capture
  every durable lesson the current session produced, or migrate a filtered,
  policy-driven publish from a local memory directory. The generic,
  domain-agnostic engine behind open-brain — open-brain is the VSI/Cerebro
  example (see profiles/vsi-engineering.yml), this skill works for any
  project once you write a project profile. Use ONLY when the user
  explicitly asks — "/shared-brain", "search the brain", "what does the
  brain know about X", "capture this", "migrate my memory". Never trigger on
  plain "remember this" (that is local memory, a different store).
license: MIT
metadata:
  version: 1.0.0
---

# Shared Brain

A shared, cross-project store, the same backend contract as `open-brain`
(MCP `search_thoughts` / `capture_thought` / `list_thoughts` /
`thought_stats`). This file generalizes open-brain's rules to any project by
moving the one genuinely project-specific piece — the publish allowlist —
into a swappable **profile** (`profiles/*.yml`) instead of hardcoding it.

**Naming note, stated honestly rather than assumed:** "Open Brain" is not a
name this project invented in a vacuum, and other MCP services with
similarly-named tools (`search_thoughts`, `capture_thought`, etc.) may exist
in the wider ecosystem. This skill has not been verified against any such
project's semantics — if you are pointing it at a backend you did not build
yourself, read that backend's own docs for its actual delete/upsert/edit
behavior before trusting anything below that assumes append-only. Don't
assume this skill's assumptions (particularly "there is no edit and no
delete") hold for a backend you didn't write.

There is no edit and no delete **in the backend this skill was designed
against**. If your backend supports upsert or fingerprint-based
deduplication instead, the "supersession" pattern below still works but the
dedup mechanics in `references/memory-sync.md` may be doing work your
backend already does — check before assuming you need both.

## What's different from open-brain

The substantive rule changed is Rule 6: its allowlist is now a config file
(a profile, see below), not a hardcoded VSI list. Rule semantics elsewhere —
the three modes, the approval gate, the verification gate, the format
convention, the dedup protocol, the worked examples — are preserved.

**What's not preserved: the supporting evidence behind several rules.**
Generalizing away VSI-specific nouns necessarily removed VSI-specific
citations (a named file, a named vendor bug), but the rewrite also dropped
some domain-neutral measurements that had nothing to do with VSI and cost
nothing to keep — for example, the concrete scale a memory-directory scan
can reach (a real run found 243 files across 10 directories, 51 mechanically
blocked, 192 still needing human judgment) and the semantic-search miss
threshold (0.45) are both restored below and in `references/memory-sync.md`,
since neither one named anything product-specific. Where a citation *did*
name an internal artifact (a function name, a specific vendor's bug), only
the artifact was generalized or removed — the fact that an audit like that
is worth running, and the kind of yield it found, is kept as a general
statement rather than deleted outright. Read
[references/memory-sync.md](references/memory-sync.md) in full before
running `migrate` mode — it carries the same rules as open-brain's, with
Rule 6 rewritten to load from a profile and its supporting evidence
de-specified rather than uniformly stripped.

## Choosing a profile

Before running `migrate` mode (and ideally before `capture` mode too, since
the same "what earns a capture" judgment applies), resolve which profile
governs this project:

1. If a project-level config already names one (see the setup skill, if
   installed, or a `.shared-brain-profile` marker file in the project root),
   use it.
2. Otherwise ask the user which profile applies, showing
   `profiles/default.yml`'s allowlist as the fallback and
   `profiles/vsi-engineering.yml` as a worked example of what a project
   profile looks like.
3. Never silently fall back to `default.yml` for a project that clearly has
   its own domain (a VSI/Cerebro codebase, for instance) — ask once, then
   remember the answer for the session.

A profile is a YAML file with `allowlist`, `blocklist`, and `tiebreaker`
keys, matching the shape of `profiles/default.yml`. Writing a new one for a
new project is copying `default.yml` and replacing the allowlist entries
with that project's actual domain nouns — it is not a code change.

**Validate a new or edited profile before trusting it**, with
`python scripts/scan_memory.py --check-profile <path>`. This checks the
shape only — non-empty `allowlist`/`blocklist` lists of strings, a non-empty
`tiebreaker` string — not whether the content is good policy. Nothing else
in this skill enforces that shape automatically; a malformed profile that
skips this check loads without error and only surfaces its problem when an
agent tries to apply a missing tiebreaker mid-run.

## Three modes — pick one before doing anything else

| Mode | Aliases the user might say | Direction |
|---|---|---|
| **search** | search, find, lookup, "what does the brain know about…" | read |
| **capture** | capture, write, save, update, add, "remember this in the brain" | write, this session's lessons |
| **migrate** | migrate, init, dump, sync, bulk, "publish my memory" | write, bulk, one-time |

`write` and `init` are accepted as aliases for `capture` and `migrate`
respectively, for continuity with open-brain's original naming.

**If invoked bare with no mode and no other clue, do not guess.** Show the
three options and ask which, exactly as open-brain does.

**search is the cheap one** — read-only, no approval gate needed. The two
write modes carry the full apparatus below.

### Mode: search

Identical to open-brain's search mode. Get keywords (from the user or
derived from the session), query 2-3 angles (subject and symptom), and
report honestly: a prose miss is not proof the store has nothing on the
topic, an error is not a miss, and both must be distinguished from real
hits. Flag staleness before the user acts on any retrieved thought.

### Mode: capture

Identical to open-brain's write mode. Sweep the whole session for every
durable lesson, not just one; test each against "what earns a capture"
(below); propose all that survive; decline is normal and frequent.

### Mode: migrate

Identical to open-brain's init mode, with one addition: **resolve the
profile first** (see above), then apply every rule in
`references/memory-sync.md`, substituting the resolved profile's allowlist
for Rule 6. Same three hard limits: one project per run, ten proposals
maximum, triage before drafting.

## The one rule that overrides convenience

Same as open-brain: never call the capture tool before showing the user the
exact final text and getting an explicit yes. Approval binds to bytes, not
intent — if anything changes after approval, re-show and re-ask.

**Scope note on automatic capture pipelines.** If this project has an
automatic capture pipeline analogous to open-brain's Cerebro integration
(something that publishes on its own trigger, without going through this
skill), that path is out of scope for this gate by design — do not route it
through this skill, and do not advise disabling it unless the user says it's
a bug. If no such pipeline exists in this project, this note doesn't apply;
don't invent one to justify skipping the gate.

## What earns a capture

Unchanged from open-brain, restated without VSI-specific examples:

- **Traps that read as correct** — code or config that looks right and
  isn't, where the "looks right" part is exactly what would fool a
  competent engineer on a first attempt.
- **Conventions with a reason** — a rule plus why it exists, so the reader
  can tell when it stops applying.
- **Cross-cutting edits** — "changing X also requires Y in a different
  file." The single highest-value shape.
- **Hard-won API facts** — undocumented behavior, a field that lies, an
  endpoint that returns success with an error body. Name the system in
  line 1 or it will never retrieve.
- **Measured numbers with unit and origin.**
- **Killed hypotheses** — "X looks like the cause and is not, because Y."

## What does not earn a capture

- Ticket outcomes, attempt counts, status. Machine bookkeeping.
- Anything grep answers in one command.
- One-off fixes that generalize to nothing.
- Anything not verified this session.
- Secrets, credentials, tokens, hostnames, IPs, customer names.
- Personal preferences or instructions about how to treat this user — see
  open-brain's "Preferences never publish" section, unchanged here: a
  preference published to a shared store can be retrieved and applied as
  though it were a team convention, which is worse than useless.

## Everything else

`references/memory-sync.md` carries the full migrate-mode mechanics
(filter rules 0-7, transform, dedup, approval gate, the helper script), the
shared format convention (line 1 / body / evidence / provenance), the
`verified:` field definitions, and the worked examples — all unchanged from
open-brain except Rule 6, which now reads "apply the resolved profile's
allowlist" instead of naming VSI directly. Read it in full before running
`migrate` mode; do not summarize it from this file alone.
