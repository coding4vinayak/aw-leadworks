import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "prisma", "@prisma/adapter-pg", "pg", "bullmq", "ioredis", "cheerio"],
  transpilePackages: ["playwright"],
  experimental: {
    serverActions: {
      // The dashboard's CSV card caps at `MAX_IMPORT_BYTES` (5 MB). The
      // framework default is 1 MB, which would reject a legal import with a
      // generic action error before the server action ever saw the file.
      bodySizeLimit: "5mb",
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
    ];
  },
};

const sentryConfig = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.SENTRY_AUTH_TOKEN,
  hideSourceMaps: true,
  widenClientFileUpload: true,
  disableLogger: true,
};

export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, sentryConfig)
  : nextConfig;