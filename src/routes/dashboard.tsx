import { Hono } from "hono";
import type { Activity, AppEnv, Invoice, Task } from "../types";
import { ActivityFeed, InvoiceTable, Stat, TaskTable } from "../views/components";
import { money, now } from "../util";
import { page } from "./page";

export const dashboard = new Hono<AppEnv>();

dashboard.get("/", async (c) => {
  const env = c.env;
  const t = now();
  const monthStart = (() => {
    const d = new Date();
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  })();

  const [mrr, clients, outstanding, overdue, paidMonth, openTasks, overdueTasks, overdueInv, dueSoon, feed] = await env.DB.batch([
    env.DB.prepare("SELECT COALESCE(SUM(mrr_cents),0) AS v, COUNT(*) AS n FROM subscriptions WHERE status IN ('active','past_due')"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM clients WHERE status = 'active'"),
    env.DB.prepare("SELECT COALESCE(SUM(amount_remaining),0) AS v, COUNT(*) AS n FROM invoices WHERE status = 'open'"),
    env.DB.prepare("SELECT COALESCE(SUM(amount_remaining),0) AS v, COUNT(*) AS n FROM invoices WHERE status = 'open' AND due_at < ?").bind(t),
    env.DB.prepare("SELECT COALESCE(SUM(amount_paid),0) AS v FROM invoices WHERE paid_at >= ?").bind(monthStart),
    env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE is_closed = 0 AND deleted = 0"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE is_closed = 0 AND deleted = 0 AND due_at < ?").bind(t),
    env.DB.prepare(
      `SELECT i.*, c.name AS client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.status = 'open' AND i.due_at < ? ORDER BY i.due_at LIMIT 10`,
    ).bind(t),
    env.DB.prepare(
      `SELECT t.*, c.name AS client_name, p.name AS project_name FROM tasks t
       LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.is_closed = 0 AND t.deleted = 0 AND t.due_at IS NOT NULL AND t.due_at < ? ORDER BY t.due_at LIMIT 15`,
    ).bind(t + 7 * 86400),
    env.DB.prepare(
      "SELECT a.*, c.name AS client_name FROM activity a LEFT JOIN clients c ON c.id = a.client_id ORDER BY a.ts DESC LIMIT 15",
    ),
  ]);
  const one = (r: D1Result) => r.results[0] as any;

  return page(
    c,
    "Dashboard",
    <>
      <h1>Dashboard</h1>
      <div class="stats">
        <Stat k="Recurring revenue" v={`${money(one(mrr).v)}`} s={`per month · ${one(mrr).n} subscriptions`} href="/invoices?view=subscriptions" />
        <Stat k="Paid this month" v={money(one(paidMonth).v)} href="/invoices?status=paid" />
        <Stat k="Outstanding" v={money(one(outstanding).v)} s={`${one(outstanding).n} open invoices`} href="/invoices?status=open" />
        <Stat
          k="Overdue"
          v={<span style={one(overdue).n ? "color:var(--red)" : ""}>{money(one(overdue).v)}</span>}
          s={`${one(overdue).n} invoices`}
          href="/invoices?status=overdue"
        />
        <Stat k="Active clients" v={one(clients).n} href="/clients" />
        <Stat k="Open tasks" v={one(openTasks).n} s={`${one(overdueTasks).n} overdue`} href="/tasks" />
      </div>
      <div class="row">
        <div class="grow" style="flex:2">
          <div class="card">
            <h2>Due this week &amp; overdue tasks</h2>
            <TaskTable tasks={dueSoon.results as unknown as Task[]} tz={env.TIMEZONE} />
          </div>
          <div class="card">
            <h2>Overdue invoices</h2>
            <InvoiceTable invoices={overdueInv.results as unknown as Invoice[]} tz={env.TIMEZONE} />
          </div>
        </div>
        <div class="grow">
          <div class="card">
            <h2>Recent activity</h2>
            <ActivityFeed items={feed.results as unknown as Activity[]} tz={env.TIMEZONE} />
            <p class="small"><a href="/activity">All activity →</a></p>
          </div>
        </div>
      </div>
    </>,
  );
});

dashboard.get("/activity", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT a.*, c.name AS client_name FROM activity a LEFT JOIN clients c ON c.id = a.client_id ORDER BY a.ts DESC LIMIT 200",
  ).all<Activity>();
  return page(
    c,
    "Activity",
    <>
      <h1>Activity</h1>
      <div class="card">
        <ActivityFeed items={results} tz={c.env.TIMEZONE} />
      </div>
    </>,
  );
});
