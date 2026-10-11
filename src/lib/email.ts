/**
 * Outbound email.
 *
 * The rule this file exists to enforce: **the caller is always told which
 * transport actually ran.** `send` returns the channel it used, so a route can
 * distinguish "we emailed you" from "this deployment has no mail provider, so
 * the link was written to the server log instead". A `send` that quietly logged
 * to stdout while the API answered "check your inbox" is the failure mode this
 * replaces — it looks like the feature works right up until a customer waits
 * for a link that was never coming.
 *
 * The HTTP sender is deliberately dependency-free (`fetch` only) so the same
 * file can be vendored into six apps that do not share a node_modules. An owner
 * who prefers SMTP or SES calls `setEmailSender` with their own implementation;
 * no route changes.
 */

export type DeliveryChannel = "http" | "log" | "custom";

export interface EmailResult {
  channel: DeliveryChannel;
  /** Present only for "log": the full message, so a local run can copy the link. */
  log?: string;
}

export interface EmailSender {
  send(to: string, subject: string, html: string, text: string): Promise<EmailResult>;
}

/**
 * True when a real provider is configured. Callers use this to decide whether
 * verification is enforced at sign-in — see `verificationEnforced`.
 */
export function isMailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.EMAIL_WEBHOOK_URL);
}

/**
 * Verification is only enforced when a message can actually arrive.
 *
 * Enforcing it without a provider would lock every new account out of its own
 * product on a deployment that was never configured for email, which is a far
 * worse failure than a typo'd signup address staying unverified. So the gate
 * follows the transport: configured, an unverified address cannot sign in; not
 * configured, it can, and the dashboard says so.
 */
export function verificationEnforced(): boolean {
  return isMailConfigured();
}

/** Write the message to the server log, and say so. Never a silent no-op. */
function createLogEmailSender(): EmailSender {
  return {
    async send(to, subject, _html, text): Promise<EmailResult> {
      const line = "=".repeat(72);
      const body = [
        "",
        line,
        `EMAIL (not delivered — no mail provider configured) to: ${to}`,
        `Subject: ${subject}`,
        line,
        text,
        line,
        "",
      ].join("\n");
      console.log(body);
      return { channel: "log", log: text };
    },
  };
}

/**
 * Generic HTTP sender. Works with Resend and anything that takes the same
 * `{from, to, subject, html, text}` JSON, so switching provider is an env
 * change rather than a code change.
 */
function createHttpEmailSender(): EmailSender {
  const apiKey = process.env.RESEND_API_KEY;
  const endpoint = process.env.EMAIL_WEBHOOK_URL ?? "https://api.resend.com/emails";
  const from = process.env.EMAIL_FROM ?? "Abetworks <noreply@abetworks.in>";

  return {
    async send(to, subject, html, text): Promise<EmailResult> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey && endpoint.includes("resend.com")) headers.authorization = `Bearer ${apiKey}`;
      if (process.env.EMAIL_WEBHOOK_TOKEN) headers.authorization = `Bearer ${process.env.EMAIL_WEBHOOK_TOKEN}`;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          signal: ctrl.signal,
          headers,
          body: JSON.stringify({ from, to: [to], subject, html, text }),
        });
        if (!res.ok) {
          // Reported as a failure rather than swallowed: a provider rejecting
          // mail is an operational problem, and pretending otherwise means a
          // customer never gets the link and nobody is paged.
          throw new Error(`mail provider refused the message: ${res.status}`);
        }
        return { channel: "http" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

let _sender: EmailSender | null = null;

export function setEmailSender(sender: EmailSender): void {
  _sender = sender;
}

export function getEmailSender(): EmailSender {
  if (!_sender) _sender = isMailConfigured() ? createHttpEmailSender() : createLogEmailSender();
  return _sender;
}

export function emailSenderChannel(): DeliveryChannel {
  if (_sender) return "custom";
  return isMailConfigured() ? "http" : "log";
}

// ---------------------------------------------------------------- templates

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(product: string, heading: string, body: string, ctaLabel: string, url: string): { html: string; text: string } {
  const text = [
    heading,
    "",
    body,
    "",
    `${ctaLabel}: ${url}`,
    "",
    "If you did not ask for this, you can ignore this message and nothing changes.",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f9fafb;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px">
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px">
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af">Abetworks</p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(product)}</h1>
      <h2 style="margin:0 0 12px;font-size:17px">${escapeHtml(heading)}</h2>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563">${escapeHtml(body)}</p>
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600">${escapeHtml(ctaLabel)}</a>
      <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#6b7280;word-break:break-all">Or paste this into your browser:<br>${escapeHtml(url)}</p>
      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af">If you did not ask for this, ignore this message and nothing changes.</p>
    </div>
  </div>
</body></html>`;

  return { html, text };
}

export function renderVerificationEmail(data: {
  product: string;
  name: string | null;
  verifyUrl: string;
  expiresHours: number;
}): { html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  return layout(
    data.product,
    "Confirm your email address",
    `${greeting} confirm this address to finish setting up your workspace. The link works once and expires in ${data.expiresHours} hours.`,
    "Verify email",
    data.verifyUrl,
  );
}

/**
 * The invite carries its own subject, because the sentence in the subject and
 * the sentence in the heading must not be maintained twice — a caller that
 * builds `inviter?.name ?? "A teammate"` separately will drift.
 */
export function renderInviteEmail(data: {
  product: string;
  inviterName: string | null;
  workspaceName: string;
  role: string;
  inviteUrl: string;
  expiresDays: number;
}): { subject: string; html: string; text: string } {
  const who = data.inviterName?.trim() || "A teammate";
  return {
    subject: `${who} invited you to ${data.workspaceName}`,
    ...layout(
      data.product,
      `${who} invited you to join ${data.workspaceName}`,
      `${who} added you to the ${data.workspaceName} workspace as ${data.role}. Use the link to set up your account — it works once and expires in ${data.expiresDays} days. If you were not expecting this, ignore it and nothing changes.`,
      "Accept invitation",
      data.inviteUrl,
    ),
  };
}
export function renderPasswordResetEmail(data: {
  product: string;
  name: string | null;
  resetUrl: string;
  expiresHours: number;
}): { html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  return layout(
    data.product,
    "Reset your password",
    `${greeting} use the link below to choose a new password. It works once and expires in ${data.expiresHours} hours. If you did not ask to reset your password, ignore this and your current password still works.`,
    "Choose a new password",
    data.resetUrl,
  );
}
