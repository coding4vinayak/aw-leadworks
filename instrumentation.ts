/**
 * LeadWorks instrumentation - runs once per server boot
 */
import * as Sentry from "@sentry/nextjs";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.addEventProcessor((event) => {
      if (event.tags) {
        event.tags.product = "leadworks";
      } else {
        event.tags = { product: "leadworks" };
      }
      return event;
    });

    // Dynamic import to avoid bundling playwright in edge runtime
    import("@/lib/queue").then(({ startWorkers }) => {
      startWorkers()
        .then(() => console.log("[LeadWorks] BullMQ workers started"))
        .catch((error) => console.error("[LeadWorks] workers failed to start:", error));
    }).catch((error) => {
      console.error("[LeadWorks] failed to load queue module:", error);
    });

    // Nothing in Next 16.2.12 calls a shutdown hook (see src/lib/shutdown.ts), so the
    // workers are drained from a signal handler the app installs. Only in production:
    // `next dev` owns SIGINT/SIGTERM in development and restarts the server itself,
    // and an app that exits on the first signal in dev would be quitting during hot
    // reload rather than being reloaded.
    if (process.env.NODE_ENV === "production") {
      import("@/lib/shutdown").then(({ installShutdownHandlers }) => {
        installShutdownHandlers();
      }).catch((error) => {
        console.error("[LeadWorks] failed to install shutdown handlers:", error);
      });
    }

    console.log("[Sentry] LeadWorks server instrumentation registered");
  }
}