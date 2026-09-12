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
  assert(reviews.version === "1.2.1", "reviews plugin version must be 1.2.1");

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

  for (const file of ["configuration.md", "model-capabilities.md", "review-protocol.md"]) {
    const pair = await readFile(
      await requireFile(path.join("plugins/reviews/skills/pair-review/references", file)),
    );
    const cross = await readFile(
      await requireFile(path.join("plugins/reviews/skills/cross-review/references", file)),
    );
    assert(pair.equals(cross), `${file}: pair-review and cross-review copies differ`);
  }

  // SKILL.md's Maintenance section names these as shared; parity is enforced, not assumed.
  for (const file of [
    "scripts/review-config.mjs",
    "scripts/provider-catalog.mjs",
    "scripts/tests/review-config.test.mjs",
    "scripts/validate-package.mjs",
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
