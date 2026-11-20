import { Hono } from "hono";
import type { AppEnv } from "../types";
import { Badge } from "../views/components";
import { ago, getSetting, recordRun } from "../util";
import { stripeConfigured, syncStripe } from "../integrations/stripe";
import { clickUpConfigured, registerClickUpWebhook, syncClickUp } from "../integrations/clickup";
import { notifySlack, slackAuthTest, slackConfigured } from "../integrations/slack";
import { emailConfigured, sendEmail } from "../integrations/email";
import { runDailyDigest } from "../jobs";
import { backWith, page } from "./page";

export const connections = new Hono<AppEnv>();

connections.get("/", async (c) => {
  const env = c.env;
  const lastRun = async (source: string) =>
    env.DB.prepare("SELECT * FROM sync_runs WHERE source = ? ORDER BY started_at DESC LIMIT 1").bind(source).first<any>();
  const [stripeRun, clickupRun, cuHook, slack] = await Promise.all([
    lastRun("stripe"),
    lastRun("clickup"),
    getSetting(env, "clickup_webhook_id"),
    slackConfigured(env) ? slackAuthTest(env).catch((e) => ({ ok: false, error: String(e) })) : Promise.resolve(null),
  ]);

  const RunInfo = ({ run }: { run: any }) =>
    !run ? <span class="muted">Not synced yet</span> : (
      <span>
        <Badge tone={run.ok === 1 ? "green" : run.ok === 0 ? "red" : "amber"}>{run.ok === 1 ? "OK" : run.ok === 0 ? "Failed" : "Running"}</Badge>{" "}
        <span class="muted small">{ago(run.started_at)}</span>
        {run.summary ? <div class="small muted" style="margin-top:4px;word-break:break-word">{run.summary}</div> : null}
      </span>
    );
  const Ready = ({ ok }: { ok: boolean }) => <Badge tone={ok ? "green" : "red"}>{ok ? "Connected" : "Not set up"}</Badge>;

  return page(
    c,
    "Connections",
    <>
      <h1>Connections</h1>
      <div class="card">
        <table>
          <thead><tr><th style="width:18%">Service</th><th style="width:14%">Status</th><th>Last sync / details</th><th style="width:30%">Actions</th></tr></thead>
          <tbody>
            <tr>
              <td><b>Stripe</b><div class="small muted">Customers, invoices, subscriptions</div></td>
              <td><Ready ok={stripeConfigured(env)} /></td>
              <td>
                <RunInfo run={stripeRun} />
                <div class="small muted">Webhook URL: <code>{env.APP_URL}/webhooks/stripe</code> {env.STRIPE_WEBHOOK_SECRET ? "✓ secret set" : "— add STRIPE_WEBHOOK_SECRET"}</div>
              </td>
              <td>{stripeConfigured(env) ? <form method="post" action="/connections/sync/stripe" class="inline"><button class="btn ghost">Sync now</button></form> : <span class="muted small">Add STRIPE_SECRET_KEY</span>}</td>
            </tr>
            <tr>
              <td><b>ClickUp</b><div class="small muted">Tasks → projects</div></td>
              <td><Ready ok={clickUpConfigured(env)} /></td>
              <td>
                <RunInfo run={clickupRun} />
                <div class="small muted">Webhook: {cuHook || env.CLICKUP_WEBHOOK_SECRET ? "✓ registered" : "not registered (instant updates off)"}</div>
              </td>
              <td>
                {clickUpConfigured(env) ? (
                  <>
                    <form method="post" action="/connections/sync/clickup" class="inline"><button class="btn ghost">Sync now</button></form>{" "}
                    <form method="post" action="/connections/clickup/webhook" class="inline"><button class="btn ghost">{cuHook ? "Re-register webhook" : "Register webhook"}</button></form>
                  </>
                ) : <span class="muted small">Add CLICKUP_API_TOKEN and CLICKUP_TEAM_ID</span>}
              </td>
            </tr>
            <tr>
              <td><b>Slack</b><div class="small muted">Alerts &amp; daily summary</div></td>
              <td><Ready ok={Boolean(slack?.ok)} /></td>
              <td>{slack ? (slack.ok ? <span class="small">Workspace: {(slack as any).team} · channel {env.SLACK_CHANNEL_ID}</span> : <span class="small" style="color:var(--red)">{(slack as any).error}</span>) : <span class="muted small">Add SLACK_BOT_TOKEN and SLACK_CHANNEL_ID</span>}</td>
              <td>{slackConfigured(env) ? <form method="post" action="/connections/test/slack" class="inline"><button class="btn ghost">Send test message</button></form> : null}</td>
            </tr>
            <tr>
              <td><b>Email</b><div class="small muted">Resend · daily summary</div></td>
              <td><Ready ok={emailConfigured(env)} /></td>
              <td class="small">From <code>{env.EMAIL_FROM}</code> to <code>{env.DIGEST_EMAILS}</code></td>
              <td>{emailConfigured(env) ? <form method="post" action="/connections/test/email" class="inline"><button class="btn ghost">Send test email</button></form> : <span class="muted small">Add RESEND_API_KEY</span>}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h2>Daily summary</h2>
        <p class="muted">Sent to Slack and email every morning at 7:00am Brisbane time. Syncs run every 15 minutes.</p>
        <form method="post" action="/connections/digest" class="inline"><button class="btn">Send summary now</button></form>
      </div>
    </>,
  );
});

connections.post("/sync/stripe", async (c) => {
  try {
    const r = await recordRun(c.env, "stripe", () => syncStripe(c.env));
    return backWith(c, "/connections", { ok: `Stripe synced: ${r.customers} customers, ${r.invoices} invoices, ${r.subscriptions} subscriptions.` });
  } catch (err) {
    return backWith(c, "/connections", { err: `Stripe sync failed: ${(err as Error).message}` });
  }
});

connections.post("/sync/clickup", async (c) => {
  try {
    const r = await recordRun(c.env, "clickup", () => syncClickUp(c.env));
    return backWith(c, "/connections", { ok: `ClickUp synced: ${r.tasks} tasks updated.` });
  } catch (err) {
    return backWith(c, "/connections", { err: `ClickUp sync failed: ${(err as Error).message}` });
  }
});

connections.post("/clickup/webhook", async (c) => {
  try {
    await registerClickUpWebhook(c.env);
    return backWith(c, "/connections", { ok: "ClickUp webhook registered. Task changes now arrive instantly." });
  } catch (err) {
    return backWith(c, "/connections", { err: `Couldn't register webhook: ${(err as Error).message}` });
  }
});

connections.post("/test/slack", async (c) => {
  const ok = await notifySlack(c.env, `👋 Test from ${c.env.APP_NAME} (sent by ${c.get("user")})`, { link: c.env.APP_URL });
  return backWith(c, "/connections", ok ? { ok: "Slack test sent." } : { err: "Slack test failed — check the bot is invited to the channel." });
});

connections.post("/test/email", async (c) => {
  const ok = await sendEmail(c.env, {
    to: c.get("user"),
    subject: `${c.env.APP_NAME} test email`,
    html: `<p>Email is working for ${c.env.APP_NAME}.</p>`,
  });
  return backWith(c, "/connections", ok ? { ok: `Test email sent to ${c.get("user")}.` } : { err: "Email test failed — check RESEND_API_KEY and that your sending domain is verified in Resend." });
});

connections.post("/digest", async (c) => {
  await runDailyDigest(c.env);
  return backWith(c, "/connections", { ok: "Daily summary sent." });
});
