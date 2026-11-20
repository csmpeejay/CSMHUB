import type { Env } from "./types";
import { stripeConfigured, syncStripe } from "./integrations/stripe";
import { clickUpConfigured, syncClickUp } from "./integrations/clickup";
import { notifySlack } from "./integrations/slack";
import { emailConfigured, escapeHtml, sendEmail } from "./integrations/email";
import { claimOnce, fmtDate, money, now, recordRun } from "./util";

/** Every 15 minutes: pull Stripe + ClickUp, then send any new alerts. */
export async function runSyncs(env: Env) {
  if (stripeConfigured(env)) {
    try {
      await recordRun(env, "stripe", () => syncStripe(env));
    } catch (err) {
      console.error("Stripe sync failed", err);
    }
  }
  if (clickUpConfigured(env)) {
    try {
      await recordRun(env, "clickup", () => syncClickUp(env));
    } catch (err) {
      console.error("ClickUp sync failed", err);
    }
  }
  await overdueInvoiceAlerts(env);
}

/** Posts one Slack alert per invoice the day it becomes overdue. */
async function overdueInvoiceAlerts(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.number, i.amount_remaining, i.currency, i.due_at, c.name AS client, c.id AS client_id
     FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
     WHERE i.status = 'open' AND i.due_at IS NOT NULL AND i.due_at < ? AND i.due_at > ?`,
  )
    .bind(now(), now() - 60 * 86400)
    .all<{ id: string; number: string | null; amount_remaining: number; currency: string; due_at: number; client: string | null; client_id: number | null }>();
  for (const inv of results) {
    if (!(await claimOnce(env, "alerts_sent", `overdue:${inv.id}`))) continue;
    await notifySlack(
      env,
      `🔴 Overdue: ${inv.client ?? "Unknown client"} — ${money(inv.amount_remaining, inv.currency)}${inv.number ? ` (invoice ${inv.number})` : ""}, due ${fmtDate(inv.due_at, env.TIMEZONE)}`,
      { link: inv.client_id ? `${env.APP_URL}/clients/${inv.client_id}` : `${env.APP_URL}/invoices` },
    );
  }
}

export interface DigestData {
  mrr: number;
  overdue: { client: string | null; number: string | null; amount_remaining: number; currency: string; due_at: number }[];
  dueToday: { name: string; client: string | null; url: string | null; assignees: string | null }[];
  overdueTasks: { name: string; client: string | null; url: string | null; due_at: number; assignees: string | null }[];
  paidYesterday: number;
}

export async function digestData(env: Env): Promise<DigestData> {
  const t = now();
  const [mrr, overdue, dueToday, overdueTasks, paid] = await env.DB.batch([
    env.DB.prepare("SELECT COALESCE(SUM(mrr_cents),0) AS v FROM subscriptions WHERE status IN ('active','past_due')"),
    env.DB.prepare(
      `SELECT c.name AS client, i.number, i.amount_remaining, i.currency, i.due_at FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.status = 'open' AND i.due_at < ? ORDER BY i.due_at`,
    ).bind(t),
    env.DB.prepare(
      `SELECT t.name, c.name AS client, t.url, t.assignees FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
       WHERE t.is_closed = 0 AND t.deleted = 0 AND t.due_at BETWEEN ? AND ? ORDER BY t.due_at`,
    ).bind(t, t + 86400),
    env.DB.prepare(
      `SELECT t.name, c.name AS client, t.url, t.due_at, t.assignees FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
       WHERE t.is_closed = 0 AND t.deleted = 0 AND t.due_at < ? ORDER BY t.due_at LIMIT 30`,
    ).bind(t),
    env.DB.prepare("SELECT COALESCE(SUM(amount_paid),0) AS v FROM invoices WHERE paid_at >= ?").bind(t - 86400),
  ]);
  return {
    mrr: (mrr.results[0] as any).v,
    overdue: overdue.results as any,
    dueToday: dueToday.results as any,
    overdueTasks: overdueTasks.results as any,
    paidYesterday: (paid.results[0] as any).v,
  };
}

/** 7am Brisbane: daily summary to Slack and email. */
export async function runDailyDigest(env: Env) {
  const d = await digestData(env);
  const overdueTotal = d.overdue.reduce((s, i) => s + i.amount_remaining, 0);

  const slackLines = [
    `*☀️ ${env.APP_NAME} — daily summary*`,
    `• Recurring revenue: *${money(d.mrr)}/mo*`,
    `• Paid in the last 24h: *${money(d.paidYesterday)}*`,
    `• Overdue invoices: *${d.overdue.length}* (${money(overdueTotal)})`,
    `• Tasks due today: *${d.dueToday.length}* · Overdue tasks: *${d.overdueTasks.length}*`,
  ];
  if (d.overdueTasks.length) {
    slackLines.push("", "*Overdue tasks*");
    for (const t of d.overdueTasks.slice(0, 10)) {
      slackLines.push(`• ${t.url ? `<${t.url}|${t.name}>` : t.name}${t.client ? ` — ${t.client}` : ""}${t.assignees ? ` (${t.assignees})` : ""}`);
    }
  }
  await notifySlack(env, slackLines.join("\n"), { link: env.APP_URL });

  if (!emailConfigured(env) || !env.DIGEST_EMAILS) return;
  const e = escapeHtml;
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td style="padding:6px 10px;border-bottom:1px solid #eee">${c}</td>`).join("")}</tr>`;
  const html = `
  <div style="font-family:system-ui,Segoe UI,Arial;max-width:640px;color:#1f2937">
    <h2 style="margin:0 0 4px">${e(env.APP_NAME)} — daily summary</h2>
    <p style="color:#6b7280;margin:0 0 16px">${fmtDate(now(), env.TIMEZONE)}</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
      ${row(["Recurring revenue", `<b>${money(d.mrr)}/mo</b>`])}
      ${row(["Paid in last 24h", `<b>${money(d.paidYesterday)}</b>`])}
      ${row(["Overdue invoices", `<b>${d.overdue.length}</b> (${money(overdueTotal)})`])}
      ${row(["Tasks due today", `<b>${d.dueToday.length}</b>`])}
      ${row(["Overdue tasks", `<b>${d.overdueTasks.length}</b>`])}
    </table>
    ${d.overdue.length ? `<h3>Overdue invoices</h3><table style="border-collapse:collapse;width:100%">${d.overdue
      .map((i) => row([e(i.client ?? "Unknown"), e(i.number ?? ""), money(i.amount_remaining, i.currency), `due ${fmtDate(i.due_at, env.TIMEZONE)}`]))
      .join("")}</table>` : ""}
    ${d.overdueTasks.length ? `<h3>Overdue tasks</h3><table style="border-collapse:collapse;width:100%">${d.overdueTasks
      .map((t) => row([t.url ? `<a href="${e(t.url)}">${e(t.name)}</a>` : e(t.name), e(t.client ?? ""), e(t.assignees ?? ""), fmtDate(t.due_at, env.TIMEZONE)]))
      .join("")}</table>` : ""}
    <p style="margin-top:24px"><a href="${e(env.APP_URL)}">Open ${e(env.APP_NAME)}</a></p>
  </div>`;
  await sendEmail(env, { to: env.DIGEST_EMAILS, subject: `${env.APP_NAME} daily summary — ${fmtDate(now(), env.TIMEZONE)}`, html });
}
