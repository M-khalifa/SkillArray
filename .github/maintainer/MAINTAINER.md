# How SkillArray pull requests are reviewed

SkillArray ships two review skills, `pair-review` and `cross-review`. `pair-review` is the source copy; the scripts and
tests in `cross-review` are a byte-identical copy that `scripts/validate-repository.mjs` checks. Docs, references and
CHANGELOGs are written per skill. These are the rules the maintainer applies to every pull request.

## Verdicts

- **merge**: correct, in scope, tested, nothing to change.
- **merge-with-fix**: one small mechanical change makes it mergeable (copy a script to `cross-review`, add the missing
  CHANGELOG line, drop a stray file). The review says exactly what to change.
- **rework**: worth having, but the author must change something real. One clear ask.
- **close**: a duplicate, out of scope, or against the base rules below. Kind, and it points at what landed instead.
- **showcase**: a bigger idea that lives in the author's own repository, with a link from the README.
- **hold**: the maintainer decides (a protocol change, a new dependency, credentials, a release).

## Base rules

- A review seat never writes to the target. A change that lets a seat, the auditor or a verifier write into the
  reviewed code, or read the other seat's files before the exchange, is **close** unless it is the maintainer's own.
- Blinding stays: the packet and the briefs carry no seat, model or vendor names. A change that weakens a blinding
  check is **hold**.
- No credentials in the repository, the run folder or a seat's environment. Anything that changes how keys, tokens or
  authentication reach a seat is **hold**.
- Plain Node.js scripts that import only `node:` modules and each other; there is no `package.json`. A new
  dependency is **hold**.
- A change to `.github/` (workflows, these rules, the templates, CODEOWNERS) or to an install path is **hold**: the
  maintainer reviews it line by line.
- Scripts and tests change in `pair-review` first and are copied to `cross-review` in the same pull request; a pull
  request that changes only one copy is **merge-with-fix** (copy it) or **rework** when the copies differ on purpose.

## What a mergeable change has

- A test that fails without the change, in the changed skill's `scripts/tests/`.
- `node --test` green in each changed skill, and `node scripts/validate-repository.mjs` green.
- All 13 CI jobs green (Linux, macOS and Windows; Node 22 and 24; both skills). `main` merges only through a pull
  request with the maintainer's approval (CODEOWNERS) and green checks; release tags `v*` are the maintainer's.
- One CHANGELOG line, the same in `CHANGELOG.md` and both skills' copies (`validate-repository` checks they match).
  No version bump: the maintainer bumps the version at release.
- Messages a person reads (FAILED, WARNING, next: lines) in plain English that say what to do next.
- One change per pull request. A pull request that bundles separable parts is **rework**: split it.

## Scope

- In scope: fixes, clearer messages, tests, docs, platform support (Windows, macOS, Linux; Claude Code and Codex
  hosts), and small options that are off by default.
- **hold**: changes to the review protocol (`references/review-protocol.md`), the severity rules, the audit, or the
  number and kind of seats.
- **showcase**: a new reviewer runtime or host, a web interface, or a hosted service.
- **close**: features that send review content to a service the user did not choose.

## Comment style

Short and thankful: name one specific thing that is good. Rework asks are one line. Closes are kind and say where the
idea can live instead.
