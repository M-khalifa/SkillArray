# cross-review

Two different provider models review independently, then challenge each other's findings.
Choose models once during setup, change them anytime, or override them for one run.

## Requirements

- Node.js 22 or later.
- A harness supporting isolated Claude subagents with explicit model selection
  and resumed exchanges. Claude Code is the primary target.
- The runtime selected for each seat: Claude harness, authenticated Codex CLI,
  or OpenCode with an authenticated configured provider.
- Git recommended for best-effort source-change auditing.

Model/effort support is checked in your runtime; installing this skill does not
grant model access. Reviews consume the selected providers' usage.

## Install

Copy this entire directory, including `scripts/` and `references/`, to
`~/.claude/skills/cross-review/` for personal use, or
`.claude/skills/cross-review/` in a project for a shared installation.
Keep the folder name `cross-review`; the helper derives its identity from it.
No npm install or sibling skill is required.

For another skill-capable harness, use its skill directory and verify it can
actually select the required Claude models. Installing under Codex alone does
not provide Claude subagents.

## Use

```text
/cross-review setup
/cross-review config
/cross-review -- review the changes in src/client.py
/cross-review reset
```

Setup asks for provider, runtime, model, and optional effort for both seats.
Codex offers the current GPT models from the bundled catalog. Claude offers Fable when
the harness exposes it. Run setup again or say "change cross-review's second
provider to PROVIDER" to update saved choices. Say "use MODEL for this review
only" for a temporary override.
Config shows settings; reset removes only this skill's preferences.
These are conversational skill commands, not standalone executables.

Preferences live under `~/.config/review-skills/` by default, outside the
installation and reviewed project. See
[configuration](references/configuration.md) for path overrides, helper commands,
and precedence. No model is preselected and no credentials are stored.

## Validation

From this directory:

```text
node scripts/validate-package.mjs
node --test
```

Tests are offline. They verify configuration persistence and isolation, dispatch flags, exact-session checks, and a fake CLI round trip.
They do not prove live model availability or effective provider-side effort.
CI runs the checks on Windows, Linux, and macOS with Node 22 and 24.

## Review behavior and limits

Source remains unchanged; findings go to a unique temporary run directory.
Both initial passes finish before peer exchange. Read-only evidence stays
labeled; a failed seat produces an incomplete review. Unresolved disagreement
is retained. Actual model and effort are reported as unverified when runtime
metadata is unavailable.

See [SKILL.md](SKILL.md) for the workflow,
[review protocol](references/review-protocol.md) for evidence and reporting rules,
and [review profiles](references/review-profiles.md) for the Code/Architecture/
Document lenses applied on top of that protocol.

OpenCode is an explicit provider bridge for configured non-Claude/non-Codex
vendors. It is never a fallback provider.

## Contributing and license

Keep shared helper, tests, configuration, capability, and protocol files aligned
when contributing changes to both packages. Each package must remain installable
on its own. Run validation and tests before submitting a change.

MIT; see [LICENSE](LICENSE). Preserve the copyright notice when redistributing.
