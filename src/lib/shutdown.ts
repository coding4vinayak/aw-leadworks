import { shutdownWorkers } from "./queue";

/**
 * Hard ceiling on the drain. Past it the process leaves non-zero rather than sitting
 * on a Worker that will not finish, because a container runtime that sends SIGTERM and
 * then SIGKILL 10s later treats a hung shutdown as a crash loop instead of a slow one.
 */
export const SHUTDOWN_DEADLINE_MS = 15_000;

let installed = false;

/**
 * The only caller `shutdownWorkers()` can have.
 *
 * Next 16.2.12 gives an app no shutdown hook to register: its `InstrumentationModule`
 * type is exactly `{ register?(): void; onRequestError?: InstrumentationOnRequestError }`
 * — read from `node_modules/next/dist/server/instrumentation/types.d.ts` in this app's
 * own install. `register()` is the only entry point the framework hands over, so the
 * signal handlers are the wiring: registered by the app, not awaited by the framework.
 *
 * A handler that exits without draining is the same as no handler: the queue teardown
 * is the reason to have one, so the exit happens *after* `shutdownWorkers()` settles,
 * with the deadline above as the bound. A second signal stops the wait — at that point
 * something is insisting, and the jobs it is cutting short were never going to finish
 * inside the window the runtime gives us anyway.
 *
 * Idempotent: `installed` guards re-entry, which matters because `register()` runs
 * once per server process but a test can call this directly.
 */
export function installShutdownHandlers() {
  if (installed) return;
  installed = true;

  let stopping = false;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) {
        console.error(`[shutdown] already draining; ${signal} exits now`);
        process.exit(1);
      }
      stopping = true;
      console.log(`[shutdown] ${signal}: draining workers`);

      const deadline = setTimeout(() => {
        console.error(`[shutdown] not drained in ${SHUTDOWN_DEADLINE_MS}ms; leaving non-zero`);
        process.exit(1);
      }, SHUTDOWN_DEADLINE_MS);

      shutdownWorkers()
        .catch((error) => {
          console.error("[shutdown] worker teardown failed:", error);
          process.exitCode = 1;
        })
        .finally(() => {
          clearTimeout(deadline);
          process.exit(process.exitCode ?? 0);
        });
    });
  }
}
