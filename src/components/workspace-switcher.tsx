"use client";

/**
 * The workspace switcher.
 *
 * A client component because changing workspaces is interactive — and it has to
 * be, because this lives in the dashboard shell, which is a server component.
 * An `onChange` handler written inline in the shell fails the whole page at
 * build/render time ("Event handlers cannot be passed to Client Component
 * props"), which is exactly what happened the first time: the dashboard 500'd
 * for every account holding two workspaces, while single-workspace accounts
 * never rendered the select and never noticed.
 */
export function WorkspaceSwitcher({
  workspaces,
  currentWorkspaceId,
  switchWorkspace,
}: {
  workspaces: { id: string; name: string; slug: string }[];
  currentWorkspaceId: string;
  switchWorkspace: (formData: FormData) => Promise<void>;
}) {
  if (workspaces.length < 2) return null;

  return (
    <form action={switchWorkspace}>
      <select
        name="workspaceId"
        defaultValue={currentWorkspaceId}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        aria-label="Switch workspace"
        className="max-w-[18ch] rounded-md border border-gray-200 bg-white px-1.5 py-1 text-[12px] text-gray-600"
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </form>
  );
}
