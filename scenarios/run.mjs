#!/usr/bin/env node
// Runs each scenario through the installed drift-ci CLI (no API key) and
// asserts its exit code + JSON-reporter `deltas` buckets against expected.json.
// Exits non-zero if any scenario fails. Usage: `node run.mjs [scenarioName]`.
//
// Scenarios use either the `mock` provider (one fixed answer per input) or, when
// the scenario has a `stub.json`, a local Ollama-compatible stub server that
// returns a scripted SEQUENCE of answers per input — needed to test repeated
// sampling (`runs` / `default_runs`), where each sample must be able to differ.
// The stub's URL is substituted for `${STUB_URL}` in the scenario's config.yaml.
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
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

/**
 * Ollama-compatible stub. `script.responses` maps the last user message to an
 * array of steps, consumed in order (the last step repeats once exhausted). A
 * step is a string (the answer) or `{ "status": <http code> }` (an error).
 */
async function startStub(script) {
  const cursors = new Map();
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      calls += 1;
      let input = '';
      try {
        const body = JSON.parse(raw);
        input = body.messages?.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      } catch {
        /* malformed request: answer with the default below */
      }
      const steps = script.responses?.[input] ?? [script.defaultResponse ?? ''];
      const i = cursors.get(input) ?? 0;
      cursors.set(input, i + 1);
      const step = steps[Math.min(i, steps.length - 1)];
      if (typeof step === 'object' && step !== null) {
        res.writeHead(step.status, { 'Content-Type': 'text/plain' });
        res.end(`stub error ${step.status}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: step }, prompt_eval_count: 5, eval_count: 5 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: HERE,
      env: { ...process.env, DRIFT_ENABLE_MOCK_PROVIDER: 'true' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

/** Number of samples behind a case result (1 when it carries no samples metadata). */
function sampleCount(c) {
  const s = c?.evaluatorBreakdown?.samples;
  return Array.isArray(s) && s.length > 0 ? s.length : 1;
}

async function runScenario(name) {
  const dir = join(HERE, name);
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  if (expected.quarantined) {
    return { name, status: 'skip', reason: expected.quarantineReason ?? 'quarantined' };
  }

  const runsDir = join(HERE, '.runs', name);
  let configPath = join(dir, 'config.yaml');
  let stub = null;
  const stubPath = join(dir, 'stub.json');
  if (existsSync(stubPath)) {
    stub = await startStub(JSON.parse(readFileSync(stubPath, 'utf8')));
    mkdirSync(runsDir, { recursive: true });
    configPath = join(runsDir, 'config.rendered.yaml');
    writeFileSync(configPath, readFileSync(join(dir, 'config.yaml'), 'utf8').replaceAll('${STUB_URL}', stub.url));
  }

  let res;
  try {
    res = await runCli([
      'run',
      '--reporter', 'json',
      '--config', configPath,
      '--suite', join(dir, 'suite.yaml'),
      '--baseline-dir', join(dir, 'baseline'),
      '--runs-dir', runsDir,
    ]);
  } finally {
    await stub?.close();
  }

  const failures = [];
  if (res.status !== expected.exitCode) {
    const gotCode = res.status ?? `null (signal: ${res.signal})`;
    failures.push(`exit code: got ${gotCode}, want ${expected.exitCode}`);
  }
  if (expected.stderrIncludes && !(res.stderr ?? '').includes(expected.stderrIncludes)) {
    failures.push(`stderr missing ${JSON.stringify(expected.stderrIncludes)}`);
  }
  if (expected.stubCalls !== undefined && stub && stub.calls() !== expected.stubCalls) {
    failures.push(`stub calls: got ${stub.calls()}, want ${expected.stubCalls}`);
  }
  if (expected.deltas || expected.cases) {
    let payload;
    try {
      payload = JSON.parse(res.stdout);
    } catch {
      failures.push('stdout was not valid JSON (run aborted or crashed?)');
      return { name, status: 'fail', failures, res };
    }
    if (expected.deltas) {
      const got = payload.deltas ?? {};
      for (const b of BUCKETS) {
        if (sortedJson(expected.deltas[b]) !== sortedJson(got[b])) {
          failures.push(
            `deltas.${b}: got ${sortedJson(got[b])}, want ${sortedJson(expected.deltas[b])}`,
          );
        }
      }
    }
    // Optional per-case checks: { "<caseId>": { "status", "score", "samples" } }.
    for (const [caseId, want] of Object.entries(expected.cases ?? {})) {
      const c = payload.run?.cases?.find((x) => x.caseId === caseId);
      if (!c) {
        failures.push(`case ${caseId}: missing from run`);
        continue;
      }
      if (want.status !== undefined && c.status !== want.status) {
        failures.push(`case ${caseId} status: got ${c.status}, want ${want.status}`);
      }
      if (want.score !== undefined && c.score !== want.score) {
        failures.push(`case ${caseId} score: got ${c.score}, want ${want.score}`);
      }
      if (want.samples !== undefined && sampleCount(c) !== want.samples) {
        failures.push(`case ${caseId} samples: got ${sampleCount(c)}, want ${want.samples}`);
      }
    }
  }
  return { name, status: failures.length ? 'fail' : 'pass', failures, res };
}

let failed = 0;
let skipped = 0;
for (const name of listScenarios()) {
  const r = await runScenario(name);
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
