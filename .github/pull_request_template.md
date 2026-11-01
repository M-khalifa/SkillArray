<!-- Thanks. One or two sentences on what this changes, and the review run or test that shows it works, is plenty. -->

**What changes:**

**Tested with:** <!-- OS, host (Claude Code or Codex), and the command or run folder -->

**Risk:** <!-- what could break for a user if this is wrong: a review that stops, a wrong report line, a seat that can write -->

**How to revert:** <!-- usually "revert this commit"; say so if a run folder or saved config made with this change needs a step too -->

### If this changes a script or a test
- [ ] Made in `pair-review` and copied to `cross-review`; `node scripts/validate-repository.mjs` passes (the shared files stay identical)
- [ ] `node --test` passes in each changed skill's `scripts/` folder
- [ ] A test for the change, which fails without it
- [ ] One line in `CHANGELOG.md`, copied to both skills' `CHANGELOG.md`; no version bump (the maintainer bumps it at release)

### If this changes a skill's docs or references
- [ ] Both skills changed where the text is shared, or a note on why only one

### Always
- [ ] No credentials, run folders, transcripts, findings or local model preferences
- [ ] No AI co-author lines in the commits
- [ ] No change under `.github/` unless the maintainer asked for it
