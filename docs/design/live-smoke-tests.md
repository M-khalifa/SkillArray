# Live-provider smoke tests — design + skeleton

Status: design + a runnable skeleton script (`bench/live-smoke.mjs`). The
skeleton requires real provider credentials to actually execute and is
never wired into public CI. No live run has happened in this session — this
document specifies what to run and why, and the skeleton is scaffolding for
a human to invoke deliberately.

## Why this exists

All 220 + 125 tests in the two review packages test against mocked
`spawnFn` calls (confirmed: `codex-dispatch.test.mjs` uses `fakeSpawn`
exclusively, never a real subprocess). This is correct for CI — it can't
depend on paid provider availability — but it means a real CLI contract
change (a flag renamed, a JSON output shape changed, a new required
argument) would pass every existing test and only surface the first time a
real user hits it. A small, optional, credential-gated smoke suite exists
to catch exactly that class of drift.

## What it checks

Using a tiny fixture repository (a few files, one seeded, known issue — not
the SkillArray repository itself, to avoid the smoke test's own output
polluting this repository's working tree):

1. **Claude invocation** — a `pair-review` seat actually dispatches and
   returns a real Phase 1 response shape.
2. **Codex invocation** — `codex-dispatch.mjs` against the real `codex` CLI,
   confirming its actual output still matches what `codex-dispatch.mjs`
   parses (thread-started event, final message shape).
3. **OpenCode-provider path**, where a provider is configured locally —
   same contract-drift check against the real `opencode` CLI.
4. **Session resume** — confirmed mechanism: `codex-dispatch.mjs --session
   <threadId>` (real flag, real behavior per the script's own `--help` text)
   actually resumes a prior thread rather than silently starting fresh.
5. **Blind exchange** — `blind-relabel.mjs relabel`/`scan` against real
   (not fixture-crafted) reviewer output, checking the identity scan doesn't
   false-positive or false-negative against real model phrasing patterns
   that a hand-written unit-test fixture might not anticipate.
6. **Auditor synthesis** — a real fresh-context auditor subagent spawn and
   `translate` run against its real output.
7. **Final `findings.json`** — schema-valid, `translate` exits 0.

## Design constraints

- **Optional/nightly/manual only.** Never a required check on a pull
  request or push — per the production-readiness directive's own
  instruction, public CI must not depend on paid provider availability or
  external account state.
- **Secrets handled safely.** Provider credentials come from the runner's
  own environment (a nightly GitHub Actions secret, or a local `.env` a
  developer sources manually) and are never written to the fixture
  repository, logs, or any committed artifact. This smoke suite is also the
  natural place to exercise the env-filtering work from Phase E once that
  ships — a good target to confirm the filter doesn't also break the
  smoke test's own legitimate credential passthrough.
- **Cheap fixture, not a real target.** A minimal fixture repo with one or
  two seeded, known-findable issues, kept in `bench/fixtures/` (not built
  yet — this document specifies the requirement, not the fixture content).
- **Cost-bounded.** Uses the cheapest available effort/model tier for each
  provider, since this runs on a schedule, not on-demand for a real review.

## Skeleton script

`bench/live-smoke.mjs` (this session): a runnable skeleton that documents
each check as a `test()` with `{ skip: !process.env.SKILLARRAY_LIVE_SMOKE }`
so `node --test bench/live-smoke.mjs` is a safe no-op (all skipped) unless a
human explicitly sets the opt-in environment variable and has real
credentials configured. This makes the smoke suite's *shape* reviewable and
testable-for-structure today, without spending any real API budget by
accident, including if someone runs `node --test` recursively across the
whole repository.

## What this document is not

No live run has happened. No claim about real-provider contract stability
is made by this document or the skeleton script — only that the skeleton
exists and is structurally safe to leave in the repository without
accidentally running against real providers or leaking credentials.
