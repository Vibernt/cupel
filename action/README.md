# Cupel GitHub Action

Planned for milestone M5. In CI it will:

- run `cupel guard`, and `cupel report` when asked
- post a job summary
- fail the job when a guardrail is breached

The guard runs here, outside the agent's write scope (L5).
