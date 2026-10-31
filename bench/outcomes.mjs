#!/usr/bin/env node
// Joins finished runs' findings, seat models and the author's outcome words (report notes, "## Finding status") into a
// count per seat model: how many findings each model raised and what the author said about them.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { notesOutcomes } from '../plugins/pair-review/skills/pair-review/scripts/build-recheck-packet.mjs';

const OUTCOME_COLUMNS = ['fixed', 'wrong', 'intentional', 'not-worth-it', 'pre-existing', 'decided'];
const USAGE = 'Usage: node bench/outcomes.mjs --run-dir <run> [--run-dir <run> ...] [--json]\n' +
  'Reads each run\'s phase3/findings.json, manifest.json (reviewers: model per seat) and phase3/report-notes.md.\n';

class OutcomeError extends Error {}

export function parseArgs(argv) {
  const args = { runDirs: [], json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--run-dir') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new OutcomeError('--run-dir requires a value');
      args.runDirs.push(v);
    } else if (tok === '--json') args.json = true;
    else if (tok === '-h' || tok === '--help') args.help = true;
    else throw new OutcomeError(`unrecognized argument: ${tok}`);
  }
  if (!args.help && args.runDirs.length === 0) throw new OutcomeError('give at least one --run-dir');
  return args;
}

const readText = async (file) => (existsSync(file) ? (await readFile(file, 'utf8')).replace(/^\uFEFF/, '') : null);

// One row per (finding, seat model): a finding both seats raised counts once for each model.
export function runRows({ findingsDoc, manifest, notesText }) {
  const models = {};
  for (const r of manifest?.reviewers ?? []) if (r?.role) models[r.role] = r.model_resolved ?? r.model_requested ?? `seat ${r.role}`;
  const outcomes = notesOutcomes(notesText ?? '');
  const rows = [];
  for (const f of findingsDoc?.findings ?? []) {
    const seats = [...new Set((f.origins ?? []).map((o) => String(o)[0]).filter((s) => s === 'A' || s === 'B'))];
    for (const seat of seats) rows.push({ id: f.id, model: models[seat] ?? `seat ${seat}`, outcome: outcomes.get(f.id)?.word ?? null });
  }
  return rows;
}

export function tally(rows) {
  const byModel = new Map();
  for (const r of rows) {
    const t = byModel.get(r.model) ?? { model: r.model, findings: 0, none: 0, ...Object.fromEntries(OUTCOME_COLUMNS.map((c) => [c, 0])) };
    t.findings += 1;
    if (r.outcome) t[r.outcome] += 1;
    else t.none += 1;
    byModel.set(r.model, t);
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}

export function renderTable(totals) {
  const head = ['model', 'findings', ...OUTCOME_COLUMNS, 'no outcome', 'wrong / with outcome'];
  const body = totals.map((t) => {
    const withOutcome = t.findings - t.none;
    return [t.model, t.findings, ...OUTCOME_COLUMNS.map((c) => t[c]), t.none, withOutcome === 0 ? 'n=0' : `${t.wrong}/${withOutcome}`].map(String);
  });
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  return [head, ...body].map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n') + '\n';
}

export async function loadRun(runDir) {
  const dir = path.resolve(runDir);
  const findingsText = await readText(path.join(dir, 'phase3', 'findings.json'));
  if (findingsText === null) throw new OutcomeError(`${dir} has no phase3/findings.json`);
  const manifestText = await readText(path.join(dir, 'manifest.json'));
  try {
    return { findingsDoc: JSON.parse(findingsText), manifest: manifestText === null ? null : JSON.parse(manifestText), notesText: await readText(path.join(dir, 'phase3', 'report-notes.md')) };
  } catch (err) {
    throw new OutcomeError(`${dir}: ${err.message}`);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const rows = [];
  for (const dir of args.runDirs) rows.push(...runRows(await loadRun(dir)));
  const totals = tally(rows);
  process.stdout.write(args.json ? `${JSON.stringify(totals, null, 2)}\n` : renderTable(totals));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`outcomes: ${err.message}\n`);
    process.exitCode = err instanceof OutcomeError ? 1 : 2;
  });
}
