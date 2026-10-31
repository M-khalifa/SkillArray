# Fixture Review Target

A checked-in stand-in target for scan tests that need `--target-dir` to point
at something whose own docs legitimately use seat vocabulary (seat A, seat B,
reviewer A) and name every vendor token this scanner recognizes (claude,
anthropic, codex, openai, gpt-, opencode, fable, opus), so a scan against it
exercises the target-derived exemption deterministically regardless of which
skill directory this fixture is copied into.
