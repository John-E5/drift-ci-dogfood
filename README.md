# drift-ci dogfood — support-ticket triage

A private-purpose **dogfood** of [drift-ci](https://github.com/Drift-CI/drift-ci):
a thin consumer repo that wires the released `Drift-CI/drift-ci@v1` action into
CI exactly as a real adopter would, to validate drift-ci end-to-end against real
Anthropic output. There is no application code — drift-ci makes the LLM calls
from `.drift/suite.yaml` and scores them against the committed baselines in
`.drift/baseline/`.

## What it exercises

One suite, 5 cases, 3 evaluators on a single Anthropic key:
`exact-match`, `json-schema`, `refusal-detection`.
System under test: `claude-sonnet-4-6`.

> **Parked for v1:** the `llm-judge` and `rubric-checklist` cases are temporarily
> removed. Dogfooding surfaced upstream drift-ci judge bugs that make them
> unreliable; they'll return once those are fixed. The full 8-case version is in
> this repo's git history.

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
