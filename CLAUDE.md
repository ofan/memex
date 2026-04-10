AGENTS.md

## Rules

### Secrets and Infrastructure

- **NEVER** commit secrets (API keys, tokens, passwords) to this repo
- **NEVER** reference the dev environment's infrastructure (hostnames, IPs, lab domains, machine names) in committed code or docs
- **NEVER** store OpenClaw user data, config, or database contents in this repo
- Use environment variables for credentials at runtime
- Tests may use a local DB for evaluation but results must not be committed with PII or infra details
- Examples in docs should use generic placeholders, not real hostnames, IPs, or domain names

### Development

- Tests first. Write acceptance criteria before implementation.
- Domain eval (`tests/domain-eval.ts`) is the primary quality metric, not LongMemEval.
- Spike before TDD — validate hypotheses with a quick experiment before full implementation.
- Progress tracked in `docs/plans/PROGRESS.md`. Any agent reads this first.
- Design docs in `docs/design/`. Research in `docs/research/`.
