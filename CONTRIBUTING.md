# Contributing to SkillArray

Keep changes focused and preserve each skill's standalone installation.

## Development requirements

- Node.js 22 or 24
- Python 3.11 and PyYAML for `shared-brain`
- Claude Code for local plugin-manifest validation
- Codex CLI only for live `cross-review` verification

## Before submitting a change

1. Run `node scripts/validate-repository.mjs` from the repository root.
2. Run `node scripts/validate-package.mjs` and `node --test` from each changed
   review-skill directory.
3. Compile and validate both Shared Brain profiles when changing that skill.
4. Run `claude plugin validate .` and validate each plugin directory when the
   plugin or marketplace layout changes.
5. Update documentation and version metadata when behavior changes.

Shared configuration, capability, and protocol files bundled in `pair-review`
and `cross-review` must remain identical. Apply changes to both packages in the
same pull request.

Do not commit credentials, review transcripts, generated findings, result
files, or local model preferences.
