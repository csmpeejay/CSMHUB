import type { Child } from "hono/jsx";
import { fmtDate, money, now } from "../util";
import type { Activity, Invoice, Task } from "../types";

export function Badge({ tone, children }: { tone?: "green" | "red" | "amber" | "blue"; children: Child }) {
  return <span class={`badge${tone ? ` b-${tone}` : ""}`}>{children}</span>;
}

export function Stat({ k, v, s, href }: { k: string; v: Child; s?: Child; href?: string }) {
  const inner = (
    <div class="stat">
      <div class="k">{k}</div>
      <div class="v">{v}</div>
      {s ? <div class="s">{s}</div> : null}
    </div>
  );
  return href ? <a href={href} style="color:inherit;text-decoration:none">{inner}</a> : inner;
}

export function statusTone(status: string | null): "green" | "red" | "amber" | "blue" | undefined {
  switch ((status ?? "").toLowerCase()) {
    case "active":
    case "paid":
    case "done":
    case "complete":
    case "closed":
      return "green";
    case "past_due":
    case "uncollectible":
    case "overdue":
    case "ended":
    case "canceled":
      return "red";
    case "open":
    case "paused":
    case "on_hold":
    case "trialing":
      return "amber";
    case "planning":
    case "draft":
      return "blue";
  }
  return undefined;
}

export function InvoiceStatus({ inv }: { inv: Invoice }) {
  const overdue = inv.status === "open" && inv.due_at && inv.due_at < now();
  return <Badge tone={overdue ? "red" : statusTone(inv.status)}>{overdue ? "overdue" : inv.status ?? "—"}</Badge>;
}

export function InvoiceTable({ invoices, tz, showClient = true }: { invoices: (Invoice & { client_name?: string | null })[]; tz?: string; showClient?: boolean }) {
  if (!invoices.length) return <p class="muted">No invoices.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Invoice</th>
          {showClient ? <th>Client</th> : null}
          <th>Status</th>
          <th>Issued</th>
          <th>Due</th>
          <th class="num">Total</th>
          <th class="num">Outstanding</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((i) => (
          <tr>
            <td>
              {i.hosted_url ? <a href={i.hosted_url} target="_blank" rel="noopener">{i.number ?? i.id}</a> : i.number ?? i.id}
              {i.description ? <div class="small muted">{i.description}</div> : null}
            </td>
            {showClient ? <td>{i.client_id ? <a href={`/clients/${i.client_id}`}>{i.client_name ?? "—"}</a> : <span class="muted">Unlinked</span>}</td> : null}
            <td><InvoiceStatus inv={i} /></td>
            <td>{fmtDate(i.created_at, tz)}</td>
            <td>{fmtDate(i.due_at, tz)}</td>
            <td class="num">{money(i.total, i.currency ?? "aud")}</td>
            <td class="num">{i.amount_remaining ? money(i.amount_remaining, i.currency ?? "aud") : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TaskTable({ tasks, tz, showClient = true }: { tasks: (Task & { client_name?: string | null; project_name?: string | null })[]; tz?: string; showClient?: boolean }) {
  if (!tasks.length) return <p class="muted">No tasks.</p>;
  const t = now();
  return (
    <table>
      <thead>
        <tr>
          <th>Task</th>
          {showClient ? <th>Client / project</th> : null}
          <th>Status</th>
          <th>Assignees</th>
          <th>Due</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((x) => {
          const late = !x.is_closed && x.due_at && x.due_at < t;
          return (
            <tr>
              <td>{x.url ? <a href={x.url} target="_blank" rel="noopener">{x.name}</a> : x.name}</td>
              {showClient ? (
                <td>
                  {x.client_id ? <a href={`/clients/${x.client_id}`}>{x.client_name}</a> : <span class="muted">No client</span>}
                  {x.project_name ? <div class="small muted"><a href={`/projects/${x.project_id}`} class="muted">{x.project_name}</a></div> : null}
                </td>
              ) : null}
              <td><Badge tone={x.is_closed ? "green" : undefined}>{x.status ?? "—"}</Badge></td>
              <td class="small">{x.assignees ?? <span class="muted">—</span>}</td>
              <td>{late ? <Badge tone="red">{fmtDate(x.due_at, tz)}</Badge> : fmtDate(x.due_at, tz)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function ActivityFeed({ items, tz }: { items: (Activity & { client_name?: string | null })[]; tz?: string }) {
  if (!items.length) return <p class="muted">Nothing yet. Activity appears here as invoices are paid and tasks are completed.</p>;
  return (
    <ul class="feed">
      {items.map((a) => (
        <li>
          <div>{a.link ? <a href={a.link} target="_blank" rel="noopener" style="color:inherit">{a.message}</a> : a.message}</div>
          <div class="small muted">
            {fmtDate(a.ts, tz)}
            {a.client_id && a.client_name ? <> · <a href={`/clients/${a.client_id}`}>{a.client_name}</a></> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
