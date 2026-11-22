# Security Policy

Sampolio is a self-hosted personal-finance app maintained by one person. It
holds sensitive financial data, so security reports are welcome and taken
seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's
private vulnerability reporting on this repository instead (**Security → Report
a vulnerability**). Include the affected version (`package.json` `version` or
commit), steps to reproduce, and the impact you expect.

You should get an acknowledgement within a week. Fixes land on `main`; there are
no separately maintained release branches.

## Scope

In scope: the application code in this repository, its deployment scripts, the
Dockerfile, and the documented configuration.

Out of scope: Enable Banking's own infrastructure and any bank's systems,
vulnerabilities that need an attacker to already control the host or the data
directory, and denial of service by volumetric flooding.

## Hardening notes for operators

- Keep `ENCRYPTION_KEY` outside the data directory and back it up separately
  (the launch scripts default to `~/.sampolio/secrets/`).
- Run behind a TLS-terminating reverse proxy and set `TRUSTED_PROXY_HOPS` to the
  number of proxies in front of the app (`0` when there is none).
- Known limitations are tracked in [`docs/known-gaps.md`](docs/known-gaps.md).
