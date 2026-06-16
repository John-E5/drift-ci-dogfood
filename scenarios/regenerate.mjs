#!/usr/bin/env node
// Rebuilds committed baseline fixtures from each scenario's baselines.json,
// using core's real suiteHash + serialiser so the fixtures stay valid as the
// hash inputs evolve. Stale cases use sentinel hashes that cannot match the
// live suite/judge. Usage: `node regenerate.mjs [scenarioName]`.
import {
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FileBaselineStore,
  computeSuiteHash,
  loadSuiteFromFile,
} from '@drift-ci/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ONLY = process.argv[2];
const STALE_SUITE = 'sha256:stale-suite-sentinel-never-matches-live';
const STALE_JUDGE = 'sha256:stale-judge-sentinel-never-matches-live';

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const scenarios = readdirSync(HERE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'node_modules')
  .map((d) => d.name)
  .filter((name) => !ONLY || name === ONLY)
  .sort();

for (const name of scenarios) {
  const dir = join(HERE, name);
  const baselineDir = join(dir, 'baseline');
  rmSync(baselineDir, { recursive: true, force: true });

  const specPath = join(dir, 'baselines.json');
  if (!existsSync(specPath)) {
    console.log(`skip   ${name} (no baselines.json)`);
    continue;
  }

  const specs = JSON.parse(readFileSync(specPath, 'utf8'));
  const suite = loadSuiteFromFile(join(dir, 'suite.yaml'));
  const store = new FileBaselineStore(baselineDir);

  for (const spec of specs) {
    const tc = suite.cases.find((c) => c.id === spec.caseId);
    if (!tc) {
      throw new Error(`${name}: baselines.json references unknown case "${spec.caseId}"`);
    }
    const output = spec.output ?? '';
    await store.save({
      caseId: spec.caseId,
      suiteId: suite.id,
      capturedAt: '2026-06-16T00:00:00.000Z',
      capturedBy: { runId: 'fixture', provider: 'mock/fixture' },
      suiteHash: spec.staleSuite ? STALE_SUITE : computeSuiteHash(tc),
      judgeHash: spec.staleJudge ? STALE_JUDGE : undefined,
      score: spec.score,
      output,
      outputTruncated: false,
      outputFullHash: sha256(output),
      evaluatorBreakdown: spec.evaluatorBreakdown,
    });
  }
  console.log(`regen  ${name}: ${specs.length} baseline(s)`);
}
