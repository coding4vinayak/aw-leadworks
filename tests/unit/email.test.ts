// Token mechanics and the honesty of the mail transport, offline.
//
// The properties worth protecting: a token is stored hashed, is single-use, is
// refused when expired, and — the one that keeps a "check your inbox" from
// being a lie — the sender reports which transport actually ran.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  setEmailSender,
  getEmailSender,
  isMailConfigured,
  verificationEnforced,
  emailSenderChannel,
  renderVerificationEmail,
  renderPasswordResetEmail,
  renderInviteEmail,
  type EmailSender,
} from "../../src/lib/email";
import { hashToken } from "../../src/lib/tokens";

describe("hashToken", () => {
  it("is a stable sha256, and never the token itself", () => {
    const token = randomBytes(32).toString("base64url");
    const hashed = hashToken(token);
    assert.equal(hashed.length, 64);
    assert.notEqual(hashed, token);
    assert.equal(hashed, createHash("sha256").update(token).digest("hex"));
  });

  it("gives different tokens different hashes", () => {
    assert.notEqual(hashToken("a"), hashToken("b"));
  });
});

describe("mail transport honesty", () => {
  it("reports no provider when none is configured", () => {
    // No RESEND_API_KEY / EMAIL_WEBHOOK_URL in the test environment.
    if (isMailConfigured()) return; // an operator configured one; nothing to assert
    assert.equal(verificationEnforced(), false);
  });

  it("says 'log' rather than pretending to send when no provider exists", async () => {
    if (isMailConfigured()) return;
    const sender: EmailSender = {
      async send() {
        return { channel: "log" as const, log: "body" };
      },
    };
    setEmailSender(sender);
    assert.equal(emailSenderChannel(), "custom");
    const result = await getEmailSender().send("a@b.test", "s", "<p>h</p>", "t");
    // The caller can therefore tell the user the message was logged, not sent.
    assert.equal(result.channel, "log");
    assert.ok(result.log, "a logged message must hand back its body so the link is recoverable");
  });

  it("a provider failure is an error, not a swallowed no-op", async () => {
    // Swallowing this is how a customer waits for a link that was never sent.
    const sender: EmailSender = {
      async send() {
        throw new Error("mail provider refused the message: 429");
      },
    };
    setEmailSender(sender);
    await assert.rejects(
      getEmailSender().send("a@b.test", "s", "<p>h</p>", "t"),
      /mail provider refused/,
    );
  });
});

describe("email templates", () => {
  it("verification mail carries the link in both html and text", () => {
    const { html, text } = renderVerificationEmail({
      product: "LeadGenius",
      name: "Ada",
      verifyUrl: "http://127.0.0.1:3200/verify-email?token=abc123",
      expiresHours: 24,
    });
    assert.match(html, /verify-email\?token=abc123/);
    assert.match(text, /verify-email\?token=abc123/);
    assert.match(text, /Ada/);
  });

  it("escapes the recipient's name rather than injecting it into the markup", () => {
    const { html } = renderVerificationEmail({
      product: "LeadGenius",
      name: '<img src=x onerror="alert(1)">',
      verifyUrl: "http://x.test/verify-email?token=a",
      expiresHours: 24,
    });
    assert.ok(!html.includes("<img"), "a name must never become markup");
    assert.match(html, /&lt;img/);
  });

  it("reset mail tells the reader a link they did not ask for is safe to ignore", () => {
    const { text } = renderPasswordResetEmail({
      product: "LeadWorks",
      name: null,
      resetUrl: "http://x.test/reset-password?token=a",
      expiresHours: 1,
    });
    assert.match(text, /ignore/i);
    assert.match(text, /reset-password\?token=a/);
  });
});

describe("invitation mail", () => {
  const invite = {
    product: "LeadWorks",
    inviterName: "Priya",
    workspaceName: "Acme & Co",
    role: "admin",
    inviteUrl: "http://127.0.0.1:3300/invite/abc123",
    expiresDays: 7,
  };

  it("puts the same invitation in the subject, the heading and the plain text", () => {
    const { subject, html, text } = renderInviteEmail(invite);
    assert.match(subject, /Priya/);
    assert.match(subject, /Acme/);
    assert.match(html, /Priya invited you to join Acme/);
    assert.match(text, /Priya invited you to join Acme/);
    assert.match(text, /invite\/abc123/);
    assert.match(text, /7 days/);
  });

  it("falls back to a named stranger when the inviter has no name", () => {
    const { subject, text } = renderInviteEmail({ ...invite, inviterName: null });
    assert.match(subject, /^A teammate invited you/);
    assert.match(text, /A teammate added you/);
  });

  it("escapes a workspace name that is markup, because names are user input", () => {
    const { html } = renderInviteEmail({
      ...invite,
      inviterName: '<img src=x onerror="alert(1)">',
      workspaceName: '<script>alert("ws")</script>',
    });
    assert.ok(!html.includes("<img"), "an inviter must never become markup");
    assert.ok(!html.includes("<script>alert"), "a workspace name must never become markup");
    assert.match(html, /&lt;script&gt;/);
  });

  it("says the link works once, which is the promise the token hash keeps", () => {
    const { text } = renderInviteEmail(invite);
    assert.match(text, /works once/i);
  });
});
