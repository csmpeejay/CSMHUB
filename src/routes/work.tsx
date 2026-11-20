import { Hono } from "hono";
import type { AppEnv, Invoice, Task } from "../types";
import { Badge, InvoiceTable, statusTone, TaskTable } from "../views/components";
import { fmtDate, money, now } from "../util";
import { page } from "./page";

export const work = new Hono<AppEnv>();

work.get("/tasks", async (c) => {
  const view = c.req.query("view") ?? "open";
  const who = c.req.query("who")?.trim() ?? "";
  const q = c.req.query("q")?.trim() ?? "";
  const t = now();
  const where = ["t.deleted = 0"];
  const binds: unknown[] = [];
  if (view === "open") where.push("t.is_closed = 0");
  if (view === "overdue") where.push("t.is_closed = 0 AND t.due_at < ?"), binds.push(t);
  if (view === "week") where.push("t.is_closed = 0 AND t.due_at < ?"), binds.push(t + 7 * 86400);
  if (view === "done") where.push("t.is_closed = 1");
  if (who) where.push("t.assignees LIKE ?"), binds.push(`%${who}%`);
  if (q) where.push("t.name LIKE ?"), binds.push(`%${q}%`);
  const order = view === "done" ? "t.closed_at DESC" : "t.due_at IS NULL, t.due_at";

  const [{ results }, people] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.*, c.name AS client_name, p.name AS project_name FROM tasks t
       LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id
       WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 300`,
    )
      .bind(...binds)
      .all<Task>(),
    c.env.DB.prepare("SELECT DISTINCT assignees FROM tasks WHERE assignees IS NOT NULL AND is_closed = 0 AND deleted = 0").all<{ assignees: string }>(),
  ]);
  const names = [...new Set(people.results.flatMap((r) => r.assignees.split(",").map((s) => s.trim())))].filter(Boolean).sort();

  return page(
    c,
    "Tasks",
    <>
      <h1>Tasks</h1>
      <form class="toolbar" method="get">
        <select name="view">
          {[["open", "All open"], ["week", "Due this week"], ["overdue", "Overdue"], ["done", "Completed"], ["all", "Everything"]].map(([v, l]) => (
            <option value={v} selected={v === view}>{l}</option>
          ))}
        </select>
        <select name="who">
          <option value="">Anyone</option>
          {names.map((n) => <option value={n} selected={n === who}>{n}</option>)}
        </select>
        <input name="q" value={q} placeholder="Search tasks" />
        <button class="btn ghost">Filter</button>
        <span class="muted small">Tasks are managed in ClickUp; this view syncs every 15 minutes and instantly via webhook.</span>
      </form>
      <div class="card"><TaskTable tasks={results} tz={c.env.TIMEZONE} /></div>
    </>,
  );
});

work.get("/invoices", async (c) => {
  const view = c.req.query("view") ?? "invoices";
  const status = c.req.query("status") ?? "all";
  const env = c.env;

  if (view === "subscriptions") {
    const { results } = await env.DB.prepare(
      `SELECT s.*, c.name AS client_name FROM subscriptions s LEFT JOIN clients c ON c.id = s.client_id
       WHERE s.status IN ('active','past_due','trialing') ORDER BY s.mrr_cents DESC`,
    ).all<any>();
    const total = results.filter((s) => s.status !== "trialing").reduce((a, s) => a + s.mrr_cents, 0);
    return page(
      c,
      "Subscriptions",
      <>
        <h1>Billing</h1>
        <div class="toolbar"><a class="btn ghost" href="/invoices">Invoices</a><a class="btn" href="/invoices?view=subscriptions">Subscriptions</a>
          <span style="flex:1" /><b>{money(total)}/month recurring</b></div>
        <div class="card">
          {results.length === 0 ? <p class="muted">No active subscriptions in Stripe.</p> : (
            <table>
              <thead><tr><th>Client</th><th>Plan</th><th>Status</th><th>Renews</th><th class="num">Monthly</th></tr></thead>
              <tbody>
                {results.map((s) => (
                  <tr>
                    <td>{s.client_id ? <a href={`/clients/${s.client_id}`}>{s.client_name}</a> : <span class="muted">Unlinked</span>}</td>
                    <td>{s.description ?? s.id}</td>
                    <td><Badge tone={statusTone(s.status)}>{s.status}</Badge></td>
                    <td>{fmtDate(s.current_period_end, env.TIMEZONE)}</td>
                    <td class="num">{money(s.mrr_cents, s.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </>,
    );
  }

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status === "overdue") where.push("i.status = 'open' AND i.due_at < ?"), binds.push(now());
  else if (status !== "all") where.push("i.status = ?"), binds.push(status);
  const { results } = await env.DB.prepare(
    `SELECT i.*, c.name AS client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.created_at DESC LIMIT 300`,
  )
    .bind(...binds)
    .all<Invoice>();

  return page(
    c,
    "Invoices",
    <>
      <h1>Billing</h1>
      <form class="toolbar" method="get">
        <a class="btn" href="/invoices">Invoices</a><a class="btn ghost" href="/invoices?view=subscriptions">Subscriptions</a>
        <select name="status">
          {["all", "open", "overdue", "paid", "draft", "void", "uncollectible"].map((s) => (
            <option value={s} selected={s === status}>{s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <button class="btn ghost">Filter</button>
      </form>
      <div class="card"><InvoiceTable invoices={results} tz={env.TIMEZONE} /></div>
    </>,
  );
});
