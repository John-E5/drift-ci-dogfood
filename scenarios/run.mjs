#!/usr/bin/env node
// Runs each scenario through the installed drift-ci CLI (mock provider, no API
// key) and asserts its exit code + JSON-reporter `deltas` buckets against
// expected.json. Exits non-zero if any scenario fails. Usage:
// `node run.mjs [scenarioName]`.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ONLY = process.argv[2];
const CLI = join(HERE, 'node_modules', '@drift-ci', 'cli', 'dist', 'index.js');
const BUCKETS = [
  'regressions',
  'improvements',
  'staleBaselines',
  'staleJudges',
  'noScore',
  'missingBaselines',
];

function listScenarios() {
  return readdirSync(HERE, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        d.name !== 'node_modules' &&
        existsSync(join(HERE, d.name, 'expected.json')),
    )
    .map((d) => d.name)
    .filter((name) => !ONLY || name === ONLY)
    .sort();
}

function sortedJson(arr) {
  return JSON.stringify((arr ?? []).slice().sort());
}

function runScenario(name) {
  const dir = join(HERE, name);
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  if (expected.quarantined) {
    return { name, status: 'skip', reason: expected.quarantineReason ?? 'quarantined' };
  }

  const res = spawnSync(
    process.execPath,
    [
      CLI,
      'run',
      '--reporter', 'json',
      '--config', join(dir, 'config.yaml'),
      '--suite', join(dir, 'suite.yaml'),
      '--baseline-dir', join(dir, 'baseline'),
      '--runs-dir', join(HERE, '.runs', name),
    ],
    {
      cwd: HERE,
      encoding: 'utf8',
      env: { ...process.env, DRIFT_ENABLE_MOCK_PROVIDER: 'true' },
    },
  );

  const failures = [];
  if (res.status !== expected.exitCode) {
    failures.push(`exit code: got ${res.status}, want ${expected.exitCode}`);
  }
  if (expected.stderrIncludes && !(res.stderr ?? '').includes(expected.stderrIncludes)) {
    failures.push(`stderr missing ${JSON.stringify(expected.stderrIncludes)}`);
  }
  if (expected.deltas) {
    let payload;
    try {
      payload = JSON.parse(res.stdout);
    } catch {
      failures.push('stdout was not valid JSON (run aborted or crashed?)');
    }
    const got = payload?.deltas ?? {};
    for (const b of BUCKETS) {
      if (sortedJson(expected.deltas[b]) !== sortedJson(got[b])) {
        failures.push(
          `deltas.${b}: got ${sortedJson(got[b])}, want ${sortedJson(expected.deltas[b])}`,
        );
      }
    }
  }
  return { name, status: failures.length ? 'fail' : 'pass', failures, res };
}

let failed = 0;
let skipped = 0;
for (const name of listScenarios()) {
  const r = runScenario(name);
  if (r.status === 'pass') {
    console.log(`PASS  ${name}`);
  } else if (r.status === 'skip') {
    skipped += 1;
    console.log(`SKIP  ${name} — ${r.reason}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}`);
    for (const f of r.failures) console.log(`        ${f}`);
  }
}
console.log(`\n${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
