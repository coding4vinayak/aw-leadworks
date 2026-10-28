/**
 * Which columns a unique index refuses on, read out of the error Prisma raises.
 *
 * `conflictFor` in `apikeys.ts` turns a unique violation into a 409 that names
 * what collided. It read the fields from `error.meta.target`, which is where
 * Prisma 5 and 6 put them. Prisma 7 with the pg driver adapter puts them
 * nowhere: measured on a live instance (aw-leadworks, `leadworks_r67`), the
 * whole meta for a duplicate lead is
 *
 *   {"driverAdapterError":{"name":"DriverAdapterError","cause":
 *     {"originalCode":"23505",
 *      "originalMessage":"duplicate key value violates unique constraint \"Lead_workspaceId_email_key\"",
 *      "kind":"UniqueConstraintViolation","constraint":{"index":"Lead_workspaceId_email_key"},
 *      "table":"Lead"}},"modelName":"Lead","target":[]}
 *
 * — `target` is there, and it is empty. It is the only field `conflictFor`
 * reads, so every door that collided answered
 * `{"error":"That Lead already exists in this workspace.","conflict":{"fields":[]}}`:
 * a caller was told a row already existed and never told which of its own
 * fields made it exist.
 *
 * The index name is the answer, and Prisma names unique indexes
 * `<table>_<column>[_<column>]_key` from the schema (`Workspace_slug_key`,
 * `Lead_workspaceId_email_key`, `LeadListMember_listId_leadId_key` — all three
 * read out of `pg_indexes` on that instance). Splitting that name needs the
 * table name, which the same meta carries as `modelName`, and it needs
 * underscores to mean one thing. They do here: `grep -c "@map\|@@map"
 * prisma/schema.prisma` is `0`, so a table is its model's name and a column is
 * its field's name, and every unique column in this schema is spelled in
 * camelCase. `tests/unit/unique-index.test.ts` pins that against the schema
 * text itself, so a future `@map` or an underscore in a unique column name
 * fails a test rather than quietly mis-naming a caller's field.
 *
 * When the name does not fit that shape — a constraint someone renamed with
 * `map:`, or an index this schema does not declare — this module says nothing,
 * and `conflictFor` keeps the sentence it has always kept for an unnamed
 * collision. A wrong field is worse than no field: a caller that reads
 * `conflict.fields` to mark the right input box red marks the wrong one red
 * instead.
 */

/** The columns behind a Postgres constraint name, in the order the index holds them. */
export function uniqueIndexColumns(indexName: string, table: string): string[] | null {
  if (!indexName.endsWith("_key")) return null;
  const prefix = table + "_";
  if (!indexName.startsWith(prefix)) return null;
  const columns = indexName.slice(prefix.length, -"_key".length).split("_");
  if (columns.some((column) => column.length === 0)) return null;
  return columns;
}

/** The shape Prisma 7's driver adapter leaves behind: `{ modelName, driverAdapterError }`. */
function indexFromDriverAdapter(meta: Record<string, unknown>): { index: string; table: string } | null {
  const adapter = meta.driverAdapterError;
  if (!adapter || typeof adapter !== "object") return null;
  const cause = (adapter as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return null;
  const shaped = cause as { kind?: unknown; constraint?: unknown; table?: unknown };
  if (shaped.kind !== "UniqueConstraintViolation") return null;
  const index = (shaped.constraint as { index?: unknown } | undefined)?.index;
  if (typeof index !== "string" || typeof shaped.table !== "string") return null;
  return { index, table: shaped.table };
}

/**
 * The columns a unique violation refused, from the error a door was handed.
 *
 * `meta.target` first, because that is what Prisma 5 and 6 gave and what the
 * existing pins were written against; the driver adapter's constraint name
 * second, because that is all Prisma 7 gives. `[]` means this error names
 * nothing the caller can act on — the door's own fallback sentence, unchanged.
 */
export function uniqueViolationColumns(error: unknown): { model: string; columns: string[] } | null {
  if (!(error instanceof Error)) return null;
  const meta = (error as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return null;
  const shaped = meta as Record<string, unknown>;
  const model = typeof shaped.modelName === "string" ? shaped.modelName : null;

  const target = shaped.target;
  const fromTarget = Array.isArray(target)
    ? target.filter((field): field is string => typeof field === "string" && field.length > 0)
    : typeof target === "string"
      ? target.split(/[\s,]+/).filter((field) => field.length > 0)
      : [];
  if (fromTarget.length > 0 && model) return { model, columns: fromTarget };

  const found = indexFromDriverAdapter(shaped);
  if (!found) return null;
  const columns = uniqueIndexColumns(found.index, found.table);
  if (!columns || columns.length === 0) return null;
  return { model: model ?? found.table, columns };
}
