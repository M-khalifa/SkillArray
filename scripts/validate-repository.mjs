#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function requireFile(relativePath) {
  const absolutePath = path.join(root, relativePath);
  await access(absolutePath, constants.R_OK);
  return absolutePath;
}

async function readJson(relativePath) {
  const absolutePath = await requireFile(relativePath);
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readSkillVersion(relativePath, expectedName) {
  const content = await readFile(await requireFile(relativePath), "utf8");
  assert(
    new RegExp(`^name: ${expectedName}$`, "m").test(content),
    `${relativePath}: expected name ${expectedName}`,
  );
  const match = content.match(/^\s*version:\s*([^\s]+)\s*$/m);
  assert(match, `${relativePath}: missing metadata version`);
  return match[1];
}

async function main() {
  for (const file of [
    "README.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    ".github/workflows/test.yml",
  ]) {
    await requireFile(file);
  }

  const marketplace = await readJson(".claude-plugin/marketplace.json");
  assert(marketplace.name === "skillarray", "unexpected marketplace name");
  assert(Array.isArray(marketplace.plugins), "marketplace plugins must be an array");

  const expectedPlugins = new Map([
    ["pair-review", "./plugins/pair-review"],
    ["cross-review", "./plugins/cross-review"],
  ]);
  assert(marketplace.plugins.length === expectedPlugins.size, "unexpected plugin count");
  for (const plugin of marketplace.plugins) {
    assert(expectedPlugins.get(plugin.name) === plugin.source, `unexpected plugin: ${plugin.name}`);
    await requireFile(path.join(plugin.source, ".claude-plugin", "plugin.json"));
  }

  // Each review skill ships as its own plugin, with a Codex manifest and marketplace entry that agree with it.
  // Both carry one version, the one CHANGELOG's top released header names.
  const codexMarketplace = await readJson(".agents/plugins/marketplace.json");
  assert(Array.isArray(codexMarketplace.plugins), "Codex marketplace plugins must be an array");
  let reviews = null;
  for (const skill of ["pair-review", "cross-review"]) {
    const plugin = await readJson(`plugins/${skill}/.claude-plugin/plugin.json`);
    assert(plugin.name === skill, `plugins/${skill}: unexpected plugin name ${plugin.name}`);
    assert(typeof plugin.version === "string" && plugin.version.length > 0, `${skill} plugin.json must declare a version`);
    reviews ??= plugin;
    assert(plugin.version === reviews.version, `${skill} plugin.json version ${plugin.version} differs from ${reviews.version}`);
    const codex = await readJson(`plugins/${skill}/.codex-plugin/plugin.json`);
    assert(codex.name === skill, `${skill} Codex plugin.json: unexpected plugin name`);
    assert(codex.version === plugin.version, `${skill} Codex plugin.json version ${codex.version} differs from ${plugin.version}`);
    assert(codex.skills === "./skills/", `${skill} Codex plugin.json: skills must be ./skills/`);
    const entry = codexMarketplace.plugins.find((p) => p.name === skill);
    assert(entry && entry.source && entry.source.path === `./plugins/${skill}`, `Codex marketplace: the ${skill} entry must point at ./plugins/${skill}`);
  }

  {
    // CHANGELOG's top RELEASED header (skipping a leading "- Unreleased"
    // section, which documents in-progress work for a version plugin.json
    // has not been bumped to yet) is another place a version could silently
    // drift from plugin.json's, the actual source of truth -- checked here
    // instead of a hardcoded literal, which itself needed hand-editing on
    // every version bump.
    const changelog = (await readFile(await requireFile("CHANGELOG.md"))).toString("utf8");
    // The negative lookahead must sit right after the full version match, not
    // merely after "\d+\.\d+\.\d+": a backtracking-friendly pattern like
    // (?! - Unreleased) placed after the digits lets the regex engine
    // backtrack the last \d+ (e.g. "10" -> "1") to satisfy the lookahead,
    // silently matching a truncated version on any two-digit patch/minor
    // (e.g. "## 1.3.10 - Unreleased" would wrongly match "1.3.1"). Anchoring
    // "(?!Unreleased)" immediately after a literal " - " closes that hole.
    const releasedHeader = changelog.match(/^## (\d+\.\d+\.\d+) - (?!Unreleased)/m);
    assert(releasedHeader, "CHANGELOG.md: missing a top-level released ## <version> header");
    assert(
      releasedHeader[1] === reviews.version,
      `CHANGELOG.md's top released header is ${releasedHeader[1]}, but plugin.json's version is ${reviews.version}`,
    );
  }

  const pairVersion = await readSkillVersion(
    "plugins/pair-review/skills/pair-review/SKILL.md",
    "pair-review",
  );
  const crossVersion = await readSkillVersion(
    "plugins/cross-review/skills/cross-review/SKILL.md",
    "cross-review",
  );
  assert(pairVersion === reviews.version, "pair-review version differs from plugin version");
  assert(crossVersion === reviews.version, "cross-review version differs from plugin version");

  {
    // model-capabilities.md previously described OpenCode as detection-only
    // protection, predating --isolate's real-prevention worktree redirect.
    const capabilities = (
      await readFile(
        await requireFile("plugins/cross-review/skills/cross-review/references/model-capabilities.md"),
      )
    ).toString("utf8");
    assert(
      !/is detection\s*\nafter the fact, never prevention\.\s*Require/.test(capabilities),
      "model-capabilities.md: stale pre---isolate OpenCode sandbox claim has returned",
    );
    assert(
      /--isolate/.test(capabilities),
      "model-capabilities.md: must describe --isolate's real-prevention worktree redirect",
    );
  }

  {
    // phase-3-scorecard.md previously referenced a "confidence-floor rule" review-protocol.md
    // never defined (a survivor of an old Verdict/Basis/Confidence schema) and used
    // free-prose "Peer response" example values instead of review-protocol.md's closed enum.
    const scorecard = (
      await readFile(
        await requireFile("plugins/cross-review/skills/cross-review/references/phase-3-scorecard.md"),
      )
    ).toString("utf8");
    assert(
      !/confidence-floor/.test(scorecard),
      "phase-3-scorecard.md: dangling 'confidence-floor rule' reference has returned; review-protocol.md defines no such rule",
    );
    const peerResponseEnum = ["unaddressed", "conceded", "disputed-no-counter-fact", "disputed-with-counter-fact"];
    for (const row of scorecard.matchAll(/^\|\s*[AB]\d+\s*\|.*\|\s*([^|]+?)\s*\|[^|]*\|[^|]*\|$/gm)) {
      assert(
        peerResponseEnum.includes(row[1].trim()),
        `phase-3-scorecard.md: example scorecard row uses "${row[1].trim()}", not a value from review-protocol.md's Peer response enum`,
      );
    }
    assert(
      /worktree prune/.test(scorecard),
      "phase-3-scorecard.md: Isolation cleanup must cover 'git worktree prune' for a scratchpad wiped before cleanup ran",
    );
    assert(
      /-C\s+"?<target-dir>"?\s+worktree remove/.test(scorecard),
      "phase-3-scorecard.md: Isolation cleanup must run 'git -C <target-dir> worktree remove', not an ambiguous-cwd command",
    );
  }

  {
    // pair-review's phase 3 must clean up every actor's worktree the same way cross-review's does.
    const scorecard = (
      await readFile(
        await requireFile("plugins/pair-review/skills/pair-review/references/phase-3-scorecard.md"),
      )
    ).toString("utf8");
    assert(
      /worktree prune/.test(scorecard),
      "pair-review phase-3-scorecard.md: Isolation cleanup must cover 'git worktree prune'",
    );
    assert(
      /-C\s+"?<target-dir>"?\s+worktree remove/.test(scorecard),
      "pair-review phase-3-scorecard.md: Isolation cleanup must run 'git -C <target-dir> worktree remove'",
    );
  }

  for (const skill of ["cross-review", "pair-review"]) {
    // Each SKILL.md carries the host table and links both host files, which must exist.
    const skillDir = `plugins/${skill}/skills/${skill}`;
    const entry = (await readFile(await requireFile(`${skillDir}/SKILL.md`))).toString("utf8");
    assert(/^## Host table\s*$/m.test(entry), `${skill} SKILL.md: missing the "## Host table" heading`);
    for (const host of ["claude-code", "codex"]) {
      await requireFile(`${skillDir}/references/hosts/${host}.md`);
      assert(
        entry.includes(`](references/hosts/${host}.md)`),
        `${skill} SKILL.md: must link references/hosts/${host}.md`,
      );
    }
  }

  {
    // A11: --isolate is real prevention for the working tree but still writes
    // git worktree bookkeeping under the target's own .git/worktrees/, which
    // review-protocol.md and model-capabilities.md previously never mentioned.
    const protocol = (
      await readFile(await requireFile("plugins/cross-review/skills/cross-review/references/review-protocol.md"))
    ).toString("utf8");
    assert(
      /\.git\/worktrees/.test(protocol),
      "review-protocol.md: must document that --isolate still writes into the target's .git/worktrees/",
    );
    const capabilities = (
      await readFile(await requireFile("plugins/cross-review/skills/cross-review/references/model-capabilities.md"))
    ).toString("utf8");
    assert(
      /\.git\/worktrees/.test(capabilities),
      "model-capabilities.md: must document that --isolate still writes into the target's .git/worktrees/",
    );
  }

  {
    // A live run found blind-relabel.mjs's known-real-claim-ID leak scan (scan --phase1-dir
    // --forbid-seats) implemented and tested, but never actually invoked by any operational
    // doc -- the helper existed, but every "scan --in ..." command line in the docs a real
    // orchestrator copies from omitted --forbid-seats, so the exact fenced-Evidence claim-ID
    // leak this scan exists to catch could recur on the next real run. This grep is the only
    // way "helper exists but is unused" can't silently return: every operational "scan --in"
    // command line in these three files (a bare unquoted line, not prose describing scan in
    // general) must also mention --forbid-seats on the same or a directly adjacent line.
    const forbidSeatsFiles = [
      "plugins/cross-review/skills/cross-review/references/phase-2-cross-examination.md",
      "plugins/cross-review/skills/cross-review/references/phase-3-scorecard.md",
      "plugins/pair-review/skills/pair-review/SKILL.md",
      "plugins/pair-review/skills/pair-review/references/phase-2-cross-examination.md",
      "plugins/pair-review/skills/pair-review/references/phase-3-scorecard.md",
    ];
    for (const file of forbidSeatsFiles) {
      const content = (await readFile(await requireFile(file))).toString("utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (!/blind-relabel\.mjs["'` ]*\s+scan\b/.test(line)) return;
        // A command-line "--in <file>" invocation is scoped to findings/peer-view files
        // specifically -- NOT every scan call. The falsification verifier's own tiny,
        // single-X/Y-claim output has no real A/B claim IDs in it at all to leak, so
        // --forbid-seats (which requires --phase1-dir and a real claim-ID universe to check
        // against) does not apply there. Cross-review's phase-3-scorecard.md phrases this as
        // "the verifier's returned text"; pair-review's SKILL.md phrases the same concept as
        // "each returned verdict" -- the exemption below matches on "verifier" appearing
        // anywhere in a wider context window specifically so it isn't keyed to one doc's exact
        // wording and silently miss the other's. Prose-only instructions (pair-review's
        // SKILL.md never uses a literal "--in <file>" command line at all) are checked more
        // narrowly than the whole file: any "scan" mention in prose must have --forbid-seats
        // within a few lines of THAT SPECIFIC mention (see the comment below on why a
        // whole-file check is insufficient).
        const hasInFindingsArg = /--in\s+"?[^"\s]*(findings|peer-view)/.test(line);
        const isVerifierOutputScan = /verifier|returned verdict|returned text/i.test(
          lines.slice(Math.max(0, i - 6), i + 1).join(" "),
        );
        if (isVerifierOutputScan) return;
        if (hasInFindingsArg) {
          const window = lines.slice(i, i + 2).join("\n");
          assert(
            /--forbid-seats/.test(window),
            `${file}:${i + 1}: a "scan" command line over a findings/peer-view file does not ` +
              "mention --forbid-seats -- the known-real-claim-ID leak scan exists but must " +
              "actually be invoked, not just available",
          );
        } else {
          // A whole-file check here would pass on warning prose alone (e.g. "omitting
          // --forbid-seats reopens that leak") even after every real usage is stripped from
          // this specific scan mention. Require the flag within a few lines of THIS mention.
          const window = lines.slice(i, i + 5).join("\n");
          assert(
            /--forbid-seats/.test(window),
            `${file}:${i + 1}: a "scan" mention (prose) does not have --forbid-seats within the ` +
              "next few lines -- the known-real-claim-ID leak scan exists but must actually be " +
              "invoked, not just available",
          );
        }
      });
    }
  }

  // SKILL.md's Maintenance section names these as shared; parity is enforced, not assumed.
  for (const file of [
    "scripts/review-config.mjs",
    "scripts/provider-catalog.mjs",
    "scripts/tests/review-config.test.mjs",
    "scripts/validate-package.mjs",
    "scripts/blind-relabel.mjs",
    "scripts/tests/blind-relabel.test.mjs",
    "scripts/build-manifest.mjs",
    "scripts/tests/build-manifest.test.mjs",
    "scripts/exchange.mjs",
    "scripts/tests/exchange.test.mjs",
    "scripts/detach-utils.mjs",
    "scripts/claude-dispatch.mjs",
    "scripts/codex-dispatch.mjs",
    "scripts/host-support.mjs",
    "scripts/native-agent.mjs",
    "scripts/tests/native-agent.test.mjs",
    "scripts/tests/host-support.test.mjs",
    "scripts/tests/codex-dispatch.test.mjs",
    "scripts/tests/claude-dispatch.test.mjs",
    "scripts/worktree-utils.mjs",
    "scripts/rollout-utils.mjs",
    "scripts/tests/detach-utils.test.mjs",
    "scripts/tests/worktree-utils.test.mjs",
    "scripts/tests/rollout-utils.test.mjs",
    "scripts/run-descriptor.mjs",
    "scripts/tests/run-descriptor.test.mjs",
    "scripts/tests/validate-package.test.mjs",
    "scripts/env-filter.mjs",
    "scripts/tests/env-filter.test.mjs",
    "scripts/spawn-utils.mjs",
    "scripts/tests/spawn-utils.test.mjs",
    "scripts/preflight.mjs",
    "scripts/tests/preflight.test.mjs",
    "scripts/tests/preflight-host.test.mjs",
    "scripts/build-report.mjs",
    "scripts/build-recheck-packet.mjs",
    "scripts/tests/build-recheck-packet.test.mjs",
    "scripts/tests/build-report.test.mjs",
    "scripts/review-run.mjs",
    "scripts/tests/review-run.test.mjs",
    "scripts/context-builder.mjs",
    "scripts/tests/context-builder.test.mjs",
    "scripts/build-brief.mjs",
    "scripts/tests/build-brief.test.mjs",
    "scripts/snapshot-utils.mjs",
    "scripts/tests/snapshot-utils.test.mjs",
    "references/review-protocol.md",
    "references/task-packet-template.md",
    "references/review-profiles.md",
    "references/configuration.md",
    "references/model-capabilities.md",
    "CHANGELOG.md",
  ]) {
    const pair = await readFile(
      await requireFile(path.join("plugins/pair-review/skills/pair-review", file)),
    );
    const cross = await readFile(
      await requireFile(path.join("plugins/cross-review/skills/cross-review", file)),
    );
    assert(pair.equals(cross), `${file}: pair-review and cross-review copies differ`);
  }

  // Every pair-review script also ships in cross-review, byte for byte, so a new shared module needs no list entry.
  const scriptFiles = async (skill) => {
    const base = path.join(root, "plugins", skill, "skills", skill, "scripts");
    const found = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name));
        else found.push(path.relative(base, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    };
    await walk(base);
    return { base, found: found.sort() };
  };
  const crossScripts = await scriptFiles("cross-review");
  const pairScripts = await scriptFiles("pair-review");
  for (const file of pairScripts.found) {
    assert(crossScripts.found.includes(file), `scripts/${file} is in pair-review but not in cross-review`);
    const pair = await readFile(path.join(pairScripts.base, file));
    const cross = await readFile(path.join(crossScripts.base, file));
    assert(pair.equals(cross), `scripts/${file}: pair-review and cross-review copies differ`);
  }

  // The two skills' test fixtures: the same files, byte for byte.
  const fixtureFiles = async (skill) => {
    const base = path.join(root, "plugins", skill, "skills", skill, "scripts/tests/fixtures");
    const found = [];
    await requireFile(path.relative(root, base));
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name));
        else found.push(path.relative(base, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    };
    await walk(base);
    return { base, found: found.sort() };
  };
  const crossFixtures = await fixtureFiles("cross-review");
  const pairFixtures = await fixtureFiles("pair-review");
  assert(
    crossFixtures.found.join("\n") === pairFixtures.found.join("\n"),
    `scripts/tests/fixtures differ between the skills: ${[...new Set([...crossFixtures.found, ...pairFixtures.found])].filter((f) => !(crossFixtures.found.includes(f) && pairFixtures.found.includes(f))).join(", ")}`,
  );
  for (const file of crossFixtures.found) {
    const cross = await readFile(path.join(crossFixtures.base, file));
    const pair = await readFile(path.join(pairFixtures.base, file));
    assert(cross.equals(pair), `scripts/tests/fixtures/${file}: pair-review and cross-review copies differ`);
  }

  // Each installed skill folder ships the release notes, so a user can see what changed.
  const rootChangelog = await readFile(await requireFile("CHANGELOG.md"));
  const skillChangelog = await readFile(await requireFile("plugins/cross-review/skills/cross-review/CHANGELOG.md"));
  assert(rootChangelog.equals(skillChangelog), "plugins/*/skills/*/CHANGELOG.md must be a copy of CHANGELOG.md");

  console.log("SkillArray: repository metadata and shared review files passed");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
