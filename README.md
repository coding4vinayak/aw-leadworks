# LeadWorks

![CI](https://github.com/coding4vinayak/aw-leadworks/actions/workflows/ci.yml/badge.svg)


Lead sourcing and enrichment. Find the buyers who are already looking —
$49/month.

Sources (web scrapers, APIs, CSV uploads, manual entry) feed jobs; jobs
scrape, enrich, validate, dedupe and export. Every lead carries a 0–100
quality score, enrichment provenance, and a validation trail.

## Quick start

```bash
npm install
npx prisma migrate dev      # creates the SQLite database
npm run db:seed             # demo workspace, source, rule, export profile
npm run dev                 # http://localhost:3300
```

## Accounts (browser)

Machine callers authenticate with an API key above. Humans sign in:

```
GET  /login                # sign in
POST /signup               # create a workspace and an account
GET  /dashboard            # your own workspace (needs the session cookie)
GET  /members              # seats, invites, roles (owner/admin)
GET  /invite/{token}       # accept a one-time invitation link
```

A signup mints a `User` and a `Workspace` in one transaction and drops the
browser straight into it. Passwords are scrypt with the work factor recorded
beside the digest, so the cost can be raised later without invalidating anyone.
The session cookie holds a random 32-byte token and the database keeps only its
sha256; it is httpOnly, sameSite=lax, and `secure` outside development.

`?workspace=demo` stays public on purpose — it is what the landing pages link to
and what a prospect evaluates. Every other workspace requires the session that
owns it: naming someone else's slug is refused rather than served, and an
anonymous visitor is pointed at the login form instead of the data.

Sign-in is rate-limited per address (10 failures, 15-minute lock) and signup to
5 workspaces, so one client cannot grind through a list of accounts. Failed
logins take the same time whether or not the address exists.

A brand-new account has no API key, so the dashboard offers to mint one and
shows it exactly once — only a hash is stored. The prompt is scoped to
signed-in workspaces: a stranger on the public demo is never nagged to sign up.
It is a server action rather than a `POST /api/keys` call so the plaintext goes
straight into the page and never into a URL, a referrer, or an access log.

### Password reset and email verification

```
GET  /forgot-password             # request a reset link
GET  /reset-password?token=       # choose a new password
GET  /verify-email?token=         # confirm the address
```

Both links are **POST-only**: the page reads the token, the button redeems it. A
GET that changes state is triggered by link previewers, chat clients and
corporate scanners, so a single Slack unfurl would spend the token before the
person read it.

Tokens are stored hashed (sha256), single-use, and expired — reset in 1 hour,
verification in 24. Issuing a new one deletes the previous, so a link forwarded
last year stops working the moment a fresh one is requested. Reset requests are
rate limited to 3 per address per hour.

Redeeming a reset also **destroys every session on that account**. A password
change that leaves old cookies working evicts nobody, which defeats the entire
point of resetting. The same gap existed in abetConnect and is fixed there too.

The request endpoint answers identically whether or not the address has an
account — a "no such user" there is a customer enumeration oracle.

### Email delivery is honest about itself

`send()` returns which transport actually ran, and the UI says so:

| State | Behaviour |
|---|---|
| `RESEND_API_KEY` or `EMAIL_WEBHOOK_URL` set | Message is delivered; verification is enforced at sign-in |
| Neither set | Link is written to the server log, and the page says plainly that nothing was sent |

An account created with no provider configured starts **pre-verified**, because
enforcing a click on a message that can never arrive would lock the account out
of its own product. With a provider set, sign-up starts unverified, sends the
link, and `signIn` refuses until it is confirmed. A provider outage at
verification is swallowed deliberately — the account exists, and the link can be
re-sent from the dashboard — because failing signup after the row is written
would leave an account nobody can reach.

No new dependency: the HTTP sender is `fetch` only, and `setEmailSender()`
accepts SMTP, SES or anything else without touching a route.

### Teams

Anyone with an account belongs to one or more workspaces, each with a role:
`OWNER` (created at signup, never issuable by invite), `ADMIN`, or `MEMBER`.
Owners and admins invite by email from `/members`; the link is single-use,
expires in 7 days, names one address, and is shown once because only its hash
is stored. Re-inviting rotates the old link dead. Accepting moves the browser
into the new workspace. Removing a seat destroys that person's sessions in it
immediately — revoking access and leaving the cookie working would be the same
mistake twice. The dashboard bar lists every workspace the account can open.

An admin can invite members but cannot mint another admin; only an owner can.
A member cannot invite, see keys, or change seats. Ownership never transfers
through the invite path — that is a decision, not a missing feature.

Set `SESSION_COOKIE` if several of these products ever share one hostname, so
their cookies stay apart. It defaults to `abetworks_session`, which is safe as
long as each product has its own database — a token from one is simply not found
in another's session table.

This file's provenance: the auth surface shipped as one source, byte-copied across six
apps during the Abetworks campaign. The vendoring scripts and drift gate that enforced
identity are retired. This app's copy is its own and can evolve independently.
Full context: `abetworks-history` §8.20 and §8.44.

## Authentication

Every management route is workspace-scoped and requires an API key. A browser session is the other half — see [Accounts](#accounts-browser). `workspaceId`
in the query or body is **checked against the key** — a mismatch is a `403`,
not a silent cross-tenant read.

```bash
# Mint a key for the demo workspace (side-effect free, mints a fresh key)
npm run seed:key            # prints the plaintext once

# Call anything
curl http://127.0.0.1:3300/api/leads?workspaceId=cmu99qk5y0000ni35n530i6ld \
  -H "Authorization: Bearer <paste-key>"
```

Keys are prefixed `lw_live_` so a leaked one is self-identifying. Only a sha256
hash is stored; the plaintext is shown once and cannot be recovered.

| Response | Meaning |
|---|---|
| `401` | No key, unknown key, or a revoked key |
| `403` | Valid key, but that `workspaceId` is not its workspace |

Deliberately **not** key-gated: `GET /api/health`, the provider inbound
webhook receivers (Twilio/WhatsApp/LinkedIn — they authenticate by their own
protocol), and `POST /api/billing/webhook` (Stripe signature).

## API

All routes below need the key from [Authentication](#authentication) —
the snippets omit the header for width.

```
GET    /api/health                         # liveness + DB ping, no key
GET    /api/sources?workspaceId=           # list
POST   /api/sources                        # create (web scraper, API, CSV, manual)
GET    /api/sources/{id}                   # detail + recent jobs
POST   /api/sources/{id}?action=run        # launch a scrape now
GET    /api/jobs?workspaceId=              # list, filter by type/status
GET    /api/jobs/{id}                      # detail + results
POST   /api/jobs/{id}?action=retry|cancel  # re-run or stop
GET    /api/leads?workspaceId=             # list, filter status/minScore
POST   /api/leads                          # create
GET    /api/leads/{id}                     # detail + enrichment log
POST   /api/leads/{id}?action=enrich       # enrich on demand
GET    /api/lead-lists?workspaceId=        # lists
POST   /api/lead-lists/{id}?action=add-leads|remove-leads
GET    /api/enrichment-rules?workspaceId=  # rules
POST   /api/enrichment-rules/{id}?action=run  # run a rule now
GET    /api/exports?workspaceId=           # exports
POST   /api/exports                        # export to CSV/JSON/XLSX/PDF
GET    /api/exports/{id}                   # status + download
GET    /api/webhooks?workspaceId=          # subscriptions
GET    /api/ai/explain-lead?id=            # explain a score in words
```

Duplicates merge on email, phone, LinkedIn or fuzzy name match — the most
complete record wins and nothing is silently dropped. Exports land in
CSV, JSON, XLSX or PDF with scheduled profiles for weekly drops.

## AI (optional)

`GET /api/ai/explain-lead?id=…` returns the deterministic 0–100 score
LeadWorks already computed alongside a plain-English explanation of *why*:
strongest signals first, gaps that would raise the score, and the model's own
confidence. Read-only — the score is never modified. Without `LLM_API_KEY`
the score is still returned with `configured: false`.

Same key setup as LeadGenius (`LLM_API_KEY`, optional `LLM_BASE_URL`,
`LLM_MODEL`, `LLM_TIMEOUT_MS`). Offline contract unit-tested in
`tests/unit/ai-score.test.ts`.

## Billing

$49/month flat via Stripe. Three endpoints under `/api/billing` (workspaceId as query param, no session in this app):

POST /api/billing/checkout
POST /api/billing/portal
POST /api/billing/webhook

`checkout` takes `{ priceId: "FLAT_MONTHLY" | "FLAT_ANNUAL", returnUrl }` and returns `{ url }` for the Stripe-hosted page. A workspace the `Subscription` row says is already trialing, active or past due gets a 409 instead of a second checkout: another session would be another subscription, and nothing cancels the one Stripe is already charging, so a plan switch or a fixed card is the portal's job. The webhook verifies the Stripe signature and syncs `checkout.session.completed`, `customer.subscription.*`, and `invoice.payment_failed` into the `Subscription` row. Setup: create the two prices in Stripe, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FLAT_MONTHLY`, `STRIPE_PRICE_FLAT_ANNUAL`, forward webhooks with `stripe listen --forward-to localhost:3300/api/billing/webhook`. Signature checks are unit-tested offline in `tests/unit/billing.test.ts`.

Every paid plan opens with a 14-day card-up trial (`trial_period_days` on the subscription), so the first invoice is dated two weeks out and the dashboard banner counts the days down to it. Two warnings are armed off the webhook that confirms the trial — delayed BullMQ jobs on `leadworks-billing`, at three days left and one day left — and each one re-reads the `Subscription` row before it mails: a workspace that already converted, cancelled, or had its trial moved gets silence rather than a wrong date. Arming is best-effort in the same shape as every other mail here, so with Redis down the webhook still answers 200 and no nudge is sent; `REDIS_URL` has to point somewhere real for these to arrive. The job id names the trial period, so a Stripe webhook retry cannot double-send. A cancellation is answered the same way: `customer.subscription.deleted` arms a confirmation (no further charge, nothing deleted) and one win-back mail seven days later, both on the same `-billing` queue. Those two are keyed on the Stripe subscription id rather than the workspace, because a subscription is deleted exactly once — a re-delivered event cannot double-send, while a buyer who comes back and leaves again is a new subscription and gets a new pair. Each mails only if the row still says `canceled` *for that subscription id*: a workspace that returned is not a churn risk, and telling a paying customer they are gone is worse than saying nothing. Every billing mail that has to go looking for a person — dunning, conversion, nudge, cancellation, win-back — is addressed by the same `ownerOf` query: the oldest `OWNER` membership, which is the account that ran checkout. Not the Stripe customer, which `ensureCustomer` creates with an empty email. The receipt is the exception, and a good one: its address is the one the buyer typed into the checkout page, so it needs no lookup. The conversion mail is the one that fails quietly, inside a `try`/`catch` that logs: by the time it would be sent the sync has already overwritten the status that made the transition visible, so the retry a non-200 buys has nothing left to announce — a loud failure there deletes the mail rather than delaying it. A declined-payment notice keeps the opposite shape, because nothing is consumed by sending it: if the lookup fails the webhook fails, and Stripe's retry delivers the mail.

## Putting it somewhere

```bash
npm ci
npm run db:deploy
npm run build
npm start
```

Point the load balancer at `GET /api/health` (200 = serving, 503 = DB down).
Queue workers (`src/lib/queue.ts`, BullMQ + Redis) drain scrape, enrich,
export, dedupe, validate, scheduled and leadworks-billing queues. Every job bounds its retention at
construction (`defaultJobOptions: { removeOnComplete: true, removeOnFail: 100 }`) — a
completed job has no reader (`GET /api/health` counts only `waiting`/`active`/`failed`, read
from `src/app/api/health/route.ts`) and the `Job` table is the durable record; failures are
kept, capped, as the only surviving record of their payload. Sitting at construction (not in
`enqueue`) it also bounds the sweep's 1,440 daily calendar jobs, which name no opts of their
own here — the leadgenius convention (#61), ported family-wide (#64). For Postgres, follow the same three
steps as abetConnect: provider switch, fresh migration history, regenerate.

Each of the seven Queues is built on first touch rather than at import: constructing one
connects to Redis even on a `lazyConnect` client, so importing the module wrote six
`bull:<name>:meta` keys — measured on the pre-fix module against a scratch db, rc=124
(never exited) with all six left behind, and dev `REDIS_URL` defaults to db 0. A getter
alone would not have been enough here: `jobRunners` used to hold `Queue` objects as its
values, and that table is evaluated at import, so it read `queues.scrape` and built the
Queue no matter where the construction lived. It holds queue *keys* now and resolves
them inside `enqueueJob`, keeping its compile-time property (a `Job.type` with no runner
is a type error). `src/lib/shutdown.ts` drains the seven workers on SIGTERM/SIGINT,
installed from `instrumentation.ts` in production only, because Next 16.2.12 exposes no
shutdown hook (`InstrumentationModule` is `register` and `onRequestError`, read from its
own `.d.ts`); the drain waits for in-flight Redis setup before closing, and disconnects
rather than quitting. Against a Redis that is not there at all, import-plus-drain exits
0 in 2003ms — the settle bound, not a hang.

The sixth queue is the one that had no producer, and it is the reason any stored schedule
worked. `runScheduledJobs()` — the code that turns a cron that matches into a `Job` row and
a queue entry — had no caller: `startWorkers()` pushed `new Worker("scheduled", …)` and that
was the whole relationship, while db 0 kept `bull:scheduled:meta` with no `:id` counter
beside it, which is bullmq's record of a queue that has never received a job. From outside it
is indistinguishable from an idle queue, because `/api/health` reports `waiting`/`active`/
`failed`, and all three are zero for a queue with a poller and for a queue with a worker.
`registerScheduledSweep()` now supplies it: `upsertJobScheduler` under the fixed key
`leadworks-scheduled-sweep`, `{ pattern: "* * * * *" }`, template name `run-scheduled` — every
minute because `shouldRunNow` in `scheduler.ts` compares the stored cron's *minute* field
against `now.getMinutes()`, so a coarser sweep drops matches. It runs last in `startWorkers()`
and bounded, so a schedule this app cannot add is not reported as six Workers that failed to
start. Bounded is the operative word (#62): a bare `try { await registerScheduledSweep() }
catch` did not save the boot, because against a Redis that answers nothing the call *never
rejects* — bullmq awaits the shared connection's readiness while ioredis reconnects forever at
`maxRetriesPerRequest: null` (`enableOfflineQueue: false` fails commands, but none is issued
while readiness is pending). Measured on :6399 with nothing listening: `startWorkers()` was
still pending past 12s, so "LeadWorks workers started" never printed and the boot never
finished — it neither failed loudly nor hung cleanly. `awaitWithRegistrationTimeout` now races
the registration against `SWEEP_REGISTER_TIMEOUT_MS` (5s, ~25× the healthy ~0.2s) and returns
`registered` / `failed` / `timed-out`, logging the two non-registered outcomes distinctly. The
rejection handler is on the registration promise itself (two-arg `then`, not a `.catch` on the
race) so a Redis that errors *after* the timeout is consumed there rather than surfacing as an
unhandledRejection — the same care `shutdownWorkers` takes with an abandoned `waitUntilReady()`.
Measured after: dead-Redis `startWorkers()` resolves at ~5.3s and the boot completes (a later
boot that reaches Redis registers the sweep); live resolves in 0.3–0.7s and the scheduler
lands. `GET /api/health` on that dead URL already answered 200 with
`{"db":"up","queues":{"error":"redis unreachable"}}`, so the fix is the boot finishing, not a
new health state. Guarded in `tests/unit/queue.test.ts`: the structural net that startWorkers
must bound it (not the bare await) and branch the outcomes, plus `awaitWithRegistrationTimeout`
driven offline with a never-settling promise, a rejecting one, and a promise that rejects only
*after* the timeout (asserted to raise no unhandledRejection). The fixed key is what makes calling it from every boot safe: measured across
two separate processes on a scratch db, the second upsert leaves
`getJobSchedulersCount()` at 1 with the same `repeat:leadworks-scheduled-sweep:<boundary>` job
id, and `bull:scheduled:repeat` holds one member. Proven end to end on a dev boot against db 13
and a copy of `dev.db` — one sweep consumed per minute boundary, and an active source with
`schedule = "* * * * *"` minted exactly one `Job` row per boundary, which the `scrape` worker
then drained and wrote back to `Source.lastRunStatus`. Rule 10 of the retired
`shared/check-queues.sh` gate asserted the same shape family-wide
(see `abetworks-history` §8.26.10); after the split, `tests/unit/queue.test.ts`
here is the only thing that pins it — the key, the pattern, the wiring and the
dedupe (that last one as a db-13 probe, run with `QUEUE_PROBE_URL=redis://localhost:6379/13`).
