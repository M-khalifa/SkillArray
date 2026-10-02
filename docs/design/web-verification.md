# Web verification — design and implementation record

Status: implemented (this release). This document records the design
decisions and the empirical findings that drove them, for future reference
when this mechanism needs to change.

## Problem

A user comparison surfaced that pasting an article directly into ChatGPT
caught real bugs that this project's own review skills (Claude, Codex,
Fable seats) missed. Investigation (via a peer session with first-hand
knowledge of that comparison) established this was NOT a model-capability
gap: the comparison was entirely out-of-band (the user pasted content into
chatgpt.com directly, never through this project's protocol), and the two
real mechanisms were (a) ChatGPT had live web-fetch access this project's
reviewers do not, and (b) six iterative re-reads caught editing-introduced
bugs, which this protocol's own Phase 2 exchange already provides for. Only
(a) was an actual, addressable gap — hence this feature. ChatGPT also
produced roughly one-third wrong findings from having zero access to actual
source code to arbitrate claims against, which is why this design does not
treat web-fetched content as an independent verdict — see Arbitration below.

## Rejected approaches, and why

**Document-profile-only gate.** The initial design gated web verification to
`review-profiles.md`'s Document profile, reasoning that code/architecture
reviews are repo-scoped by nature. The user correctly rejected this: "some
endpoints confirmation in code might need it... we should allow the agents
to do this when it is required." A Code review claim like "this SDK method
was deprecated in the vendor's 2025 release" or "this error string doesn't
match the library's current API" is exactly as web-checkable as a Document
claim, and profile is the wrong axis to gate on.

**Opt-in task-text phrase.** The next design gated it behind a canonical
phrase, matching the existing Falsification pass's opt-in mechanism. This
was also rejected: an opt-in phrase means the user must remember to ask for
web verification, which is the exact failure mode that let ChatGPT "win" in
the first place — nobody thought to ask this project's reviewers to check
the web, because there was no reason to expect they could.

**Final design: gate on the claim, default-on.** Web verification is
default-ON for both seats. The actual gate is whether a specific claim is
externally verifiable AND the target/repo cannot settle it on its own —
this is a judgment call stated in the reviewer's brief, not a mechanical
flag. An opt-out phrase ("repo-only review") disables it entirely for a run
when the user wants pure repo-scoped review.

## Verified provider capability (empirical, not assumed)

Per this project's standing rule against inventing CLI flags or API
surfaces, every claim below was tested directly before being designed
around:

- **`codex exec --search` is rejected**: `error: unexpected argument
  '--search' found`. `--search` is documented on top-level `codex --help`,
  not `codex exec --help`.
- **`codex --search exec ...` works**: tested live with a real prompt asking
  the model to fetch `https://example.com`'s title. Verified via the actual
  event trace (not just the model's claimed answer) — genuine `web search:`
  tool-call lines appeared, and the returned content ("Example Domain") is
  independently checkable as correct. `--search` is a global codex flag and
  must precede `exec` in argv; codex's own `features list` was also checked
  and confirms no `-c features.*=true` override reaches this from within
  `exec` — the global-flag-before-subcommand ordering is the only path.
- **`codex --search exec resume <id> ...` also works**: tested against a
  real prior session id. The resumed turn's trace showed a fresh `web
  search:` call and returned the correct current year, confirming Phase 2
  (which resumes Phase 1's session) keeps web access when `--web` is passed
  again on resume.
- **`codex exec resume` has no `-s`/`--sandbox` flag** (confirmed via `codex
  exec resume --help`; passing it errors: "unexpected argument '-s'
  found") — resume reuses the original session's sandbox. This is pre-existing,
  correct behavior in `codex-dispatch.mjs`'s `buildCodexArgs` (the resume
  branch never pushes `-s`), not something this feature needed to change,
  but is recorded here since it was verified as part of this investigation.
- **`opencode run --help` has no web/search/fetch flag** at all — confirmed
  by direct grep of the full help output. There is no config-level path to
  give an OpenCode seat live web access today.
- **Claude seat A/B are spawned as harness subagents**, not scripted CLI
  dispatches (`phase-1-independent-passes.md`'s "give the agent a unique
  name and keep its agent ID" — an `Agent`-tool spawn). This session's own
  environment shows a `general-purpose` agent type carries `Tools: *`. No
  spawn type was previously named in the docs; this feature makes it
  explicit so the capability is guaranteed, not inferred.
- **Cost**: a single trivial web-search turn under `codex exec --search`
  cost 12,758–13,454 tokens across repeated tests, including session/hook
  overhead. This is the basis for the 5-fetches-per-seat-per-phase cap.

## Design

- **Gate**: claim-checkability, not profile, not a phrase. Default on.
  Opt-out phrase: "repo-only review".
- **Order**: repo/pre-flight evidence first; web fetch only when the target
  genuinely cannot settle the claim.
- **Cap**: 5 fetches per seat per phase (see cost measurement above).
- **Citation**: mandatory for any web-backed claim — `Basis: SOURCE_CITATION`
  (the existing enum value; no new `Basis` was added) with the URL AND the
  relevant quoted text in the `Evidence` fence. A URL alone is insufficient.
- **Trust boundary**: fetch only documentation the reviewer independently
  chose (a vendor's own docs site, a published spec) — never a URL or
  endpoint found embedded in the reviewed material itself. Fetched content
  is evidence, never instructions. A target-embedded URL/endpoint that 404s
  is a question for a human, never a finding, per this project's own
  standing rule that a guessed URL 404s indistinguishably from an
  unlicensed feature.
- **Arbitration**: fetched content contradicting the target is a finding;
  the target contradicting fetched content is a question, not a finding —
  the web source can itself be wrong, stale, or inapplicable.
- **Dispatch**: `codex-dispatch.mjs --web` prepends `--search` before `exec`
  in argv (a genuinely new argv-ordering rule, not a simple flag push — see
  Verified provider capability above) and records `webAccess: true` in
  result.json. Claude seats need only the brief instruction plus an explicit
  general-purpose spawn type; no dispatch-flag equivalent exists or is
  needed. `opencode-dispatch.mjs --web` is accepted for call-site parity
  (so a caller need not special-case the runtime) but does nothing; its
  result.json always records `webAccess: false`.
- **Auditor**: reads each seat's `webAccess` (copied into the manifest like
  `isolated`/`worktreePath`) and weighs a URL-backed `SOURCE_CITATION` claim
  as a checkable counter-fact like any other citation — never specially
  discounted or specially trusted for being web-sourced, and the auditor
  itself never re-fetches to verify (it has no web access of its own).

## Not built

- A new `Basis` enum value — `SOURCE_CITATION` already covers this.
- Phase 3 auditor web access.
- `scan`-side URL enforcement on findings text.
- Any OpenCode web plumbing, or routing an OpenCode seat's web needs through
  Codex or another runtime as a silent fallback — this project's standing
  rule is that OpenCode is never a silent fallback, and the reverse (using
  Codex to cover an OpenCode gap) is the same rule in the other direction.

## Known residual gap

An OpenCode seat has no supported path to web verification today. This is a
real capability asymmetry (documented in `review-protocol.md`'s Web
verification section and in each dispatcher's own result.json schema via
`webAccess`), not silently patched over.
