# Contributing to SkillArray

Keep changes focused and preserve each skill's standalone installation.

## Where does my idea go?

| The idea | Where it goes |
|---|---|
| A bug, a confusing message, a missing test | A pull request, or a [bug issue](https://github.com/M-khalifa/SkillArray/issues/new?template=bug.yml) with the exact command and output |
| How a real review run went | A [field report](https://github.com/M-khalifa/SkillArray/issues/new?template=field-report.yml); short notes are fine |
| A small option, off by default | A pull request |
| A change to the review protocol, the severity rules or the audit | An issue first: the maintainer decides |
| A new reviewer runtime, a web interface, a hosted service | Your own repository; open an issue to have it linked |

[`.github/maintainer/MAINTAINER.md`](.github/maintainer/MAINTAINER.md) has the merge rules every pull request is
reviewed against.

## Development requirements

- Node.js 22 or 24
- Claude Code for local plugin-manifest validation
- Codex CLI only for live `cross-review` verification

## Before submitting a change

1. Run `node scripts/validate-repository.mjs` from the repository root.
2. Run `node scripts/validate-package.mjs` and `node --test` from each changed
   review-skill directory.
3. Run `claude plugin validate .` and validate each plugin directory when the
   plugin or marketplace layout changes.
4. Update the documentation and add a line to each changed skill's `CHANGELOG.md`
   when behavior changes. Leave the version alone: the maintainer bumps it at release.

Shared configuration, capability, and protocol files bundled in `pair-review`
and `cross-review` must remain identical. Apply changes to both packages in the
same pull request.

Do not commit credentials, review transcripts, generated findings, result
files, or local model preferences.

Keep commit and pull request attribution with the human contributors. Do not add
Claude Code or other AI tools as co-authors. The project's `.claude/settings.json`
disables Claude Code's automatic commit and pull request attribution.
