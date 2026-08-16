# Security Policy

## Data handling

cceye is local-first. It stores usage metadata and cost provenance locally, but does not store prompt or response bodies. Configuration, cache, state, and database files are created with user-only permissions where supported and are re-hardened when read. API keys are read from environment variables and are not written to configuration or diagnostic output. Malformed YAML errors omit source lines so secret values are not echoed.

Model, project, and session labels are treated as untrusted local input. Parser failures are reduced to health counters rather than persisted as complete log lines.

## Reporting a vulnerability

Please report security issues privately to the repository maintainers before opening a public issue. Include the affected version, operating system, reproduction steps, and whether credentials or local data could be exposed.
