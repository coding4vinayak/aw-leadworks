# Security — aw-leadworks

leadworks is one of the Abetworks independent products. It enforces the campaign's
non-negotiables at every write boundary. Report a vulnerability in this repo
to **hello@abetworks.in** and we will acknowledge within 3 business days.

## What this codebase asserts by test

- **Fail-closed API-key ownership.** `src/lib/apikeys.ts` resolves the key
  on every write; a missing or mismatched `workspaceId` claim rejects the
  request before the handler runs. Not a warning — a 401/403.
- **Egress policy.** `src/lib/egress.ts` refuses internal addresses (loopback,
  RFC1918, link-local, cloud metadata) at every server-side fetch site. Set
  `ABET_ALLOW_PRIVATE_TARGETS=1` in a dev environment only; production must
  leave it unset. See `aw-abetworks-history` §8.45 for the classifier.
- **Scalar validation at writes.** `src/lib/validate.ts` binds every write
  route to a declared table + column set; unknown or wrong-typed values fail
  with a structured 422/400 rather than persisting silently.
- **Queue-shape discipline.** `src/lib/queue.ts` uses a product-prefixed
  queue name and a fixed `JobScheduler` key so a repeat cannot fan out across
  restarts. Guard tests in `tests/unit/queue.test.ts`.

## Deployment posture

- `render.yaml` declares no shared secrets; every `envVars` entry is
  `sync: false` so the value lives in the provider's dashboard, not in git.
- `DATABASE_URL` must point at an authenticated Postgres (the SQLite default
  is dev-only).
- `REDIS_URL` must not be exposed to the public internet. BullMQ has no
  auth layer of its own.

## Reporting

Email **hello@abetworks.in** with a short description, reproduction steps and
a suggested severity. Please do not open a public issue for an unfixed
vulnerability.
