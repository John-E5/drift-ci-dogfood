# drift-ci dogfood — support-ticket triage

A private-purpose **dogfood** of [drift-ci](https://github.com/Drift-CI/drift-ci):
a thin consumer repo that wires the released `Drift-CI/drift-ci@v1` action into
CI exactly as a real adopter would, to validate drift-ci end-to-end against real
Anthropic output. There is no application code — drift-ci makes the LLM calls
from `.drift/suite.yaml` and scores them against the committed baselines in
`.drift/baseline/`.

## What it exercises

One suite, 8 cases, 5 evaluators on a single Anthropic key:
`exact-match`, `json-schema`, `rubric-checklist`, `llm-judge`, `refusal-detection`.
System under test: `claude-sonnet-4-6`. Judge: `claude-haiku-4-5`.

> The `llm-judge` and `rubric-checklist` cases require **drift-ci ≥ 1.1.3**.
> This dogfood originally surfaced three judge bugs (per-case judge resolution,
> `temperature` 400s on claude-4.7+, judge-JSON fence intolerance) that were
> fixed in 1.1.3 — which is exactly the kind of bug a dogfood exists to catch.

## Two kinds of drift it catches

1. **Code-side drift** — you edit the suite's system prompt, swap the model, or
   tighten a threshold in a PR. The `drift` workflow flags the behaviour change
   on the PR (see "Reading a drift PR" below).
2. **Model-side drift** — the provider changes behaviour underneath the pinned
   models. The `nightly-drift` cron runs the suite against `main`'s committed
   baselines every day; a failure with no code change means the model moved.

## Reading a drift PR

The PR comment shows regression / improvement tables per case. A **regression**
means a case scored materially below its committed baseline (past
`thresholds.regression`). To accept an intentional change:

```bash
npx @drift-ci/cli@latest run            # produce a fresh run
npx @drift-ci/cli@latest baseline accept --all   # adopt the new outputs
git add .drift/baseline && git commit   # commit baselines in the SAME PR
```

## Pinned models are load-bearing

`.drift/config.yaml` pins the exact model id. Changing it is a deliberate
re-baseline event, not a casual edit — the nightly cron only means anything
because the model is pinned.

## Local setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx @drift-ci/cli@latest run                 # run the suite
npx @drift-ci/cli@latest baseline doctor     # see missing/stale baselines
```

## Scenario harness (`scenarios/`)

Beyond the live Anthropic suite, `scenarios/` is a deterministic, offline,
**key-less** harness that asserts drift-ci's failure-vs-regression exit-code
boundaries using the `mock` provider and a dead `baseUrl`. Each subdirectory is
one scenario (`config.yaml` + `suite.yaml` + committed `baseline/` + an
`expected.json` of the exit code and `deltas` buckets).

```bash
cd scenarios
npm install
node regenerate.mjs   # rebuild baseline fixtures (after a drift-ci change)
node run.mjs          # run all scenarios and assert
```

Baseline `suiteHash`/`judgeHash` are **content-addressed**, so two scenarios with
identical case content share a hash — that is expected, not a copy-paste error.
Stale-* scenarios use sentinel hashes that can never match the live suite/judge.

CI runs the harness on every `scenarios/**` change and nightly against
`@drift-ci/cli@latest`.
