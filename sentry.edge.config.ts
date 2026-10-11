/**
 * Sentry configuration for LeadWorks - Edge Middleware
 */
import * as Sentry from "@sentry/nextjs";

const SENTRY_DSN = process.env.SENTRY_DSN;

Sentry.init({
  dsn: SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.01 : 1.0,
  environment: process.env.NODE_ENV || "development",
  enabled: process.env.SENTRY_ENABLED === "true" || process.env.NODE_ENV === "production",
  ignoreErrors: [
    "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EADDRINUSE",
  ],
  initialScope: {
    tags: {
      product: "leadworks",
      component: "nextjs-edge",
    },
  },
});
