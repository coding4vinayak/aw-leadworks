# leadworks — ledger index

Sections in `aw-abetworks-history/abetworks-improvements.txt` that name `leadworks`.

Total: **42 top-level §§** — 2 name only leadworks; 40 also name at least one sibling.

Full text lives in the `aw-abetworks-history` repo:
`https://github.com/coding4vinayak/aw-abetworks-history/blob/main/abetworks-improvements.txt`.

This file is a pointer, not a copy. The campaign's whole discipline was
keeping decisions in one narrative; duplicating a § into two repos is exactly
the failure mode it guarded against.

## §§ naming only this app

| § | Line | Title |
|---|-----:|-------|
| 8.7 | L680 | MISTAKES I MADE INSIDE THIS ROUND, WRITTEN DOWN SO THEY ARE NOT LOST |
| 8.61 | L8917 | LEADWORKS OUTBOUND WEBHOOKS, BUILT (#17) |

## §§ naming this app and one or more siblings

| § | Line | Title | Also names |
|---|-----:|-------|-----------|
| 8.1 | L420 | NUMBERS (final instrumented run, SECONDS=5 LEVELS=1,10,50) | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.2 | L452 | DEFECTS THE LOAD TEST FOUND (none were visible to the unit tests) | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.4 | L550 | HOW TO REPRODUCE | abetapi, abetflow |
| 8.5 | L579 | "FIX ALL" — WHAT SHIPPED, AND THE REGRESSION THE FIRST ATTEMPT CAUSED | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.8 | L697 | N1 FIXED — EVERY LIST ROUTE NOW BOUNDS ITS OWN QUERY STRING | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.9 | L756 | N4 FIXED — AND IT WAS NEVER ONLY A listId PROBLEM | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.10 | L873 | N6 — THE ONE THAT MATTERED MORE THAN SCALAR TYPES: NO AUTH AT ALL | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.13 | L1305 | N5, LEADWORKS — THE SAME BOUNDARY, AND THE FIRST TIME IT REFUSED DATA THAT | leadgenius |
| 8.14 | L1423 | N5, ABETAGENT — VALUES QUIETLY NOT STORED, AND AN OWNERSHIP CHECK BURIED IN | abetagent, leadgenius |
| 8.15 | L1527 | N5, ABETFLOW — A WRONG TYPE THAT REACHES A COLUMN THE SCHEMA ONLY | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.16 | L1752 | N5, ABETANALYTICS — TWENTY-ONE 500s, AND THE FIRST AFTER-RUN THAT MADE A | abetagent, abetanalytics, abetflow, leadgenius |
| 8.18 | L2344 | N6 GUARD, ALL SIX APPS — A KEY CHECK IN THE BODY IS NOT A KEY CHECK ON | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.19 | L2664 | N5 GUARD, LEADGENIUS — THE FOUR ROUTES THE DEPLOYMENT ALREADY VOUCHES FOR | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.20 | L2952 | THE SCANNER, VENDEORED — THE FILE THAT DECIDES WHAT THE GUARDS CAN SEE | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.21 | L3180 | THE TWO AI SURFACES, REUNITED — AND WHAT THE DRIFT CHECK CANNOT SEE | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.22 | L3406 | "IDENTICAL AND UNUSED" LOOKS GREEN TO cmp — THE AUTH CHECK LEARNS WHAT THE | abetagent, abetapi, abetflow, leadgenius |
| 8.23 | L3601 | THE GATE IS AN EXIT CODE, AND LIVENESS IS NOT ALLOWED IN IT | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.24 | L3830 | THE CLAIM RULE BECAME ONE FUNCTION, AFTER THE PROBE PROVED IT COULD NOT LIE | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.25 | L4044 | THE CONSOLE'S OWN REGISTRY BECOMES A SUITE — #40'S DETECTION HALF | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.26 | L4263 | TWO PRODUCTS, ONE QUEUE — AND A GUARD THAT WAS GREEN ON A MODULE THAT COULD | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.27 | L4630 | #50 — ABETFLOW + ABETAGENT: THE QUEUE MODULE COULD NOT BE IMPORTED WITHOUT | abetagent, abetanalytics, abetflow, leadgenius |
| 8.28 | L4854 | #52 — THE OTHER THREE APPS, AND THE DEFECT IN #50'S OWN PROBE | abetagent, abetanalytics, abetflow, leadgenius |
| 8.29 | L5133 | #53 — LEADWORKS' `scheduled` QUEUE HAD A WORKER AND NO PRODUCER, AND RULE 10 NOW KEEPS IT | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.30 | L5369 | #54 — LEADGENIUS' TWO STARVED QUEUES GOT PRODUCERS, AND ONE OF THEM ATE A TAIL EVENT | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.31 | L5590 | #55 — ABETFLOW'S CRON SWEEP GOT A DRIVER, AND THE COLUMN IT READS TURNED OUT TO HAVE FIVE WRITERS | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.32 | L5852 | — ROUND #57: leadgenius' scheduleWarmup repeat key ignored accountId, so | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.35 | L6228 | — #62  leadworks + abetflow startWorkers() never resolved against an | abetagent, abetanalytics, abetflow |
| 8.36 | L6335 | — #64  the queue-retention convention (#61, leadgenius) is ported to the four | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.41 | L6750 | — #35  the auth guard could not see a write that one line away from the handler | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.42 | L6903 | — #38  the read side was counted before it was given a rule, and the rule it | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.43 | L7076 | CROSS-TENANT WRITE PROBE: WHAT A RUNNING ROUTE ANSWERS, NOT WHAT THE SOURCE SAYS | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.44 | L7217 | ONE READER FOR THE ARGUMENT AXIS: WHAT "FIVE APPS HAD A REGEX" ACTUALLY MEANT | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.45 | L7360 | EGRESS POLICY: THE ADDRESS IS THE QUESTION, NOT THE SYNTAX | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.46 | L7618 | REUNITE THE SIX validate.ts COPIES — ONE GRAMMAR, TWO ENVELOPES | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
| 8.49 | L7927 | ONE MODULE IS NOT DEAD JUST BECAUSE THE ROUTER DOES NOT REACH IT (#45) | abetagent, abetapi |
| 8.53 | L8259 | THE RETENTION DEFAULT IS GUARDED AT THE GATE, NOT JUST IN FIVE TESTS (#71 guard half) | abetapi, abetflow, leadgenius |
| 8.54 | L8311 | THE RETENTION DEFAULT IS ONE FILE THE GATE CAN SEE (#71 vendoring half) | abetapi, abetflow, leadgenius |
| 8.55 | L8388 | THE BOUNDED-REGISTRATION HELPER BECOMES ONE FILE TOO (#71 sweep half) | abetagent, abetflow |
| 8.62 | L9045 | DB 0 ORPHAN DECISION, AND THE README THAT HAD NOT CAUGHT UP (#51) | abetanalytics, leadgenius |
| 8.63 | L9126 | SWEEP CLOSES WITH #40 STILL PENDING — MEASURED, NOT INVENTED | abetagent, abetanalytics, abetapi, abetflow, leadgenius |
