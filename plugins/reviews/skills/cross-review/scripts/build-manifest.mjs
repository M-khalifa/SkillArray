#!/usr/bin/env node
// Stamps deterministic fields onto an orchestrator-authored manifest.json
// skeleton: a run_id, and sha256 content hashes of the task packet, Phase 1
// outputs, Phase 2 outputs, verifier files, and findings.json.
//
// The orchestrator/model still authors the manifest's descriptive fields
// (topology, mode, reviewers[].provider/model_requested/..., exchange,
// falsification -- see review-protocol.md's Manifest and final output
// section) since those describe intent and configuration a script cannot
// observe. This script owns only what deterministic code can actually
// verify: a run identifier, and hashes proving which exact artifact bytes
// a report was generated from -- reproducibility and audit, not authorship
// of judgment calls.
//
// Each reviewer's own timing (startedAt/finishedAt/durationMs/timeoutS) and
// token/cost fields already live in that seat's own result.json (see
// codex-dispatch.mjs/opencode-dispatch.mjs's RESULT_REQUIRED_KEYS); this
// script does not duplicate them onto the manifest, it leaves them where
// the dispatcher that owns that data already wrote them.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

class RelayError extends Error {}

function printUsageAndExit(code) {
  process.stderr.write(
    `Usage: node build-manifest.mjs --in <manifest.json> --out <manifest.json>\n` +
      `  --task-packet <path> [--phase1 <path>]... [--phase2 <path>]...\n` +
      `  [--verification <path>]... [--findings <findings.json>]\n\n` +
      `Reads an orchestrator-authored manifest skeleton (topology, mode, reviewers,\n` +
      `exchange, falsification -- see review-protocol.md's Manifest and final output\n` +
      `section) from --in, adds a run_id and a sha256 "hashes" object computed from\n` +
      `the given artifact files, and writes the result to --out. Never invents or\n` +
      `overwrites any field the input manifest already set other than "run_id" and\n` +
      `"hashes" -- refuses if either key already exists in the input, to avoid\n` +
      `silently replacing a value someone else already computed.\n\n` +
      `Any of --task-packet/--phase1/--phase2/--verification/--findings may be\n` +
      `omitted; the corresponding hash is then omitted from the output rather than\n` +
      `fabricated as null, since "this artifact was not supplied" and "this artifact\n` +
      `hashed to a known value" are different facts.\n` +
      `--phase1/--phase2/--verification may repeat (one per seat/claim); each is\n` +
      `hashed individually and reported keyed by its own filename, since a single\n` +
      `combined hash across multiple files would not let a reader verify one file\n` +
      `in isolation.\n`
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    in: null, out: null, taskPacket: null,
    phase1: [], phase2: [], verification: [], findings: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new RelayError(`${a} requires a value`);
      return v;
    };
    if (a === '--in') args.in = takeValue();
    else if (a === '--out') args.out = takeValue();
    else if (a === '--task-packet') args.taskPacket = takeValue();
    else if (a === '--phase1') args.phase1.push(takeValue());
    else if (a === '--phase2') args.phase2.push(takeValue());
    else if (a === '--verification') args.verification.push(takeValue());
    else if (a === '--findings') args.findings = takeValue();
    else if (a === '-h' || a === '--help') printUsageAndExit(0);
    else throw new RelayError(`unrecognized argument: ${a}`);
  }
  if (!args.in || !args.out) throw new RelayError('--in and --out are both required');
  return args;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function hashFile(filePath) {
  const buf = await readFile(filePath);
  return sha256(buf);
}

async function hashFileList(paths, flag) {
  const entries = {};
  for (const p of paths) {
    const key = path.basename(p);
    // Entries are keyed by filename, so a second same-named file would silently replace the first hash.
    if (Object.hasOwn(entries, key)) {
      throw new RelayError(`${flag} was given two files named "${key}"; rename one so each hash stays verifiable`);
    }
    entries[key] = await hashFile(p);
  }
  return entries;
}

async function buildHashes(args) {
  const hashes = {};
  if (args.taskPacket) hashes.task_packet = await hashFile(args.taskPacket);
  if (args.phase1.length > 0) hashes.phase1 = await hashFileList(args.phase1, '--phase1');
  if (args.phase2.length > 0) hashes.phase2 = await hashFileList(args.phase2, '--phase2');
  if (args.verification.length > 0) hashes.verifications = await hashFileList(args.verification, '--verification');
  if (args.findings) hashes.findings_json = await hashFile(args.findings);
  return hashes;
}

async function run(args) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(args.in, 'utf8'));
  } catch (err) {
    throw new RelayError(`failed to read/parse --in "${args.in}": ${err.message}`);
  }

  if (Object.hasOwn(manifest, 'run_id')) {
    throw new RelayError(
      `--in "${args.in}" already has a "run_id" field; refusing to overwrite it. ` +
        `build-manifest.mjs only adds these fields, it never replaces an existing value.`
    );
  }
  if (Object.hasOwn(manifest, 'hashes')) {
    throw new RelayError(
      `--in "${args.in}" already has a "hashes" field; refusing to overwrite it. ` +
        `build-manifest.mjs only adds these fields, it never replaces an existing value.`
    );
  }

  const hashes = await buildHashes(args);
  const stamped = { ...manifest, run_id: randomUUID(), hashes };

  await writeFile(args.out, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
  return stamped;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) printUsageAndExit(0);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RelayError) {
      process.stderr.write(`build-manifest.mjs: ${err.message}\n\n`);
      printUsageAndExit(2);
    }
    throw err;
  }
  try {
    await run(args);
  } catch (err) {
    if (err instanceof RelayError) {
      process.stderr.write(`build-manifest.mjs: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`build-manifest.mjs: unexpected failure: ${err.stack || err}\n`);
    process.exit(1);
  });
}

export { parseArgs, buildHashes, run, sha256, hashFile, RelayError };
