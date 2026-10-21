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
POST   /api/leads/import                   # CSV import (text/csv or JSON)
GET    /api/leads/{id}                     # detail + enrichment log
PATCH  /api/leads/{id}                     # update; `{score}` is an override, not a write (see Score below)
POST   /api/leads/{id}?action=enrich       # visit the one lead the URL names
GET    /api/lead-lists?workspaceId=        # lists
POST   /api/lead-lists/{id}?action=add-leads|remove-leads
GET    /api/enrichment-rules?workspaceId=  # rules
POST   /api/enrichment-rules               # create; `conditions` and `actions` are both required, and both are read
PATCH  /api/enrichment-rules/{id}          # change a rule; conditions and actions are re-checked as a pair
POST   /api/enrichment-rules/{id}?action=run  # run a rule now → { jobId, appliesTo }
GET    /api/exports?workspaceId=           # exports
POST   /api/exports                        # export to CSV/JSON/XLSX/PDF
GET    /api/exports/{id}                   # status + download
DELETE /api/exports/{id}                   # delete the record — and, when it named one, the file it wrote
GET    /api/webhooks?workspaceId=          # subscriptions
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
`imported`, `total`, `invalid`, `duplicatesInFile`, `duplicatesExisting` and up
to 50 `problems`, each with the real file line. The dashboard shows the first
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
- **`schedule` is the cron the minute is matched against**, stored in the one
  single-space form `shouldRunNow` splits.
- **A declaration this build cannot honour is refused at the door that would store it,**
  every problem in one 400, with the offending part quoted: a key nothing performs
  (`enrich` was this repo's own demo spelling), a column no write knows — the refusal
  quotes the list `ENRICH_WRITABLE` owns, which `rule-actions.ts` imports instead of
  re-spelling — an empty list, a cadence holding a step (`*/5`) or a range (`9-17`),
  which reads as a schedule and is never matched by this build, a number outside its
  field's range, and the one pairing the blob cannot state about itself: a `SCHEDULED`
  rule with no cadence is stored, active and never swept, and a cadence on any other
  trigger is stored and never swept. Both halves of that are checked on the edit door
  too, against whichever half the request left alone, so flipping `trigger` to
  `SCHEDULED` cannot smuggle in the row the create door refuses.
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

What this does not claim: the two visits that remain are still two visits. A rule the ranking
left a remainder for still walks into a provider that has no opinion on it — `derive` reads
titles, not company sizes — and logs a `PARTIAL` and a `creditsUsed`, because no plan written
before the provider runs can know that in advance. And the starved rule leaves no *row* behind:
what a starvation costs is visible as the absence of a job and of a `creditsUsed`, and the
sentence explaining it is in the server's log, not in `EnrichmentLog`. What is on the record is
who won, which is #33's pair beside the winner's name.

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

Pinned offline by `tests/unit/lead-score.test.ts` (64 of the 642 in the suite: the
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
with the created subscription and its `secret`. A subscription can name only
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

Delivery is one attempt, best-effort and never throwing: a receiver that is
down is logged and skipped, and never fails the lead create or the job whose
work already committed. `tests/unit/webhook-dispatch.test.ts` pins the
wiring — an event declared without an emitter, or an emitter that loses its
call site, fails the suite.

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
