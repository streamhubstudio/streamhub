# Security Policy

We take the security of StreamHub seriously. Thank you for helping keep StreamHub and its
users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions,
or pull requests.**

Instead, report them privately by email to **security@streamhub.studio**, or via
<https://streamhub.studio/security>.

Please include as much of the following as you can:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, affected endpoint/component, version/commit).
- Any relevant logs, configuration, or environment details.

We will acknowledge your report, keep you updated on our progress, and coordinate a
disclosure timeline with you. Please give us a reasonable window to investigate and ship a
fix before any public disclosure.

## Scope

This repository is the self-hosted **open-source core**. When reporting, note whether the
issue affects the core API (`streamhub-core`), the dashboard (`streamhub-web`), the browser
SDK (`streamhub-adaptor`), the installer/deploy tooling, or the underlying LiveKit
configuration shipped here.

## Good hygiene for operators

- Never commit a real `.env`, `data/secrets.json`, or any `sk_`/`clt_`/`wsk_` token.
- Keep `/metrics` and the LiveKit native metrics ports bound to `127.0.0.1` (the shipped
  reverse-proxy config already denies them from the outside).
- Run with `STREAMHUB_AUTHZ_ENFORCE=on` in production.
