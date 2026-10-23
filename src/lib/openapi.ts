import { VERSION } from "./version";

/**
 * The API contract — what an integrator reads, and what the acceptance
 * sweep checks against the routes.
 *
 * LeadWorks is the lead-operations funnel: capture every lead once
 * (duplicates refused at the door), sources and jobs and enrichment rules
 * that run on schedule, validation, dedupe and CRM-ready CSV exports. A
 * contract is a second description of that machine, and second descriptions
 * rot. This one cannot: `scripts/check-contract.mts` reads every claim back
 * out of the source that serves it. Every route that answers is in here and
 * every operation here has a route that answers; every request body is
 * compared with the app's own declared field table, so the spec cannot
 * advertise a field the door would refuse; and the version is the app's
 * version, read from the same place the landing page's badge reads it.
 */
const API_KEY = [{ apiKey: [] }];
const SESSION = [{ sessionCookie: [] }];
const NONE: Record<string, string[]>[] = [];

type Method = "get" | "post" | "patch" | "put" | "delete";

interface Operation {
  /** A stable name for the call — the operationId an SDK would generate. */
  id: string;
  /** One line, said the way the README says it. */
  summary: string;
  /** The auth the route enforces. */
  auth?: "key" | "session" | "none" | "stripe";
  /** Query parameters, as `[name, description]`. */
  query?: [string, string][];
  /** A JSON body, described as its properties — the ones the route reads. */
  body?: { description: string; properties: Record<string, { type: string; description: string; required?: boolean }> };
  /** The statuses the route can answer, with what each one carries. */
  responses?: Record<string, string>;
  /** The field table the body is checked against, by name. */
  fields?: string;
}

interface PathItem {
  get?: Operation;
  post?: Operation;
  patch?: Operation;
  put?: Operation;
  delete?: Operation;
}

const securityFor = (auth: Operation["auth"]) =>
  auth === "key" ? API_KEY : auth === "session" ? SESSION : NONE;

function op(method: Method, operation: Operation): Record<string, unknown> {
  const parameters = (operation.query ?? []).map(([name, description]) => ({
    name,
    in: "query",
    required: false,
    description,
    schema: { type: "string" },
  }));
  const body = operation.body
    ? {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(operation.body.properties).map(([name, shape]) => [
                  name,
                  { type: shape.type, description: shape.description },
                ]),
              ),
              required: Object.entries(operation.body.properties)
                .filter(([, shape]) => shape.required)
                .map(([name]) => name),
            },
          },
        },
      }
    : undefined;
  const responses = Object.fromEntries(
    Object.entries(operation.responses ?? { "200": "The answer." }).map(([status, description]) => [
      status,
      { description, content: { "application/json": { schema: { type: "object" } } } },
    ]),
  );
  return {
    operationId: operation.id,
    summary: operation.summary,
    tags: [operation.id.split(".")[0]],
    ...(parameters.length ? { parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    responses,
    ...(operation.auth === "key" || operation.auth === "session"
      ? { security: securityFor(operation.auth) }
      : {}),
  };
}

const PATHS: Record<string, PathItem> = {
  "/api/health": {
    get: {
      id: "health.get",
      summary: "Liveness. No key needed.",
      auth: "none",
      responses: { "200": "ok." },
    },
  },
  "/api/leads": {
    get: {
      id: "leads.list",
      summary: "The workspace's leads.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["listId", "Only the leads on one list."],
        ["status", "One lead status."],
        ["page", "1-based page number."],
        ["limit", "Page size; it caps at 100."],
      ],
      responses: { "200": "The leads, with a total." },
    },
    post: {
      id: "leads.create",
      fields: "LEAD_CREATE",
      summary: "Capture one lead — a duplicate of what this workspace already holds is refused at the door.",
      auth: "key",
      body: {
        description: "The lead's fields. Every column is optional here; a lead with no email and no phone is still a person you met.",
        properties: {
          email: { type: "string", description: "An address, or leave it out." },
          phone: { type: "string", description: "A phone number." },
          linkedinUrl: { type: "string", description: "A profile URL." },
          firstName: { type: "string", description: "Given name." },
          lastName: { type: "string", description: "Family name." },
          company: { type: "string", description: "The company." },
          title: { type: "string", description: "The title." },
          department: { type: "string", description: "The department." },
          seniority: { type: "string", description: "One of the lead seniorities." },
          location: { type: "string", description: "Where they are." },
          country: { type: "string", description: "The country." },
          industry: { type: "string", description: "The industry." },
          companySize: { type: "string", description: "The headcount band, as you name it." },
          revenue: { type: "string", description: "The revenue band, as you name it." },
          technologies: { type: "array", description: "Tools the company uses." },
          intentSignals: { type: "array", description: "Signals you saw." },
          tags: { type: "array", description: "Your tags." },
          socialProfiles: { type: "object", description: "Profile links as {platform: url}." },
          customFields: { type: "object", description: "Anything else this workspace wants to keep." },
        },
      },
      responses: { "201": "The lead, with its score. 422 for a duplicate." },
    },
  },
  "/api/leads/import": {
    post: {
      id: "leads.import",
      fields: "LEAD_IMPORT",
      summary: "Bring a CSV in — the rows are judged by the same door one lead takes.",
      auth: "key",
      body: {
        description: "The file, as text.",
        properties: {
          csv: { type: "string", description: "The CSV, up to the import cap.", required: true },
        },
      },
      responses: { "201": "How many rows were captured, skipped or refused, with reasons." },
    },
  },
  "/api/leads/{id}": {
    get: {
      id: "leads.get",
      summary: "One lead, with its validation results.",
      auth: "key",
      responses: { "200": "The lead." },
    },
    patch: {
      id: "leads.update",
      fields: "LEAD_PATCH",
      summary: "Edit a lead. `score` writes the override (0–100) the ranking walks; everything else is the column it is.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          email: { type: "string", description: "A new address." },
          phone: { type: "string", description: "A new number." },
          linkedinUrl: { type: "string", description: "A new profile URL." },
          firstName: { type: "string", description: "A new given name." },
          lastName: { type: "string", description: "A new family name." },
          company: { type: "string", description: "A new company." },
          title: { type: "string", description: "A new title." },
          department: { type: "string", description: "A new department." },
          seniority: { type: "string", description: "A new seniority." },
          location: { type: "string", description: "A new location." },
          country: { type: "string", description: "A new country." },
          industry: { type: "string", description: "A new industry." },
          companySize: { type: "string", description: "A new headcount band." },
          revenue: { type: "string", description: "A new revenue band." },
          technologies: { type: "array", description: "A new tool list." },
          intentSignals: { type: "array", description: "New signals." },
          tags: { type: "array", description: "New tags." },
          socialProfiles: { type: "object", description: "New profile links." },
          customFields: { type: "object", description: "New extras." },
          score: { type: "number", description: "The 0–100 override; null gives the row's own score back." },
          status: { type: "string", description: "A new status." },
        },
      },
      responses: { "200": "The lead as it now reads." },
    },
    post: {
      id: "leads.enrich",
      summary: "Act on one lead — ?action=enrich — run the workspace's enrichment rules on this lead, or ?action=add-to-list — put it on one list.",
      auth: "key",
      query: [["action", "enrich — run the workspace's enrichment rules on this lead; add-to-list — put it on one list."]],
      body: {
        description: "For add-to-list: the list. For enrich: nothing.",
        properties: {
          listId: { type: "string", description: "The list to add the lead to (action=add-to-list only)." },
        },
      },
      responses: { "200": "What the action did.", "422": "The list does not exist." },
    },
    delete: {
      id: "leads.delete",
      summary: "Forget a lead.",
      auth: "key",
      responses: { "200": "The lead is gone." },
    },
  },
  "/api/lead-lists": {
    get: {
      id: "leadLists.list",
      summary: "The workspace's lists.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The lists." },
    },
    post: {
      id: "leadLists.create",
      fields: "LEAD_LIST_CREATE",
      summary: "Create a list — static, or dynamic with a filter the workspace re-evaluates.",
      auth: "key",
      body: {
        description: "The name and, for a dynamic list, the filter.",
        properties: {
          name: { type: "string", description: "What the list is called.", required: true },
          description: { type: "string", description: "What it is for." },
          isDynamic: { type: "boolean", description: "A dynamic list re-evaluates its filter." },
          filterJson: { type: "object", description: "The filter." },
        },
      },
      responses: { "201": "The list." },
    },
  },
  "/api/lead-lists/{id}": {
    get: {
      id: "leadLists.get",
      summary: "One list, with its members.",
      auth: "key",
      query: [
        ["fields", "Comma-separated Lead columns to project each member's lead onto — the same names Export.fields takes. Absent means the whole row."],
      ],
      responses: { "200": "The list.", "400": "A `fields` entry that is not a Lead column, or names nothing." },
    },
    patch: {
      id: "leadLists.update",
      fields: "LEAD_LIST_PATCH",
      summary: "Edit a list's name, filter or kind.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          description: { type: "string", description: "What it is for." },
          isDynamic: { type: "boolean", description: "Whether it re-evaluates." },
          filterJson: { type: "object", description: "A new filter." },
        },
      },
      responses: { "200": "The list as it now reads." },
    },
    post: {
      id: "leadLists.members",
      summary: "Move leads in or out — ?action=add-leads or ?action=remove-leads, each taking leadIds.",
      auth: "key",
      query: [["action", "add-leads — put the leads on the list; remove-leads — take them off."]],
      body: {
        description: "The leads to move.",
        properties: {
          leadIds: { type: "array", description: "The lead ids; at least one.", required: true },
        },
      },
      responses: { "200": "The list as it now reads.", "422": "A leadId that does not exist, named." },
    },
    delete: {
      id: "leadLists.delete",
      summary: "Delete a list — the leads survive it.",
      auth: "key",
      responses: { "200": "The list is gone." },
    },
  },
  "/api/sources": {
    get: {
      id: "sources.list",
      summary: "The workspace's sources.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["isActive", "Only the ones running (1) or paused (0)."],
        ["page", "1-based page number."],
        ["limit", "Page size."],
      ],
      responses: { "200": "The sources, with a total." },
    },
    post: {
      id: "sources.create",
      fields: "SOURCE_CREATE",
      summary: "Register a source — where leads start, on a schedule if you name one.",
      auth: "key",
      body: {
        description: "The name, the type, and the config that type needs.",
        properties: {
          name: { type: "string", description: "What the source is called.", required: true },
          type: { type: "string", description: "One of the source types.", required: true },
          config: { type: "object", description: "The type's own configuration.", required: true },
          schedule: { type: "string", description: "A cron expression." },
          isActive: { type: "boolean", description: "Whether it runs." },
        },
      },
      responses: { "201": "The source." },
    },
  },
  "/api/sources/{id}": {
    get: {
      id: "sources.get",
      summary: "One source, with what it last did.",
      auth: "key",
      responses: { "200": "The source." },
    },
    patch: {
      id: "sources.update",
      fields: "SOURCE_PATCH",
      summary: "Edit a source — its config, schedule or state.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          type: { type: "string", description: "A new type." },
          config: { type: "object", description: "A new configuration." },
          schedule: { type: "string", description: "A new cron expression, or null to unschedule." },
          isActive: { type: "boolean", description: "Whether it still runs." },
        },
      },
      responses: { "200": "The source as it now reads." },
    },
    post: {
      id: "sources.run",
      summary: "Run this source now — ?action=run.",
      auth: "key",
      query: [["action", "run — the only action."]],
      responses: { "201": "The job, queued." },
    },
    delete: {
      id: "sources.delete",
      summary: "Delete a source.",
      auth: "key",
      responses: { "200": "The source is gone." },
    },
  },
  "/api/jobs": {
    get: {
      id: "jobs.list",
      summary: "The workspace's jobs.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["type", "One job type."],
        ["status", "One job status."],
        ["sourceId", "Only one source's jobs."],
        ["page", "1-based page number."],
        ["limit", "Page size."],
      ],
      responses: { "200": "The jobs, with a total." },
    },
    post: {
      id: "jobs.create",
      fields: "JOB_CREATE",
      summary: "Queue a job yourself — the sources and rules queue these too.",
      auth: "key",
      body: {
        description: "What to do, and where it works.",
        properties: {
          type: { type: "string", description: "One of the job types.", required: true },
          config: { type: "object", description: "The job type's own configuration.", required: true },
          sourceId: { type: "string", description: "The source it belongs to, if it has one." },
        },
      },
      responses: { "201": "The job, PENDING." },
    },
  },
  "/api/jobs/{id}": {
    get: {
      id: "jobs.get",
      summary: "One job — its state and progress.",
      auth: "key",
      responses: { "200": "The job." },
    },
    patch: {
      id: "jobs.update",
      fields: "JOB_PATCH",
      summary: "Move a job's state or edit its config — and a cancelled job says where it stopped.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          status: { type: "string", description: "A job status — a name outside the set is refused." },
          config: { type: "object", description: "A new configuration." },
        },
      },
      responses: { "200": "The job as it now reads." },
    },
    post: {
      id: "jobs.lifecycle",
      summary: "Act on a job — ?action=retry a FAILED one, or ?action=cancel one still queued.",
      auth: "key",
      query: [["action", "retry — queue it again; cancel — stop it where it stands."]],
      responses: { "201": "The job the action produced.", "409": "The action is for a state this job is not in." },
    },
    delete: {
      id: "jobs.delete",
      summary: "Forget a job.",
      auth: "key",
      responses: { "200": "The job is gone." },
    },
  },
  "/api/enrichment-rules": {
    get: {
      id: "rules.list",
      summary: "The workspace's enrichment rules.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["isActive", "Only the ones running (1) or paused (0)."],
        ["page", "1-based page number."],
        ["limit", "Page size."],
      ],
      responses: { "200": "The rules, with a total." },
    },
    post: {
      id: "rules.create",
      fields: "RULE_CREATE",
      summary: "Write an enrichment rule — what fires it, what conditions it needs, which providers it calls.",
      auth: "key",
      body: {
        description: "The rule's trigger, conditions, actions and providers.",
        properties: {
          name: { type: "string", description: "What the rule is called.", required: true },
          description: { type: "string", description: "What it is for." },
          trigger: { type: "string", description: "One of the rule triggers.", required: true },
          conditions: { type: "object", description: "What the lead must look like.", required: true },
          actions: { type: "object", description: "What the rules do to it.", required: true },
          providers: { type: "array", description: "At least one provider name.", required: true },
          priority: { type: "number", description: "The ranking; the range the borders quote." },
          isActive: { type: "boolean", description: "Whether it fires." },
        },
      },
      responses: { "201": "The rule." },
    },
  },
  "/api/enrichment-rules/{id}": {
    get: {
      id: "rules.get",
      summary: "One rule.",
      auth: "key",
      responses: { "200": "The rule." },
    },
    patch: {
      id: "rules.update",
      fields: "RULE_PATCH",
      summary: "Edit a rule.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          description: { type: "string", description: "What it is for." },
          trigger: { type: "string", description: "A new trigger." },
          conditions: { type: "object", description: "New conditions." },
          actions: { type: "object", description: "New actions." },
          providers: { type: "array", description: "New providers." },
          priority: { type: "number", description: "A new ranking." },
          isActive: { type: "boolean", description: "Whether it fires." },
        },
      },
      responses: { "200": "The rule as it now reads." },
    },
    post: {
      id: "rules.run",
      summary: "Run this rule now — ?action=run queues its job.",
      auth: "key",
      query: [["action", "run — the only action."]],
      responses: { "201": "The job, queued." },
    },
    delete: {
      id: "rules.delete",
      summary: "Delete a rule.",
      auth: "key",
      responses: { "200": "The rule is gone." },
    },
  },
  "/api/exports": {
    get: {
      id: "exports.list",
      summary: "The workspace's exports.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["profileId", "Only one profile's exports."],
        ["status", "One export status."],
        ["page", "1-based page number."],
        ["limit", "Page size."],
      ],
      responses: { "200": "The exports, with a total." },
    },
    post: {
      id: "exports.create",
      fields: "EXPORT_CREATE",
      summary: "Queue an export — the format, the fields it renders, and the filter it reads.",
      auth: "key",
      body: {
        description: "The format, the columns, and the filter.",
        properties: {
          format: { type: "string", description: "One of the export formats — upper-cased at the door, because the exporter switches on the exact word.", required: true },
          fields: { type: "array", description: "Lead's columns the file renders — a name that is not a column renders empty.", required: true },
          filterJson: { type: "object", description: "Which leads." },
          profileId: { type: "string", description: "A saved export profile, if you keep one." },
        },
      },
      responses: { "201": "The export job." },
    },
  },
  "/api/exports/{id}": {
    get: {
      id: "exports.get",
      summary: "One export — its state, and where the file stands.",
      auth: "key",
      responses: { "200": "The export." },
    },
    post: {
      id: "exports.retry",
      summary: "Retry this export — ?action=retry.",
      auth: "key",
      query: [["action", "retry — the only action."]],
      responses: { "201": "The new export attempt.", "409": "This export has nothing to retry." },
    },
    delete: {
      id: "exports.delete",
      summary: "Delete an export — its file goes with it.",
      auth: "key",
      responses: { "200": "The export is gone." },
    },
  },
  "/api/exports/{id}/download": {
    get: {
      id: "exports.download",
      summary: "Download an export's file, while retention keeps it.",
      auth: "key",
      responses: { "200": "The file.", "410": "The file's retention has passed." },
    },
  },
  "/api/webhooks": {
    get: {
      id: "webhooks.list",
      summary: "The outbound subscriptions, with their signing secret previewed.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The subscriptions." },
    },
    post: {
      id: "webhooks.create",
      fields: "WEBHOOK_CREATE",
      summary: "Subscribe an address to events — each delivery is signed.",
      auth: "key",
      body: {
        description: "Where to deliver, and which events.",
        properties: {
          url: { type: "string", description: "Where the deliveries go.", required: true },
          events: { type: "array", description: "The event names — an array or a comma string." },
        },
      },
      responses: { "201": "The subscription, with the signing secret returned once." },
    },
  },
  "/api/webhooks/{id}": {
    get: {
      id: "webhooks.get",
      summary: "One subscription.",
      auth: "key",
      responses: { "200": "The subscription." },
    },
    patch: {
      id: "webhooks.update",
      fields: "WEBHOOK_PATCH",
      summary: "Edit a subscription's address or state.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          url: { type: "string", description: "A new address." },
          isActive: { type: "boolean", description: "Whether it still delivers." },
          events: { type: "array", description: "A new set of event names." },
        },
      },
      responses: { "200": "The subscription as it now reads." },
    },
    delete: {
      id: "webhooks.delete",
      summary: "Unsubscribe.",
      auth: "key",
      responses: { "200": "The subscription is gone." },
    },
  },
  "/api/ai/explain-lead": {
    get: {
      id: "ai.explainLead",
      summary: "Why this lead scores what it scores, said in words.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["id", "The lead to explain."],
        ["model", "The model to write the explanation with."],
      ],
      responses: { "200": "The explanation, or why there is none." },
    },
  },
  "/api/billing/checkout": {
    post: {
      id: "billing.checkout",
      summary: "Start a subscription.",
      auth: "session",
      body: {
        description: "The plan to buy.",
        properties: {
          plan: { type: "string", description: "monthly or annual." },
        },
      },
      responses: { "200": "The checkout URL." },
    },
  },
  "/api/billing/portal": {
    post: {
      id: "billing.portal",
      summary: "Open the billing portal — where a plan is changed or cancelled.",
      auth: "session",
      responses: { "200": "The portal URL." },
    },
  },
  "/api/billing/webhook": {
    post: {
      id: "billing.webhook",
      summary: "Stripe's own callback. Signed, not called with a key.",
      auth: "stripe",
      responses: { "200": "The event was recorded." },
    },
  },
};

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "LeadWorks API",
    version: VERSION,
    description:
      "Lead operations in one pipeline: capture every lead once, score and enrich it, run sources and jobs on schedule, and take the whole thing out as CRM-ready CSV exports.",
    contact: { name: "Abetworks", email: "support@abetworks.in" },
    license: { name: "Proprietary" },
  },
  servers: [{ url: "https://leadworks.abetworks.in" }],
  paths: Object.fromEntries(
    Object.entries(PATHS).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item)
          .filter(([method]) => ["get", "post", "patch", "put", "delete"].includes(method))
          .map(([method, operation]) => [method, op(method as Method, operation as Operation)]),
      ),
    ]),
  ),
  components: {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "A workspace API key, as 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "abetworks_session",
        description: "The signed-in browser session — for the billing routes.",
      },
    },
  },
};

/** The operations, flattened: what the contract check reasons about. */
export const openapiOperations: { path: string; method: Method; operation: Operation }[] =
  Object.entries(PATHS).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      path,
      method: method as Method,
      operation: operation as Operation,
    })),
  );
