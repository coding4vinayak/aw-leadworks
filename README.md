# LeadWorks

![CI](https://github.com/coding4vinayak/aw-leadworks/actions/workflows/ci.yml/badge.svg)


Lead sourcing and enrichment. Find the buyers who are already looking —
$49/month.

Sources (web scrapers, APIs, CSV uploads, manual entry) feed jobs; jobs
scrape, enrich, validate, dedupe and export. Every lead carries a 0–100
quality score, enrichment provenance, and a validation trail. The score is
computed from the row's own signals by one module, which stores its work with it.

## Quick start

```bash
npm install
cp .env.example .env        # DATABASE_URL points at the compose Postgres
docker compose up -d        # local Postgres 16
npx prisma migrate deploy   # applies the committed migrations
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

The whole API is also described by one machine-readable document, in the
OpenAPI 3.1 format every API tool probes first:

- `/api/openapi` — the versioned home of the contract
- `/openapi.json` — the conventional discovery path, the same document

Read it without a key (a contract is a description, not data). It cannot
drift from the product by hand: `npm run check:contract` compares every claim
in it with the routes that serve it — every documented call has a route that
answers it and vice versa, every request body is compared with the app's own
declared field table (`src/lib/fields.ts`), the door a route enforces is the
door the spec advertises, and the version is this app's own. It runs in CI,
and it fails naming the lie.

**The deep-content file**: `GET /llms-full.txt` carries the shipped index
(`llms.txt`) verbatim and then every operation the contract answers, each with
its own summary and the door it declares — built from those two sources, not
from hand-written prose, so it cannot say more than the product does.
`npm run check:llms-full` (in CI) fails naming the first line that moved
against a stale index or contract; rebuild with `npm run build:llms-full`.

All routes below need the key from [Authentication](#authentication) —
the snippets omit the header for width.

```
GET    /api/health                         # liveness + DB ping + whether this instance
                                           # can scrape, no key
GET    /api/sources?workspaceId=           # list; `?isActive=` takes one word — `true`
                                           # or `false` — and nothing else is the other
                                           # state's page (see *A boolean is two words*)
POST   /api/sources                        # create (web scraper, API, CSV, manual); a
                                           # `schedule` is refused unless some minute can
                                           # match it (see *the cadence somebody types*),
                                           # and a `config.url` unless this server is
                                           # allowed to open it (see *what a scrape is
                                           # allowed to point at*)
PATCH  /api/sources/{id}                   # rename, retype, or set/clear the cadence; a
                                           # `config` it names is judged as a create would
GET    /api/sources/{id}                   # detail + recent jobs
POST   /api/sources/{id}?action=run        # launch a scrape now — 400 for an address this
                                           # server will not open, 503 when this instance
                                           # has no browser, and no `Job` row in either case
GET    /api/jobs?workspaceId=              # list, filter by type/status — one word each,
                                           # spelled as the column spells it (see *a filter
                                           # word is not a crowd*)
GET    /api/jobs/{id}                      # detail + up to 50 per-item results, beside a
                                           # `report` that says whether this row's
                                           # percentage has a denominator to be taken over
POST   /api/jobs/{id}?action=retry|cancel  # stop it, or restart it: a worker that is running
                                           # reads the mark before its next row, finishes the
                                           # row already in flight, and stamps CANCELLED with
                                           # the arithmetic of the rows it actually did — and a
                                           # row carrying that mark is one `?action=retry` may
                                           # be taken from, which makes a new job over the
                                           # crowd the stopped one's config names
GET    /api/leads?workspaceId=             # list, filter status/minScore; `?status=` is one
                                           # `LEAD_STATUSES` word and a wrong one is a 400 that
                                           # names the set; `?fields=` projects each
                                           # row onto the columns named, the same names
                                           # `POST /api/exports` takes `fields` from, and a name
                                           # that is not a Lead column is a 400, not the page
POST   /api/leads                          # create
POST   /api/leads/import                   # CSV import (text/csv or JSON)
GET    /api/leads/{id}                     # detail + enrichment log
PATCH  /api/leads/{id}                     # update; `{score}` is an override, not a write (see Score below)
POST   /api/leads/{id}?action=enrich       # visit the one lead the URL names
GET    /api/lead-lists?workspaceId=        # lists
GET    /api/lead-lists/{id}                # one list, a page of its members, and what the whole membership counts
POST   /api/lead-lists/{id}?action=add-leads|remove-leads|refresh
                                          # `refresh` asks the row, never the body: a list whose
                                          # `isDynamic` is true re-runs the `filterJson` it stores
                                          # and its members become the leads that filter names
GET    /api/enrichment-rules?workspaceId=  # rules; the same `?isActive=true|false`, judged
                                           # by the same two words (see *A boolean is two
                                           # words*)
POST   /api/enrichment-rules               # create; `conditions` and `actions` are both required, and both are read
PATCH  /api/enrichment-rules/{id}          # change a rule; conditions and actions are re-checked as a pair
POST   /api/enrichment-rules/{id}?action=run  # run a rule now → { jobId, appliesTo }
GET    /api/exports?workspaceId=           # list, filter by status — the four words an Export
                                           # row holds, not the five a Job row holds
POST   /api/exports                        # export to CSV/JSON/XLSX/PDF; a `filterJson.status`
                                           # no Lead column can hold is refused before the row
                                           # exists, not delivered as an empty file
GET    /api/exports/{id}                   # status + download
POST   /api/exports/{id}?action=retry      # the door's other half: `?action=download` answers a
                                           # URL only while the row names bytes that are there,
                                           # and `retry` takes a `FAILED` row — including one an
                                           # operator stopped, whose record names no file and
                                           # whose bytes its own worker took back — and makes a
                                           # fresh export of the same crowd
DELETE /api/exports/{id}                   # delete the record — and, when it named one, the file it wrote
GET    /api/webhooks?workspaceId=          # subscriptions, not their signing
                                           # secrets — see *Webhooks (outbound)*
POST   /api/webhooks                       # subscribe; deliverable events are
                                           # the three the product emits
                                           # (see *Webhooks (outbound)*)
GET    /api/ai/explain-lead?id=            # explain a score in words
```

Duplicates merge on email, phone, LinkedIn or fuzzy name match — the most
complete record wins and nothing is silently dropped. Exports land in
CSV, JSON, XLSX or PDF with scheduled profiles for weekly drops, and every finished
export carries the date its own download door closes (`EXPORT_RETENTION_MS`, seven
days by default); one sweep minute after that date the file itself is gone, and deleting the
record takes the file with it in the same request — see *How long an export's file answers* and
the two sections after it.

### Importing a list

`POST /api/leads/import` takes the list a buyer already has, as `text/csv` or as
JSON `{ "csv": "..." }` (the dashboard uses the same importer through a server
action, so the browser never needs a key):

```bash
curl -X POST http://127.0.0.1:3300/api/leads/import \
  -H "Authorization: Bearer $LEADWORKS_KEY" \
  -H "Content-Type: text/csv" \
  --data-binary @leads.csv
```

The first row must be a header. Aliases such as `E-mail`, `Company Name`,
`First Name` and `LinkedIn URL` are understood, and a row is accepted with an
email, phone or LinkedIn URL. Up to 1,000 rows / 5 MB per request. Duplicates —
within the file or already in the workspace, matched case-insensitively by
email — are skipped, never merged or silently overwritten. The response reports
`imported`, `total`, `invalid`, `duplicatesInFile`, `duplicatesExisting`, up to
50 `problems` each with the real file line, and `webhooks` — the count of what
the `lead.created` fan-out did for this file (`subscriptions`, `attempted`,
`delivered`, `refused`, `noAnswer`, `blocked`, `lastError`), so a batch whose
subscriber answered 500 is not reported the same way as a workspace that has no
subscriber at all. The dashboard shows the first
five and downloads the whole report as CSV (`line,field,message`); cells use the
same formula-escaping rule as an export. Every created row emits `lead.created`,
the same event `POST /api/leads` emits.

Unlike discovery from a source — which merges on email, phone, LinkedIn or a
fuzzy name match — an import is the customer's own list: a duplicate address is
not a better record, it is the same person twice.

### An enrichment rule applies the conditions it declares

`schema.prisma` declares `EnrichmentRule.conditions Json // When to apply this
rule`, and `POST /api/enrichment-rules` requires the field: a rule cannot be
created without saying when it applies. Until now nothing read it back. The
three doors that pick leads — the scheduled sweep in `src/lib/scheduler.ts`, the
worker's `getLeadsToEnrich`, and `runScheduledEnrichment` — each carried their
own `status: { in: ["NEW", "ENRICHED"] }`, so `{ status: "NEW" }` selected the
same crowd as `{ status: "CONVERTED" }`, and the seeded rule named *Auto-enrich
new leads* did not mean its own name.

A condition names one of four `Lead` attributes:

```json
{ "status": "NEW", "seniority": ["VP", "C_LEVEL"], "score": { "gte": 60 }, "tags": ["high-intent"] }
```

One value or a list; the two enums are folded to the uppercase the column spells
and any other word is refused with the column's own list quoted; `score` takes
whole-number bounds inside 0-100, and an inverted pair is refused because no
number is both. Keys the schema has no column for — `department`, `region` — are
refused by name, every problem in one 400, because a filter on a column that does
not exist matches nothing forever and looks like a quiet week.

What is stored is the normalized shape, and what runs is one translation of it
(`leadWhere`), shared by all three doors, so the minute that queues a job and the
worker that runs it cannot pick different crowds. Two rules keep the rewrite from
widening what a rule already did: a rule that declares *nothing* keeps
`NEW | ENRICHED` rather than the whole workspace, and a stored blob that cannot
be read selects nobody — the schedule skips it with a log line, `?action=run`
answers 400 (that call has a caller to tell), and a job that arrives with such a
config enriches zero rows. `?action=run` answers `appliesTo` in words
(`status NEW, seniority VP or C_LEVEL`) so an operator can see what they just
fired.

Tags are the one attribute compared exactly, both in SQL and in memory: measured
against this workspace's own seeded leads (`["vip", "dubai"]`),
`array_contains` with `vip` returned 2 rows and with `VIP` returned 0, so
upper-casing a tag at the door would store a rule the query cannot honour. The
worker re-checks every row it fetched with the same declaration before writing to
it, which can only narrow what is enriched.

Pinned offline by `tests/unit/rule-conditions.test.ts` (46: the schema's own
words, every refusal, both readings of one declaration agreeing, and a scan
showing each door calling the translation in the right order with the hardcoded
set gone from `src/` entirely). The live proof — three unspeakable declarations
refused 400 by name, then four accepted rules visiting 2, 2, 0 and 0 leads out of
the 24 NEW leads the workspace holds: a tag, that tag AND a seniority that fits,
that tag AND a seniority that cannot, and the same tag written in capitals — is
`demo/run-demo.sh leadworks` STEP 9. What that step measures is *reach*: which
leads a rule puts in front of the worker, read off the job's own per-lead
counters. What a visit then writes is the next section, and STEP 10.

## Enrichment: what a visit may write

The rule decides the crowd; the provider decides the value; and until this round
the write itself was broken in a way no counter showed. `enrichLead` returned the
providers' answers plus a `confidence` number, `updateLeadEnrichment` spread that
straight into `prisma.lead.update`, and `Lead` has no `confidence` column — so
Prisma refused the whole update, every lead a rule named landed in
`Job.failedItems`, and the row kept `lastEnrichedAt: null`. Measured against the
running app: `processed=0, failed=2` for a rule aimed at two leads, enrichment
writing nothing for anybody while reporting itself as failing. Had the spread not
thrown, the same line would have written `score: 5` over a lead whose real signals
earned 82, because the score was computed from the provider's return value rather
than from the row. And `EnrichmentLog.workspaceId` was the literal `""`.

`src/lib/enrich-plan.ts` owns the write now, and `src/lib/enrichment.ts` uses it:

- **A real column, into a gap, or nothing.** `ENRICH_WRITABLE` is the set of `Lead`
  columns an enrichment may fill — `score`, `scoreOverride`, `scoreBreakdown`,
  `scoredAt`, `status`, `tags`, `validationResults` and the row's identity are not in
  it. A field the row already holds is left
  alone, so enrichment is additive and running it twice changes nothing. A value
  whose shape the column cannot hold (a bare string where `technologies` is a list
  of words) is dropped, not coerced; the log row still carries what the provider
  said.
- **No score arrives, none is invented.** The plan rejects a provider that tried to
  answer with `score`, because a vendor's return value is not a person's worth. What
  the visit *does* move is the row's own number: the write goes through
  `scoredWriteData`, so filling `seniority` from a title re-prices the lead by the
  table in the section below — 57 for the `Managing Director` the demo runs, beside
  the 82 someone typed.
- **One status, earned.** A lead that was `NEW` and gained a field becomes
  `ENRICHED` — the schema's own word for it, and the only code in the product that
  moves a row into it. A qualified, contacted, converted or rejected lead is never
  pulled back by a background job.
- **A visit that learned nothing says so.** `lastEnrichedAt` is the honest stamp of
  "the worker looked at this row", so it is written either way, and the log's
  status is `PARTIAL` when no column was filled. That is the true state of every
  provider in this build except `derive`, and a log line claiming `SUCCESS` would
  be the second way this job lied.

`derive` is the one provider that works without a key: `src/lib/seniority.ts` reads
the `seniority` a person's own title states. It fills a gap and never argues with a
typed value; it **abstains** — a title outside the table returns `null`, not
`UNKNOWN`, because that word is a judgment someone makes about a person; and the
phrases are matched before the single words, because `Vice President` contains
`President`, `Managing Director` contains `Director` and `General Manager` contains
`Manager`, each at a different rung than the title means. `Head of Growth`,
`Team Lead`, `Principal`, `Architect`, `EVP` and `Chief of Staff` have no entry on
purpose: they mean different rungs at different companies.

The other six names — `apollo`, `clearbit`, `hunter`, `linkedin`,
`clearbit_company`, `apollo_company` — are the call sites a key belongs in. They are
dispatched and they return nothing until they are configured. They used to return
invented data (`industry: "SaaS"`, `companySize: "51-200"`, `revenue: "$10M-$50M"`),
which is worse than silence: the fiction lands in a customer's row and reads like
research. A rule that listed a name nothing implements used to be stored, read by
the worker and answered with silence, so the operator who typed `"hubspot"` watched
a workspace fill with leads that never got the fields they asked for; the rules API
now refuses it with the list of names the worker dispatches on, and folds `Apollo`
onto the spelling the dispatch table compares (`enrichment-providers.ts`).

### What the row said before a visit changed it

`schema.prisma` declares `EnrichmentLog.beforeData Json?` beside `afterData Json?` —
the audit pair, one column for what the row said and one for what landed. Only the
second was ever written. Measured against the running app before this round, over three
leads sharing the title `Chief Operating Officer` and one provider: the lead whose typed
`VP` outlived the provider's `C_LEVEL`, and the lead whose provider answer the rule's own
declaration had pruned away, left **byte-identical** log rows —
`["PARTIAL", [], null, {}, "derive"]`. `beforeData` was `null` in all three, including the
gap case where something *was* written, so the row held nothing or the row refused to say
and the record did not tell them apart. Two opposite facts — "the row's own word won" and
"nobody asked for that" — were stored as one silence.

`planEnrichmentWrite` reports the row's own words now, and `updateLeadEnrichment` stores
them.

- **`before` is keyed by what was *answered*, never by what was written.** That is the
  point of the pair: `fieldsEnriched` says what changed and `beforeData` says what the row
  said, which makes a refusal a recorded fact instead of an empty string.
- **`null` in that record is the row saying it held nothing.** Enrichment here is additive,
  so the first visit to an empty column logs `{"seniority": null}` and the second logs
  `{"seniority": "C_LEVEL"}` — the same rule, two honest rows.
- **The row's own value is recorded even when nothing lands.** A provider handing back a
  bare string for a column that holds a list — `"React"` where the row has `["React"]` —
  is not coerced, and until this round that refusal left no trace; the row now says
  `{"technologies": ["React"]}` beside an empty `afterData`. A blank `"  "` and an empty
  `[]` are recorded as the gaps they are, and get filled.
- **A column the rule's declaration pruned never reaches this plan, so it is absent here
  too.** The pruning happened upstream in `restrictToDeclared`, and this module does not
  invent a value for an answer it was never shown.
- **One plan per visit, one log row per plan.** Both halves plus `fieldsEnriched` are
  arguments to the same single `enrichmentLog.create`, so the pair can never describe two
  different visits. `logEnrichmentError` writes neither half: nothing was answered, so
  there is nothing the row could be said to have been asked.

`GET /api/leads/{id}` includes `enrichmentLogs` with no `select`, so both halves arrive
with the row. `explain-lead` still cites only `afterData` — what landed, not what was
there before — which is the one read surface this round left alone.

Pinned offline by `tests/unit/enrich-provenance.test.ts` (18: the schema already asked for
both halves; `before` keyed by the answer set and not the write set; a gap as `null`; a
blank and an empty list kept as the row said them; a dropped shape mismatch visible while
nothing lands; a pruned column absent; the refusal and the pruning having different
signatures; the record surviving a JSON round trip; the second visit; and a mixed list
where `written` is two columns while `before` is three — plus a source scan showing the
triple in one create call, one plan per visit, no invented halves on a thrown visit, the
detail door returning whole log rows, and #29's score and status invariants untouched).
The live proof is `demo/run-demo.sh leadworks` STEP 14: the lead that kept its `VP` logs
`beforeData {"seniority": "VP"}` while the lead whose answer was pruned logs `{}` —
*after* agreeing with it on `status`, on the empty write list and on the empty
`afterData`, which is exactly the byte-identical pair this round exists to split; the lead
with the real gap logs `{"seniority": null}` beside `{"seniority": "C_LEVEL"}`, `SUCCESS`,
`ENRICHED` and **47 → 53**; a provider that read the title and abstained (`derive` answers
nothing for `Head of Growth`) still records the visit — a stamp, a `PARTIAL`, and nothing
in either half of the audit; and running the same rule a second time logs `PARTIAL` with
`beforeData {"seniority": "C_LEVEL"}`, both rows readable side by side on the lead. 10
checks in this step, and the whole run against this build is **129 ✓ / 0 ✗**, exit 0.

What this does not claim: the abstaining provider and the pruned answer are *one* record,
because in both cases nothing reached the plan. What separates them is the rule's own
`actions` — printed above each row in that step, and stored on the rule — not anything the
log invents.

The count above is the build this section landed on. The demo's next step adds ten more
checks and prints the count against that one.

The count the run prints belongs to the build this section landed on. The demo's next step
adds ten more checks and prints the count against that one.

### The button on a lead's own row

`POST /api/leads/{id}?action=enrich` is the one door that names a person rather than a
rule, and until this round the id in its URL was decoration: it queued a job whose
config carried no `conditions` and no lead at all, the worker read the workspace's
default crowd — **every lead, `take: 1000`** — and visited all of them, with the three
providers it hardcoded (`apollo`, `clearbit`, `hunter`) that answer nothing without a
key. Measured against the running app before this round's fix, on a workspace holding 20
leads: one click on one lead's row reported **`processed=20`**, and because every
provider stayed silent, the sweep filled no column and left no stamp either — all 20
rows still `lastEnrichedAt: null`, `totalItems: 0`, the whole list walked for nothing.

The door now says who it means. `EnrichmentConfig.leadIds` is the crowd a job may
visit, read as the caller-writable JSON it is (`namedLeads` in
`src/lib/lead-crowd.ts`: non-strings dropped, blanks dropped, duplicates folded, a
non-array or an empty list meaning *not named*), and the query stays scoped to the
job's own `workspaceId` whichever way it goes — an id belonging to another tenant
visits nobody. `?action=enrich` writes `leadIds: [id]`, and lists `derive` first,
because a keyless box has exactly one provider that answers. A job carrying both a rule
and a crowd visits the intersection: the id named must still satisfy the rule's
`conditions`, because **filtering can only narrow**.

Pinned offline by `tests/unit/enrich-write.test.ts` (42: the schema's own words, the
title table answer for answer, the provider list checked against the worker's
`PROVIDER_IMPLEMENTATIONS` table in both directions from the source, the write plan's
every refusal, and a scan of the worker and both rule doors) and
`tests/unit/lead-crowd.test.ts` (16: every shape a caller can write into a job config
and which of them mean *not named*, that naming narrows a scope without ever replacing
or widening it, and a source scan showing that the only module on the job path which
spells an `id: { in: … }` is `lead-crowd.ts`). The live proof is
`demo/run-demo.sh leadworks` STEP 10: three leads arrive with a title and no
seniority, each carrying a score of 82 a person set. After one run of a rule listing
`derive`, the `Managing Director` reads `C_LEVEL` and `ENRICHED` (not `DIRECTOR`,
the word inside the title), the `Product Manager` whose seniority a rep typed as
`VP` is untouched, and `Head of Growth` gained nothing and is not filed as
`UNKNOWN`; all three carry the visit's stamp, all three still read the 82 a person
typed — held as an override, with the 57 the `Managing Director`'s own signals earned
written beside it — and the
rule's own log reads one `SUCCESS` with `fieldsEnriched: ["seniority"]` beside two
`PARTIAL` with an empty list. A second run reaches the same three leads and fills
nothing.

STEP 12 is the same visit asked for by the row's button rather than by a rule. Four
leads arrive; the workspace holds **19**. One `POST /api/leads/{id}?action=enrich` on
the `Chief Operating Officer` comes back `COMPLETED: processed=1 failed=0 total=1`, its
job row carrying `leadIds: ["cmvhnw…"]` and `providers: ["derive"]`; that row reads
`C_LEVEL` / `ENRICHED`, its score moved **47 → 53** by the seniority the visit filled,
and the other three are unwritten — no stamp, no status. Across the whole workspace the
rows carrying `lastEnrichedAt` went **0 → 1**: one stamp for one named lead, where the
same click used to walk 19 rows and stamp none. The same door opened on a
`Head of Facilities` visits exactly one row again, stamps it, and invents nothing —
`seniority` still empty, `status` still `NEW`, the score still the 47 it arrived with.

### What a rule says to enrich, and when it says to run

`schema.prisma` declares `EnrichmentRule.actions Json // What enrichment to perform`,
and `POST /api/enrichment-rules` requires the field. Until this round nothing performed
it: one column had two readers and honoured neither. `scheduler.ts` asked
`shouldRunNow(typeof rule.actions === "string" ? rule.actions : "", now)` — the JSON
(`shouldRunNow` is the matcher `scheduler.ts` kept until #38 replaced it with
`cron-schedule.ts`; the coercion above is what was measured, not what ships now)
object every door requires, coerced to `""` — and both run doors queued `fields: []`
whatever the rule declared.

Measured against the running app before the fix. A `SCHEDULED` rule whose actions held
`{ fields: ["seniority"] }` queued **nothing across three sweep minutes**, while the
same rule with a bare `"* * * * *"` in that column queued **one job a minute**: the only
shape the sweep could act on was one the create door refuses. And two rules over
identical `Chief Operating Officer` leads — one declaring `industry`, one declaring
`seniority` — left identical rows, because the `derive` provider's answer filled
`seniority` under both and the declaration was never consulted.

`src/lib/rule-actions.ts` reads it now, and both halves are honoured.

- **`fields` is the list the visit is narrowed to.** What a provider answered passes
  through `restrictToDeclared` before the write plan sees it: the list can only remove
  columns, never add one the provider did not give or reorder what stays. An absent list
  is not "no columns" — it is the rule saying nothing about which columns, which is how
  every job in this build was queued before the declaration was read, and it is what the
  single-lead door still sends, so STEP 12's visit is untouched. What a visit may write
  at all remains `enrich-plan.ts`'s decision; this narrows it further and never widens it.
- **`schedule` is the cron the minute is matched against**, read by `lib/cron-schedule.ts`
  — the grammar and the matcher in one module, stored in the single-space form it splits,
  and asked the same way by every door that keeps a cadence.
- **A declaration this build cannot honour is refused at the door that would store it,**
  every problem in one 400, with the offending part quoted: a key nothing performs
  (`enrich` was this repo's own demo spelling), a column no write knows — the refusal
  quotes the list `ENRICH_WRITABLE` owns, which `rule-actions.ts` imports instead of
  re-spelling — an empty list, a cadence holding a weekday or month name, a `?`, a step of
  `0`, a range that runs backwards or a number outside its field's range, and the one
  pairing the blob cannot state about itself: a `SCHEDULED`
  rule with no cadence is stored, active and never swept, and a cadence on any other
  trigger is stored and never swept. Both halves of that are checked on the edit door
  too, against whichever half the request left alone, so flipping `trigger` to
  `SCHEDULED` cannot smuggle in the row the create door refuses.
  *#38 retired one clause of this list:* a step (`*/5`) or a range (`9-17`) used to be
  refused here on the matcher's behalf, because the matcher split each field on `,` and
  compared whole strings. That matcher is gone; the two shapes are cadences now, they are
  accepted at every door that stores one, and the rest of the list is still refused.
- **Junk already in the column contributes a log line and skips the rule**, the way
  unreadable `conditions` already do, and `?action=run` answers 400 instead, because
  that call has a caller to tell.
- **A column is folded to the spelling the row uses.** `ENRICH_WRITABLE` is camelCase
  because the columns are: the first cut of this module lower-cased every word and so
  refused `{ fields: ["companySize"] }` as `"companysize"` — a bug this round's own demo
  measured, then fixed by matching case-insensitively and storing the canonical name.

Pinned offline by `tests/unit/rule-actions.test.ts` (35: the two keys and nothing else,
every refusal's wording checked against the list it quotes, the cadence accepted field by
field and refused by name, the trigger pairing in both directions, what a declared list
does to an answer, and a source scan showing both doors refusing before they store, the
sweep matching the declared cadence with the coercion gone from `src/`, the worker
narrowing after its answered-guard, and the shipped seed still acceptable to the shipped
door). The live proof is `demo/run-demo.sh leadworks` STEP 13: the six refusals above
answered 400 by name; then two rules over the same title — the one asking for `seniority`
writes `C_LEVEL`, `ENRICHED` and **47 → 53** with a `SUCCESS ["seniority"]` log, while the
one asking for `industry` writes no seniority at all, is stamped as a visit all the same
and logs `PARTIAL []`, because a provider's opinion about a column the rule did not ask
for is not written into anybody's row. A `SCHEDULED` rule declaring
`{ fields: ["seniority"], schedule: "* * * * *" }` queued its first job after **39 s** and
wrote that column on the lead its conditions name — the same rule used to queue none at
any hour; a cadence on a rule being demoted to `MANUAL`, and a cadence dropped from a
scheduled rule, are both refused on the way out; and `" 30  9 * * 1 "` is accepted and
stored as `"30 9 * * 1"` — 22 checks in this step, and the whole run was **119 ✓ / 0 ✗**, exit 0,
on that build; STEP 14 below adds 10 checks and prints the count against this one.

### What the row said before a visit changed it

`schema.prisma` declares `EnrichmentLog.beforeData Json?` beside `afterData Json?` —
the audit pair, one column for what the row said and one for what landed. Only the
second was ever written. Measured against the running app before this round, over three
leads sharing the title `Chief Operating Officer` and one provider: the lead whose typed
`VP` outlived the provider's `C_LEVEL`, and the lead whose provider answer the rule's own
declaration had pruned away, left **byte-identical** log rows —
`["PARTIAL", [], null, {}, "derive"]`. `beforeData` was `null` in all three, including the
gap case where something *was* written, so the row held nothing or the row refused to say
and the record did not tell them apart. Two opposite facts — "the row's own word won" and
"nobody asked for that" — were stored as one silence.

`planEnrichmentWrite` reports the row's own words now, and `updateLeadEnrichment` stores
them.

- **`before` is keyed by what was *answered*, never by what was written.** That is the
  point of the pair: `fieldsEnriched` says what changed and `beforeData` says what the row
  said, which makes a refusal a recorded fact instead of an empty string.
- **`null` in that record is the row saying it held nothing.** Enrichment here is additive,
  so the first visit to an empty column logs `{"seniority": null}` and the second logs
  `{"seniority": "C_LEVEL"}` — the same rule, two honest rows.
- **The row's own value is recorded even when nothing lands.** A provider handing back a
  bare string for a column that holds a list — `"React"` where the row has `["React"]` —
  is not coerced, and until this round that refusal left no trace; the row now says
  `{"technologies": ["React"]}` beside an empty `afterData`. A blank `"  "` and an empty
  `[]` are recorded as the gaps they are, and get filled.
- **A column the rule's declaration pruned never reaches this plan, so it is absent here
  too.** The pruning happened upstream in `restrictToDeclared`, and this module does not
  invent a value for an answer it was never shown.
- **One plan per visit, one log row per plan.** Both halves plus `fieldsEnriched` are
  arguments to the same single `enrichmentLog.create`, so the pair can never describe two
  different visits. `logEnrichmentError` writes neither half: nothing was answered, so
  there is nothing the row could be said to have been asked.

`GET /api/leads/{id}` includes `enrichmentLogs` with no `select`, so both halves arrive
with the row. `explain-lead` still cites only `afterData` — what landed, not what was
there before — which is the one read surface this round left alone.

Pinned offline by `tests/unit/enrich-provenance.test.ts` (18: the schema already asked for
both halves; `before` keyed by the answer set and not the write set; a gap as `null`; a
blank and an empty list kept as the row said them; a dropped shape mismatch visible while
nothing lands; a pruned column absent; the refusal and the pruning having different
signatures; the record surviving a JSON round trip; the second visit; and a mixed list
where `written` is two columns while `before` is three — plus a source scan showing the
triple in one create call, one plan per visit, no invented halves on a thrown visit, the
detail door returning whole log rows, and #29's score and status invariants untouched).
The live proof is `demo/run-demo.sh leadworks` STEP 14: the lead that kept its `VP` logs
`beforeData {"seniority": "VP"}` while the lead whose answer was pruned logs `{}` —
*after* agreeing with it on `status`, on the empty write list and on the empty
`afterData`, which is exactly the byte-identical pair this round exists to split; the lead
with the real gap logs `{"seniority": null}` beside `{"seniority": "C_LEVEL"}`, `SUCCESS`,
`ENRICHED` and **47 → 53**; a provider that read the title and abstained (`derive` answers
nothing for `Head of Growth`) still records the visit — a stamp, a `PARTIAL`, and nothing
in either half of the audit; and running the same rule a second time logs `PARTIAL` with
`beforeData {"seniority": "C_LEVEL"}`, both rows readable side by side on the lead. 10
checks in this step, and the whole run against the round #33 build was **129 ✓ / 0 ✗**, exit 0;
STEP 15 below prints the count against this one.
checks in this step, and the whole run against this build is **129 ✓ / 0 ✗**, exit 0.

What this does not claim: the abstaining provider and the pruned answer are *one* record,
because in both cases nothing reached the plan. What separates them is the rule's own
`actions` — printed above each row in that step, and stored on the rule — not anything the
log invents.

### When two rules want the same column in the same minute, the ranking says which one

`schema.prisma` declares `priority Int @default(0)` on `EnrichmentRule`, both rule doors have
always accepted it, and the list door has always handed it back. Nothing ordered by it.
Measured against the running app before this round — one lead, three `SCHEDULED` rules over it
each asking `seniority`, created in the order 10, 90, 50: `GET /api/enrichment-rules` returned
**50, 90, 10** (`createdAt` reversed, the number the operator set in none of it); the sweep
queued them **10, 90, 50** (its `findMany` carried no `orderBy` at all, so the order the
storage engine handed the rows back in was the order they were applied in); and **the rule
that filled the column was the one queued last** — `prio=50` logged `SUCCESS ["seniority"]`
with `beforeData {"seniority": null}` while `prio=10` and `prio=90` logged `PARTIAL []` with
`beforeData {"seniority": "C_LEVEL"}` — because the `enrich` worker runs five jobs at a time,
so the three raced for one lead and whichever write landed first won it. Two sweep minutes
later that single lead carried **six log rows, each recording `creditsUsed: 1`**, five of the
six visits being refusals that were guaranteed before any provider woke up.

An `orderBy` alone would not have made the ranking true: reordering a race leaves the race to
decide the column. What a ranking *can* decide is who owns a column, and that has to be
settled before anything is queued. `src/lib/rule-priority.ts` settles it — the rules due in
one workspace are walked highest-ranked first, each claims the columns its own `actions.fields`
asked for, and the next rule in line gets what remains. Or nothing remains, and it queues
nothing at all.

- **The order is total, and it is spelled once.** `priority desc`, `createdAt asc`, `id asc`
  is `RULE_PRIORITY_ORDER`; the list door and both sweeps quote that one constant, so what an
  operator reads and what the minute does are the same rule twice rather than two rules that
  drift. The tie-breaks are not decoration: three rules created in a loop land milliseconds
  apart, and `id` is what makes that a defined order instead of a coin toss — at the page
  boundary as well as in the walk.
- **A rule claims what it *asked* for, never what a provider answered.** The plan is decided
  before any provider wakes, so the same rules produce the same plan whatever `derive` happens
  to say. That is why the lower-ranked rule's job carries `["companySize"]` rather than the
  `["seniority", "companySize"]` it asked for: the narrowing happens at the queue, not at the
  write, which is the only place a concurrent worker cannot undo it.
- **A rule left with nothing visits nobody.** No job, no log row, so nothing recorded against
  `creditsUsed`, and no `lastEnrichedAt` stamp — #29's rule holds: a timestamp nobody asked for
  is a lie. The skip is a line in the server log naming the columns it was left without and
  that a higher-ranked rule owns this minute.
- **Who may write is still decided elsewhere.** `ENRICH_WRITABLE` bounds the columns a visit
  may touch, `restrictToDeclared` (#32) prunes what a provider answers down to what the rule
  asked for, and `planEnrichmentWrite` (#33) records what the row said. The ranking says whose
  word lands first, which is a different question — and the one the column advertised.
- **`?action=run` is deliberately unranked.** A named rule run because an operator pressed the
  button is an explicit request, and the operator outranks every number in the table; that door
  still sends the rule's own `fields`. A source test pins that it carries no ranking at all.
- **A rule that names no columns claims them all.** `actions.fields` absent means "the rule did
  not say" (#32's reading), and a rule that did not say wants whatever its provider answers, so
  it owns every writable column for this minute. Ranking is exclusivity, and a broad rule
  outranks a narrow one by its number rather than by its breadth.

`priority` is validated as an int in `0..100` at both doors, importing `PRIORITY_MIN` and
`PRIORITY_MAX` from the module that walks the ranking so the refusal and the walk cannot
disagree about what a number means: `101` and `9999999` are `priority must be at most 100`,
`-1` is `priority must be at least 0`, `"2"` is refused as text and `1.5` as a fraction, and
`null` as `priority cannot be null; omit it to leave the value alone`.

Pinned offline by `tests/unit/rule-priority.test.ts` (27: the schema's own `@default(0)`; both
door tables quoting the module's constants instead of repeating them; the six refusals above,
and an absent key meaning no `priority` in the patch at all; the shipped seed's `priority: 1`
still storable; 90/50/10 ordering with a `createdAt` tie and an `id` tie plus antisymmetry, so
no sort is at the mercy of input order; `RULE_PRIORITY_ORDER` being exactly those three keys and
agreeing with the comparator; `rankRules` leaving the caller's array alone; `planTick` keeping a
lone rule's own order, starving 10 under 90 with the ask recorded, leaving a partial overlap with
only its remainder, a `{}` rule claiming all 18 writable columns, no starvation across tenants,
one plan whatever the order rules are handed over; composition with `restrictToDeclared` (#32)
and with `planEnrichmentWrite` (#33) — the winner writing `seniority` while the loser's record
still says `industry: null`; and the wiring scanned from source: every `enrichmentRule.findMany`
in `src/` carrying the shared `orderBy`, the skip checks running before a rule can claim
anything it will never visit, `planTick` before any lead is counted, both sweeps walking the one
plan, the run door unranked, and #32/#33/#29's invariants untouched).

The live proof is `demo/run-demo.sh leadworks` STEP 15: three rules created 50, 90, 10 come back
from the door as **90, 50, 10** while their stored `createdAt`s say the opposite; the sweep
minute that follows queues **two jobs for three due rules** — `prio=90` carrying
`config.fields ["seniority"]`, `prio=10` carrying `["companySize"]` (the remainder, not what it
asked for) and `prio=50` carrying nothing, with no log row and no `creditsUsed` of its own; the
lead ends `seniority=C_LEVEL`, `ENRICHED`, **47 → 53**, with #33's gap record beside it. Then one
number moves: `priority: 200` answers `400 priority must be at most 100`, `priority: 95` is
stored, and the next minute hands *both* columns to the rule at 95 and starves the two that used
to outrank it — ownership followed the number, both minutes. 24 checks in this step, and the
whole run against the round #34 build was **153 ✓ / 0 ✗**, exit 0; STEP 16 below prints
the count against this one.
whole run against this build is **153 ✓ / 0 ✗**, exit 0.

What this does not claim: the two visits that remain are still two visits. A rule the ranking
left a remainder for still walks into a provider that has no opinion on it — `derive` reads
titles, not company sizes — and logs a `PARTIAL` and a `creditsUsed`, because no plan written
before the provider runs can know that in advance. And the starved rule leaves no *row* behind:
what a starvation costs is visible as the absence of a job and of a `creditsUsed`, and the
sentence explaining it is in the server's log, not in `EnrichmentLog`. What is on the record is
who won, which is #33's pair beside the winner's name.
stored as `"30 9 * * 1"`.
stored as `"30 9 * * 1"` — 22 checks in this step, and the whole run against this build is
**119 ✓ / 0 ✗**, exit 0.

### How long an export's file answers: the row says, and both doors obey

`Export.expiresAt DateTime?` has been in the schema since the first migration, every export
door has handed it back, and nothing ever filled it or read it. Measured against the running
app before this round: an export created through `POST /api/exports` came back `COMPLETED`
1130 ms later with a real `completedAt`, a real `filePath` and 918 bytes — and
`expiresAt: null`; both downloads answered `200`; the table held **25 `COMPLETED` exports and
0 with an expiry stamped**, the oldest finished **four days** earlier, its file still on disk
and still served (`200`, 1528 bytes). None of the eleven `prisma.export.*` mutations in `src/`
passed the column, and none of the 29 `expiresAt` mentions outside `src/generated/` was about
`Export` at all. The one place the word "expired" lived was the download door's 410 — *"export
file expired from this server — re-run the export"* — which fires when `stat`/`readFile`
throws, i.e. when the operating system happened to reclaim `/tmp`. A sentence about expiry with
no date behind it anywhere, and a file the machine lost indistinguishable from a row that never
had a lifetime.

`src/lib/export-retention.ts` now does the two things that make the column true, and no more:

- **the write that finishes a file also says how long it lives** — `expiryFor` stamps
  `expiresAt` in the export worker's single `COMPLETED` update, beside the `completedAt` from
  the same `finishedAt`, so the row that names the file is the row that owns its lifetime.
  Nothing else stamps it: the other nine writes still pass no `expiresAt`, and the test counts
  all ten and asserts exactly one carries the column;
- **both doors ask before they touch the bytes** — `retentionVerdict(expiresAt, now)` answers
  `served` / `retired` / `unstamped` (the boundary inclusive), and
  `GET /api/exports/{id}/download` and `POST /api/exports/{id}?action=download` ask it *before*
  opening the file. A retired export is refused by policy rather than by whatever `/tmp` did,
  and the door that hands out the URL no longer hands out a link to a file this module has
  already refused;
- **the two 410s stay two sentences** — `retiredExportError` names the date the export died and
  says re-run, `MISSING_EXPORT_FILE_ERROR` is the old wording, word for word, for a file that
  is genuinely gone. A test asserts they differ, so they cannot drift back into one.

The lifetime is `EXPORT_RETENTION_MS`, **seven days** if the operator says nothing, read when
the export *finishes* rather than when it is served. That ordering is what makes a short value
safe: the demo boots the app with 25 seconds and cannot retire the exports a seven-day instance
wrote before it, because each row carries the number its own writer had. Anything that is not a
run of digits falls back to the default rather than becoming `NaN` in a `Date` —
`parseRetentionMs` is table-tested with 17 inputs, including `"1e9"`, `"1500.5"`, `"-5000"`,
`"5,000"` and `"007"`. A caller still cannot name the lifetime of the file the server is about
to write: `EXPORT_CREATE` takes `format`, `fields`, `filterJson` and `profileId`, and neither
export door has a PATCH verb, so there is no way to move one afterwards either. And a row whose
`expiresAt` is `null` is served, not refused — the 25 exports this round was measured against
were finished before the column was ever filled, and retiring them on the strength of a column
nobody wrote would be a policy decided by a migration instead of by an operator.

Pinned offline by `tests/unit/export-retention.test.ts` (36 of the 609 in the suite: the schema
declaration, the default and the one env key, the create door dropping a caller-supplied
lifetime, the 17 parsing cases, the arithmetic and the inclusive boundary, the three verdicts,
the two refusal sentences staying different, and the wiring scanned from source — one stamp site
among the ten writes, the verdict asked before `stat()`, no PATCH verb on either door, and no
`unlink` in any file this round touches).

The live proof is `demo/run-demo.sh leadworks` STEP 16: with the app booted at
`EXPORT_RETENTION_MS=25000`, a CSV export is created with `expiresAt: null`, finishes at
`08:36:01.064Z` stamped `08:36:26.064Z` — **+25000 ms, exactly** — downloads `200` with all 957
bytes, and **25 seconds later both doors answer 410** with
`export retired on 2026-10-21T08:36:26.064Z — re-run the export for a fresh file`, the same
words from both, while the row itself still reads `COMPLETED` with the same `filePath` and the
same `fileSize`, and the unstamped export finished before this round still downloads `200`.
11 checks in this step, and the whole run against this build is **164 ✓ / 0 ✗**, exit 0.

What this does not claim: **the bytes are still there.** A retired export is a closed door, not
a deleted file — this round stops *serving* the copy and says so; the `unlink` and the sweep
that would call it are the next round, and until then "the file is where the worker put it" is
the whole truth. The stamp lands only on rows the worker finishes from here: an export that was
already `COMPLETED` keeps its `null` unless someone chooses to backfill it, which is an operator
decision with an `UPDATE` in it rather than something a feature does quietly.

### How long an export's file answers: the row says, and both doors obey

`Export.expiresAt DateTime?` has been in the schema since the first migration, every export
door has handed it back, and nothing ever filled it or read it. Measured against the running
app before this round: an export created through `POST /api/exports` came back `COMPLETED`
1130 ms later with a real `completedAt`, a real `filePath` and 918 bytes — and
`expiresAt: null`; both downloads answered `200`; the table held **25 `COMPLETED` exports and
0 with an expiry stamped**, the oldest finished **four days** earlier, its file still on disk
and still served (`200`, 1528 bytes). None of the eleven `prisma.export.*` mutations in `src/`
passed the column, and none of the 29 `expiresAt` mentions outside `src/generated/` was about
`Export` at all. The one place the word "expired" lived was the download door's 410 — *"export
file expired from this server — re-run the export"* — which fires when `stat`/`readFile`
throws, i.e. when the operating system happened to reclaim `/tmp`. A sentence about expiry with
no date behind it anywhere, and a file the machine lost indistinguishable from a row that never
had a lifetime.

`src/lib/export-retention.ts` now does the two things that make the column true, and no more:

- **the write that finishes a file also says how long it lives** — `expiryFor` stamps
  `expiresAt` in the export worker's single `COMPLETED` update, beside the `completedAt` from
  the same `finishedAt`, so the row that names the file is the row that owns its lifetime.
  Nothing else stamps it: the other nine writes still pass no `expiresAt`, and the test counts
  all ten and asserts exactly one carries the column;
- **both doors ask before they touch the bytes** — `retentionVerdict(expiresAt, now)` answers
  `served` / `retired` / `unstamped` (the boundary inclusive), and
  `GET /api/exports/{id}/download` and `POST /api/exports/{id}?action=download` ask it *before*
  opening the file. A retired export is refused by policy rather than by whatever `/tmp` did,
  and the door that hands out the URL no longer hands out a link to a file this module has
  already refused;
- **the two 410s stay two sentences** — `retiredExportError` names the date the export died and
  says re-run, `MISSING_EXPORT_FILE_ERROR` is the old wording, word for word, for a file that
  is genuinely gone. A test asserts they differ, so they cannot drift back into one.

The lifetime is `EXPORT_RETENTION_MS`, **seven days** if the operator says nothing, read when
the export *finishes* rather than when it is served. That ordering is what makes a short value
safe: the demo boots the app with 25 seconds and cannot retire the exports a seven-day instance
wrote before it, because each row carries the number its own writer had. Anything that is not a
run of digits falls back to the default rather than becoming `NaN` in a `Date` —
`parseRetentionMs` is table-tested with 17 inputs, including `"1e9"`, `"1500.5"`, `"-5000"`,
`"5,000"` and `"007"`. A caller still cannot name the lifetime of the file the server is about
to write: `EXPORT_CREATE` takes `format`, `fields`, `filterJson` and `profileId`, and neither
export door has a PATCH verb, so there is no way to move one afterwards either. And a row whose
`expiresAt` is `null` is served, not refused — the 25 exports this round was measured against
were finished before the column was ever filled, and retiring them on the strength of a column
nobody wrote would be a policy decided by a migration instead of by an operator.

Pinned offline by `tests/unit/export-retention.test.ts` (36 tests at that round, 53 in the file
now: the schema
declaration, the default and the one env key, the create door dropping a caller-supplied
lifetime, the 17 parsing cases, the arithmetic and the inclusive boundary, the three verdicts,
the two refusal sentences staying different, and the wiring scanned from source — one stamp site
among the ten writes, the verdict asked before `stat()`, no PATCH verb on either door, and no
`unlink` in the worker or in a door — the deletion `#36` adds is the sweep's, below).

The live proof is `demo/run-demo.sh leadworks` STEP 16: with the app booted at
`EXPORT_RETENTION_MS=25000`, a CSV export is created with `expiresAt: null`, finishes at
`08:36:01.064Z` stamped `08:36:26.064Z` — **+25000 ms, exactly** — downloads `200` with all 957
bytes, and **25 seconds later both doors answer 410** with
`export retired on 2026-10-21T08:36:26.064Z — re-run the export for a fresh file`, the same
words from both, while the row itself still reads `COMPLETED` with the same `filePath` and the
same `fileSize`, and the unstamped export finished before this round still downloads `200`.
11 checks in this step; the whole run against the round `#35` build was **164 ✓ / 0 ✗**, and
STEP 17 below prints the count against this one.

What `#35` left undone, stated while it was still true: **the bytes were still there.** That
round stopped *serving* the copy and said so; the section below is the round that takes the
file. Its other limit stands as written — the stamp lands only on rows the worker finishes from here: an export that was
already `COMPLETED` keeps its `null` unless someone chooses to backfill it, which is an operator
decision with an `UPDATE` in it rather than something a feature does quietly.

### …and the next minute takes the file: `planPurge`, and the only `unlink` in the app

Closing the door left the copy on the disk, and measured again the same day that was the whole
story: **27 `COMPLETED` rows, 2 of them past their date with both files still there byte-exact**
(`/tmp/export_1792571592233.csv` at 4,195 bytes, `export_1792571761063.csv` at 957); **51 files
matching `/tmp/export_*` against those 27 rows, so 24 named by no row at all** — the work of
`DELETE /api/exports/{id}`, which has always removed the row and left the file; **0 rows whose
file was missing**, i.e. the missing-file 410 had never fired in this database; and **zero sites
in `src/` that had ever deleted anything** — the application had never removed a file it
created.

Two pieces, in the order that makes a deletion safe:

- **`planPurge(rows, now)` decides, with no disk and no database.** The row's own date is asked
  first, through the same `retentionVerdict` the doors use, *before the path is looked at* —
  which is what makes *a purge cannot change what a door answers* true by construction rather
  than by luck. Then that a path is named at all, then that it is a shape the worker can
  actually produce: `/tmp/export_<digits>.<csv|json|xlsx|pdf>`. Everything else is kept, with
  one of four reasons an operator can read back — `served`, `unstamped`, `no file`, `path is
  not an export artifact`.
- **`purgeRetiredExports()` acts on what the plan returned**, at the top of the once-a-minute
  sweep and inside its own `try`/`catch`, so a filesystem that misbehaves cannot cost the jobs
  the calendar is due for that minute. It is the only `unlink` in `src/`, and it runs only on
  the `filePath` the plan handed back. A file already gone — `/tmp` is reclaimed by the
  operating system on its own schedule — is counted as *already gone*, not reported as a
  deletion or a failure. Every removal is one stdout line naming the row id, the path, and
  **the date that authorized it**.

The row is not rewritten. `filePath`, `fileSize` and `COMPLETED` all stay, because the row is the
record of an export that happened and the date on it is what says the bytes are gone — which is
also why both doors keep answering the *retired* sentence after the sweep instead of the
missing-file one: they ask the date before they ask the disk.

Two things this leaves alone, on purpose:

- **`null` is not an expiry, so it is not a deletion.** The 25 exports finished before `#35`
  keep their files — a lifetime nobody promised cannot have passed. Backfilling their
  `expiresAt` is an operator decision with an `UPDATE` in it, and the sweep will honour whatever
  date that sets.
- **The 24 orphans stay.** Reclaiming a file no row names needs a rule about what a file means
  once its record is gone, and `DELETE /api/exports/{id}` needs deciding first — delete the
  bytes with the row, or refuse to delete the row while its file is still served. This round
  counts them, pins by test that it changed nothing about them, and leaves the decision to the
  next.

Pinned offline by `tests/unit/export-retention.test.ts` (the file's 17 new tests: the shape
guard proven against the four template literals the worker actually builds its paths from and
the 17 shapes it must refuse — including `/tmp/export_1792571592233.csv || rm -rf /tmp`; the
whole four-reason table; the inclusive boundary shared with the door to the millisecond; the
25 unstamped rows kept whatever their paths; `planPurge`'s purity; and the sweep scanned from
source — one `unlink` in `src/`, after `planPurge`, on `plan.remove`'s own `filePath`, with no
`prisma.export.update` in it and `DELETE /api/exports/{id}` unchanged).

The live proof is `demo/run-demo.sh leadworks` STEP 17, run against the export STEP 16 had just
refused: its 957 bytes are on the disk when the step begins and **gone 34 s later**, with the row
still reading `COMPLETED filePath=/tmp/export_1792579440609.csv fileSize=957`, both doors still
quoting the retired sentence word for word (and not the missing-file one), the sweep's own line
in the server's stdout — `Export cmvhzikll002jekqcflv4wmx3: retired file removed at
/tmp/export_1792579440609.csv (retired on 2026-10-21T10:44:25.610Z)` — and **24/24 orphaned files
plus 25/25 pre-`#35` rows' files still on disk**. 9 checks in this step, and the whole run
against this build is **173 ✓ / 0 ✗**, exit 0.

### How long an export's file answers: the row says, and both doors obey

`Export.expiresAt DateTime?` has been in the schema since the first migration, every export
door has handed it back, and nothing ever filled it or read it. Measured against the running
app before this round: an export created through `POST /api/exports` came back `COMPLETED`
1130 ms later with a real `completedAt`, a real `filePath` and 918 bytes — and
`expiresAt: null`; both downloads answered `200`; the table held **25 `COMPLETED` exports and
0 with an expiry stamped**, the oldest finished **four days** earlier, its file still on disk
and still served (`200`, 1528 bytes). None of the eleven `prisma.export.*` mutations in `src/`
passed the column, and none of the 29 `expiresAt` mentions outside `src/generated/` was about
`Export` at all. The one place the word "expired" lived was the download door's 410 — *"export
file expired from this server — re-run the export"* — which fires when `stat`/`readFile`
throws, i.e. when the operating system happened to reclaim `/tmp`. A sentence about expiry with
no date behind it anywhere, and a file the machine lost indistinguishable from a row that never
had a lifetime.

`src/lib/export-retention.ts` now does the two things that make the column true, and no more:

- **the write that finishes a file also says how long it lives** — `expiryFor` stamps
  `expiresAt` in the export worker's single `COMPLETED` update, beside the `completedAt` from
  the same `finishedAt`, so the row that names the file is the row that owns its lifetime.
  Nothing else stamps it: the other nine writes still pass no `expiresAt`, and the test counts
  all ten and asserts exactly one carries the column;
- **both doors ask before they touch the bytes** — `retentionVerdict(expiresAt, now)` answers
  `served` / `retired` / `unstamped` (the boundary inclusive), and
  `GET /api/exports/{id}/download` and `POST /api/exports/{id}?action=download` ask it *before*
  opening the file. A retired export is refused by policy rather than by whatever `/tmp` did,
  and the door that hands out the URL no longer hands out a link to a file this module has
  already refused;
- **the two 410s stay two sentences** — `retiredExportError` names the date the export died and
  says re-run, `MISSING_EXPORT_FILE_ERROR` is the old wording, word for word, for a file that
  is genuinely gone. A test asserts they differ, so they cannot drift back into one.

The lifetime is `EXPORT_RETENTION_MS`, **seven days** if the operator says nothing, read when
the export *finishes* rather than when it is served. That ordering is what makes a short value
safe: the demo boots the app with 25 seconds and cannot retire the exports a seven-day instance
wrote before it, because each row carries the number its own writer had. Anything that is not a
run of digits falls back to the default rather than becoming `NaN` in a `Date` —
`parseRetentionMs` is table-tested with 17 inputs, including `"1e9"`, `"1500.5"`, `"-5000"`,
`"5,000"` and `"007"`. A caller still cannot name the lifetime of the file the server is about
to write: `EXPORT_CREATE` takes `format`, `fields`, `filterJson` and `profileId`, and neither
export door has a PATCH verb, so there is no way to move one afterwards either. And a row whose
`expiresAt` is `null` is served, not refused — the 25 exports this round was measured against
were finished before the column was ever filled, and retiring them on the strength of a column
nobody wrote would be a policy decided by a migration instead of by an operator.

Pinned offline by `tests/unit/export-retention.test.ts` (36 tests at that round, 53 in the file
now: the schema
declaration, the default and the one env key, the create door dropping a caller-supplied
lifetime, the 17 parsing cases, the arithmetic and the inclusive boundary, the three verdicts,
the two refusal sentences staying different, and the wiring scanned from source — one stamp site
among the writes (ten when #35 counted them; #39 deleted a scheduler no caller had, whose create
and update were two of the ten, so the scan reads eight now — see
*what a scrape is allowed to point at*), the verdict asked before `stat()`, no PATCH verb on
either door, and no
`unlink` in the worker or in a door — the deletion `#36` adds is the sweep's, below).

The live proof is `demo/run-demo.sh leadworks` STEP 16: with the app booted at
`EXPORT_RETENTION_MS=25000`, a CSV export is created with `expiresAt: null`, finishes at
`08:36:01.064Z` stamped `08:36:26.064Z` — **+25000 ms, exactly** — downloads `200` with all 957
bytes, and **25 seconds later both doors answer 410** with
`export retired on 2026-10-21T08:36:26.064Z — re-run the export for a fresh file`, the same
words from both, while the row itself still reads `COMPLETED` with the same `filePath` and the
same `fileSize`, and the unstamped export finished before this round still downloads `200`.
11 checks in this step; the whole run against the round `#35` build was **164 ✓ / 0 ✗**, and
STEP 17 below prints the count against this one.

What `#35` left undone, stated while it was still true: **the bytes were still there.** That
round stopped *serving* the copy and said so; the section below is the round that takes the
file. Its other limit stands as written — the stamp lands only on rows the worker finishes from here: an export that was
already `COMPLETED` keeps its `null` unless someone chooses to backfill it, which is an operator
decision with an `UPDATE` in it rather than something a feature does quietly.

### …and the next minute takes the file: `planPurge`, and the app's first `unlink`

Closing the door left the copy on the disk, and measured again the same day that was the whole
story: **27 `COMPLETED` rows, 2 of them past their date with both files still there byte-exact**
(`/tmp/export_1792571592233.csv` at 4,195 bytes, `export_1792571761063.csv` at 957); **51 files
matching `/tmp/export_*` against those 27 rows, so 24 named by no row at all** — which this
section called the work of `DELETE /api/exports/{id}`, wrongly: the next section measures those
24 and retires the claim; **0 rows whose file was missing**, i.e. the missing-file 410 had never fired in this database; and **zero sites
in `src/` that had ever deleted anything** — the application had never removed a file it
created.

Two pieces, in the order that makes a deletion safe:

- **`planPurge(rows, now)` decides, with no disk and no database.** The row's own date is asked
  first, through the same `retentionVerdict` the doors use, *before the path is looked at* —
  which is what makes *a purge cannot change what a door answers* true by construction rather
  than by luck. Then that a path is named at all, then that it is a shape the worker can
  actually produce: `/tmp/export_<digits>.<csv|json|xlsx|pdf>`. Everything else is kept, with
  one of four reasons an operator can read back — `served`, `unstamped`, `no file`, `path is
  not an export artifact`.
- **`purgeRetiredExports()` acts on what the plan returned**, at the top of the once-a-minute
  sweep and inside its own `try`/`catch`, so a filesystem that misbehaves cannot cost the jobs
  the calendar is due for that minute. It was then the only `unlink` in `src/`, and it runs only
  on the `filePath` the plan handed back; `#37` adds the second one, at the door that deletes a
  row, and both consult the same guard. A file already gone — `/tmp` is reclaimed by the
  operating system on its own schedule — is counted as *already gone*, not reported as a
  deletion or a failure. Every removal is one stdout line naming the row id, the path, and
  **the date that authorized it**.

The row is not rewritten. `filePath`, `fileSize` and `COMPLETED` all stay, because the row is the
record of an export that happened and the date on it is what says the bytes are gone — which is
also why both doors keep answering the *retired* sentence after the sweep instead of the
missing-file one: they ask the date before they ask the disk.

Two things it left alone on purpose — and the second is what the next section is for:

- **`null` is not an expiry, so it is not a deletion.** The 25 exports finished before `#35`
  keep their files — a lifetime nobody promised cannot have passed. Backfilling their
  `expiresAt` is an operator decision with an `UPDATE` in it, and the sweep will honour whatever
  date that sets.
- **The 24 orphans stayed.** Reclaiming a file no row names needs a rule about what a file
  means once its record is gone, and `DELETE /api/exports/{id}` needed deciding first — delete
  the bytes with the row, or refuse to delete the row while its file is still served. This round
  counted them, pinned by test that it changed nothing about them, and left the decision to the
  next, which took it: the door now deletes the file, and the files with no row at all are
  counted out loud every minute and still left alone.

Pinned offline by `tests/unit/export-retention.test.ts` (the file's 17 new tests: the shape
guard proven against the four template literals the worker actually builds its paths from and
the 17 shapes it must refuse — including `/tmp/export_1792571592233.csv || rm -rf /tmp`; the
whole four-reason table; the inclusive boundary shared with the door to the millisecond; the
25 unstamped rows kept whatever their paths; `planPurge`'s purity; and the sweep scanned from
source — one `unlink` in `src/` at that build, after `planPurge`, on `plan.remove`'s own
`filePath`, with no `prisma.export.update` in it, and `DELETE /api/exports/{id}` unchanged. Both
of those last claims are retargeted below: the count is now two, and the door is no longer
unchanged).

The live proof is `demo/run-demo.sh leadworks` STEP 17, run against the export STEP 16 had just
refused: its 957 bytes are on the disk when the step begins and **gone 34 s later**, with the row
still reading `COMPLETED filePath=/tmp/export_1792579440609.csv fileSize=957`, both doors still
quoting the retired sentence word for word (and not the missing-file one), the sweep's own line
in the server's stdout — `Export cmvhzikll002jekqcflv4wmx3: retired file removed at
/tmp/export_1792579440609.csv (retired on 2026-10-21T10:44:25.610Z)` — and **24/24 orphaned files
plus 25/25 pre-`#35` rows' files still on disk**. 9 checks in this step, and the whole run
against this build is **173 ✓ / 0 ✗**, exit 0.

### …and the record that is deleted takes its file: one guard, two callers, and a count of what has no owner

`#36` closed a retired export's door, reclaimed its bytes a minute later, and left two sentences
about the residue: *the 24 files no row names are `DELETE /api/exports/{id}`'s work*, and *that
door deletes the row and only the row*. Measured before this round, the first was wrong and the
second was a decision nobody had taken yet.

The count says so. `Job` rows of type `EXPORT` number **60 against 29 `Export` rows**, and **all
31** jobs naming an `exportId` with no row were created inside one hour — 2026-10-17 07:00 —
**24 of them `COMPLETED`**: the same 24, in the same five minutes (07:40–07:45) the orphan mtimes
fill. The demo never calls `DELETE` on an export and its first export code was committed about
three hours after that window, no test calls the four writers, and three sampled orphans have
`atime == mtime` — nobody ever downloaded them either. So the residue is **job history from a
window in which the table was emptied**, and the door's measured contribution to it is *zero rows
in this database*. That is a fact about the data, not a defence of the code: the door would have
left the file, and until now it did.

- **`planRowDelete(filePath)` is the guard, already written.** The same `isExportArtifact`
  question `planPurge` asks, with the same two words for saying no — `no file`, `path is not an
  export artifact`. What it deliberately does *not* receive is a clock: deleting a record is not
  a retention decision, so an export one second from its expiry is still deleted the moment its
  caller asks. `expiresAt` governs the doors that serve, never the record.
- **The row goes first, and the order is chosen out of the two failures available.** A row
  outliving its file is a download door pointing at nothing — the state the operating system used
  to produce by reclaiming `/tmp`, and the reason a second 410 sentence exists at all. A file
  outliving its row is what this directory already holds. One is a broken promise to a caller and
  the other is bytes answering to nobody, so the delete happens, then `unlink` on the path read
  before it, and a failure is reported instead of rolled back.
- **The answer says what happened to the bytes.** `removed`, `already gone from this server` (an
  `ENOENT` is a fact about `/tmp`, not a deletion and not a failure), `left on disk` with the
  error's own message beside it, or the guard's reason. A bare `{ ok: true }` over a file that is
  still there was the over-claim this round removes, and no response shape in the door still
  allows it.
- **`logExportFileCensus(now)` counts the files with no owner, and deletes nothing.** A file no
  row names has no `expiresAt`, no `status` and — decisively — no `workspaceId`, so no policy can
  be applied to it and no tenant could authorize removing it; the number goes to the server's
  stdout, not onto an API. It also sets aside any artifact whose own filename timestamp is
  younger than a minute, because the path is built before the row that names it is written: the
  gap between the two, measured across the 25 live rows, is **2.3–16.1 ms**. A sweep that deleted
  what no row names would be deleting exports being born, which is why the idea stays out of the
  code and the count stays in the log. It prints when the number moves, not 1,440 times a day.

Pinned offline by `tests/unit/export-retention.test.ts` — 69 tests in the file now (53 before
this round, and the suite at 642 against its 626),
and three of `#36`'s retargeted rather than deleted: *nothing in the app deletes* became *nothing
that serves a file deletes it* (the worker, the streaming door and the list door still contain no
deletion, and inside the detail door the `unlink` is confined to `DELETE_impl`, not to the two
branches that hand bytes back); *one `unlink` in `src/`* became *two, and both act only on a path
`planPurge` or `planRowDelete` named*; and `DELETE`'s own unchanged-behaviour test now pins the
file going with the row. The new tests cover the plan's answers against the same 17 shapes a
column can hold, the door's order read out of its source (read `filePath` → check ownership →
delete → guard → `unlink`, four `NextResponse.json` exits each naming a byte-state, no
`prisma.export.update` anywhere), the stamp inside a name, and the census table — named, unclaimed
and old, unclaimed and 16 ms young, and shaped like nothing this app writes — plus the claim that
no file route or page mentions the census at all.

The live proof is `demo/run-demo.sh leadworks` STEP 18, which walks all three states a delete can
find in one run. The export `#36`'s sweep had already reclaimed is deleted first: the door answers
`{"ok":true,"file":"already gone from this server"}`, its id answers 404 afterwards, and the bytes the sweep removed stay removed — naming a
missing file is not a second attempt to delete one. Then a fresh JSON export whose 1,602 bytes are
on the disk exactly where the row says 1,602: one `DELETE` later `file: "removed"`, the file is
not there, and neither is the row. Then the guard, in the only way it can be proven at a door — a
row's `filePath` rewritten by hand (over `psql`) to `/tmp/leadworks-demo-not-an-export-0zrc7.txt`,
a file the script wrote itself: the answer is `file: "path is not an export artifact"`, the
sentinel is untouched, and the file the worker *really* wrote (`/tmp/export_1792582140622.csv`) is
now named by no row at all — which is precisely what the sweep's line counts and no code in the
application deletes. The run's first census line reads `Export file census: 24 files shaped like
exports in /tmp are named by no row (65996 bytes) — left alone: no row, so no expiry, no status and
no workspace to decide from`; one sweep minute after the guard refused, the same line says **25
files, 66,598 bytes**, and this script's own count of the same directory against the same table's
30 paths lands on the same 25. 16 checks in this step, 9 in STEP 17 above it, and the whole run
against this build is **189 ✓ / 0 ✗**, exit 0.

### …and the cadence somebody types is the cadence the sweep reads: one grammar, four doors, and a line for the rows that predate it

#34 refused a step and a range at the enrichment-rule door *on the matcher's behalf* —
`("/5" and "9-17" are not matched, so such a rule would never fire)`. That matcher was
`shouldRunNow`, nineteen lines at the foot of `scheduler.ts`, under a comment reading
`Simplified cron matching - in production use croner or similar`: split each field on `,`,
compare whole strings. The refusal was right about the matcher and wrong about the product,
because it was the only place the matcher's limits were stated. `Source.schedule` and
`ExportProfile.schedule` are plain `String?` columns; the source doors took any 64 characters of
them, while a profile's cadence has exactly one writer — `prisma/seed.ts`, storing `0 9 * * 1`,
a shape this grammar reads — so an unreadable one there means somebody moved the row outside the
app, which is the case the log line exists for.

Measured against the running app before any of this changed: four sources created in one
minute, left for four sweep minutes.

| stored `schedule` | what it asks for | `Job` rows in four sweep minutes |
|---|---|---|
| `*/5 * * * *` | a scrape every fifth minute | **0**, in a window holding minute :20 and :25 |
| `0 9 * * 1-5` | a weekday-morning scrape | **0**, forever |
| `* * * * * 1` | a scrape restricted to one weekday | **4** — one per minute, on **every** day |
| `* * * * *` | the control | 4, which is what proves the other three were a deaf sweep, not a dead one |

Two silences and one lie: a six-field expression passed the matcher's `parts.length < 5` test,
was read as its *first five* fields, and so ran every minute of every day while its sixth field
— the one that was supposed to restrict it — was the field that got dropped. Nothing was printed
in any of the three cases. The same three strings, sent to `POST /api/enrichment-rules`, came
back 400 with the offending part quoted.

`src/lib/cron-schedule.ts` is the fix in both halves. It honours `*`, a whole number, a comma
list, an inclusive range `a-b`, and a step `*/n`, `a-b/n` or `a/n`; it takes `7` as Sunday's
other spelling and folds it to `0` before matching; and it refuses, by name, what it will not
read — a weekday or month name (naming the convention it belongs to), `?` and `#`, the `L`/`W`
extensions, a step of `0`, a range that runs backwards, a number outside its field, an empty
entry between commas, anything that is not exactly five fields — every field's problem in one
message. Two decisions are stated rather than inherited:

- **A cadence that restricts both a day of month and a day of week means the day that is
  both**, not either. Vixie cron means either. This matcher has always meant both, and #38 kept
  it, because rows stored under the old matcher mean what *it* said — silently widening every
  `0 12 15 * 1` in a live database would be the same class of surprise this round exists to close.
  It is a pinned behaviour now, not a comment someone can forget.
- **`matchesSchedule` answers `false` for a cadence `scheduleProblem` would refuse**, so a caller
  that skipped the check still cannot run work nobody asked for. It only cannot say why it is
  quiet — which is why the doors check and the sweep logs.

The four states a cadence can be in, and who says them: `POST /api/sources` and
`PATCH /api/sources/{id}` refuse an unreadable one with the matcher's own sentence before
`prisma.source.create`/`update` runs (`null` still means no cadence, which is why the door gates
on `typeof … === "string"`); `POST /api/enrichment-rules` refuses it through `actionsProblem`,
which now imports the grammar instead of re-spelling the field table, so the rule's 400 contains
the matcher's sentence verbatim; the sweep asks the grammar per row and, for a `schedule` stored
before the door refused, prints `Source <id> is active and scheduled, but no minute matches it —
schedule "* * * * * 1" is 6 fields — this build reads exactly five (…)` and skips the row; and a
cadence that is well formed but cannot fall on the calendar (`0 0 30 2 *`) is matched as never,
not refused — inventing a rule about February 30th would be the product deciding what a cron
means, which is the thing this round stopped doing.

Pinned offline by `tests/unit/cron-schedule.test.ts` (27 tests, in a suite of 670 that round and
of 697 since #39: known answers
on fixed clocks, including 12-of-60 for `*/5`, the range-with-step, `7` and `0` as the same
Sunday, the 15th-and-a-Monday pairing, and February 30th; every refusal's wording checked
against the field it names; the accepted shapes quoted once in `GRAMMAR`; the module imports
nothing, reads no clock, and mutates nothing it was handed). The cross-check the round turns on
is one table of 19 cadences run through **both** verdicts — the matcher's and the rule door's —
asserting they agree on every row and that the rule's message contains the matcher's sentence,
because two grammars disagreeing is the bug this round measured, wearing a different hat. The
source scans pin `shouldRunNow` and its `Simplified cron matching` comment gone from every file
in `src/` (#39's correction: that scan searched the *deleted matcher's own phrases*, and two
more hand-parsed cadences were sitting in `src/lib/scraper.ts` and `src/lib/exporter.ts` — both
unreachable, both deleted by #39, and the claim is true of the app now for the reason it was
only true of the live paths then), the five field ranges spelled in exactly one module, three
`matchesSchedule` calls in
the sweep and no `getX()` clock read in it, and both source doors refusing before their write.
`rule-actions.test.ts`, `rule-priority.test.ts` and `queue.test.ts` were retargeted where they
pinned the deleted matcher — the two cadences #34 refused by name are asserted *accepted* now,
and the field table's own copy is gone rather than kept beside the original. Lint went from 18
warnings to 14: four of them were dead locals in the code this round deleted, two of them in the
matcher (`nowDayOfMonth`/`nowDayOfWeek`, computed while the same line already had `now.getDate()`).

Live, `demo/run-demo.sh leadworks` STEP 19 — 18 checks, and the whole run **207 ✓ / 0 ✗**,
exit 0, against the rebuilt app. Six cadences go to `POST /api/sources`, and each comes back
400 naming the part it refuses in quotes and the field it belongs to: `0 9 * * MON-FRI` gets
`"MON-FRI" is not something this build's matcher reads — day of week must be "*" or a whole
number, a comma-separated list, an inclusive range "a-b", or a step`, `* * * * * 1` gets
`schedule "* * * * * 1" is 6 fields — this build reads exactly five (minute hour day-of-month
month day-of-week)`, `*/0 * * * *` gets `"*/0" steps by 0, which never advances — a step is 1
or more`, `61 * * * *` gets `minute "61" holds 61, outside 0-59`, `0 0 ? * 1` gets `"?" holds a
"?" or "#", which this build's matcher does not read`, and `20-5 * * * *` gets `"20-5" is a
range that runs backwards in minute: 20-5`. The same `MON-FRI` sent to
`POST /api/enrichment-rules` comes back with the matcher's sentence *inside* the rule door's
400 — the check is a substring test, because one grammar two doors paraphrase is two grammars.
The three cadences #34 refused at the rule door on the matcher's behalf — `*/5 * * * *`,
`0 9 * * 1-5`, `*/15 9-17 * * 1-5` — answer **201** now, and `PATCH /api/sources/{id}` refuses
`0 9 * * SUN` with the same quoted-part sentence the create door uses while `schedule: null`
stays a clear rather than a cadence to refuse.

Then the minute itself: a source stored with `*/2 * * * *` mints its first scrape job inside
the 60-second poll and that job's own timestamp reads **minute :04** — an even minute, which is
what a 2-minute step means, where the pre-round build answered `*/5 * * * *` with 0 jobs in a
260-second window that contained two of the fifth-minutes. The row the measurement caught
lying — `* * * * * 1`, hand-inserted over `psql` because no door would take it
anymore — mints **0** jobs in the same window and prints
`Source demo38legacy is active and scheduled, but no minute matches it — schedule "* * * * * 1"
is 6 fields — this build reads exactly five (minute hour day-of-month month day-of-week)`, so a
cadence that predates the door is a line in the stdout instead of an absence nobody can
distinguish from a quiet minute. Cleanup leaves 0 of STEP 19's rows in `Source`.

STEP 13's refusal list was retargeted rather than left to rot: `*/5 * * * *` came out of it (it
is readable now, and STEP 19 proves what it does) and `* * * * * 1` went in, so that step still
shows a door refusing a cadence the sweep cannot act on instead of quietly agreeing with one
it cannot read.

### …and the day somebody types is a day the month has: the same grammar, now read against the calendar

#38 pinned, in its own words, that `0 0 30 2 *` "is still a well-formed cron — refusing it would
be inventing a rule". It is well formed. Every field is in range, the matcher reads it, and the
door took it with a 201. What #61 measured is the other half of that sentence: **no minute of any
year matches it**, and the build had no way to say so.

Four cadences were pressed at the running app in one round of `POST /api/sources`, then read back
from `GET /api/sources` and left for four sweep minutes:

| stored `schedule` | what each field says | what the minute does |
|---|---|---|
| `0 0 30 2 *` | the 30th of February, 00:00 | 201; **0 `Job` rows in four sweeps**; no line in the log |
| `0 0 31 4 *` | the 31st of April, 00:00 | 201; 0 jobs; no line |
| `0 9 * * 9` | a weekday the field does not have | 400 at the door, and `Source … is active and scheduled, but no minute matches it` in the sweep |
| `* * * * *` | the control | 201; 8 jobs in four sweeps, which is what proves the other rows were deaf rather than the sweep dead |

The third row is the one the first two were measured against: the sweep's warning hangs off
`scheduleProblem`, so a cadence the grammar cannot read is named, and a cadence the grammar reads
and the calendar does not have is not. `*/5 * * * *` — #38's own case — is a *readable* cadence
now, which is why the base run's warning list named `0 9 * * 9` and left `0 0 30 2 *` quiet.

`scheduleProblem` grew one cross-field check after its per-field loop: expand the day-of-month
field and the month field, and refuse when the earliest day it names is past the longest month it
names. February is 29 in that table, not 28, because a leap year exists. Six of the 372
day-and-month pairs the grammar can name are refused by it — `30.2`, `31.2`, `31.4`, `31.6`,
`31.9`, `31.11` — and the pin is that list against `Date` itself, over the years 2026 through
2041, not against a hand-written table.

What it deliberately does not refuse is the part the measurement had to be careful about.
`0 0 29 2 *` matched exactly **1** minute in the scan (2028-02-29 00:00), `0 0 31 4-11 *` matched
16 and `0 0 31 1,4 *` matched 4: a range or a list that contains a month with 31 days is a
cadence that comes round, not a dead one, and the longest month in the list is what the check
reads. `0 0 1-31/30 2 *` names the 1st and the 31st of February, and February has the 1st.
The weekday field stays out of the verdict entirely: `0 0 29 2 1` matches nothing in the scanned
window and everything on 2044-02-29, which is a Monday, so a cadence that waits a long time is
not a cadence that never comes. And a cadence misfiring twice — `23 59 30 2 *` — is refused for
its hour, because both sentences in one message would bury the field complaint the caller can
actually fix.

No wiring changed. `POST /api/sources`, `PATCH /api/sources/{id}` and `ruleDeclarationProblem` in
`lib/rule-actions.ts` all call the same function they already called, and the three sweep legs all
ask it before matching, which is the point #38 made about one grammar.

Offline first, on the rebuilt app: the same presses against the shipped build. Six cadences the
base run stored with a 201 come back **400** naming both fields as written and the month's real
length — `day of month "30" is not a day of month "2" — the longest month it names has 29 days,
so no minute of any year matches this cadence` — while `0 0 29 2 *`, `0 0 31 4-11 *`,
`0 0 31 1,4 *`, `0 0 1-31/30 2 *`, `0 0 29 2 1`, `0 0 30 * *` and `* * * * *` all still answer
**201**, and `23 59 30 2 *` answers 400 for its hour alone. `POST /api/enrichment-rules`, which
shares the module and had no idea, took `0 0 30 2 *` with a 201 before and refuses it with the
matcher's own sentence inside the 400 after; `0 0 29 2 *` is still a 201 there.

Then the rows that predate the door, which is the half a refusal cannot fix. The base run had left
9 sources in this round's own database holding one of the never-cadences, plus the ungrammatical
control and 2 rules holding one of them each.
Before: 1 warning line per sweep minute (the ungrammatical one) and 0 jobs. After: **10 source
lines and 2 rule lines** per sweep minute, the never-cadences named by the same sentence the door
refuses with, and still **0 jobs** — the sweep's behaviour toward them is unchanged; what changed
is that the silence has a reason in the log. `tests/unit/cron-schedule.test.ts` went from 27 to 36
cases and `npm test` from 1132 to 1141, all green, against `main` at `286b1f9` — six other
branches merged onto `main` while this branch was open, so the suite totals are stated against
that hash and the file's own 27 to 36 is what survives a moving base. Six of the nine new cases fail against `main`'s
module, and the retargeted #38 pin fails with them — 7 of the file's 36; the three that pass on
both are the guard-rails, which assert what has to stay storable rather than what this round
refuses. `npx tsc --noEmit` clean, lint 0 errors and 13 pre-existing warnings,
`npm run check:contract` 8/8, `npm run build` exit 0.

The contract gains the 400 those four doors have been giving since #38 and never advertised, and
the `schedule` field's description now says what the door checks. `public/llms-full.txt` is
unchanged — it renders each operation's summary and auth, and neither moved.

What is not claimed: no migration touched the rows the base run left, and none is proposed — they
are a measurement, in a database only this session can see; the module still reads `7` as
Sunday's other spelling and still requires *both* a day of month and a day of week, so
`0 12 15 * 1` stays rarer than Vixie cron would make it; a cadence whose day exists somewhere in
its month list is accepted even when the weekday makes the combination wait, which is the
behaviour above measured at 2044-02-29; `GET /api/sources` prints no verdict on a row, only what
was stored, so a legacy cadence is visible there only as the string the sweep refuses to explain;
and `matchesSchedule` still answers `false` rather than throwing, because the sweep's legs are
allowed to be run by a row the door refused before it existed.
### What a scrape is allowed to point at: the address a caller names, and the browser this instance does not have

`WEB_SCRAPER` is one of the five `Source.type` values a caller may write.
`POST /api/sources/{id}?action=run` mints a `Job` for it, the worker reads `job.config.url`,
and its first act is `chromium.launch()`. Measured on this box before anything changed —
`playwright@1.64` is a dependency, nothing in `package.json` installs a browser (`postinstall`
is absent) and `~/.cache/ms-playwright` does not exist — three sources run in a row each came back
**200 with a `jobId`**, three `Job` rows went `FAILED`, and all three wrote the same
message into `Job.error` *and* into `Source.lastRunError`:

```
browserType.launch: Executable doesn't exist at /home/opc/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
```

That is verbatim off this box, re-captured while writing this section. It was the whole of what
the application said about a scrape: a fact about the *instance* arriving in the column about a
*lead*, three rows deep, in a UI that renders the column raw. Nothing anywhere stated the one
thing a buyer needs before pointing a schedule at a scraper — *this instance cannot scrape*.

The second half is the reason this file sits next to `egress.ts` rather than inside the scraper.
The three runs above had **different** `config.url`s and produced an identical message, because
`chromium.launch()` dies before any address is opened — so the banner also hid the round's other
finding, which is what the source says happens next: `page.goto(config.url)`, with nothing between
the row and the wire. `https://example.com/` and `file:///etc/passwd` were, to this application,
the same instruction. `src/lib/egress.ts` is the vendored policy for exactly that
shape (an address this process will open because a caller named it), already guarding webhook
delivery and the LLM calls, and the scrape path never called it. `tests/unit/egress-sites.test.ts`
did not see the gap either: its census matches a callee whose name contains `fetch`, and this
app's one navigation is `page.goto` — so the single site where a caller's address reaches a wire
the server itself opens was the one site the guard could not read.

`src/lib/scrape-capability.ts` is the capability half, with no browser, no filesystem and no
database behind its answers, which is the same reason an instance *without* a browser is still
allowed to have an opinion about scraping:

- `scrapeCapability(probe)` turns `{ executablePath, present }` into a `Capability` — it decides,
  it does not look; the looking is `readBrowserProbe()` in `scraper.ts` (`chromium.executablePath()`
  plus `existsSync`, wrapped, because a resolver is allowed to throw).
- `browserMissingReason(path)` is the one sentence a row, a door and a health page all use. Both
  of its states carry `BROWSER_INSTALL_COMMAND` (`npx playwright install chromium`) — the
  `null` state is an install that is broken rather than missing, and the operator has no other
  command to reach for — but they are not the same fact, and neither one prints `no browser at null`.
- `classifyLaunchFailure(message)` recognises Playwright's `Executable doesn.t exist at <path>`
  and returns the sentence, or `null` meaning *this error is about the page, not about the
  instance* — and then the caller keeps the original message, because inventing a tidier one for a
  real scrape failure trades the box-drawing banner for a different lie. The apostrophe is typed
  both ways by different versions, so the pattern requires neither.
- `scrapeTarget(config)` reads the address and is **deliberately not filtered on `Source.type`**.
  The sweep mints a `SCRAPE` job for any active source whose cadence matches and `runScrapeJob`
  reads `job.config.url` whatever the type column says, so an `API`-labelled row holding a url is
  a scrape target as far as the browser is concerned; #38's own demo stores `type: "API"` sources
  pointing at its hook server, which is the case a type-shaped guard would have walked past.
- `NO_TARGET_REASON` and `scrapeTargetProblem(config)` — the last being the one export that is not
  pure, because `classifyTarget` resolves the host and an unresolvable host is a refusal.

Five sites ask, in four shapes:

| site | what it asks | what it answers |
|---|---|---|
| `POST /api/sources` | `scrapeTargetProblem` on the incoming `config`, and `scrapeTarget === null` when the type says scraper | 400 in the egress module's own words, or `NO_TARGET_REASON`, before `prisma.source.create` |
| `PATCH /api/sources/{id}` | the same, of the **effective** config — a patch that does not name `config` leaves the stored one, a patch that does not name `type` leaves a scraper a scraper | 400 before `prisma.source.update`, and the row keeps the address it had |
| `POST /api/sources/{id}?action=run` | the **stored** row: address, then no-address, then `readBrowserProbe()` | 400, 400, or 503 with the capability sentence — and no `Job` row in any of the three |
| `runScrapeJob`, the worker | `assertAllowedTarget` immediately above every `page.goto`, the first url and each pagination url | the refusal thrown as itself; a missing browser turned into the sentence by `classifyLaunchFailure` |
| `GET /api/health` | `readBrowserProbe()`, reported and never deciding the status | `scrape: {runnable, reason}` beside `ok/db/queues/time`, still 200 — a browser-less instance is not a down one |

Two orderings are pinned, not left to the reader.

- **Policy before capability**, in the worker and at the run door. Which address this server will
  open does not depend on which machine the code runs on; whether this machine has a browser does.
  Ask the box-shaped question first and a browser-less instance hides every refusal it also ought
  to give — which on *this* box would also have meant the ordering could not be demonstrated at
  all. It is demonstrated: STEP 20 writes a `file:` address straight into `Job.config` through
  `POST /api/jobs`, the one door this round leaves alone, and the job fails with
  `file: is not a scheme this server will request` — not with the capability sentence, and not
  with the banner.
- **The judgement before the write**, at all three doors, so the answer is a 400 naming the
  address instead of a 200 with a `jobId`, a `PENDING` row, and a doomed `FAILED` a few seconds
  later. 503 and not 400 for the missing browser, because nothing about the request is wrong: the
  same call against a deployment that ran the install command succeeds.

Two schedulers died in the making of this. `runScheduledScrapers` (`scraper.ts`) and
`runScheduledExports` (`exporter.ts`) were both caller-less, both hand-parsing a cadence with
their own `split(" ")` after #38 had declared the matcher the app's one grammar — and #38's own
"gone from every file in `src/`" scan had missed them because it searched the *deleted matcher's
own phrases*, not the shape. The scrape half also carried `config: { url: source.config }`: had it
ever run, its scrape job's address would have been the source's whole JSON object. Deleting the
export half moved #35's scan from ten reachable export writes to eight (its `Job`-equivalent
create and update were two of the ten), which is retargeted in that file with the reason, not
relaxed. `npm run lint` went from 14 warnings to 13 with them.

The limits, stated:

- **`POST /api/jobs` still stores a caller's `config` unguarded**, and this round leaves it that
  way on purpose: a `Job` is what the queue is for, and the cover is the assertion at the send
  site, above the navigation — which STEP 20 fires on a real worker rather than arguing about.
- **Click-pagination goes wherever the page's DOM points.** `nextBtn.click()` navigates without a
  url this app named; the guard judges the addresses this application writes down.
- **The sentence names the resolver's path**, `…/chromium-1248/chrome-linux-arm64/chrome` here,
  while a default headless launch misses a *different* one, the `chromium_headless_shell-1248`
  path in the banner above. Recorded rather than smoothed, because one install command puts both
  there — the instruction is right even where the path is the near neighbour.
- **A scraper row with no address is refused at three doors; a non-scraper row with no address is
  refused only at the run door** — because it is the run that mints a `SCRAPE` job whatever the
  type column says, and the write doors have no scrape to judge yet.
- **The census is textual.** A check inside a branch the request never passes still counts as
  covering it — the same weakness the auth guard has, in the same direction: it can be satisfied
  by code that is unreachable, never by code that is missing.
- No page renders the `scrape` field yet. The door returns it.

Pinned offline by `tests/unit/scrape-capability.test.ts` (26 tests, in a suite of 670 before the
round and 697 now: the banner above reproduced verbatim as the fixture and recognised by the
classifier, including a message spelled with the other apostrophe; the two capability states being
different facts and neither printing a path it does not have; `scrapeTarget` reading an `API`-typed
row's url and refusing an array, a string and a `null` config; and a table of the **nine** targets
this door used to store — `file:///etc/passwd`, `data:text/html,<h1>hi</h1>`, `javascript:alert(1)`,
`about:config`, `http://admin@127.0.0.1:6379/`, `http://169.254.169.254/latest/meta-data/`,
`http://localhost:5432/`, `/etc/passwd`, `localhost:6379/dev.db` — each refused with the wording
its own code produces, under a control that passes (`http://93.184.216.34/`, a public IP literal,
so the nine are a policy and not a broken check) and with the development override deleted for the
duration of the test because the scheme and userinfo refusals are meant to hold *through* it). The
source scans pin the order at every site: `assertAllowedTarget` above each `page.goto`, policy
above capability in the worker and at the run door, all three doors' checks before their
`prisma.*` write, the run door's 503 before `prisma.job.create`, `readBrowserProbe` imported
lazily into health so the capability cannot make the liveness door throw, and the shipped
`prisma/seed.ts` `WEB_SCRAPER` row still acceptable to the door it now shares — a seed that could
not survive its own app's validation is a demo that only passes when nobody runs it. The census in
`tests/unit/egress-sites.test.ts` (3 tests) gained `NAVIGATION_CALLEE`, matching `goto`, `navigate`
and `loadURL` beside the fetch-shaped names — `reload` and `setContent` stay out because neither
takes an address a caller named — and pins the exact set of navigation sites in the app,
`src/lib/scraper.ts page.goto`, as `policy`-covered with argument `pageUrl`, so the extension
cannot silently stop matching anything. Its own guard was mutation-checked: deleting the
pre-`goto` assertion makes three tests fail.

Live, `demo/run-demo.sh leadworks` STEP 20 — 28 checks, and the whole run **235 ✓ / 0 ✗**, exit 0,
against the rebuilt app. Seven addresses go to `POST /api/sources` and seven come back 400 in the
egress module's own words: `file:///etc/passwd` → `file: is not a scheme this server will request`,
`data:text/html,<h1>lead</h1>` → `data: is not a scheme…`, `javascript:alert(1)` → `javascript: is
not a scheme…`, `about:config` → `about: is not a scheme…`, `/etc/passwd` → `config.url is not an
absolute URL`, `localhost:6379/dev.db` → `localhost: is not a scheme…`, and
`http://admin@127.0.0.1:6379/` → `a URL with credentials in it is not an address we will fetch` —
that last one with the runner's `ABET_ALLOW_PRIVATE_TARGETS=1` in force, because the scheme and
userinfo refusals are asked *before* the override. A `WEB_SCRAPER` with no `config.url` is refused
too: `a scrape navigates to the address in config.url, and this config holds none — no run of this
source could keep the promise`. Then the same door answers **201** for `http://127.0.0.1:3901/scrape-me`,
the run's own hook server, and the stdout carries the hatch saying itself out loud —
`egress: ABET_ALLOW_PRIVATE_TARGETS is set — http://127.0.0.1:3901 allowed despite internal
addresses 127.0.0.1` — because a hatch that passes quietly is a hole that reads as a policy.
`PATCH` that row's `config.url` to `file:///etc/shadow` is refused with the create door's sentence
and the row keeps the address it had; a `config` with no url onto a scraper is refused, because the
row's type is already the promise; and `PATCH { isActive: false }`, which names neither, still
works — the doors refuse writes they can judge, not every write.

Then the three states the run door answers. A `file:///etc/passwd` row hand-inserted over `psql` —
a legal write in every round before this one — gets **400** and **0** `Job` rows, so an address that
was storable last week cannot mint work today. An allowed address on this browser-less box gets
**503** `this instance cannot run a scrape — no browser at /home/opc/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome;
npx playwright install chromium puts it there`, again with no row: the check is a ternary, so an
instance that *has* a browser passes the same leg honestly rather than asserting this box's shape.
The ordering leg stores a `file:` address in a job's own `config` through `POST /api/jobs` (**201**)
and reads the row back `FAILED` with `file: is not a scheme this server will request` — no banner,
and not the capability sentence either, which is the proof that the verdict that does not depend on
the box is stated first; `Source.lastRunError` carries the same sentence. An active `* * * * *`
source still mints its scrape job (this round changed what the job says, not whether the sweep
runs) and writes the capability sentence where the banner used to be — the step asserts the absence
of `╔` and `═`, not merely the presence of nicer words. `GET /api/health` still answers the shape
every reader expects, with `ok=true db=up` untouched, and now adds
`scrape={"runnable":false,"reason":…}` word for word the run door's 503; cleanup leaves 0 of the
step's rows in `Source`.

STEP 19's legs were re-run rather than assumed: still **18 checks**, `*/2 * * * *` still mints and
every job still lands on an even minute (minute :04 in this window), the hand-inserted
`* * * * * 1` row still mints 0 and still prints its `no minute matches it` line, and both doors
still refuse the six cadences. The one footprint this round leaves on an earlier step is
`tests/unit/export-retention.test.ts`'s write census, retargeted from ten to eight with the
scheduler named — the same treatment #38 gave STEP 13's refusal list, and for the same reason: a
pin that agrees with code it no longer describes is quieter than the bug it replaced.

### The same address, in the spelling the caller did not choose

`src/lib/egress.ts` judges an **address**, and every door in this product hands it one through
`new URL(...)`. That parser rewrites an IPv6 literal into compressed hex on the way, and the
rewrite is the whole story of #55. Measured on a built `main` with the policy at its documented
default (no `ABET_ALLOW_PRIVATE_TARGETS`), the same loopback listener was offered to
`POST /api/webhooks` in eight notations: `http://127.0.0.1:8097/ok` → **400** and
`http://[::1]:8097/ok` → **400**, while six IPv6 coats of it — `[::ffff:127.0.0.1]`,
`[::ffff:7f00:1]`, `[0:0:0:0:0:ffff:7f00:1]`, `[::7f00:1]`, `[64:ff9b::7f00:1]`,
`[2002:7f00:1::]` — were each **stored with 201**. The first of those is the caller's own spelling,
and what the door kept was the second: the guard's v4-in-v6 branch tested the text of a
`::ffff:`-prefixed *dotted* tail, and the parser had already turned that tail into two hex groups.
Four more internal targets arrived coated the same way and were stored the same way — the metadata
address as `[::ffff:a9fe:a9fe]`, this box's own `10.0.0.82` at `:6379` as `[::ffff:0a00:0052]`, a
`192.168.4.5` as `[::ffff:c0a8:0405]`, a `100.64.0.1` mesh address as `[::ffff:6440:0001]`, each of
them a plain internal address the same door refuses written without the coat — and
`POST /api/sources` took the identical press in its `config.url` with a **201**. The
metadata row was deleted before a single lead existed, so nothing was ever delivered there; what
this section claims about it is the door's verdict, not a socket.

Three of the six accepted spellings then put a real signed `lead.created` on the loopback listener
— an address every write door refuses when it is written the ordinary way — and the other three
failed at the connect (`TypeError: fetch failed`, `ENETUNREACH` for `2002:7f00:1::`), which is the
box's routing and not the policy's opinion.

`isInternalV6` now parses the literal into its eight 16-bit groups and judges the IPv4 four forms
carry inside them: v4-mapped (`::ffff:x:y`, dotted or hex, compressed or expanded), v4-compatible
(`::x:y`), the NAT64 well-known prefix (`64:ff9b::x:y`) and 6to4 (`2002:x:y::`). A literal that
does not parse is refused rather than guessed at, in either family. A coat around a *public* IPv4
stays public — `::ffff:808:808`, `64:ff9b::0808:0808` and `2002:0808:0808::` are 8.8.8.8, and the
door still stores them — so this is the range table read in the second notation, not a ban on the
notation. The refusal names both halves, `url must not be an internal address (::ffff:7f00:1 carries
127.0.0.1)`, because a message that quotes only one of the two strings is a message about a URL the
caller did not write — and names neither for an address that is internal without carrying anything:
`http://[::1]:8097/ok` is refused as `(::1)`, not as the `0.0.0.1` the same eight groups also read
as, because the reason an operator is told has to be the reason the door acted on.

Every press above went through the same doors on the fixed build. The ten coated addresses the base
run stored are **400** each, the four extra forms the base run never reached (`[::ffff:0a00:0001]`
for a private-network Redis, `[::ffff:c0a8:0101]`, and the metadata address in the 6to4 and NAT64
coats) are 400, `[fe80::1]` and `[fd12::1]` are 400 as the ranges they are, and the five public
coats are **201** with the URL stored verbatim — the same door, the same list, ten rows flipped and
none of the admissible ones moved. `POST /api/sources` now refuses its `config.url` coated the same
way, naming `config.url` and both halves. The redirect leg had to be retaken under the documented
hatch, because after this fix every address reachable on this box is internal and hop 1 can only be
admitted by saying so: the redirector logged **1 hit `POST` with `Location:
http://127.0.0.1:8096/stolen`**, the listener behind that Location logged **no hit at all**, and the
delivery is one line in the app's stdout — `webhook … -> lead.created: 302 Found`. The same boot
delivered one ordinary signed event to a loopback subscriber and the receiver verified it under
**both** header spellings (`signatureMatches: true, genericMatches: true`), which is the check that
the redirect change did not disturb the path that still works; and the hatch said what it let
through, `allowed despite internal addresses ::ffff:7f00:1`.

The second measured press is the one that did not need a parser to be tricked. A subscription whose
endpoint answers **302** was pointed at a redirector on `:8097` whose `Location` was
`http://127.0.0.1:8096/stolen` — the dotted form no door in this product will store, refused in the
list above. The delivery followed it: the listener on `:8096` logged **1 hit, `GET`, 0 bytes**, the
body and event id dropped at the hop by the redirect's method change and the `X-Leadworks-Event`
header carried through. One ask per delivery, and a second address on the wire. The scrape path had
already learned this — `src/lib/scraper.ts` calls `assertAllowedTarget` once for `config.url` and
again for every page URL it builds — so the delivery fetch now says `redirect: "manual"` and a 3xx
is left as the response it is, which is a non-2xx and lands in the same log line a 500 does.

**What that costs a subscriber**: an endpoint that answers a webhook with a redirect no longer
receives it. Nothing in this family's contract, or nuCRM's `x-webhook-signature` convention, asks
for a redirectable receiver, and a receiver that needs one is given a `302` in this instance's
stdout rather than a silent delivery to wherever it points. **What is still owed, and stated in the
module header**: `classifyTarget` resolves a name, judges every answer, and hands the *name* to
`fetch`, which resolves again — DNS rebinding across the two lookups is closed only by connecting
to the address that was checked, which needs a custom agent; and a `page.goto` follows whatever the
document it loads tells the browser to do, which no check on `config.url` can name in advance.
**And this module is a copy.** Its header says the family vendors it from `shared/sync-auth.sh`
into every app, and the shared tree is not on this box, so the five other copies — abetapi's
dispatch and SSO doors, abetanalytics' alerts, leadgenius' webhooks, abetagent's `http_fetch`,
abetflow's `http_request` node — carry the same v4-in-v6 hole until the fix is synced back up.
What is claimed here is one app's door, not the fleet's.

Pinned offline by `tests/unit/egress-v4-in-v6.test.ts` (**20** tests, in a suite of 978 before the
round and 998 now): the parser's rewrite asserted as the reason a bare-string case was not enough
(`new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]`); the ten coated addresses
above refused through `classifyTarget` in the caller's own label; each of the four carrying forms; a
cross-check that every v4 range the dotted table refuses is refused in hex too, with the two
one-past-the-edge addresses (`172.32.0.1`, `100.128.0.1`) staying public on both sides; the
metadata coat refused at the boundary; unparseable literals refused rather than decoded; a `[::1]`
refusal that names the v6 loopback rather than the `0.0.0.1` the same eight groups also read as,
because the decision and the explanation come out of one function and `carries` is printed only when
the wrapped IPv4 is what made the answer internal; the
development hatch still carrying a coated address through *and* reporting itself; `assertAllowedTarget`
throwing with `egressCode: "internal"` so a coated refusal and a dotted one reach a log identically;
and the delivery source read for its redirect decision — exactly one `fetch`, exactly one
`redirect:`, the ask before the connect, and the scraper's two asks pinned beside it.

### What a finished job says it did: the percentage, the denominator, and a record per row

`README`'s own API list has read `GET /api/jobs/{id}  # detail + results` since the first
commit. Measured on the table before any of this shipped: **475 `Job` rows, 466 of them
COMPLETED, and `JobResult` held 0 rows** — because nothing in `src/` had ever written one. The same query showed every COMPLETED row
reporting `progress: 100`, and **386 of them reporting it beside `totalItems: 0`** while
reporting `processedItems: 16`: the workers held the crowd size in a local variable, wrote
it into no column, and typed the answer at the finish line. Five more reported COMPLETED
with `failedItems > 0`. And no row had *ever* been CANCELLED.

`src/lib/job-report.ts` owns the reading now, and four things follow from it.

- **The percentage is arithmetic.** `progressValue({ total, processed, failed })` divides,
  and the four workers that can finish on this instance call it at their terminal write —
  enrichment calls it inside the loop as well, on the per-lead row update it was already
  making. A job that was told to visit 200 rows and visited 100 says 50.
- **A job with no denominator says so.** `total: 0` is not 100% and not 0%: `progressOf`
  returns `{ measured: false, reason: NO_DENOMINATOR }` and the row is stored with
  `progress: 0` beside the `totalItems: 0` that explains it. An export whose filter matched
  nothing finishes COMPLETED and reports *not measured*, which is the truth, rather than
  100% of nothing, which is a number a dashboard can average into a lie.
- **A row whose own counters disagree is named, not smoothed.** `countersProblem` reads
  "16 rows accounted for against a denominator of 0" out of the 386 historical rows and
  says it in `report.problem`. It is a reading: those rows stay exactly as they are, and
  the fix is that no new row can be written that way, because the hand that computes the
  share now writes the denominator it computed it from.
- **Every row a worker decided has a record.** ENRICH, VALIDATE and DEDUPE decide
  something per lead and used to throw the decision away, keeping three integers. Each now
  writes one `JobResult`: the visit that filled a column is `SUCCESS` with the columns it
  wrote, the visit that reached a row and wrote nothing is `SKIPPED` with a reason read off
  the row — *which* of `planEnrichmentWrite`'s gates fired (`the row already held
  \`seniority\``, `\`technologies\` came back in a shape its column does not accept`,
  `\`confidence\` is not a column a lead row has`) beside the sets it was derived from — the
  lead that threw is `FAILED` with the message, and the duplicate that was folded into a
  master names both ids. Telling an answer the rule narrowed away from an answer that named
  nothing needs both sets, so `enrichLead` hands over what the providers named *and* what
  `actions.fields` let through; the narrowed one alone cannot make the difference.

Two orders are pinned, and both are about *when* the record is written.

**A record exists before the row says it finished.** Each `JobResult` is created inside the
loop, next to the lead write it describes, so a `COMPLETED` row cannot name results that
were never stored — and a job that throws halfway leaves the records for the rows it did
finish. `GET /api/jobs/{id}` reads `results` with `take: 50`, so `report.results` counts
them: `{ recorded, returned, truncated }`. 50 of 50 and 50 of 4,000 are different facts and
the door used to return the same array for both.

**A removal is recorded before the row it names is deleted.** `VALIDATE` with
`action: "remove"` deletes the lead, and `JobResult.leadId` is `ON DELETE SET NULL` — so the
insert runs first, with the id copied into the payload as `removedLeadId`, and what survives
is a record that points at nothing and still says which lead it described. `DEDUPE` with
`merge` or `delete` does the same to the duplicate, so its record passes `leadId: null`
deliberately and keeps `duplicateId` in the payload; `flag` keeps the row, so its record
keeps the FK. Writing either record after the merge would be a foreign-key violation
masquerading as a log line.

Where each question is answered:

| who asks | where | what it gets |
|---|---|---|
| an operator reading one job | `GET /api/jobs/{id}` → `report` | `measured`, `percent`, `reason`, `verdict`, `verdictNote`, `problem`, `results` |
| the same operator, mid-run | the `Job` row itself | `progress` recomputed on every per-lead write, `totalItems` stamped by the worker |
| a receiver of `enrichment.completed` | the payload's `processed/enriched/failed` | unchanged — the event is not the record list |
| whoever deletes a lead | the schema | `SET NULL` on `leadId`, `CASCADE` on `jobId`: a job takes its records with it |
| a caller trying to forge a denominator | `POST /api/jobs`, `PATCH /api/jobs/{id}` | nothing available: `JOB_CREATE`/`JOB_PATCH` declare no counter column, so `report`'s inputs are the worker's alone |

What this does not claim, in the words the surfaces use:

- **`Job.status` has no value between COMPLETED and FAILED**, so "finished, and 2 of 16
  could not be done" is *derived* at read time (`verdictNote: "partial: 2 of 16 …"`) and
  the stored status is left alone. Adding a sixth status is a schema decision, not a
  reporting one.
- **`?action=cancel` marked the row and nothing obeyed the mark.** No worker re-read the
  status, so a cancelled job could still run to COMPLETED, and 0 rows had ever been
  CANCELLED — which is what a door that is never reached looks like. The reading above
  printed that limit as the verdict note of a cancelled row, in the present tense, because
  that was the truth about the code at the time. The next section is the round that made
  the mark obeyed; the API list's comment on this action and that note are the two places it
  had to rewrite.
- **SCRAPE still types its 100, and this round left it alone on purpose.** Its terminal
  write is unreachable on an instance with no browser (STEP 20 is that fact), so no change
  to it could be checked here; and its counters mix units — the denominator it would divide
  by is pages while `processedItems` holds leads saved — which is a unit decision this
  reporting module must not make silently. `countersProblem` would call a 16-of-1 row a
  contradiction, and for a scrape it would be right to.
- **EXPORT writes no per-item record, by decision.** Every row its filter matched went into
  the file, so 16 identical `SUCCESS` rows would repeat the file at 16 inserts. DEDUPE,
  ENRICH and VALIDATE each decide something per row that the job row cannot show; that is
  the line the records stop at.
- **The 386 rows are counted, not repaired.** The census in the demo prints them by job
  type every run. Backfilling them would invent per-item outcomes no worker recorded, and an
  outcome nobody observed is not a fact.

The whole reading is pinned offline in `tests/unit/job-report.test.ts` — **54 tests**, no
browser, no database, no network: the arithmetic's known answers (16/16 → 100, 1/3 → 33,
14+2 of 16 → 100 with a partial verdict, `total: 0` → unmeasured), the 386 row shape read
back as a contradiction, the two refusals in `jobResultRow` (a FAILED with no message and a
SKIPPED with no reason are both filled in words, never dropped), a status outside
`SUCCESS | FAILED | SKIPPED` turned into a FAILED rather than a new word, and the schema
comment for `JobResult.status` compared to the set the module writes. Then the five shapes
of a visit that landed nothing, each with its reason spelled out — including the one where a
column is refused for shape while another is already held and a third has no column in the
table at all — with the module importing `enrich-plan`'s own `holds` and `ENRICH_WRITABLE`
rather than deciding the same question a second time. Then the wiring, from
the source: no `progress: 100` left in any of the four workers, and a census over `src/`
that finds **exactly one** file still typing it — `lib/scraper.ts` — so a future round that
fixes it has to change this test rather than drift past it. Every `prisma.jobResult.create`
in the tree must be shaped by `jobResultRow`, no worker hands out a `SUCCESS` any more,
`updateLeadEnrichment` hands back the columns
it wrote instead of a count of them, the validator's record is proven to sit before its
`lead.delete` by index arithmetic on the body, `JOB_CREATE`/`JOB_PATCH` are read to show no
caller can write a counter, and the migration's own DDL is matched for
`ON DELETE SET NULL`.

Live, in STEP 21 of the LeadWorks demo — **25 checks**, each one answered by a row the
running application wrote itself:

- **An old row is re-read, not smoothed.** A job written before this round still stores
  `progress=100, totalItems=0, processedItems=1`; the door answers `measured=false, percent=0`
  beside `problem=1 row(s) accounted for against a denominator of 0 — the job reported work on
  rows it never counted into its total`, and its `results.recorded` is 0. Counted, not backfilled.
- **The CANCELLED rows are still hand-written** — this step was built before any worker obeyed
  the mark — and #41 rewrote what the door answers for them. A row carrying 4 of 10 reads
  `verdict=CANCELLED` beside *"stopped at the mark with 4 of 10 row(s) accounted for; 6 row(s)
  after it were never reached — a row already in flight is finished, the next one is not
  started"*; a row carrying 0 of 10 reads *"the mark was read before the worker reached a row —
  10 row(s) in its denominator, none visited, no record on any of them"*. Neither shape is
  reported as a contradiction, because a stop is the one shape those numbers are honest in.
  The next section is about the runs that earn those rows instead of hand-writing them.
- **A new row's 100 is arithmetic.** VALIDATE over three named leads finishes
  `progress=100` over the `totalItems=3` the worker stamped, and
  `results={"recorded":3,"returned":3,"truncated":false}` — `detail + results` with results in
  it for the first time on this instance. The kept lead's own row flags
  `[linkedin_format, phone_format]` and its record names the same two columns.
- **A removal leaves its record behind.** VALIDATE `action=remove` ends with 2 records and both
  leads answering 404; the database agrees that 2 records on that job point at no lead, each
  naming the id it described in its payload.
- **A 1-of-1 dedupe says what its 100 is 100% of**, and the duplicate it flagged is one record
  naming `duplicate=… master=…` with the lead still under it — `flag` keeps the row, so the FK
  survives.
- **The enrichment visit, re-read**: `SUCCESS=1 SKIPPED=2`, the two skips printing *“the
  providers replied, and their answer named no column at all”* and *“the row already held
  `seniority`”*. Run again over the same three leads it is `SUCCESS=0 SKIPPED=3` — every record
  a skip the row explains, because the writes are idempotent.
- **The export whose filter matches nothing**: `COMPLETED progress=0 totalItems=0
  measured=false`, reason *“not measured: this job stamped no denominator, so there is no share
  of a whole to report”*.
- **The residue counted out loud**: `terminal jobs still holding no per-item record, by type:
  DEDUPE=55 ENRICH=380 EXPORT=125 VALIDATE=75`, EXPORT and SCRAPE each carrying the stated 3 ENRICH=376 EXPORT=117 VALIDATE=75`, EXPORT and SCRAPE each carrying the stated
  reason they are not gaps, and 353 COMPLETED rows on this database whose own counters disagree
  named at the top of the step.
- **The cascade, checked rather than assumed**: after the step's cleanup,
  `0 per-item records left on this step's 4 jobs`.

The whole run came out **290 ✓ / 0 ✗, exit 0** — STEP 21's 25 checks and STEP 22's 19 87 ✓ / 0 ✗, exit 0** — STEP 21's 25 checks and STEP 22's 17
(the #41 round, below) among them. It was performed on resources this round owns
rather than on the shared `demo/run-demo.sh leadworks` boot, and the reason is a collision, not
a preference: another session's runner on this box begins with `fuser -k 3300/tcp` and re-seeds
the shared database, so a run against 3300 can be answered by the other build and lose its API
key mid-flight — three attempts here died exactly that way: one partway through on a key the
other run had just revoked, two with port 3300 taken over from under them.
So the app was started from this worktree on port **3311**, against a `pg_dump` clone of the
shared table (`leadworks_r40`), with a private Redis on **6380** and the webhook capture on
**3901** — the environment `run-demo.sh` itself supplies (`ABET_ALLOW_PRIVATE_TARGETS=1`,
`EXPORT_RETENTION_MS=25000`, a freshly minted key) with only those four addresses changed
(`/tmp/opencode/lw40-harness.sh`). The database behind it therefore holds this demo's own
earlier traffic, which is why the census above reads 353 rather than the 386 rows the shared
production table held when the module was written.

Verification: `npm test` **799/799** (54 new here, 44 more in #41), `npx tsc --noEmit` clean,
`npm run lint` **0 errors / 12 warnings** (13 → 12), `npm run build` exit 0.

### The mark is obeyed: what a cancelled job stops doing, and what it says it stopped at

The API list above has carried `?action=cancel` since the first commit, and the table answered
what it had ever done: **475 `Job` rows, 466 COMPLETED, 0 CANCELLED**. The door wrote the status
and `completedAt`, answered `{ ok: true }`, and **nothing in `src/` read the mark back** — not one
of the three workers that loop over rows. A cancelled job ran to COMPLETED over the operator's
word. The reading the previous section shipped had to print that as the verdict note of a
cancelled row, in the present tense, because it was the truth about the code. This section is the
round that makes it false, which is why the sentence is gone from the tree and the API list now
says the opposite.

`src/lib/job-stop.ts` owns the mark: `MARK` is the one status that is a mark, `isMarked` reads it
off a row (a row that is *gone* is not a mark — absence is not permission to stop, because the
worker would then write a terminal status to a row that is not there), `startWrite` is the word a
worker uses when it takes a row over, and `stoppedWrite` is the terminal write of one that obeyed.
The *reading* — what the row's counters say and what the door hands back about them — stayed in
`lib/job-report.ts`, one owner for the words.

- **The boundary is between rows.** Each of ENRICH, VALIDATE and DEDUPE re-reads the row's status
  before the next lead, and stops there. A row already in flight is finished: abandoning one
  would leave a lead half-written and a `JobResult` claiming nothing about it. That is the whole
  of what a stop cannot promise, and it is why the check sits at a boundary rather than at an
  `await`.
- **The stop's arithmetic is the finish's arithmetic.** `stoppedWrite` stamps `CANCELLED` — the
  door's own word, never a worker's — beside the denominator the worker walked, the counters it
  holds, and the percentage between them. A job stopped at 4 of 16 says 25, and cannot say 100
  about a run it stopped.
- **A stop is not a contradiction.** `countersProblem` forgives exactly one shape: a denominator
  with nothing accounted for under a row that says `CANCELLED` is what a mark read before the
  first row looks like, and calling it "finished without saying it visited any row" would accuse
  a stopped job of the one thing the stop guarantees it did not do. The same numbers on a
  COMPLETED row are still an accusation, and a mark is not a licence to smooth over-reporting.
- **`reached` is not `failed`.** `stopAt` splits a stopped row into the rows it accounted for and
  the rows after the mark it never saw — the counters alone cannot tell "never tried" from "tried
  and could not", so the reading does, and `stopNote` says all three numbers plus the one caveat.
- **A stopped job tells nobody a finish it did not have.** `enrichment.completed` is dispatched
  only when the walk was not stopped; there is no fourth event name to invent, because an event
  that fires for a job the operator stopped is the wire version of the typed 100.

The mark outranks every word a worker writes, at all four places a status is stamped:

| where | what it used to do | what it does now |
|---|---|---|
| the claim, before the crowd is read | `update` writing `RUNNING` over anything | one `updateMany` with `status: { not: MARK }` in its WHERE: a cancel that lands between the snapshot read at the top of the worker and this statement is not answered by a `RUNNING` the worker made up, and `count: 0` means the row says the mark — so the worker never begins |
| the per-lead stamp (enrichment's, once a row is counted) | `update` of `progress`/counters, which could walk a fresh mark back to `RUNNING` | `updateMany` guarded the same way, and it now carries `totalItems` too, so a row read *between two leads* is a measurable share rather than a bare status |
| the finish | `update` of COMPLETED, win or lose | `where: { status: stopped ? MARK : { not: MARK } }` — a stop writes under the mark, a finish writes around it; a finish that matched nothing is the row saying the mark, and the repair writes the stop's counters under it |
| the error path | `update` of FAILED over anything | `updateMany` with the mark in its WHERE: a throw is this worker's own word and does not outrank the operator's |

| who asks | where | what it gets |
|---|---|---|
| an operator mid-run | `GET /api/jobs/{id}` | a measurable `progress` over a `totalItems` the worker stamped as it counted, and `results.recorded` — one per row reached, none for rows never started |
| the same operator after a cancel | the same door | `verdict=CANCELLED`, `verdictNote` naming reached/left/in-flight, `problem=null` |
| a caller of `?action=cancel` | `{ ok: true }` | the word the row ends on, unless it had already finished — the door still refuses to cancel a terminal row |
| a caller of `?action=retry` | a new row | retry has always made a *new* job, and #42 made a *stopped* row one it can be made from — this row said "unchanged" and the door answered `400 "Can only retry failed or completed jobs"`; see **A stop that can be undone** below |
| a webhook subscriber | the wire | nothing for a stopped job; one `enrichment.completed` for a finished one |

What this does not claim, in the words the surfaces use:

- **Two workers still do not consult the mark, by name and for stated reasons.** `lib/exporter.ts`
  has no per-row loop — its work is one file written over the whole crowd — and `Export.status`
  has no word for a cancelled file, which is a schema decision rather than a reporting one.
  `lib/scraper.ts` is unreachable on an instance with no browser (STEP 20 is that fact) and is
  still the one file typing `progress: 100`. A test pins that exactly these two files are the
  ones left out, so a future round has to change the test rather than drift past it.
  **#43 took the first of the two.** The export worker now obeys the mark, and the word it puts
  its record down with is `FAILED` — one of the four `Export.status` already documents, so no
  fifth word was invented. The census in `tests/unit/job-stop.test.ts` moved with it: four
  workers obey and one door asks for the word, and `lib/scraper.ts` is now the only worker left
  that drives through a stop.
- **A cancel that lands after a worker's last boundary check still loses** — the door refuses to
  mark a row that has already finished, which is the right answer: the work is done, and a status
  that says otherwise would be the same lie in a different font. What #41 removed is the window
  *inside* the run: the finish is now a guarded write, so a mark landing during the last row's
  work is honoured with the counters that row produced.
- **A stop lands in two writes, and the window between them is the row that was in flight.**
  `?action=cancel` marks the row at once; the worker's own terminal write — the one carrying the
  counters, the denominator and the percentage — comes only after the lead it had already started
  finishes, and each row's record is written before its counter is counted. A reader that polls the
  *status* alone can therefore catch a row saying 3 accounted for beside 4 records, short by the
  one row it is still working, for as long as that row takes. STEP 22 used to poll that way and the run before this one is how it was found: the step
  now reads the mark's snapshot and the worker's snapshot separately, waits for the row to agree
  with the records it holds, and asserts the gap never exceeds one row. Closing it completely would mean
  finishes. A reader that polls the *status* alone can therefore catch a row saying 3 accounted
  for beside 4 records, short by exactly the one row it is still working, for as long as that row
  takes. STEP 22 used to poll that way and this run is how it was found: the step now reads the
  mark's snapshot and the worker's snapshot separately, waits for the row to agree with the
  records it holds, and asserts the gap never exceeds one row. Closing it completely would mean
  abandoning a row mid-visit — the one thing a stop must not do — or writing each record and its
  counters in one transaction, which is a decision about every row rather than about the stop.
- **`Job.status` still has no value between COMPLETED and FAILED**, so a stop that reached some
  rows and failed others is read at the door rather than stored as a sixth word.
- **The 466 historical rows are counted, not repaired.** A stop's shape is now written by the
  worker that stopped; nothing in this round rewrote a row that ran before it.

Live, in STEP 22 of the LeadWorks demo — **19 checks** on the same isolated boot as STEP 21:

- **A stop read between two leads is a measurable share.** 300 leads imported, an ENRICH job
  over those named ids, found `RUNNING` with 1 of 300 already counted and `progress=0` — the
  percentage is stamped while the job is still walking, not only at its finish line, and one row
  out of three hundred is a third of a percent, which is what the arithmetic says rather than
  what a typed number would. `?action=cancel` answers 200, and the row settles **`CANCELLED` at
  3 processed + 0 failed of 300 with `progress: 1`**: 3 reached, 297 never started,
  `results.recorded` 3 — one per row it did and none for the crowd it did not — the leads
  themselves agreeing (3 rows carrying a fresh `lastEnrichedAt`, 297 not), and `report.problem`
  null beside a note that names reached, left, and the row that was already in flight.
- **A stop is two writes, and the demo reads both.** The door marks the row at once; the
  worker's terminal stamp — the one carrying the counters — follows when the lead it had already
  started finishes. STEP 22 snapshots the row as the mark arrives and again once the row agrees
  with the records it holds, and asserts the gap between the two is never more than the one row in
  flight; this run's gap was **0**, because the mark landed at a boundary with nothing in flight.
  The run before it polled the status alone and read 3 accounted for beside 4 records — that is
  the window, and the check is now the proof of its size rather than an accident of timing.
Live, in STEP 22 of the LeadWorks demo — **17 checks** on the same isolated boot as STEP 21:

- **A stop read between two leads is a measurable share.** 300 leads imported, an ENRICH job
  over those named ids, found `RUNNING` with 1 of 300 already counted and `progress=0` — the
  percentage is stamped while the job is still walking, not only at its finish line, and one row
  out of three hundred is a third of a percent, which is what the arithmetic says rather than
  what a typed number would. `?action=cancel` answers 200, and the row settles **`CANCELLED` at
  3 processed + 0 failed of 300 with `progress: 1`**: 3 reached, 297 never started,
  `results.recorded` 3 — one per row it did and none for the crowd it did not — the leads
  themselves agreeing (3 rows carrying a fresh `lastEnrichedAt`, 297 not), and `report.problem`
  null beside a note that names reached, left, and the row that was already in flight.
- **A stop is two writes, and the demo reads both.** The door's mark and the worker's own
  terminal stamp landed 3 rows apart from each other and 0 rows apart in this run's account — the
  step snapshots the row as the mark arrives, waits for the row to agree with the records it
  holds, and asserts the gap never exceeds the one row that was in flight. An earlier run of this
  step polled the status alone and read 3 accounted for beside 4 records: that is the window, and
  the check is now the proof of its size rather than an accident of timing.
- **A stopped job tells nobody a finish it did not have — proved against a job that did.** A
  webhook subscribed to `enrichment.completed` receives **nothing** for the stopped job and
  **exactly one** delivery for a 3-lead control that finished, so the silence above means the
  stop rather than a dead subscription.
- **A mark that lands before the worker begins is obeyed by never beginning**, and this half is
  made deterministic instead of raced: the dedupe worker holds **one** slot, so a sweep over
  200 imported phone-pairs (400 leads) keeps it `RUNNING` while a second job waits `PENDING`.
  That waiting job is cancelled, and when the worker frees up it reads the row and does not
  start it: `CANCELLED`, `startedAt` null, 0 processed, 0 records — read as a stop that claimed
  no denominator, while the sweep that refused to begin it finishes its own crowd.
- **The step prints what it left alone** — the two workers that still do not consult the mark,
  by name and with their reasons — and its cleanup takes 703 leads and 4 jobs back out through
  the doors, leaving 0 rows and 0 records from the step.

STEP 22's 19 checks are among the **290 ✓ / 0 ✗, exit 0** that STEP 21's note above reports 7 checks are among the **287 ✓ / 0 ✗, exit 0** that STEP 21's note above reports
for the whole run.

The 44 new offline tests are the same claims without a server: `stopAt`, `stopNote` and
`stoppedWrite` answered by hand (including the NaN and negative shapes, which is why every
field of the terminal write goes through the one clamp `job-report` owns rather than a second
`Math.max`), the one forgiveness and the two it still refuses, each worker's boundary read
proved by index arithmetic against the row that worker is about to work on, all four guarded
writes proved in the source of each worker, the repair proved to come *after* the write it
repairs, the dispatch proved to sit inside `if (!stopped)`, `WEBHOOK_EVENTS` still exactly
three names, a census over `src/` proving that the literal `status: "CANCELLED"` is written in
exactly one place — the door — that the mark-payload form is written in exactly one module, and
that **exactly two** files still do not consult the mark (`lib/exporter.ts`, `lib/scraper.ts`,
for the two stated reasons — #43 has since made the export worker obey, and that round's pins
say so), plus the sentence #40 had to print proven gone from the tree and
the API list proven to say the opposite now.

Verification: `npm test` **799/799** (44 new in `tests/unit/job-stop.test.ts`, 38 `it(` blocks
over 9 describes — no browser, no database, no network), `npx tsc --noEmit` clean,
`npm run lint` **0 errors / 12 warnings** (unchanged), `npm run build` exit 0.

### A stop that can be undone: the door that marks a row is the door that restarts the crowd it left

The round before this one made `?action=cancel` real, and in the same breath wrote a line about
the other action on that door that its own code contradicted:

| what #41's table said | what `?action=retry` answered |
|---|---|
| retry has always made a *new* job, so an operator who stops a job at row 4 of 200 restarts it over the rows still standing | `400 "Can only retry failed or completed jobs"` — `CANCELLED` was not one of the two words that guard accepted |

That is the shape this project keeps finding: a sentence describing what a door is *for* rather
than what it checks. #41 fixed the worker and left the door's refusal standing, so a stop was
honest and irreversible at once — the row told an operator exactly how many leads were never
reached, and would not let anything reach them. This round takes the sentence out of the
contradiction by making the door say it.

`src/lib/job-retry.ts` owns the two decisions the route used to make inline.

| the decision | what it is now |
|---|---|
| which rows a resume may be taken from | the three a worker has put down: `COMPLETED`, `FAILED`, `CANCELLED`. A `PENDING` or `RUNNING` row answers `409` and names what a resume there would do — a second runner walking the same crowd beside one that has not stopped. A status outside the set the schema documents answers `400` with the word in the message, because `lib/fields.ts` records that an unknown status is invisible to every comparison in the app; a guard that fell through would open for anything it did not recognise. |
| what the row it creates carries | `workspaceId`, `type`, `config`, and `PENDING` — and none of the stopped row's account of itself. `progress`, `totalItems`, `processedItems`, `failedItems`, `error`, `startedAt`, `completedAt` are not copied, because `lib/job-report.ts` reads those columns as arithmetic: a job that has visited nothing must not open reporting 1 of 300. |

The order in the door is the order the guard needs: the status asked, then `hasRunner` (a type
nothing runs must not leave a second `PENDING` row behind), then the insert, then the queue. The
stopped row is written by none of it — a resume is a new job, and `CANCELLED` stays on the row
that stopped, with the counters its own worker stamped.

**What a resume is not: a cursor.** `Job` has no position column and nothing here invents one. The
crowd lives in `config` — a named list of leads, or the conditions that select one — so the
resumed job walks the set the operator meant, *including* the leads the stopped job already
wrote. What makes that safe is the gate enrichment's own visit already obeys: a column the row
holds is left alone, and the record of the visit says which gate refused it. So the second walk
fills the rows still standing and re-states nothing on the rows already done. The one thing that
does move twice is `lastEnrichedAt`, because the visit really happened twice.

Live, in STEP 23 of the LeadWorks demo — **16 checks** on the same isolated boot as
STEPS 21 and 22:

- **A stop, taken for real.** 300 leads imported through the CSV door, an ENRICH job over those
  named ids, found `RUNNING` with a lead already counted and `?action=cancel` answered 200; the
  worker's own stamp settled the row at **8+0 of 300,
  `progress=3%`**, its two writes 1 row apart, and 8 of the
  crowd carrying what the first walk wrote — one lead per row the job accounted for.
- **The door answers a stopped row.** `POST /api/jobs/{id}?action=retry` against that
  `CANCELLED` row returns **200 with a new job id** — the ask that got a 400 before this round.
  The row it makes is `RUNNING` (not the mark copied forward) and its `config` is
  byte-identical to the stopped job's: the whole 300, because there is nothing on this table
  that could remember a position.
- **The resume finishes the crowd.** It settles **`COMPLETED` at 300 of 300 with
  `progress=100`** — 100 because the arithmetic says 100 — and `report.problem` is null beside
  it. `results.recorded` is **300**: one record per row of the walk, including the rows
  the stopped job had already visited.
- **The second walk refuses exactly the leads the stop wrote, and only those.** Of those
  300 records, **292 are `SUCCESS` and 8 are `SKIPPED`** with
  a reason quoting the value the row already held. 8 equals the number of leads
  the first walk had touched and 292 equals the number it never reached — the gate
  deciding the split, row by row, with no arithmetic in the door. The crowd ends at
  **300/300 leads holding the seniority**, which is where a job that had never been
  stopped would have left it.
- **The stopped row is not resurrected.** Read again after its resume finished: same `CANCELLED`,
  same 8 processed, same `completedAt`. Two jobs, two walks, two records of them. The
  same door still refuses to cancel that row a second time (`400`), which is the guard #42 did
  not touch.
- **A row a worker still holds is not a stop.** The same ask against an ENRICH found `RUNNING`
  with a lead counted answers **409**, names the double walk in its message, and creates no
  second row — `400` was the old answer to a different question, and a state collision is not a
  malformed request.
- **The wire says which of the two finished.** 1 `enrichment.completed` for
  the resumed job, and still zero for the stop that never completed.
- **Cleanup** takes 300 leads and 3 jobs back out through the doors and proves
  0 crowd rows, 0 per-item records and 0 job rows remain
  from the step.

What this does not claim:

- **A resume taken while the stopped job still has a row in flight can visit that lead twice.**
  The writes are idempotent and the second visit is refused and recorded, so nothing is
  clobbered — but `lastEnrichedAt` moves twice and both jobs' records can name the same lead.
  STEP 23 takes its resume after the second of a stop's two writes lands, which is the shape an
  operator's click will usually be; the window itself is #41's, not a new one.
- **The resumed job's numbers are its own walk, not the crowd's history.** 300 records
  for 300 leads, of which 8 say they filled nothing. A reader who wants to know
  what the crowd got asks the leads; the two job rows together are a record of two attempts, not
  one sum.
- **Nothing here is a scheduler.** The resume is a click on a door; no retry happens by itself,
  and nothing marks a stopped row as worth resuming.
- **Two workers still did not consult the mark** — `lib/exporter.ts` and `lib/scraper.ts`, named
  with their reasons in the section above. A door cannot undo a stop those workers never made:
  their rows end `COMPLETED` or `FAILED` however an operator feels about it. **#43 made the first
  of them obey**, which is what turned this round's "left alone by name" bullet into a resumable
  door: see the section below.
- **No history was rewritten**, and there was no marked history to resume — the census that
  opened #41 counted 0 `CANCELLED` rows in 475 jobs, which is the other way of saying no
  operator could ever have used that door.

Verification: `npm test` **827/827** (28 new in `tests/unit/job-retry.test.ts`
over 4 describes — no browser, no database, no network), `npx tsc --noEmit` clean,
`npm run lint` **0 errors / 12 warnings** (unchanged), `npm run build` exit 0. The 28 new tests
answer `retryAsk` by hand for all five documented statuses and for the lookalikes a fall-through
guard would open for (`cancelled`, `Canceled`, `COMPLETED `, the empty and blank strings); prove
`retryRow`'s key set is exactly the four columns a new job may claim, with `sourceId` omitted when
the row has none; take `progressValue` of the stopped row's own numbers to show what copying them
would have said; drive `planEnrichmentWrite` and `enrichmentVisit` over a crowd of four whose
first three the stop already wrote and assert the end state — one write, three refusals naming the
gate, every lead holding the one value; and pin the door by index arithmetic (status before runner
before insert before queue, no `job.update` anywhere in the retry branch), the census that the old
sentence is gone from this door and the only inline retry guard left is the export one, and the
fact that the module that decides all of this holds no query and no status code.

### The file is the unit of work: a stopped export names no file, takes its bytes back, and can be run again

#41 named this worker and left it alone. #42 named what leaving it alone made unresumable. This
round is the worker.

The trace #41 measured on the running app is still the clearest statement of the bug: an
`?action=cancel` on a queued `EXPORT` job answered `200 {"ok":true}`, the `Job` row held the mark
for **139 ms**, and the worker wrote over it twice — `RUNNING` the moment it took the job, then
`COMPLETED` with the file's path, size, count and lifetime — with `export.completed` already on
the wire beside a row that said its operator had stopped it. Two rows about one file, disagreeing,
and no way back: `POST /api/exports/{id}?action=retry` accepts only `FAILED`.

What makes an export different from the three row-wise workers is its indivisible unit. It reads
the crowd in one query, renders it in memory and writes it with one `writeFile`; there is no "next
row" to stop at. So the mark is asked at the boundaries this work actually has — before the bytes
and after them — and the second half produces a residue the row-wise workers never do: bytes on a
disk that no row will ever name.

`src/lib/export-stop.ts` owns the two decisions, and holds no query, no `unlink` and no status
code. The worker keeps the arithmetic it already had from `lib/job-stop.ts`.

| the decision | what it is now |
|---|---|
| which word the record is put down with | `FAILED` — one of the four words `Export.status`'s own comment documents, so no fifth word was invented — beside `STOPPED_EXPORT_ERROR`, a sentence that names neither an expiry nor a loss. The word is also the door's: `?action=retry` refuses anything but `FAILED`, so a stopped export is resumable from the moment it stops. |
| what the five file columns say | `filePath`, `fileSize`, `expiresAt`, `completedAt` nulled and `recordCount` 0 — written as nothing rather than omitted, because this put-down can land on a row the same run had already stamped `COMPLETED`. A row that says `FAILED` while still pointing at bytes that are being deleted is a door answering about a file the disk has not. |
| what happens to bytes already written | `planRowDelete` — the same guard `DELETE /api/exports/{id}` asks, so "we only delete files we wrote" stays one rule with three callers instead of a second copy that can drift. `none` is an honest third answer: the file stays and is reported as staying. |
| the order | disk, then record, then job — the row stops naming a path before the path stops existing. |
| the claim | one `updateMany` with `status: { not: MARK }`; `count: 0` and the worker never begins, so a cancel that lands while the job sits in the queue is answered by the two put-downs and nothing else. |
| the announcement | `dispatchWebhookEvent(... "export.completed")` is the last statement of the `try`, reached only when the guarded finish matched. Every stopped path returns out of the block before it. |

Live, in STEP 24 of the LeadWorks demo — **18 checks** on the same isolated boot as STEPS 21-23,
over a crowd the step imports for itself and deletes again: **12,000 leads through the CSV door in
102,630 ms**, so the workspace holds 12,019 and a PDF run is long enough to stop inside.

- **The denominator first.** An uninterrupted PDF over that crowd -> **`COMPLETED` in 4,221 ms**,
  `/tmp/export_1792728790187.pdf`, **616,829 bytes over 12,019 rows**. Every aim below is a
  fraction of that 4,221, and that is the state a stopped run is told apart from.
- **A stop taken inside the run.** `POST /api/jobs/{id}?action=cancel` fired **3,545 ms** into the
  ~4,221 ms run, its job read `RUNNING` — between the crowd and the file, which is the window the
  export worker used to drive straight through. The door answered `200 {"ok":true}`, and this time
  the answer was kept.
- **The record it lands on.** `FAILED`, `filePath=null`, `fileSize=null`, `expiresAt=null`,
  `recordCount=0`, `error` quoting the cancel as the reason. Its job row: `CANCELLED` 0+0 of
  **12,019**, `progress=0` — the denominator it was told to walk, none of the work.
- **The 139 ms is now just time.** The same two reads that measured the erasure, re-run
  **+1,200 ms** later, say `Job[CANCELLED 0 12019] Export[FAILED null 0]`. Nothing wrote
  `COMPLETED` over the mark afterwards, and `completedAt` stayed null.
- **The wire says nothing about a file nobody asked for.** **0** `export.completed` deliveries for
  the cancelled run.
- **Both download doors refuse it.** `GET /api/exports/{id}/download` -> **404** `export is failed
  — download unlocks when it completes`; `POST /api/exports/{id}?action=download` -> **404** `File
  not found`. The second is a refusal rather than an advertised URL only because `filePath` was
  nulled instead of left dangling.
- **The bytes came back, and the worker says which path.** Its own line from the app's stdout:
  `Export cmvkgfqbg0b00fvqcef0we3ig: stopped run's file removed at /tmp/export_1792728794392.pdf`
  — and that path re-checked on the disk: gone. Then #37's question, asked of the same window:
  **0** files that exist and are named by no export row.
- **The stop is undoable through the door that already existed.** `POST /api/exports/{id}?action=retry`
  -> **200** with a new job id, and the export settles **`COMPLETED`, 12,019 rows in 616,087
  bytes**, `statSync(filePath).size` equal to the `fileSize` the row wrote, a lifetime of exactly
  the **25,000 ms** this instance exports with, the file served at 200 for those bytes, and
  **1** `export.completed`.
- **The other shape: a stop before the worker ever claims the row.** Two exports take the worker's
  two slots and a third is cancelled **1,728 ms** after it was created, its job provably read
  `PENDING`. The claim is refused — no `RUNNING` is stamped over a mark — and the pair lands
  `FAILED` beside `CANCELLED` 0+0 of 0. Its window holds **2** files on disk and **0** named by no
  row (both belong to the two exports that finished, and their rows name them), no delivery, and
  `DELETE /api/exports/{id}` answers `{"ok":true,"file":"no file"}`.
- **Cleanup** takes 12,000 crowd leads, 5 exports and 5 jobs back out through the doors: **0** rows
  and **0** files left from the step.

What this does not claim:

- **A stop that lands while the crowd query is open is only seen at the boundary after it.** That
  is why the row's `totalItems` is the whole 12,019 with nothing processed: the denominator is
  what the worker was told to walk, and the mark was obeyed before any of it was rendered.
- **A stopped export has no partial arithmetic to keep.** The row-wise workers stop between rows
  and can say 4 of 16; an export stopped between the crowd and the file can only say 0 of the
  crowd, which is true and is the whole of what it knew.
- **A file the guard will not name stays on the disk and says so.** `planRowDelete` answers `none`
  for anything not shaped like this application's artifact; the run logs the refusal and #37's
  census counts the file. Nothing here deletes a file it cannot attribute.
- **`lib/scraper.ts` still drives through a stop**, by name: unreachable on an instance with no
  browser, and still the one file typing `progress: 100`. The census in
  `tests/unit/job-stop.test.ts` now reads *four workers obey the mark, one does not, and one door
  asks for the word* — adding the fifth obeys means changing that test rather than drifting past it.
- **Two rows about one file are still two rows.** No transaction, no two-phase anything: the order
  (disk, record, job) and the guarded writes are what make a reader never see a row pointing at
  bytes that have already gone.
- **No history was rewritten.** The rows this round puts down are the ones its own run wrote; the
  475 rows that predate #41 still carry the statuses their workers gave them.

Verification: `npm test` **862/862** (31 of them new, in `tests/unit/export-stop.test.ts` over 7
describes, with no browser, no database and no network), `npx tsc --noEmit` clean, `npm run lint` **0 errors / 11
warnings** — one *fewer* than #42's 12, because `lib/exporter.ts`'s `unlinkSync` import, unused
ever since the export stopped deleting, is now used — and `npm run build` exit 0. The 31 new tests
answer `stoppedExportWrite` key by key (exactly seven keys; every file fact `null`; `FAILED`
checked against the `model Export` block sliced out of `prisma/schema.prisma`, so the word is the
schema's and not this file's memory); keep the stopped sentence three separate facts apart from
`retiredExportError` and `MISSING_EXPORT_FILE_ERROR`, and prove it names no path, no size and no
digit; drive `stoppedExportBytes` over four artifact shapes and eight non-shapes, deep-equal to
`planRowDelete` for every one, with its body pinned to that single delegation and holding no `/tmp`
and no `export_` of its own; prove the module holds no disk, no database and no clock (one import
line, and no `prisma`, `unlink`, `await`, `new Date(` or `process.env` anywhere in it); pin the
worker's boundaries by index arithmetic — the claim before the crowd, the three mark asks in order
around the format switch, the `fs.stat` and the finish, `expiresAt` written exactly once in the
whole worker, the dispatch after all four in-`try` put-downs; assert the put-down's order is disk
then record then job and that its job write is guarded by the mark; and check the export route's
retry guard against the word the put-down writes, so "a stopped export is resumable" is a fact
about two files rather than a hope.

Live STEP 24 joins STEPS 21-23 in `aw-deploy/demo/demo-leadworks.mjs`; the whole LeadWorks demo is
**314 checks, 0 failures**.
### A dynamic list is one that re-runs the filter it declares: `?action=refresh`, and the crowd it names becomes the membership

`LeadList` has carried two columns since its first migration —

```prisma
isDynamic  Boolean  @default(false)
filterJson Json?    // Filter criteria for dynamic lists
```

— and `LEAD_LIST_CREATE` and `LEAD_LIST_PATCH` both sold them. Nothing in `src/` read either one.
The single door that could have acted on them answered, measured on the running app before this
round:

```
POST /api/lead-lists/{id}?action=refresh   {isDynamic:true}
  -> 200 {"ok":true,"message":"Dynamic list refresh not fully implemented"}
```

with the membership unchanged on both sides of it. Three more things were true of that door, and
each is the shape of the fix rather than a detail of it: the branch was keyed on the *body*, so a
dynamic list refreshed without typing the flag got `400 "Unknown action"` and a static one got an
`ok` as soon as a caller typed it; `filterJson: { a: 1 }`, `filterJson: []` and `filterJson: 42`
were all stored as 201, because `kind: "json"` proves the shape of a blob and nothing about whether
a lead could ever be it; and `{isDynamic:true}` with no filter was a list that could never be
refreshed by anything.

The decisions, and who owns each:

| question | answer | where it is decided |
| --- | --- | --- |
| May a list be dynamic with nothing to re-run? | no — `400` at the create door, `400` at the edit door | `readListFilter`, `listRefreshAsk` |
| What may a filter say? | `status`, `seniority`, `score` bounds, `tags` — the vocabulary a rule already had | `src/lib/rule-conditions.ts`, one reader for both doors |
| A filter that declares nothing? | refused. A rule defaults to `NEW`/`ENRICHED` when its conditions are empty; a list inherits nothing, because "every lead" is not a crowd anybody chose | `readListFilter` vs `readStoredConditions`, pinned as a contrast test |
| Whose say-so decides whether a refresh runs? | the row's `isDynamic` — never the body's | `listRefreshAsk(_owned.isDynamic, …)` |
| What is the membership afterwards? | exactly the leads the filter names: the ones it lost go, the ones it gained are added, the rest stay | `planListRefresh`, applied as one transaction |
| A filter the column holds but no lead can be? | `409` quoting the row's own state, and nothing written | `listRefreshAsk` on `readListFilter(filterJson).problem` |
| A lead an operator put in by hand? | stays until the next refresh, which takes it back | `?action=add-leads` does not police a dynamic list |
| Does anything re-run on its own? | no | see "What this does not claim" |

What the running application did after the wiring, printed by `demo/demo-leadworks.mjs` STEP 25
against a crowd of six leads the step owns — three of them moved to `QUALIFIED` through the lead's
own door, two of them `C_LEVEL`, all six carrying a tag nobody else in the workspace holds, so every
number below is checked against `SELECT … FROM "Lead"` rather than against whatever the seed left
behind:

- **The admission is gone.** `refresh` on `{status:["QUALIFIED"], tags:[…tag…]}` answered
  `200 {"ok":true,"filter":"status QUALIFIED, tagged dyn44-imhg8","matched":3,"added":3,"removed":0,"kept":0,"members":3}`,
  and the three ids in `LeadListMember` were the three ids the filter's own words named, row for row.
- **A list that declares a crowd holds none of it until the door is posted.** `GET` before the first
  refresh: `members=0`, with the filter already stored.
- **The stored filter is the normalized one.** A create with `status:["QUALIFIED"]` and a create with
  `seniority:"c_level"` both come back as arrays; the answer quotes what was run, in words
  (`"seniority C_LEVEL, tagged dyn44-imhg8"`), so a caller can see the crowd it asked for.
- **A refresh over an unmoved crowd is a no-op**, and says so: `added=0 removed=0 kept=3`. Twice in a
  row, same answer.
- **The filter is the authority for a dynamic list.** `?action=add-leads` still lets an operator put
  a `NEW` lead in by hand (the table went to 4 rows and the add door did not refuse it); the next
  refresh returned `removed=1 kept=3`, and the ids were the filter's again.
- **The list follows the crowd both ways.** With one lead qualified and one member moved to
  `CONTACTED`, `refresh` answered `added=1 removed=1 kept=2 matched=3` — and the arithmetic of all
  seven refreshes in the step closes: `matched = kept + added`, and the member count the answer
  reports is the crowd size.
- **Two lists over one workspace hold their own memberships.** A second list filtering the same crowd
  by `seniority` matched 2 and left the first list's 3 rows untouched.
- **A row re-runs the filter it now holds, not the one it was made with.** `PATCH`ing
  `filterJson` on the live second list and refreshing answered `matched=3 added=2 removed=1 kept=1`.
- **The flag is a column, so typing it in a body is not a write.** `refresh` on a static list
  answered the same `400` — byte for byte, with and without `{isDynamic:true}` in the body:
  `"this list is not dynamic — its isDynamic is false, so it has no filter to re-run and its members
  are what an operator put in it"`.
- **No row can be made un-refreshable.** `PATCH {isDynamic:true}` onto a filterless row is a `400`
  (`"this list declares no filter to re-run — a dynamic list is one that says which leads belong in
  it"`), as is `POST {isDynamic:true}` with no `filterJson`.
- **A column a door would never write is still read as what it says.** `isDynamic=true` with
  `filterJson={"department":"Ops"}` — forced through `UPDATE` so the row exists to be read — made the
  refresh a `409`: `"this list's filter cannot be re-run as written: \"department\" is not an
  attribute a dynamic list can condition on — the supported keys are status, seniority, score,
  tags"`. Emptying the column on the same dynamic row is the same `409` for the other reason. Neither
  refusal wrote a member.
- **The create door refuses what the column can never run**, and refuses it before the write:
  `{"department":"Ops"}`, `[]` and `42` are each a `400` with a sentence, and `SELECT count(*) FROM
  "LeadList" WHERE name LIKE 'refuse44-%'` stayed `0`.
- **Cleanup through the doors**: 3 lists and 6 crowd leads deleted, `0 → 0` lists, `0 → 0`
  memberships, `0` crowd leads left.

What this does not claim:

- **Nothing re-runs by itself.** A lead's status moving does not touch a list until somebody posts
  `?action=refresh` — there is no trigger, no scheduler entry and no queue message for it. This round
  made the door mean the column; it did not make the column push.
- **`GET /api/lead-lists/{id}` lists at most 100 members** (`take: 100`, unchanged since before this
  round), so a crowd larger than that is not fully listed in the answer even though the table holds
  every row.
- **`score` bounds are exercised by the reader's refusals** (`gte` above the column's range, `gte`
  above `lte`, both pinned offline) and by the same `leadWhere` the two attributes above go through —
  the live step's headline numbers are `status` and `seniority`, because a score a caller cannot
  predict makes a crowd size a claim rather than a check.
- **A static list is untouched by any of this** except the refusal it now gets instead of an `ok`.
  Its membership is still whatever an operator put there.
- **One vocabulary, not two.** A list's filter is the reader a rule already used
  (`conditionsProblem`, `normalizeConditions`, `leadWhere`, `describeConditions`), so the two doors
  cannot drift apart; the cost is that a new attribute has to be added once, in `rule-conditions.ts`,
  for both.

Verification: `npm test` **899/899** — this branch's 34 on top of `main`'s 865, which it does not
touch (the 34 live in `tests/unit/dynamic-list.test.ts` over 6 describes —
no browser, no database, no network), `npx tsc --noEmit` clean, `npm run lint` **0 errors / 13
warnings** (unchanged from `main`), `npm run build` exit 0. The 34 new tests answer `readListFilter`
by hand for the shapes that used to be stored (`[]`, `42`, `"hello"`, `true`, `{department:"Ops"}`,
`{status:[]}`, `{score:{gte:90,lte:40}}`, `{score:{gte:250}}`) and for the one place a list reads
differently from a rule; assert `planListRefresh` over added/removed/kept/idempotent/emptying/
duplicate-row inputs and that its three lists come back sorted; pin the module's purity (no
`prisma`, no `await`, no clock, no disk, exactly one import); and scan the two doors with the
repository's own route scanner — `blankComments` over `functionBody(…, "POST_impl")` — for the order
the answers need: the row's flag asked before a single lead is selected, `deleteMany` before
`createMany` inside one `prisma.$transaction`, `asInputJson(declared.filter)` stored at both doors,
`body.isDynamic` gone from the branch, the admission gone from the repository, and `LeadList`'s field
set unchanged so no new column was invented to make the click countable. Live: `demo-leadworks.mjs`
STEP 25, **39 checks**, whole run **353 ✓ / 0 ✗**, exit 0 (the same run re-verifies STEP 24, whose
residue census was corrected in `aw-deploy` this round to blame only the format a stopped run writes
and to wait out `IN_FLIGHT_GRACE_MS` before calling an unnamed file a leak — on a box running several
LeadWorks instances into one `/tmp`, the sweep as first written accused a sibling export mid-write).

### `?fields=` on the lead read: the other door #46 left standing

`GET /api/leads` is the door a caller who just learned `?fields=` at the list read tries next: the
workspace's leads, filtered by list, status and score band, paged. It never read its own query
string for that name. Measured on the running app before this round, on this PR's own base
(`origin/main` at `4a88f17`, built in a throwaway worktree and served on a port of its own) against a
database filled for the occasion — 300 leads through `POST /api/leads/import`, 100 of them added to
one static list, the workspace reading 319 (`/tmp/opencode/r47-ab-before-main.log`):

```
GET /api/leads?limit=50                         -> 200, 105,536 bytes, 35 keys per row
           &fields=email,score,status           -> 200, 105,536 bytes, 35 keys
           &fields=email                        -> 200, 105,536 bytes, 35 keys
           &fields=id,email,score,status,company -> 200, 105,536 bytes, 35 keys
           &fields=score,company,email          -> 200, 105,536 bytes, 35 keys
           &fields=email&fields=score           -> 200, 105,536 bytes, 35 keys
           &fields=email,email                  -> 200, 105,536 bytes, 35 keys
           &fields=%20email%20                  -> 200, 105,536 bytes, 35 keys
           &fields=nonsense                     -> 200, 105,536 bytes — a 200, not a refusal
           &fields=(300 entries)                -> 200, 105,536 bytes
           &select=email                        -> 200, 105,536 bytes
           &include=email                       -> 200, 105,536 bytes
           &fields[]=email                      -> 200, 105,536 bytes
```

Thirteen spellings of "give me less than the row" and one 105,536-byte answer, and the row it hands
back is wider than the table: 35 keys where `information_schema` says `Lead` has 33 columns, because
this door adds two joins of its own. What that page is made of, measured value by value on the same
database and the same import shape (`/tmp/opencode/r47-compose3.log`, the values summing to 82,078 of
its 105,536 bytes and the rest being key names and the envelope):

```
scoreBreakdown       45,480B  55.4%   the arithmetic that produced `score`, re-sent per row
listMemberships      18,868B  23.0%   a nested `list` record for every membership (48 rows of 50 had one)
_count                1,751B   2.1%   activity and enrichment-log counts
the other 32 columns 15,979B  19.5%   combined
```

Now the same door on this round's build, same database, same import shape, its own crowd
(`/tmp/opencode/r47-ab-after2.log`, run minutes after the table above):

```
(no fields)                                     -> 200, 105,536 bytes, 35 keys — the same page, the same joins
?fields=email,score,status                      -> 200,  3,346 bytes,  3 keys, in the order asked
?fields=email                                   -> 200,  2,019 bytes,  1 key
?fields=id,email,score,status,company           -> 200,  6,649 bytes,  5 keys
?fields=score,company,email                     -> 200,  4,225 bytes — the order is the caller's, not the table's
?fields=email&fields=score                      -> 200,  2,577 bytes,  2 keys — both parameters are read
?fields=email,email                             -> 200,  2,019 bytes — a column asked twice is one column
?fields=%20email%20                             -> 200,  2,019 bytes — padding is not part of the name
?fields=                                        -> 400   110B "fields[0] must be a non-empty string"
?fields=email,,score                            -> 400   110B "fields[1] must be a non-empty string"
?fields=Email                                   -> 400   670B — a column is not its own capitalisation
?fields=nonsense                                -> 400   676B, naming fields[0] and the 25-name vocabulary
?fields=(300 entries)                           -> 400   109B "fields holds 300 entries; at most 100"
?select=email, ?include=email, ?fields[]=email  -> 200, 105,536 bytes — the synonyms stay unanswered
```

Three columns of fifty rows cost 3,346 where the base build cost 105,536 for the identical page:
**31.5× less wire**, and one column **52.3×**. The
projection is decided before the database answers — `include: { listMemberships … , _count … }`
becomes a Prisma `select` over the named columns, so the row is never sent to be thinned afterwards.
Asking for every name the vocabulary holds costs 28,096 of that same page (**3.8×**) and
still hands back 25 keys rather than 35: the exporter's column set is eight columns narrower than
the row and does not contain `scoreBreakdown`, so even the widest legal ask drops the column that
was 55% of the page.

A projected page drops the two joins too. A caller who named `email`, `score` and `status` had no
vocabulary for a nested `list` record or an activity count and received both; `fields` chooses Lead
columns at every door, and a join nobody can name is not a column. The unprojected branch is the
same `include`, the same `orderBy`, the same `skip`/`take` it was — one shared `pageWindow` feeds
both branches, so the two cannot disagree about which page they are projecting — and the page and
the count stay one question: `total=319, page=1, limit=50, totalPages=7` printed identically on the
projected and unprojected answers, and 319 is what `count(*)` says the table holds. Filtering and
projecting are independent claims and were checked together: `?listId=…&fields=email` answers 1,976
bytes with `total` equal to the membership count, `?status=NEW&fields=email,score` 2,589 with
`total=317`, `?minScore=50&fields=email` 145 bytes over the two rows the bound admits, and
`?page=2&limit=5&fields=email,score` 339 — the same four asks on the base build cost 105,843,
105,843, 3,981 and 8,698 for the same rows.

The names come from the place #46 argued they had to: `LEAD_FIELD_PICK.fields.values` **is**
`LEAD_EXPORT_FIELDS` **is** `EXPORT_CREATE.fields.values` — the same array object, pinned by identity
rather than by contents, so the two read doors and the export door cannot drift into three
vocabularies. The live step compares the list the two read doors print in a refusal: 25 names, same
order, all of them columns the table has, 8 of the table's 33 not askable at either.

What this does not claim:

* `?select=`, `?include=` and `?fields[]=` still return the whole page. Same decision as #46,
  repeated because it is the same decision: one parameter, one vocabulary, and a door that learns a
  second synonym for it is a door that can answer them differently.
* The order has no tiebreaker. `orderBy: { score: "desc" }` says nothing about rows that tie, and an
  imported crowd ties everywhere: three reads of one URL inside one run answered the identical
  105,536 bytes, and this round's matched pair happens to agree on that number on both sides, but
  earlier independent runs of the same measurement over the same import shape answered 93,129 and
  93,517 for the same page — which of the tied rows land on a page, and therefore how many nested
  `listMemberships` it carries, moves. The ratios above are this pair's, not a property of every
  page. #45 found this at the list door and gave that door `orderBy: { leadId: "asc" }`; picking a
  secondary key for the lead door changes which rows a caller who asked for nothing sees, so it is a
  separate round's decision and this round only measured it.
* The unprojected page still embeds the whole `list` record inside every membership, `filterJson`
  included. Dropping that changes the shape of a documented response — the changelog's 30-days'-notice
  class of change — and this round only stops handing it to callers who named columns instead.
* `limit` still caps at 100 in `pageParams`, `total` still counts the whole filtered crowd rather
  than the projected subset, and the field naming the columns the answer carries is `leadFields` here
  where the list read calls it `memberFields`. They are not the same field and are not the same
  question: one is a lead's columns, the other a membership row's.
* A bad name is judged *after* the key here and *before* the row at the list door: keyless
  `?fields=nonsense` answers 401 at this door and 400 at that one, because the list door must read its
  row to learn whose list it is while this door's workspace comes from the key. Neither prints a name
  the other does not.

Verification: `npm test` **978/978**, `npx tsc --noEmit` clean, `npm run lint` **0 errors /
13 warnings** — none on a line this round wrote — `npm run check:contract` **8 passed, 0 failed**,
`npm run check:llms-full` unchanged and `npm run build` exit 0. Forty-four of that total are new, in
`tests/unit/leads-fields.test.ts` over 7 describes, with no browser, no database and no network. The
first reads the door's own source with its comments blanked and pins that the projection is a
`select` on one branch with no `include:` beside it while the other branch keeps both include
strings whole, that a `delete`- or reserialization-based fake would not pass, that both branches
share one `pageWindow` and one `Promise.all` with exactly one `prisma.lead.count`, that `leadFields`
is written only on the projected branch and no `memberFields` appears at this door, that
`authedWorkspaceId` is awaited before `fieldsParam` and `findMany` after both, and that `POST_impl`
was not touched. The next pins the vocabulary by *object identity* across the three doors and reads
`openapiSpec` to assert both read doors advertise `fields` and a `400`. The third parses the
`Lead` model out of `prisma/schema.prisma` — 33 scalar columns — and pins that every askable name is
one of them, that the eight that are not are exactly `workspaceId`, `sourceRef`, `scoreOverride`,
`scoreBreakdown`, `scoredAt`, `validationResults`, `lastEnrichedAt` and `lastContactedAt`, that a
relation name (`listMemberships`, `_count`, `activities`) and a prototype key (`__proto__`) are
refused rather than selected, and that `leadSelect` returns a plain object
holding only the columns named. The fourth pins the count to `{ where }` with no `select` and no
`take`, the `skip` arithmetic to one occurrence spread into both reads, the door's own `pageParams(…,
50)` and score clamps to where they were, and the envelope's five keys to the same five either side
of the projection. The fifth walks the neighbouring doors — detail, import, export, list — to prove
this round reached one door and not the others, and that the shared module still exports exactly two
helpers. The last two drive the refusals through the validator the door actually calls: empty entry
by position, padding, a list of nothing but separators, wrong capitalisation, a hundred repeats of
one column accepted and the hundred-and-first refused *before* dedupe, an encoded comma split like a
literal one, three `fields` parameters merged in the order they arrive, and not asking held apart
from asking for nothing.

This branch also re-adds `tests/unit/list-fields.test.ts` — #46's 29 pins for the list door, which
main lost when #72 landed through its rebase-proxy (`merge/72-onto-main` brought the route, the
shared module and the README section but not the test file), leaving the shipped projection with no
offline pins at all. Twenty-eight passed against main unchanged; one asserted that door's literal
`take: 100`, and #70 has since turned that line into `pageParams(searchParams, 100)` with
`take: limit`, so the pin now names the cap where it actually lives and adds the stronger claim —
no literal page size survives beside a parameter that decides it. That is also why #46's own
non-claim about the member cap reads as history rather than as the current door.

The served contract says it too: `leads.list` now carries a `fields` query parameter and a `400`
response, and `GET /api/openapi` on this build answers
`parameters: ["workspaceId","listId","status","page","limit","fields"]`, `responses: ["200","400"]`,
`info.version` still the app's own `1.3.0`.

Live STEP 26 joins STEPS 21-25 in `aw-deploy/demo/demo-leadworks.mjs` and measures this door on a
crowd it builds itself — 240 imported leads in one request, 100 of them on one static list, read at
the door's own page cap. The unprojected page is 202,711 bytes over 100 rows of 35 keys (50 of those
rows sit in a list, which is why the page pays for the join), `?fields=email,score,status` is 6,520
(**31.1×** less), one column is 3,888, all 25 names are 56,242 over exactly 25 keys, `total` is the
table's own 259 on both sides of the projection, three pages of 100 tile those 259 rows with none
appearing twice, a score bound and a projection agree on the table's own 12, the 25 names this door
refuses with are the 25 the list door refuses with, a refusal costs 676 bytes against the 202,711 the
same ask cost unanswered, and the cleanup leaves 0 crowd leads, 0 members and a 404. The step is
**29 checks**; the whole LeadWorks demo reads **373 ✓ / 0 ✗, exit 0**.
### The queue says no in two voices, and the row has to say which one it heard

Seven doors in this app insert a `Job` row and then hand it to the queue. All seven caught
`QueueUnavailableError` and answered 503 with the sentence "the work is saved, retry shortly",
and `enqueueJob`'s own docblock said the class exists so the caller "answers 503 rather than
leaving the row PENDING and reporting it as started". Measured on a running instance with its
Redis turned off, both halves of that promise were false:

| pressed with the queue down | the caller got | what the row said, minutes later |
| --- | --- | --- |
| `POST /api/jobs` | `500`, **0-byte body** | `PENDING`, `error: null`, nothing enqueued |
| `POST /api/exports` | `500`, 0-byte body | a `PENDING` `Job` **and** a `PENDING` `Export` |
| `POST /api/leads/{id}?action=enrich` | `500`, 0-byte body | `PENDING`, and `report.problem`: "a denominator of 1 and nothing accounted for — this job **finished** without saying it visited any row" |
| `POST /api/enrichment-rules/{id}?action=run` | `500`, 0-byte body | `PENDING` |
| `POST /api/jobs/{id}?action=retry` × 7 | `500`, 0-byte body | **seven more `PENDING` rows** |
| `POST /api/sources/{id}?action=run` | `503` with the browser sentence | no row — this door refuses *before* it writes |

Eleven rows, and after 150 seconds of a healthy queue exactly eleven of them were still
`PENDING`. Worse, they were not merely stale: `retryAsk` refuses a `PENDING` row with 409 and the
words "the worker has not reached it, **and it will run**" — a sentence #42 wrote to stop an
operator resuming a crowd twice, and it is a trap for a row the queue refused. The only door that
moved one was a raw `PATCH {status:"FAILED"}`, after which `?action=retry` answered 200 and the
job ran; `POST /api/exports/{id}?action=retry` answered 400 "Can only retry failed exports" for the
export the outage left behind.

Why the 503 never arrived took a diagnostic printed from inside a door's own `catch` to see,
because the queue refuses in two voices and only one of them is a rejection:

```
[r50-diag] Error "Stream isn't writeable and enableOfflineQueue options is false" status undefined instanceof false
```

A Redis that dies under a running process rejects in about a tenth of a second with *that*
sentence. The classifier knew `connection is closed`, `connect ECONNREFUSED`, `stream
disconnected`, `connection is not open`, `connect ETIMEDOUT` and `LOADING` — six shapes, none of
them this one — so the rejection reached each door unclassified, the `instanceof` branch never
ran, and the door re-threw. A process that *starts* while Redis is already gone does not reject at
all: `queue.add` never settles, because BullMQ waits for a `ready` connection that never arrives.
The row written at 09:15:27 was still `PENDING` three minutes later and the door had produced no
response bytes at any code, while the driver's `AggregateError` — empty `message`, the two
`connect ECONNREFUSED` lines on `.errors[]` — filled the log as an emitted error and never as a
rejection anyone could classify.

The decisions, and who owns each:

| question | answer | where it is decided |
| --- | --- | --- |
| Is this rejection the queue being unreachable? | a walk into `errors[]` as well as the message, bounded at depth 4 | `isConnectionFailure`, `src/lib/queue.ts` |
| And a hand-off that never answers? | the same refusal: `add` races a 3 s deadline, and the expiry is a `QueueUnavailableError` | `HANDOFF_DEADLINE_MS`, `enqueue` |
| What does the refused row say? | `FAILED`, `completedAt` now, and `error` starting `never queued:` | `refusalWrite`, `src/lib/queue-refusal.ts` |
| Which rows may it write? | only ones still `PENDING` — a worker that took the row wins | `updateMany` guarded on `status: "PENDING"`, no bare `update` |
| Does the caller learn which row to retry? | the 503 body carries `jobId`, and the row is already truthful when the answer arrives | the seven doors, `await markNeverQueued(…)` before the return |
| What about the export half? | moved by the two export doors, so its own retry door reads `FAILED` | `markExportNeverQueued` |
| A hand-off with no caller in front of it? | the minute's three sweep legs and the bulk enrich run refuse through the same helper and keep going | `enqueueOrMark` |
| Why not enqueue before inserting, the way #39's scrape door does? | the queue payload *names* the `Job` row a worker must read, so the id has to exist first; five doors would have to mint ids they do not own | disclosed in `src/lib/queue-refusal.ts` |

What the same instance answered after the fix, with Redis killed under a running process — six
presses, 0.60 s end to end:

```
POST /api/jobs (ENRICH)              -> 503 (172 B) {"error":"job queue unavailable — Redis is unreachable; …","jobId":"cmvm7o6wq000it8qchr5w8zq6"}
POST /api/exports                    -> 503 (172 B) {…,"jobId":"cmvm7o6y0000kt8qc1npemno3"}
POST /api/leads/{id}?action=enrich   -> 503 (172 B) {…,"jobId":"cmvm7o6z5000lt8qcgxsszr17"}
POST /api/enrichment-rules/{id}?run  -> 503 (172 B) {…,"jobId":"cmvm7o700000mt8qcbm19j414"}
POST /api/jobs/{id}?action=retry     -> 503 (172 B) {…,"jobId":"cmvm7o71h000nt8qcm13v1j8d"}
POST /api/sources/{id}?action=run    -> 503 (179 B) the browser sentence, unchanged, and no row
```

and the rows they left, read out of the table: five `Job`s and the one `Export`, every one `FAILED`
with `error` starting `never queued: the queue refused this row while Redis was unreachable`. With
Redis back, those same five ids were ordinary retries — `?action=retry` answered 200 with a new
`jobId` five times, and the work ran: `ENRICH` rows `COMPLETED` with 1 and 4 leads visited, the
`EXPORT` row `COMPLETED` with 15 records and a file. The export's own door was pressed too and
answered 400 "Can only retry failed exports" only because the job retry had already re-run it to
`COMPLETED`. On a process that starts while Redis is already gone, the same five doors answer 503
in just over 3 s each — the hand-off deadline, plus the door's own work — instead of never
answering, and the rows read `FAILED` the same way. `aw-deploy`'s `demo-leadworks.mjs` STEP 27
presses those five doors on a second instance booted against a port with nothing listening on it,
reads the five rows back out of the table, and retries them through the instance that does have a
queue: 50 checks, every one of them passing, the doors answering in 3.03–3.21 s.

What this does not claim:

- **A worker that never had a queue does not always come back.** On the instance that booted while
  Redis was absent, the retried rows reached `bull:enrich:wait` and `active` stayed `0`: the hand-off
  succeeds, the refusal is written correctly, and nothing runs until that process restarts. This
  round bounds the *door*, not the worker's own reconnect.
- **`GET /api/health` can keep saying `queues: {error: "redis unreachable"}`** after the queue is
  reachable again — measured for 20 s on that same instance, while its `POST /api/jobs` hand-offs
  were resolving. A different door, a different owner.
- **A queue that loses its data after accepting leaves a `PENDING` row.** Five rows handed off
  successfully at 09:28:31 were still `PENDING` when the queue was restarted without persistence;
  the durable record is the `Job` table, and `removeOnComplete` has said so for a while. The refusal
  this round writes is about the hand-off that *failed*, not the queue that forgot.
- **A late success is possible.** If Redis returns inside the 3 s window but after the deadline
  fires, the row reads `FAILED` and the job still runs; the worker's own write then replaces the
  status. The window is disclosed rather than closed, because closing it means taking the job back
  out of a queue that may not answer.
- **The sweep's `countersProblem` wording** still calls a `PENDING` row's empty report "this job
  finished". Left alone: the row this round writes is never `PENDING`, and that sentence belongs to
  the report, not the queue.

Verification: `npm test` **937/937** — this branch's 32 in `tests/unit/queue-refusal.test.ts` on top
of `main`'s 905, plus the two census pins this fix moved (`export-retention` retargeted 9 writes →
10 with the refusal site named as the owner of neither lifetime nor bytes; `job-retry`'s "retry"
mentioners retargeted to the files that still spell the word in code). `npx tsc --noEmit` clean,
`npm run check:contract` **8/8**, `npm run build` exit 0. The 32 answer `isConnectionFailure` against
both measured shapes — the mid-run sentence built from the diagnostic, and the grouped one from the
log — against four non-faults that must keep propagating, and against a fake queue that throws and a
fake queue that *never answers*; they pin the 3 s deadline and the `clearTimeout` on the way out, the
refusal write's shape and its `status: "PENDING"` guard, the order inside all seven doors (mark, then
answer, with the id in the body), the two export doors, the minute's three legs and the bulk run's
one hand-off, and a census that every hand-off in `src/` is named as data — seven doors, four wrapped
sites, no eighth. Live: the outage measured above on this branch's own runtime, and
`demo-leadworks.mjs` STEP 27.
### What the health door says about seven queues, when only one of them has stopped answering

`GET /api/health` asks all seven queues for `waiting`/`active`/`failed` and has always done it in
one `try` — so the door had exactly two things it could say: the map, or `{"error":"redis
unreachable"}`. Measured on `origin/main` at `65bd942`, on instances of this session's own (ports
3319-3321, redises 6388/6397, database `leadworks_r51`), those two words cover four different
situations and get three of them wrong:

```
:3319  booted with its queue up, then lost it      200, 16-38 ms, queues:{"error":"redis unreachable"}
                                                    — right answer, and it recovers: numbers on the
                                                      second press after the port came back (~2 s)
:3320  booted against a port nothing was on; that  200, 14-47 ms, queues:{"error":"redis unreachable"}
       port came up 32 s later                      …for the next 150 presses over 12.5 minutes, while
                                                    POST /api/jobs beside it handed off in 20-64 ms
                                                    and left 36 rows in the queue it called down
:3321  the first cut of the fix: per-queue asks    http=000 — `curl -m 12` timed out. The door that
       with no deadline, pressed blind            replaced a 29 ms answer answered nothing at all
:3319  the second cut: nothing asked while the     200, 0/7 numeric on six presses over 18 s, while
       shared client is not `ready`                its Redis was up and answering
```

`:3320` is the one that made this a round. A `Queue`'s client in bullmq 6.3.15 is a one-shot
promise — `RedisConnection` sets `this.initializing = this.init()` in its constructor and its
`client` getter hands back that same promise forever — so the queue that is first touched while the
shared lazy client is still failing rejects `Connection is closed.` for the life of the process,
after the socket is long back up. Probed off the app (`/tmp/opencode/r51_heal.out`): the poisoned
instance threw on its next twelve asks *and on `add()`* with the shared client `ready`, while a
`Queue` built after the recovery counted on the same connection in 7 ms. Two consequences, both
fixed here: the door's word for that queue was a lie about Redis, and because the old probe
returned from its `catch` at the first throw, that one client erased the six sets of numbers its
neighbours had just handed back.

The judgement is now `src/lib/queue-snapshot.ts` and it says one thing per queue, always arriving:

```
healthy  {"ok":true,"db":"up","queues":{"scrape":{"waiting":0,"active":0,"failed":0},"enrich":{…},
          …seven…},"queueConnection":"ready","scrape":{…},"time":"…"}                 16-29 ms
blind    {"ok":true,"db":"up","queues":{"scrape":{"error":"unreachable"},"enrich":{…},
          …seven…},"queueConnection":"connecting"}                                    24-33 ms
```

Four rules, each one a row of the table above. **A queue that answers keeps its numbers** whatever
the others did, so a broken client is a cell and not a verdict. **The press is bounded** — 1 s per
ask, ~300× a healthy 2-4 ms one, cleared on every path — because an unbounded health door is the
defect this app has already paid for twice, at the boot (`SWEEP_REGISTER_TIMEOUT_MS`) and at the
hand-off. **The socket is opened before the door calls it dead**, through the raw ioredis client
(`queueWake`) and never through a `Queue`, which is the only difference between waking a lazy
client and poisoning one; and while the client is demonstrably down nothing is asked of it at all,
which is what an outage costs: `connecting`/`reconnecting` beside seven honest cells, 15-45 ms.
**A queue that refuses while the socket is up gets its client dropped and re-asked inside the same
press**, once, so the door reports the recovery rather than waiting for the next boot.

Re-measured on the shipped build, both instances booted blind and both given their queue back:

```
15:06:41 FIX  blind-booted          http=200   24ms conn=reconnecting  7 cells, 0 numeric
15:06:41 FIX   after recovery        http=200   19ms conn=ready        7 cells, 7 numeric
…            a second cycle on the same process, 6 blind presses + 14 after the port came up:
              15-21 ms each, the first numeric answer 1 s after the port, and the count of
              "Connection is closed." lines in its log stayed at exactly the 8 its boot wrote.
```

That last count is the no-storm half of the design: an outage press asks nothing and replaces
nothing, so a 30-second outage does not leave seven latched clients rebuilt on every press. The
hand-off is untouched by all of this — `POST /api/jobs` on the fixed build answered 201 in 199 ms
and its row read `COMPLETED` 152 ms later (test row deleted, `Job` PENDING count 0), and a clean
healthy boot still registers the sweep: `bull:scheduled:repeat:leadworks-scheduled-sweep:…` in that
instance's own Redis.

What this does not claim:

* **The `queues` failure body changed shape.** It was `{"error":"redis unreachable"}`, now it is a
  cell per queue plus `queueConnection`. `src/lib/openapi.ts` gives `health.get` a `200: "ok."` and
  no body schema, `scripts/smoke.sh` reads `db` only, and `public/llms-full.txt` never spelled the
  queue body — which is why `check:llms-full` still reports the file unchanged. #49's section quotes
  the old words as what it measured on the base it booted on, and stays its measurement.
* **The door does not hasten the socket.** It reports `reconnecting` until ioredis says otherwise —
  1 s after the port in one run, 8 s in another. Nothing here changes `retryStrategy`.
* **The boot's sweep registration is not re-run by the door.** `:3321` booted blind, printed #49's
  timeout line and built clients that refused; after its queue came back the door reported seven
  sets of numbers while its own Redis still held no scheduler key. The queue is answering; the
  schedule waits for a boot that reaches Redis.
* **One replacement per queue per press.** A queue that stays broken after its client is rebuilt
  says `unreachable after rebuilding this process's client for it` and stops, rather than becoming a
  retry loop. A refusal that is *not* about the socket is passed through in the driver's own words,
  cut at 120 characters; an outage cell never carries `host:port`, because this door needs no key.
* **`Stream isn't writeable and enableOfflineQueue options is false` is still not classed as a
  connection failure on this branch**, so a hand-off during an outage still answers 500 with an
  empty body. PR #77 owns that line (`fix(#50)`, commit `c0209ab`); re-classing it here would
  re-fix another round's defect and buy a conflict. Pinned as a non-claim in the test file rather
  than left implicit.
* `503` is still decided by the database alone, and `queues` still counts only
  `waiting`/`active`/`failed`.

Verification: `npm test` **1001/1001**, `npx tsc --noEmit` clean, `npm run lint` **0 errors / 13
warnings** (none on a line this round wrote), `npm run check:contract` **8 passed, 0 failed**,
`npm run check:llms-full` unchanged, `npm run build` exit 0. Twenty-three of that total are new, in
`tests/unit/queue-snapshot.test.ts` over 4 describes, with no Redis: the four shapes driven as
arguments (a refusal that keeps its neighbours' numbers, a never-settling ask that must still come
back inside six deadlines and at least two, a wake that opens a lazy socket, a wake that never
settles), the census that every queue the module can build gets its own cell without the door
naming one, and the wiring read off source — that the door imports the judgement and not the
queues, that no `queues.<name>` read survives at import, that `forgetQueue` closes the instance it
drops and never quits the shared connection, and that the wake touches the client and never a
`Queue`. `tests/unit/scrape-capability.test.ts`'s four body pins were retargeted, with the reason
written beside them: two of the strings moved (`queues: await queueDepth()` → `queues:
report.cells`, plus the new `queueConnection`); `ok: true`, `db: "up"` and `time: new Date()` are
the same claim about the same lines.

### A row the queue never took did not finish, and the job report stops saying it did

`GET /api/jobs/{id}` reads a `Job` row and hands back a `report` beside it: the share of the crowd the
job walked, the verdict the status column cannot hold, and — since #40 — a `problem` naming the case
where the row's own numbers cannot all be true at once. That reading had one rule about tense and it
applied it to every row: a denominator with nothing accounted for under it was
*"this job finished without saying it visited any row"*. True of a `COMPLETED` row written that way.
Not true of the row a refused hand-off leaves behind, which has not finished anything because nothing
ever started it.

Measured on this session's own runtime, both legs built from `origin/main` at `65bd942`
(`/tmp/opencode/r52_measure.log`, `/tmp/opencode/r52_ab.log`). `:3323` booted with `REDIS_URL` on a
port nothing is listening on, `:3326` and `:3327` beside it — one on a real Redis (6391), one carrying
`main`'s `job-report.ts` byte for byte so the two readings could be pressed against the **same rows**.
The door that leaves the row is `POST /api/leads/{id}?action=enrich`: it writes the `Job` first, with
the denominator in the insert (`totalItems: 1`, `src/app/api/leads/[id]/route.ts:85`), and hands off
after. The scheduled sweep does the same with up to 100 (`scheduler.ts:223`), and so does a rule run
(`enrichment.ts:340`). With no queue to take it:

```
POST /api/leads/{id}?action=enrich   -> 30.0 s, no answer at all (curl exit 000)
the row it left                     -> status PENDING, totalItems 1, processedItems 0,
                                       progress 0, startedAt null, error null
GET /api/jobs/{that row}            -> "verdict": "PENDING", "verdictNote": null,
                                       "problem": "a denominator of 1 and nothing accounted for —
                                                   this job finished without saying it visited any row"
```

Two sentences in that answer are false. The door never answered — that half is #50's, whose 3-second
hand-off deadline is still an open branch, and this round does not touch the queue. And the report
calls a row with `startedAt: null` a job that *finished*. The second half is this file's own, and
`GET /api/jobs/{id}` is the door an operator reaches for when a job does not move.

The same counters under the status a worker writes when it takes a row printed the same finished-tense
sentence: `RUNNING` beside 1 promised and 0 visited is a job that has not reached its first row, not a
job that got through it silently. And the open row with **no** denominator said *"this job stamped no
denominator"* — #40's past tense about a row that has no past.

So the reading now asks the row what phase it is in before it accuses it of anything. `phaseOf(status)`
in `src/lib/job-report.ts` partitions the five words the `Job.status` column holds — `PENDING` and
`RUNNING` are `open` (a worker may still count rows into this row), `CANCELLED` is `stopped` (#40's
forgiven shape, under a name that says why it is forgiven), and `COMPLETED`, `FAILED` and any word the
schema does not know are `closed`. `jobReport` derives the phase once, from the column, and gives it to
the two readings that can be wrong about it: `countersProblem` keeps its `done > total` contradiction
for every phase — rows accounted for come from a worker that reached them, and no phase explains 14 of
10 — and fires the silent-finish sentence only on a `closed` row. `progressOf` keeps `measured: false`
and `percent: 0` for an open row with no denominator, and changes only which of the two
`"not measured: …"` sentences explains it (`NOT_STARTED` beside `NO_DENOMINATOR`).

Telling the truth takes `problem` away, and `problem` was the only key a caller could watch, so the
sentence moves rather than disappearing: it arrives in `verdictNote`, the key that was `null` beside it.

```
                     row: status PENDING, totalItems 1, processedItems 0, startedAt null
  main  : problem "a denominator of 1 and nothing accounted for — this job finished without saying it visited any row"
          verdictNote null                                                          618 bytes
  here  : problem null
          verdictNote "not started: a denominator of 1 with nothing counted against it, and no worker has
                       written a start on this row — the wait is the fact, not a result"      667 bytes
```

Matched on the same database and the same rows, both readings pressed side by side:

| The row | `main` | this build | the two answers |
| --- | --- | --- | --- |
| `PENDING`, 1 promised, 0 visited | `problem` calls it finished | `verdictNote`: *not started … the wait is the fact, not a result* | 618 → 667 bytes |
| `RUNNING`, 1 promised, 0 visited | the same finished-tense sentence | `verdictNote`: *in flight … what a worker that has not reached its first row looks like* | differs |
| `PENDING`, no denominator | *this job stamped no denominator* | *no worker has written on this row, so it has stamped no denominator … yet* | differs |
| `COMPLETED`, 12 promised, 0 visited | *this job finished without saying it visited any row* | unchanged, **byte for byte** | 626 = 626 |
| `COMPLETED`, 16 visited against 0 | *16 row(s) accounted for against a denominator of 0* | unchanged, **byte for byte** | 626 = 626 |
| `CANCELLED`, 1 promised, 0 visited | #40's *the mark was read before the worker reached a row* | unchanged, **byte for byte** | identical |
| `COMPLETED`, 1 of 1 (the leg with a queue) | `problem` null, `verdictNote` null | unchanged | identical |

The reference leg is the one that shows the accusation is not needed for the honest case: the same door
on `:3326`, whose Redis was up, answered 200 in **133 ms** with a `jobId`, and three seconds later its
row read `COMPLETED`, `processedItems: 1`, `problem: null` and one `JobResult`. That row's report is
identical on both builds.

What this does not claim:

* **`GET /api/jobs` still prints no report at all.** Measured on both legs: 17 keys per row, no
  `report` on any of them. The list door hands out raw counters, so `progress: 0` on a row that is
  waiting reads the same as `progress: 0` on a row that stopped reporting. Giving that door a per-row
  reading is a separate round's decision — it is a `count` per row on a paged door, and #45 and #46
  are the precedent for what that costs.
* **`verdict` is still the stored status.** `PENDING`, `RUNNING`, `COMPLETED` — none is rewritten, and
  no column is written by this module. #40's rule stands: the arithmetic decides, a worker does the
  writing, and `prisma.` appears nowhere in `job-report.ts`.
* **`percent: 0` on an open row with a denominator is kept, not softened.** 0 of 1 is arithmetically
  true of a job that has not started, `measured` stays `true`, and `reason` stays `null`. The lie was
  in the sentence, not in the number.
* **#50's row is not this row.** Once that branch lands, a refused hand-off leaves `FAILED` with
  `error` starting `never queued:` — a *terminal* row, so `phaseOf` calls it `closed` and #40's
  finished-tense sentence fires on it again. The row that branch writes is a fact about the queue and
  this file reads it as one; teaching the reading that a `never queued:` row never started means
  deciding what a row's `error` text is evidence of, which is that branch's question and not this
  round's measurement. Said in both PR bodies rather than quietly coded against an unmerged branch.
* **A `PENDING` row with work already counted under it is not called a contradiction.** It cannot be
  made through any door — `JOB_PATCH` and `JOB_CREATE` forbid a caller from writing `progress`,
  `totalItems`, `processedItems` or `failedItems` — and this round adds no accusation for a shape it
  did not measure.

Verification: `npm test` **1001/1001** — 23 new in `tests/unit/job-report-phase.test.ts` over 6
describes on top of `main`'s 978, with none of `main`'s tests touched except two, no browser, no
database, no network. `npx tsc --noEmit` clean, `npm run lint` **0 errors / 13 warnings** (unchanged
from `main`), `npm run check:contract` **8/8**, `npm run check:llms-full` unchanged — the report is a
response body, not a declared schema, so the contract and the deep-content file print none of these
sentences — and `npm run build` exit 0. The new file pins: `phaseOf` walked over the five words parsed
out of `prisma/schema.prisma` so the partition cannot silently drop a status, and an unknown word
falling to `closed` rather than being excused; the accusation firing on `open` and, in the same call,
*not* firing on `closed` — where the `closed` sentence is asserted digit for digit against #40's exact
string, so this round cannot soften the case it was written for; the over-count surviving all three
phases; `progressOf`'s two unmeasured sentences sharing the `"not measured: "` prefix a caller may
branch on while being different sentences; the report's seven keys being the same seven keys in the
same order; and the write path untouched — no worker file speaks `open`/`stopped`/`closed` or calls
`phaseOf`, `counters, phase` is passed in exactly twice and both times inside `jobReport`, and no door
re-decides the phase beside the module. The two retargeted pins are `tests/unit/job-stop.test.ts`'s
two `countersProblem(…, true)` calls, which now pass `"stopped"`: the second argument is a phase, not
a flag, and #40's forgiveness is the same forgiveness under its own name.

Live STEP 28 is not written this round, for the reason #51 recorded: the newest demo step on
`aw-deploy`'s `main` would have to sit on top of a still-open branch to be a direct child of anything,
and a step whose base moves twice is a step that gets lost. The measurement above is this session's own
runtime, on ports and databases this session owns, and the two legs read the same rows.

### A filter word is not a crowd: the read doors say which words the column holds

Four query-string filters and one stored filter took a word for an enum column straight off the
request and handed it to Prisma. The column is a `String` with a vocabulary in a comment, so nothing
between the caller and the database knew whether the word was one the column can hold. A mistyped
filter and a crowd that really is empty were the same answer — `200`, `total=0`, no refusal. Measured
on the running app before this round, in this round's own runtime (`:3361` over database
`leadworks_r56`, `/tmp/opencode/r56_measure.log`, `r56_measure_c.log`, `r56_measure_d.log`) against
six leads seeded one per `Lead.status` word, the five job types queued through `POST /api/jobs` and
one completed CSV export — so the export rows below were answering a table that genuinely held no
`PENDING` or `PROCESSING` row, which is exactly why an empty page was indistinguishable from a wrong
word:

```
GET /api/leads?status=NEW                    200 total=1
GET /api/leads?status=new                    200 total=0      — the same lead, asked in lower case
GET /api/leads?status=New                    200 total=0
GET /api/leads?status=NEW%20                 200 total=0      — the padding became the word
GET /api/leads?status=%20NEW                 200 total=0
GET /api/leads?status=NEW,ENRICHED           200 total=0      — a comma is not an OR
GET /api/leads?status=NEW&status=ENRICHED    200 total=1      — one of the two, silently
GET /api/leads?status=ACTIVE                 200 total=0      — a word no column holds
GET /api/leads?status=DONE                   200 total=0      — the value PATCH refuses by name
GET /api/leads?status=PROCESSING             200 total=0      — an Export word, asked of a Lead
GET /api/leads?status=null                   200 total=0
GET /api/leads?status=                       200 total=6      — nothing named, everything returned

GET /api/jobs?type=SCRAPE                    200 total=1
GET /api/jobs?type=scrape                    200 total=0      — POST /api/jobs calls this a 400
GET /api/jobs?type=BOGUS                     200 total=0
GET /api/jobs?status=pending                 200 total=0
GET /api/jobs?status=PROCESSING              200 total=0      — an Export word, asked of a Job
GET /api/jobs?status=PENDING&status=FAILED   200 total=2      — the PENDING rows, the FAILED lost
GET /api/jobs?status=PENDING,FAILED          200 total=0

GET /api/exports?status=COMPLETED            200 total=1      (9 rows later: total=9)
GET /api/exports?status=completed            200 total=0
GET /api/exports?status=RUNNING              200 total=0      — a Job word, asked of an Export
GET /api/exports?status=PROCESSING           200 total=0      — a real Export word, declared nowhere
GET /api/exports?status=CANCELLED            200 total=0      — also a Job word
```

The same three doors already refuse a wrong `?fields=` name, a wrong `sourceId` and a wrong body word
by printing the whole vocabulary — `?fields=nonsense` was a 400 naming 25 column names on the door
whose `status` filter answered `200 total=0` — and the write doors had the sentence this round needed:

```
PATCH /api/leads/{id} {status:"DONE"}   400 status must be one of NEW | ENRICHED | QUALIFIED | CONTACTED | CONVERTED | REJECTED, got "DONE"
PATCH /api/jobs/{id}  {status:"DONE"}   400 status must be one of PENDING | RUNNING | COMPLETED | FAILED | CANCELLED, got "DONE"
POST  /api/jobs       {type:"scrape"}   400 type must be one of SCRAPE | ENRICH | EXPORT | DEDUPE | VALIDATE, got "scrape"
```

The fifth surface was worse than an empty page. `Export.filterJson` is the crowd the file renders, and
the worker compares it with the same exactness — so the word went in unjudged at the door and came
back as a *delivered file*:

```
POST /api/exports {"filterJson":{"status":"QUALIFIED"}}   201 → COMPLETED records=1  bytes=70
POST /api/exports {"filterJson":{"status":"qualified"}}   201 → COMPLETED records=0  bytes=0
POST /api/exports {"filterJson":{"status":"ACTIVE"}}      201 → COMPLETED records=0  bytes=0
POST /api/exports {"filterJson":{"status":"RUNNING"}}     201 → COMPLETED records=0  bytes=0
```

An export that succeeded, at `records=0`, with a 0-byte file at the end of it and a `200` at every
door that reads the row. The identical body at `POST /api/lead-lists` was a 400 naming the set.

Three behaviours meet at these columns and this round left two of them alone. A word outside the set
is **refused** by every write route that validates (`LEAD_PATCH.status`, `JOB_PATCH.status`,
`JOB_CREATE.type`, `RULE_TRIGGERS`); a word of the wrong case is **folded** by the rule and list
doors — `POST /api/enrichment-rules {conditions:{status:"new"}}` was a `201` that stored `NEW`, and
`POST /api/lead-lists {filterJson:{status:"qualified"}}` a `201` — and a word of any shape was
**ignored** by the five places above, which is the hole this round closes. `src/lib/list-filter.ts` is
the new helper: `filterParam(searchParams, name, words)` reads every value of the parameter with
`getAll`, trims, drops the empties, dedupes, and either hands the door one checked word or answers the
sentence the write routes already speak. Three decisions, each taken to match a rule the app already
runs: padding is not part of the word (so `?fields=%20email%20` projects `email`, and `?status=%20NEW`
is `NEW`); an empty value names nothing and returns the page, because a form whose select has no
choice sends exactly that, and "no opinion" is a request — contrast `?fields=`, which is refused, an
empty list of columns being a projection of nothing; and a word repeated twice is a question with two
answers, so the second one cannot also be honoured and dropping it silently is the quiet rewrite
`fieldsParam`'s own comment refuses. Same word twice is one word.

The same door on this round's build, same database, same rows:

```
status=NEW                       200 total=1     — every word of the set still answers its own crowd
status=new   New   DONE  ACTIVE  400             — each one: `status must be one of NEW | … , got "x"`
status=null  PROCESSING          400             — the Export and Job words, asked of a Lead
status=NEW%20  %20NEW  %09NEW    200 total=1     — padding trimmed, then matched
status=%22NEW%22                 400 got ""NEW"" — the quotes are not part of the word
status=NEW%00                    400             — refused; the NUL is in the word it echoes
status=NEW,ENRICHED              400 got "NEW,ENRICHED"   (also as %2C: the same one word)
status=NEW&status=ENRICHED       400 status was given 2 words ("NEW", "ENRICHED"); this filter compares status to one of them
status=NEW&status=NEW            200 total=1
status=NEW&status=               200 total=1
status=              (absent)    200 total=6     — still the whole page, still no opinion
GET /api/jobs?type=scrape        400 type must be one of SCRAPE | …   (type=SCRAPE: 200 total=1)
GET /api/jobs?status=DONE        400 status must be one of PENDING | … (status=COMPLETED: 200 total=14)
GET /api/exports?status=RUNNING  400 status must be one of PENDING | PROCESSING | COMPLETED | FAILED, got "RUNNING"
GET /api/exports?status=PROCESSING 200 total=0   — a legal word this time, and an honest empty table
```

`RUNNING` is refused at the export door with the four words *that* column holds, which is the other
half of the round: nothing in `src/lib/enums.ts` declared `Export.status` at all, because the file's
own rule is "only the sets a write route takes" and no route writes that column — `POST /api/exports`
stores `PENDING`, `exporter.ts` moves the row to `PROCESSING` and then to `COMPLETED` or `FAILED`, and
`POST /api/exports/{id}?action=retry` writes `PENDING` again. A reader needs the vocabulary the
writers use, so `EXPORT_STATUSES` is transcribed from the schema comment and pinned to it, the way
`RESULT_STATUSES` is pinned in `job-report.ts`. That declaration was then caught being right by the
app itself: no base press ever caught the row in `PROCESSING` — every poll struck three seconds after
the ask and found it already `COMPLETED` — while this round's poll, at 200 ms, read `poll 1:
PROCESSING` then `poll 2: COMPLETED`. The word is not a guess; it is a state a live export passes
through, and it is now a word the door can answer.

The stored filter is judged by the same code as the query string, one call earlier than the row:
`exportFilterProblem` runs before `prisma.export.create`, and says the worker's piece of it — a word
the Lead column never holds is not a narrower crowd, it is no crowd.

```
{"status":"ACTIVE"}         400 filterJson.status must be one of NEW | … , got "ACTIVE"
{"status":"qualified"}      400 … got "qualified"
{"status":"NEW,ENRICHED"}   400 … got "NEW,ENRICHED"
{"status":""}               400 … got ""
{"status":7}                400 filterJson.status must be a string
{"nonsense":1}              400 filterJson key "nonsense" is not supported — use status, minScore, maxScore, listId, tags
"NEW"                       400 filterJson must be an object or an array, got a string
{"status":"QUALIFIED"}      201 → COMPLETED records=1, and the table holds one row with that status
```

Seven refusals, twice over: the row count went 14 → 14 on the first run and 16 → 16 on the second,
so a refused body writes nothing and queues nothing — and the accepted asks between them took the
table to 17, each rendering the single row its word names (`records=1`, `bytes=70`, where the bad
filterJson rows the base build left behind still read `records=0 bytes=0`).

What this does not claim:

* `GET /api/sources?isActive=` and `GET /api/enrichment-rules?isActive=` are untouched, and still
  wrong. Measured against one active and one inactive rule: `isActive=true` named the active row,
  `isActive=TRUE`, `isActive=1`, `isActive=yes`, `isActive=no`, `isActive=` and `isActive=%20true` each
  named the *inactive* one — `isActive === "true"` is a coercion, not a vocabulary, and its wrong
  answer is a page of the other state rather than an empty one. `isActive=no` after this round still
  answers `total=1` with the inactive rule. It is a second defect with its own blast radius — a `1` is
  a plausible way to ask for true, and every answer but one is a page a caller will believe — so it is
  left for its own round rather than folded into this one's sentence.
* Case still behaves differently at two doors that share one vocabulary. The rule and list doors
  **fold** a lower-case word — `{conditions:{status:"new"}}` stores `NEW`, `{filterJson:{status:
  "qualified"}}` stores `QUALIFIED` — and this round made `POST /api/exports` **refuse** it. The fold
  is the older decision, made where the value is rewritten into a column the reader then matches
  exactly; refusing at the export door is the smaller change, because `filterJson` is echoed back to
  callers as the row's own filter and silently rewriting what a caller sent is the class of thing
  #46 and #47 both declined to do. Either way the word that used to arrive as a delivered empty file
  now arrives as an error that names the set; making the fold and the refusal one policy across every
  door is a vocabulary-wide decision this round did not make.
* There is still no OR over a status. Two words are refused, not unioned, and the refusal counts them
  and quotes them so a caller who meant both can see what it sent. `?fields=a&fields=b` unions
  because a projection holds what it was given; a filter compares one column to one value and cannot.
* `?page=abc` still falls back to page 1 rather than refusing, and `?select=`, `?include=` and
  `?fields[]=` are still unanswered synonyms. Neither is this round's defect and neither moved.
* The other three doors' bodies are unchanged: `?fields=nonsense` is still the same 400 naming 25
  columns, `?fields=email&status=NEW` still projects one column over the one lead that word names, and
  `?status=NEW&page=2&limit=1` still answers `{total:1,page:2,limit:1,totalPages:1}` with an empty
  page — a filter that matches one row and a second page of one row is legitimately nothing.

Verification: `npm test` **999/999**, `npx tsc --noEmit` clean, `npm run lint` **0 errors /
13 warnings** — none on a line this round wrote — `npm run check:contract` **8 passed, 0 failed**,
`npm run check:llms-full` unchanged and `npm run build` exit 0. Twenty-one of that total are new, in
`tests/unit/list-filter.test.ts`, needing no browser, no database and no network: the base table's
refusals pinned to the exact sentence including the quote `short()` puts around the word; the
two-word refusal quoted whole; padding, empty and repeated values; the four sets pinned against the
schema comments they were transcribed from (`EXPORT_STATUSES` against `Export.status`'s comment and
against every word `exporter.ts` writes, `PROCESSING` included); the three doors' own sources read
with their comments blanked, asserting `filterParam(...)` in the handler and `searchParams.get("status")`
gone; the `POST_impl` order, that `exportFilterProblem` is called before `prisma.export.create`; and a
census over every file under `src/app/api` that fails the fifth door which reads a `status` or `type`
word raw, because a door added next month is exactly what three per-file assertions would miss. The
last pins the contract's own lines — that each of the four parameters names its set and that each door
advertises a `400` — and it reads the sets out of `enums.ts` rather than re-typing them, so a
vocabulary can be added to the source and cannot be left out of the spec. One existing test moved with
a stated reason, not relaxed: the census in `tests/unit/route-validation.test.ts` that "every enum set
is used by a write route" failed on `EXPORT_STATUSES`, and the point of that rule is that a declared
set is *consulted*, so it now counts a set consulted by `filterParam`/`filterWordProblem` at a read
door as used, and still fails a set nothing consults anywhere.

The served contract says it too. `GET /openapi.json` on this build answers `leads.list`
`responses=200,400` with `?status` reading *"One lead status, spelled as the column spells it: NEW |
ENRICHED | QUALIFIED | CONTACTED | CONVERTED | REJECTED. Spaces around it trim; a lower-case word, two
words or a comma-joined pair is refused rather than answered with an empty page."*, `jobs.list`
`responses=200,400` naming five types and five statuses, `exports.list` `responses=200,400` naming the
four export states and adding *"`RUNNING` is a job word, not an export one."*, and `exports.create`
`responses=201,400` with its `filterJson` described as *"Which leads — status, minScore, maxScore,
listId, tags. A `status` here is one Lead word (…); a word the column never holds is refused at the
door instead of delivered as a COMPLETED file with no rows in it."* Every one of those strings is
built from the arrays the routes check against, so the document cannot advertise a vocabulary the door
does not use.

### A boolean is two words, not one: `?isActive=` and the page of the other state

`Source.isActive` and `EnrichmentRule.isActive` are the only two `Boolean` columns a list
door filters on, and both doors filtered them with the same line:

```ts
if (isActive !== null) where.isActive = isActive === "true";
```

That is not a vocabulary. It is a coercion with one accepted spelling, and the word it
rejects is not a mistype — it is the word the product's own contract tells callers to send.
Fetched off the running instance before anything changed (`GET /api/openapi`, both doors):

```
isActive :: Only the ones running (1) or paused (0).
```

Measured on `origin/main` at `65bd942`, built in this round's worktree, served on **:3371**
over the session's own database `leadworks_r57` with a private Redis on 6396, over five
sources sealed through `POST /api/sources` (three `isActive: true`, two `false`) and three
rules sealed through `POST /api/enrichment-rules` (two active, one paused). Every number is
`curl`'s own `%{http_code}`, `%{size_download}` and `%{time_total}`, and the names the page
returned (`/tmp/opencode/r57_measure.log`, `r57_measure_c.log`):

```
GET /api/sources                        200 total=5  — everything
GET /api/sources?isActive=true          200 total=3  [src-active-1..3]
GET /api/sources?isActive=false         200 total=2  [src-paused-1..2]
GET /api/sources?isActive=1             200 total=2  [src-paused-1..2]   ← "running", per the contract
GET /api/sources?isActive=0             200 total=2  [src-paused-1..2]   ← and "paused" is the same page
GET /api/sources?isActive=TRUE          200 total=2  [src-paused-1..2]
GET /api/sources?isActive=True          200 total=2  [src-paused-1..2]
GET /api/sources?isActive=yes           200 total=2  [src-paused-1..2]
GET /api/sources?isActive=no            200 total=2  [src-paused-1..2]
GET /api/sources?isActive=%20true       200 total=2  [src-paused-1..2]
GET /api/sources?isActive=true%20       200 total=2  [src-paused-1..2]
GET /api/sources?isActive=              200 total=2  [src-paused-1..2]   ← "I have no opinion"
GET /api/sources?isActive=true&isActive=false
                                        200 total=3  [src-active-1..3]   ← one of the two, silently
GET /api/enrichment-rules?isActive=1    200 total=1  [rule-paused-1]
GET /api/enrichment-rules?isActive=yes  200 total=1  [rule-paused-1]
GET /api/enrichment-rules?isActive=     200 total=1  [rule-paused-1]
```

Sixteen presses across the two tables. Eleven of them answered a page whose every row has
`isActive = false` for a word that did not ask for the paused crowd; two answered one of the
two words the caller sent, silently. The two digits the contract names are indistinguishable
from each other, from a capitalisation, from a word in another language, from a space, from
nothing at all, and from the first half of a two-word question.

Which is worth more than an untidy query string, because `isActive: true` is the predicate
the workers run on: `scheduler.ts:76` and `scheduler.ts:106` sweep the sources with
`where: { isActive: true, schedule: { not: null } }`, `scheduler.ts:147` and
`enrichment.ts:349` sweep the rules with `where: { isActive: true, trigger: "SCHEDULED" }`.
So "the ones running" is exactly the set the door hides from a caller who believed the
contract, and the page it hands back instead is the set that will never run again. An
operator who asks `GET /api/sources?isActive=1` and counts what comes back believes this
workspace has two sources running. It has none: both rows on that page have
`isActive = false`, and the three that the sweep will actually visit are not on it.

The asymmetry was already visible from the other door. The write path has a boolean
*kind*, and it refuses in words:

```
PATCH /api/sources/{id} {"isActive":"1"}     400 isActive must be true or false, got a string — send it unquoted
PATCH /api/sources/{id} {"isActive":1}       400 isActive must be true or false, got a number
PATCH /api/sources/{id} {"isActive":"true"}  400 isActive must be true or false, got a string — send it unquoted
PATCH /api/sources/{id} {"isActive":"yes"}   400 isActive must be true or false, got a string — send it unquoted
PATCH /api/sources/{id} {"isActive":true}    200 — accepted, row now isActive=true
POST  /api/sources        {"isActive":"1"}   400 (the create door speaks the same sentence)
```

`validation-engine.ts` keeps that kind for a reason it documents — `Boolean(isActive)` used
to turn `"no"`, `[]` and `42` into `true` and `""` and `null` into `false`, "so one spelling
switched a live subscription off and another kept it on, and neither answer mentioned the
field". The same application therefore refused `"1"` with a 400 in a JSON body and answered
it with the opposite page in a query string. These were the last two places in `src/` where
a caller's word for a boolean was judged by equality against one literal.

`src/lib/bool-word.ts` is the set they were missing: `BOOL_WORDS = ["true", "false"]`,
`boolWordProblem(name, value)` and `boolParam(searchParams, name)`, no database, no network
and no clock in the file, so the judgement is testable without any of them. Both doors now
call `boolParam(searchParams, "isActive")` once, before the query, and return its refusal.
Three decisions, each taken to match a rule this app already runs at another read door:

* **Padding is not part of the word.** `?fields=%20email%20` projects `email` and `short()`
  trims before quoting, so `?isActive=%20true` and `?isActive=true%20` are `true`.
* **An empty value names nothing.** `?isActive=` is an absent `isActive` and both return the
  whole table. A form whose select has nothing chosen sends exactly that; the column's own
  `@default` is `true`, so "no opinion" and "paused" are different questions and the door
  was answering them as one.
* **A word repeated is a question with two answers.** `?isActive=true&isActive=false` cannot
  be honoured by one column comparison, so it is refused by name and count rather than
  resolved to whichever value `get()` returned first. Same word twice is one word.

`1` and `0` are refused rather than folded in, and the contract sentence that recommended
them is corrected in the same commit. They are the digits a JSON body is told off for
sending, and this API's body takes `true` and `false` unquoted; a read door accepting a word
its write door refuses is two vocabularies for one column, which is how the sentence above
got written in the first place. The words are interpolated nowhere — `openapi.ts` keeps no
import from `bool-word.ts` because the contract module is loaded by scripts that must not
pull `next/server` — so the pin is a test instead: the sentence at each door must name both
words, must no longer contain `(1)` or `(0)`, must price a 400 that names `isActive`, and
must not be repeated at a third door.

The same rows, the same database, both builds pressed side by side (`:3371` base, `:3372`
this round — `/tmp/opencode/r57_after.log`, `r57_after_b.log`, `r57_after_c.log`):

```
isActive=true            base 200 1144B total=3        fix  200 1144B total=3
isActive=false           base 200  740B total=2        fix  200  740B total=2      (md5 identical)
isActive=1               base 200  740B total=2 paused fix  400   59B "…must be one of true | false, got \"1\""
isActive=0               base 200  740B total=2 paused fix  400   59B "…got \"0\""
isActive=TRUE            base 200  740B                fix  400   62B
isActive=yes             base 200  740B                fix  400   61B
isActive=no              base 200  740B                fix  400   60B
isActive=%20true         base 200  740B total=2 paused fix  200 1144B total=3      — the padding trims
isActive=true%20         base 200  740B total=2 paused fix  200 1144B total=3
isActive=                base 200  740B total=2 paused fix  200 1826B total=5      — no opinion, whole table
isActive=true&isActive=false
                         base 200 1144B total=3        fix  400  106B "isActive was given 2 words (\"true\", \"false\"); …"
isActive=true&isActive=true
                         base 200 1144B total=3        fix  200 1144B total=3      — same word twice is one word
(no parameter)           base 200 1826B total=5        fix  200 1826B total=5      (md5 identical)
```

and at the rules door the three shapes that mattered: `1` base `200 total=1 [rule-paused-1]`
→ fix `400 …got "1"`; `isActive=` base `200 total=1` → fix `200 total=3`; `true&false` base
`200 total=2` → fix a 400 naming both words. The untouched legs were checked to be
untouched, by hash rather than by eye: `?isActive=false` (740 B), `?isActive=true&page=1&limit=2`
(781 B, `total=3 page=1 limit=2 totalPages=2`), the rules door's `?isActive=true` (749 B) and
both doors with no parameter at all (1,826 B and 1,096 B) are byte-identical on the two
builds, the five keys and their order are the same five, and `PATCH /api/sources/{id}` is
unchanged on both builds for `"1"`, `1` and `"yes"` — refused, byte for byte, by the door this
round did not edit — and the accepted `{"isActive":false}` differs between the two answers only
in `updatedAt`, which is what a write does (`{name, isActive, type}` compared equal, and the row
was put back through the same door).

Pinned offline: **1003/1003** — **25 new** in `tests/unit/bool-word.test.ts` over 6 describes,
no browser, no database, no network. The set is pinned as two words; twenty measured
non-words are each refused with the value echoed back and the whole set named; the
three-way distinction between *absent*, *empty* and *one word* is pinned so `?isActive=`
cannot drift back into meaning `false`; padding is trimmed on both sides and a tab; a word
repeated is one word and two words are a refusal naming both and their count; the refusal is
a 400 carrying exactly one key, `error`, with the same `content-type` as the doors' other
refusals. The two doors are pinned by reading their own source: `boolParam` called once each,
about `isActive`, its `.error` returned before any `prisma.` line, the `where` clause fed the
judged value, and no `=== "true"` or `!== "true"` left anywhere in `src/` except inside the
module that now owns the comparison — a census that walks every file, so a third door cannot
open the same hole. `BOOL_WORDS` is pinned to be the set the refusal sentence prints, both
contract entries are pinned to name both words, to price a 400 mentioning `isActive`, and to
be the *only* two entries that document `isActive` as a query parameter. The write doors are
pinned against the same two words through `validateBody`, so the body's `must be true or
false` and the query's `must be one of true | false` cannot quietly become different
vocabularies. tsc clean, lint **0 errors / 13 warnings** (unchanged from `main`, none on a
line this round wrote), `check:contract` **8/8**, `check:llms-full` **unchanged** (the deep
content file prints operation summaries, not query-parameter prose), build exit 0. No
existing test was retargeted: the suite on `main` is 978 and nothing in it quoted the digit
sentence.

What this does not claim:

* **The contract text on an already-published copy is still the old sentence.** `GET
  /api/openapi` is generated from the source, so a running instance starts telling the truth
  when it is rebuilt — verified above, the base instance still printing `(1) or (0)` while
  the fix instance prints the two words. Nothing caches the document elsewhere;
  `public/llms-full.txt` never contained it.
* **`?isActive=` is still not a filter at three other doors.** `Webhook.isActive`,
  `ExportProfile.isActive` and `LeadList.isDynamic` are boolean columns nobody filters on;
  `GET /api/webhooks` takes no `isActive` at all and `GET /api/lead-lists` takes none. The
  census that walks `src/` pins that no *third* door reads a boolean word, and the contract
  test pins that these two operations are the only ones that document `isActive` as a query
  parameter — not that every boolean column is filterable. That would be a feature, and an
  undocumented filter is not the same defect as a misdocumented one.
* **No first-party caller sends anything at all.** On `main`, `git grep 'isActive='` across
  `src`, `demo`, `docs`, `README.md` and `public` returns nothing — the parameter is read by
  two doors and spelled in a query string by no page, no demo and no document, so this round
  breaks no internal caller. An external integration that has been sending `1` was being
  answered with the paused crowd; it now gets a 400 that tells it so, which is the point of
  the round and the only thing that changes for them.
* **`?isActive=true|false` still cannot ask for both states at once, or express an OR over
  statuses.** One column, one word — the same limit #56 recorded for the enum filters. Two
  words is a refusal, not a union.
* **The empty-value rule is a decision, not a discovery.** `?isActive=` returning the whole
  table is the reading the open `?status=` round (#56) chose for an empty enum word; a
  product could decide an empty boolean means `false`. It is stated here because the two
  doors now share one rule and someone will eventually want them not to.
* **No demo step this round**, for the reason #51, #52 and #53 recorded — `aw-deploy`'s only
  open pair (#96, STEP 27) is `CONFLICTING`, so a step stacked on it is not a direct child of
  that repo's `main`.

## Score: one arithmetic, and who may change it

`Lead.score` has had a column, a sort order (`GET /api/leads?orderBy=score desc`)
and a sentence in this README since the first migration, and no producer. Intake
left it at the column default of 0; the CSV importer left it at 0; the only
automatic write was the validator subtracting 10 per failed check from whatever
number happened to be there, which for every lead meant from 0 — so the same three
failed checks lowered it again on every run and it could never be anything else.
Measured on this workspace: the three best-imported contacts sat at `score=0`
holding an email, a company, a title, a location, a country and an industry.

`src/lib/lead-score.ts` owns it now, and four rules decide it.

- **The row's own signals, only.** `SCORE_TERMS` is 17 terms over 5 groups —
  contact 30, identity 16, company 36, signals 14, provenance 4 — and the points
  sum to exactly 100, so "0–100" is arithmetic rather than a clamp. Presence
  earns; format does not. A `+4798abc` phone is a real phone signal worth 8 and a
  failed `phone_format` worth −10, and both facts are on the row.
- **A number a person typed is an input, not a write.** `PATCH /api/leads/{id}`
  with `{score: 82}` stores 82 in `scoreOverride` and keeps the row's own total
  beside it; `{score: null}` hands the number back to the arithmetic. `0` is a
  real override, so it is read with `typeof … === "number"`, never `||`.
  `POST /api/leads` declares no `score` at all: nobody can put a number in at
  intake, and the door that does bound it to 0–100 and refuses a string.
- **A failed check is a priced rule, not a side effect.** The validator records
  `validationResults` and asks this module what the row is now worth. The record
  is overwritten, not appended, which is the only reason re-running the same job
  cannot lower the same failure twice.
- **The work travels with the number.** Every write stores `scoreBreakdown` —
  `basis`, `computed`, `override`, each earned term with its points and a
  one-line `why`, each column that earned nothing — and `scoredAt`, in three
  columns added by `20261021120000_lead_score_owner`. A ledger kept in
  `customFields` would be caller-writable; these are not, and no door in
  `src/lib/fields.ts` takes them.

What the number measures gets said once, because the table invites the wrong
reading: it is **how much this workspace knows about the person and the company**.
Not rank — `UNKNOWN` earns 0 while `IC` and `C_LEVEL` both earn 6. Not outcome —
`status` earns nothing. Not effort — tags earn nothing. Seven writers route
through `scoredWriteData` (both lead doors, the CSV importer, the scraper's two
branches, the validator, the dedupe merge, the enrichment plan), so a signal
written anywhere moves the number, and the test that scans `src/**` for any other
place that adds to or subtracts from a `score` expects to find none.

Read path: `GET /api/ai/explain-lead` returns the number that sorts the list with
the stored ledger and `stale: lead.score !== live.score`, model or no model; the
dashboard's top-leads table prints the earned terms under the number, and for an
override, `typed 82 · the row earns 96`.

Pinned offline by `tests/unit/lead-score.test.ts` (64 of the 573 in the suite: the 28 in the suite: the 46 in the suite: the 609 in the suite: the 28 in the suite: the 46 in the suite: the 609 in the suite: the 626 in the suite: the 28 in the suite: the 46 in the suite: the 609 in the suite: the 626 in the suite: the 642 in the suite: the 670 in the suite: the
table against the schema's own columns and its migration, the group totals, known
answers for four hand-added rows, the override and its `0`, the `-0` a Json column
would swallow, the ledger's round-trip, the seven writers scanned from source, the
crowd a validation job may name, and the buyer's read path). The live proof is
`demo/run-demo.sh leadworks` STEP 11, 37 assertions: four rows arrive at intake and
come out priced 20 / 90 / 96 / 49 by the arithmetic in the insert — one of them
having sent `score: 99` to a door that takes none; every ledger adds up to the
number on its row; an imported CSV row arrives at 41; a typed 82 becomes an
override that still shows the 96 the row earns, with 150 and `"82"` both 400; a
company and title written later lift the thin row from 20 to 36; and one `VALIDATE
… score_down` job named at those five rows prices two failed checks at −20 —
16, 90, 96, 29, 21 — and the same job again returns the same five numbers.

## Webhooks (outbound)

`POST /api/webhooks` takes `{ workspaceId, url, events }` and answers `201`
with the created subscription and its `secret` — the one door that prints that
secret, and the one moment it can be shown to anyone. `GET /api/webhooks`,
`GET /api/webhooks/{id}` and the reply to a `PATCH` carry every other column of
the row without it: the value a caller can read again is a value nothing can
retire, and this is the key a subscriber verifies deliveries with, so re-issuing
it on every press turns a read credential into the ability to forge this
product's deliveries into someone else's endpoint. A secret lost is replaced by
`DELETE` then `POST` — a new row, a new id, a new secret — the same shape the
terms page already states for API keys ("Plaintext keys are shown once") and
`src/lib/apikeys.ts` ships ("returned once and never persisted"). The column
itself cannot be hashed away the way a key is: verification of a bearer token
needs only its digest, while an HMAC delivery is signed with the value itself, so
`src/lib/webhooks.ts` keeps reading it straight from the table. A subscription
can name only
the events this product emits — an unknown name is refused with the list
rather than stored, because a subscription filtered on a name nothing sends
is the same silence as no subscription at all:

| Event | Fires when |
|---|---|
| `lead.created` | a lead is created through `POST /api/leads` or a CSV import |
| `enrichment.completed` | an enrichment job finishes; payload carries `jobId`, `processed`, `enriched`, `failed` |
| `export.completed` | an export job finishes; payload carries `exportId`, `format`, `recordCount`, `fileSize` |

Each delivery is a JSON body `{ id, event, timestamp, data }`, signed
HMAC-SHA256 over the raw body with the subscription's secret, under two
headers carrying the same digest: `X-Leadworks-Signature: <hex>` (this
product's spelling) and `X-Webhook-Signature: sha256=<hex>`. The second is the
generic spelling a nuCRM plugin webhook verifies out of the box — point one at
`/api/tenant/plugins/webhook/{id}` with the same secret and nuCRM accepts the
call with no adapter in between. `id` names the logical event; a receiver that
deduplicates on it is already correct on the day delivery grows retries.

Delivery is one attempt per (row, subscription), best-effort and never throwing:
a receiver that is down is counted and skipped, and never fails the lead create
or the job whose work already committed. The attempts a batch owes are made
**eight in flight per subscription** (`WEBHOOK_FANOUT`) inside one attempt budget
of 5 s (`WEBHOOK_ATTEMPT_BUDGET_MS`), so a door pays
`⌈rows / 8⌉ × 5 s` for a receiver that never answers and `⌈rows / 8⌉ × its
latency` for one that answers slowly — not the row count times either. See
*Who waits for the subscriber* below for the measured numbers behind that rule.
`tests/unit/webhook-dispatch.test.ts` pins the wiring — an
event declared without an emitter, or an emitter that loses its
call site, fails the suite; `tests/unit/webhook-fanout.test.ts` pins the pool,
the counts and the three kinds of failure.

### Who waits for the subscriber

A webhook subscription is an operator's decision that turns a third party's
latency into this API's response time. That was measured on `origin/main` at
`65bd942` — this session's own instance (`:3331`, database `leadworks_r53`,
booted with `ABET_ALLOW_PRIVATE_TARGETS=1` so a subscription could name a
receiver on this box) against a receiver with four behaviours, every number
`curl`'s own time for the door call (`/tmp/opencode/r53_measure.log`):

| subscription | `POST /api/leads` (1 row) | import of 20 fresh rows | import of 40 |
|---|---|---|---|
| none | 0.043 s | 0.166 s | — |
| answers 200 at once | 0.072 s | 0.226 s | — |
| answers 200 after 300 ms | 0.317 s | 6.222 s | — |
| answers 500 | 0.018 s | — | — |
| accepts and never answers | 5.037 s | **100.190 s** | **200.275 s** |

The last row is the defect stated exactly: 20 × 5.009 = 100.19 and 40 × 5.006 =
200.27. The importer awaited one delivery per row, so #17's 5 s attempt budget —
the reason a reader of that code believed "a hung receiver cannot pin the
caller" — bounded a single attempt while the door paid the crowd. The receiver's
own count for those runs was 72 hits for 66 rows and 6 for the second
subscription, so no attempt was extra and none was lost: the contract of one
`lead.created` per row is not what could be shed, only the order they were made
in. And the `answers 500` row is the other half: **0.018 s, and nothing said.**
The door returned the same `201` with the same body it returns when the
subscriber says yes; `GET /api/webhooks/{id}` afterwards prints the row — url,
events, `isActive: true`, the signing secret — and no fact about a delivery,
because no delivery is recorded. The only place the 500 was written down is this
instance's stdout: `webhook cmvo1su82… -> lead.created: 500 Internal Server
Error`.

`src/lib/webhook-fanout.ts` is the arithmetic, with no fetch and no database in
it, which is what makes it testable at all. `fanOut(items, width, run)` claims
items by an index that only advances — so an item cannot be lost or run twice, a
task that throws still costs the pool nothing but itself, and a width above the
item count costs one wave rather than a promise per item. `tallyDeliveries`
counts what was attempted from the outcomes it was handed, never from a number
the caller supplied, and keeps the three kinds of failure apart because they are
three parties: **`refused`** is a receiver that was reachable and answered 500,
**`no-answer`** is a socket that produced no HTTP response (the budget expiring,
a connection refused), **`blocked`** is an address this instance's own egress
policy refused before it was attempted. Collapsing them is what made a
subscriber's application bug and a typo in its URL look identical from outside.

The width is spent **per subscription**, not across the batch, and that is a
deliberate asymmetry: nine endpoints watching one event are nine independent
receivers, so a single `POST /api/leads` still answers in one attempt budget
(measured: 5.018 s with two silent subscriptions, the same as with one) while the
one receiver with 240 events waiting for it is posted to eight at a time instead
of having 240 sockets opened at it.

What the caller is told changed in one place and not in the other. The import
report now carries `webhooks`, because the import already answers with a report
and a report that omits 720 failed deliveries is a report that omits the point.
`POST /api/leads` still answers with the lead row and nothing else — #17 pinned
that as "webhooks are best-effort on top of a successful create, not a
replacement for it", and the lead body is the one `?fields=` projects, so an
extra key there is a key the projection has to be taught about. A single create
whose subscriber is down is therefore still visible only in stdout; the count is
in the file import, where the crowd makes the difference measurable.

Said rather than implied: **the door still waits.** The fan-out is inline —
`src/lib/queue.ts` has no `webhook` arm and adding one is a change to a vendored
module, so the attempts are made in the request, and a 400-row import against a
receiver that never answers still costs `⌈400/8⌉ × 5 s` = 250 s. What changed is
the multiplier: the row count is divided by the width instead of being the
width. **Nothing is recorded per delivery** — `webhooks` is the outcome of the
fan-out the caller's own request performed, not a delivery log; an event emitted
by a scheduled job is still counted only in that worker's stdout, and an
operator who wants "did my subscriber get yesterday's leads" needs a deliveries
table, which is a different round's decision. **`attempted` is a count of
sockets, not of acknowledgements**: a receiver that answers 200 and drops the
body is `delivered`. And the failure is now *displayed*, not *fixed*: a 500 from
a subscriber is still one attempt, and retries would break the "deduplicate on
`id`" promise the section above makes.

## AI (optional)

`GET /api/ai/explain-lead?id=…` returns the deterministic 0–100 score
LeadWorks already computed alongside a plain-English explanation of *why*:
strongest signals first, gaps that would raise the score, and the model's own
confidence. Read-only — the score is never modified. Without `LLM_API_KEY`
the score is still returned with `configured: false`, and with or without a model the
answer carries the arithmetic too: `score`, `scoredAt`, `breakdown` (the stored ledger,
or this module's live recomputation for a row predating it) and `stale`, which is
`lead.score !== computeLeadScore(lead).score` — the honest way to admit a number nobody
has re-priced. The demo run has no key and gets `score: 90`, `stale: false` and 15
earned terms for the row STEP 11 created.

Same key setup as LeadGenius (`LLM_API_KEY`, optional `LLM_BASE_URL`,
`LLM_MODEL`, `LLM_TIMEOUT_MS`). Offline contract unit-tested in
`tests/unit/ai-score.test.ts`.

## Billing

$49/month flat via Stripe. Three endpoints under `/api/billing` (workspaceId as query param, no session in this app):

POST /api/billing/checkout
POST /api/billing/portal
POST /api/billing/webhook

`checkout` takes `{ priceId: "FLAT_MONTHLY" | "FLAT_ANNUAL", returnUrl }` and returns `{ url }` for the Stripe-hosted page. A workspace the `Subscription` row says is already trialing, active, past due or unpaid gets a 409 instead of a second checkout: another session would be another subscription, and nothing cancels the one Stripe is already charging, so a plan switch or a fixed card is the portal's job. The `/pricing` page reads the same row before it sells anything: a workspace that is already billed sees its plan named, with the renewal date the row carries, its own card marked *Your plan* and the other turned into a portal link — a trial button that answers 409 reads as a broken button, and a buyer with nothing to decide has nowhere to be told where to change it. The webhook verifies the Stripe signature and syncs `checkout.session.completed`, `customer.subscription.*`, and `invoice.payment_failed` into the `Subscription` row. Replays are answered `duplicate` without re-running the handler: every verified delivery is claimed by its event id before it is handled, and the row carries the newest event time it has applied, so a redelivered or late-arriving snapshot cannot re-fire a mail or drag the status backwards. Setup: create the two prices in Stripe, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FLAT_MONTHLY`, `STRIPE_PRICE_FLAT_ANNUAL`, forward webhooks with `stripe listen --forward-to localhost:3300/api/billing/webhook`. Signature checks are unit-tested offline in `tests/unit/billing.test.ts`.

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
minute because `matchesSchedule` in `cron-schedule.ts` decides which of those minutes mean
anything, so a coarser sweep drops matches — the sweep hands it the clock and never reads one
itself (`scheduler.ts` contained two unused `now.getX()` locals until #38 deleted them with the
matcher they belonged to). It runs last in `startWorkers()`
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
