#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
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
  assert(marketplace.name === "skill-array", "unexpected marketplace name");
  assert(Array.isArray(marketplace.plugins), "marketplace plugins must be an array");

  const expectedPlugins = new Map([
    ["reviews", "./plugins/reviews"],
    ["shared-brain", "./plugins/shared-brain"],
  ]);
  assert(marketplace.plugins.length === expectedPlugins.size, "unexpected plugin count");
  for (const plugin of marketplace.plugins) {
    assert(expectedPlugins.get(plugin.name) === plugin.source, `unexpected plugin: ${plugin.name}`);
    await requireFile(path.join(plugin.source, ".claude-plugin", "plugin.json"));
  }

  const reviews = await readJson("plugins/reviews/.claude-plugin/plugin.json");
  assert(reviews.name === "reviews", "unexpected reviews plugin name");
  assert(reviews.version === "1.3.0", "reviews plugin version must be 1.3.0");

  const pairVersion = await readSkillVersion(
    "plugins/reviews/skills/pair-review/SKILL.md",
    "pair-review",
  );
  const crossVersion = await readSkillVersion(
    "plugins/reviews/skills/cross-review/SKILL.md",
    "cross-review",
  );
  assert(pairVersion === reviews.version, "pair-review version differs from plugin version");
  assert(crossVersion === reviews.version, "cross-review version differs from plugin version");

  for (const file of ["configuration.md", "model-capabilities.md", "review-protocol.md", "review-profiles.md"]) {
    const pair = await readFile(
      await requireFile(path.join("plugins/reviews/skills/pair-review/references", file)),
    );
    const cross = await readFile(
      await requireFile(path.join("plugins/reviews/skills/cross-review/references", file)),
    );
    assert(pair.equals(cross), `${file}: pair-review and cross-review copies differ`);
  }

  {
    // model-capabilities.md previously described OpenCode as detection-only
    // protection, predating --isolate's real-prevention worktree redirect.
    const capabilities = (
      await readFile(
        await requireFile("plugins/reviews/skills/cross-review/references/model-capabilities.md"),
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
        await requireFile("plugins/reviews/skills/cross-review/references/phase-3-scorecard.md"),
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
    // A11: --isolate is real prevention for the working tree but still writes
    // git worktree bookkeeping under the target's own .git/worktrees/, which
    // review-protocol.md and model-capabilities.md previously never mentioned.
    const protocol = (
      await readFile(await requireFile("plugins/reviews/skills/cross-review/references/review-protocol.md"))
    ).toString("utf8");
    assert(
      /\.git\/worktrees/.test(protocol),
      "review-protocol.md: must document that --isolate still writes into the target's .git/worktrees/",
    );
    const capabilities = (
      await readFile(await requireFile("plugins/reviews/skills/cross-review/references/model-capabilities.md"))
    ).toString("utf8");
    assert(
      /\.git\/worktrees/.test(capabilities),
      "model-capabilities.md: must document that --isolate still writes into the target's .git/worktrees/",
    );
  }

  // SKILL.md's Maintenance section names these as shared; parity is enforced, not assumed.
  for (const file of [
    "scripts/review-config.mjs",
    "scripts/provider-catalog.mjs",
    "scripts/tests/review-config.test.mjs",
    "scripts/validate-package.mjs",
    "scripts/blind-relabel.mjs",
    "scripts/tests/blind-relabel.test.mjs",
    "scripts/tests/fixtures/blind-relabel/A-findings.md",
    "scripts/tests/fixtures/blind-relabel/B-findings.md",
  ]) {
    const pair = await readFile(
      await requireFile(path.join("plugins/reviews/skills/pair-review", file)),
    );
    const cross = await readFile(
      await requireFile(path.join("plugins/reviews/skills/cross-review", file)),
    );
    assert(pair.equals(cross), `${file}: pair-review and cross-review copies differ`);
  }

  console.log("SkillArray: repository metadata and shared review files passed");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
