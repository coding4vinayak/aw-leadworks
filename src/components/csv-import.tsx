"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { importCsvAction, type ImportState } from "@/app/import-actions";
import { MAX_IMPORT_ROWS } from "@/lib/import-limits";
import { problemsToCsv } from "@/lib/import-problems";
import type { ImportProblem } from "@/lib/csv-parse";

const INITIAL: ImportState = null;

function downloadProblems(problems: ImportProblem[]) {
  const blob = new Blob([problemsToCsv(problems)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "import-problems.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Importing…" : "Import CSV"}
    </button>
  );
}

/**
 * The missing half of "CSV uploads": a buyer's first useful action is usually
 * their existing list, not a scraper they have to configure.
 *
 * The server action, not an API call, so the browser never needs a key and the
 * workspace comes from the session.
 */
export function CsvImport() {
  const [state, action] = useActionState(importCsvAction, INITIAL);

  return (
    <form action={action} className="rounded-2xl bg-white p-6 shadow-sm">
      <h2 className="text-lg font-bold text-gray-900">Import your list</h2>
      <p className="mt-1 text-sm text-gray-500">
        A CSV with a header row. Email, phone or LinkedIn is enough to create a lead; extra columns
        are ignored, aliases like &ldquo;Company Name&rdquo; and &ldquo;E-mail&rdquo; are understood,
        and duplicates are skipped. Up to {MAX_IMPORT_ROWS.toLocaleString("en-US")} rows per file.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border-0 file:bg-orange-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-orange-700 hover:file:bg-orange-100"
        />
        <SubmitButton />
      </div>
      {state ? (
        <div
          className={`mt-4 rounded-lg px-4 py-3 text-sm ${
            state.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
          }`}
        >
          <p>{state.message}</p>
          {state.ok && state.problems.length > 0 ? (
            <div className="mt-2">
              <ul className="list-disc space-y-1 pl-5 text-xs">
                {state.problems.slice(0, 5).map((p) => (
                  <li key={`${p.line}-${p.field}-${p.message}`}>
                    Line {p.line}: {p.field} — {p.message}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {state.problems.length > 5 ? (
                  <span className="text-green-800">
                    Showing 5 of {state.problems.length}
                    {state.problemsTruncated ? "+" : ""} issues.
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => downloadProblems(state.problems)}
                  className="font-semibold text-green-900 underline underline-offset-2 hover:text-green-950"
                >
                  Download problems (CSV)
                </button>
              </div>
              {state.problemsTruncated ? (
                <p className="mt-1 text-xs text-green-800">
                  The report carries the first 50 issues; fix those and run the file again.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
