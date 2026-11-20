import { Hono } from "hono";
import type { Activity, AppEnv, Client, Invoice, Project, Task } from "../types";
import { ActivityFeed, Badge, InvoiceTable, Stat, statusTone, TaskTable } from "../views/components";
import { fmtDate, logActivity, money, now } from "../util";
import { applyFolderToClient, listClickUpFolders } from "../integrations/clickup";
import { backWith, page, str } from "./page";

export const clients = new Hono<AppEnv>();

const STATUSES = ["active", "paused", "ended"];

clients.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const status = c.req.query("status") ?? "active";
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status !== "all") {
    where.push("c.status = ?");
    binds.push(status);
  }
  if (q) {
    where.push("(c.name LIKE ? OR c.email LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT c.*,
       (SELECT COALESCE(SUM(mrr_cents),0) FROM subscriptions s WHERE s.client_id = c.id AND s.status IN ('active','past_due')) AS mrr,
       (SELECT COALESCE(SUM(amount_remaining),0) FROM invoices i WHERE i.client_id = c.id AND i.status = 'open') AS owing,
       (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id AND i.status = 'open' AND i.due_at < ?) AS overdue_n,
       (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.is_closed = 0 AND t.deleted = 0) AS open_tasks
     FROM clients c ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.name COLLATE NOCASE`,
  )
    .bind(now(), ...binds)
    .all<Client & { mrr: number; owing: number; overdue_n: number; open_tasks: number }>();

  return page(
    c,
    "Clients",
    <>
      <h1>Clients</h1>
      <form class="toolbar" method="get">
        <input name="q" value={q} placeholder="Search name or email" />
        <select name="status">
          {["active", "paused", "ended", "all"].map((s) => (
            <option value={s} selected={s === status}>{s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <button class="btn ghost">Filter</button>
        <span style="flex:1" />
        <a class="btn" href="/clients/new">New client</a>
      </form>
      <div class="card">
        {results.length === 0 ? (
          <p class="muted">No clients yet. They're created automatically from Stripe customers, or add one with “New client”.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Client</th><th>Status</th><th class="num">Monthly</th><th class="num">Owing</th><th class="num">Open tasks</th></tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr>
                  <td><a href={`/clients/${r.id}`}><b>{r.name}</b></a>{r.email ? <div class="small muted">{r.email}</div> : null}</td>
                  <td><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                  <td class="num">{r.mrr ? money(r.mrr) : "—"}</td>
                  <td class="num">{r.owing ? <span style={r.overdue_n ? "color:var(--red);font-weight:600" : ""}>{money(r.owing)}</span> : "—"}</td>
                  <td class="num">{r.open_tasks || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>,
  );
});

async function clientForm(c: any, client: Partial<Client> | null) {
  let folders: { id: string; name: string; space: string }[] = [];
  let folderErr: string | null = null;
  try {
    folders = await listClickUpFolders(c.env);
  } catch (err) {
    folderErr = String((err as Error).message);
  }
  const action = client?.id ? `/clients/${client.id}` : "/clients";
  return (
    <form method="post" action={action} class="card">
      <div class="formgrid">
        <div>
          <label>Name</label>
          <input name="name" required value={client?.name ?? ""} />
        </div>
        <div>
          <label>Billing email</label>
          <input name="email" type="email" value={client?.email ?? ""} />
        </div>
        <div>
          <label>Status</label>
          <select name="status">
            {STATUSES.map((s) => <option value={s} selected={(client?.status ?? "active") === s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label>Stripe customer ID</label>
          <input name="stripe_customer_id" placeholder="cus_..." value={client?.stripe_customer_id ?? ""} />
        </div>
        <div>
          <label>ClickUp folder</label>
          <select name="clickup_folder_id">
            <option value="">— none —</option>
            {folders.map((f) => (
              <option value={f.id} selected={client?.clickup_folder_id === f.id}>{`${f.name} (${f.space})`}</option>
            ))}
            {client?.clickup_folder_id && !folders.some((f) => f.id === client.clickup_folder_id) ? (
              <option value={client.clickup_folder_id} selected>{`Folder ${client.clickup_folder_id}`}</option>
            ) : null}
          </select>
          {folderErr ? <div class="small muted">Couldn't load ClickUp folders: {folderErr}</div> : null}
        </div>
        <div>
          <label>Client Slack channel ID (optional)</label>
          <input name="slack_channel_id" placeholder="C0123..." value={client?.slack_channel_id ?? ""} />
        </div>
      </div>
      <label>Notes</label>
      <textarea name="notes">{client?.notes ?? ""}</textarea>
      <p><button class="btn">{client?.id ? "Save changes" : "Create client"}</button>{" "}
        <a class="btn ghost" href={client?.id ? `/clients/${client.id}` : "/clients"}>Cancel</a></p>
    </form>
  );
}

function readClient(form: Record<string, unknown>) {
  return {
    name: str(form.name) ?? "Untitled client",
    email: str(form.email),
    status: STATUSES.includes(String(form.status)) ? String(form.status) : "active",
    stripe_customer_id: str(form.stripe_customer_id),
    clickup_folder_id: str(form.clickup_folder_id),
    slack_channel_id: str(form.slack_channel_id),
    notes: str(form.notes),
  };
}

clients.get("/new", async (c) => page(c, "New client", <><h1>New client</h1>{await clientForm(c, null)}</>));

clients.post("/", async (c) => {
  const v = readClient(await c.req.parseBody());
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO clients (name, email, status, stripe_customer_id, clickup_folder_id, slack_channel_id, notes) VALUES (?,?,?,?,?,?,?) RETURNING id",
    )
      .bind(v.name, v.email, v.status, v.stripe_customer_id, v.clickup_folder_id, v.slack_channel_id, v.notes)
      .first<{ id: number }>();
    await applyFolderToClient(c.env, row!.id, v.clickup_folder_id);
    await logActivity(c.env, { kind: "client_created", client_id: row!.id, message: `Client added by ${c.get("user")}: ${v.name}` });
    return backWith(c, `/clients/${row!.id}`, { ok: "Client created." });
  } catch (err) {
    return backWith(c, "/clients/new", { err: `Couldn't create client: ${(err as Error).message}` });
  }
});

clients.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const env = c.env;
  const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first<Client>();
  if (!client) return c.notFound();

  const [subs, invoices, projects, tasks, feed, totals] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM subscriptions WHERE client_id = ? ORDER BY status = 'active' DESC, created_at DESC").bind(id),
    env.DB.prepare("SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 50").bind(id),
    env.DB.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.is_closed = 0 AND t.deleted = 0) AS open_tasks
       FROM projects p WHERE p.client_id = ? ORDER BY p.status = 'done', p.name`,
    ).bind(id),
    env.DB.prepare(
      `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.client_id = ? AND t.is_closed = 0 AND t.deleted = 0 ORDER BY t.due_at IS NULL, t.due_at LIMIT 50`,
    ).bind(id),
    env.DB.prepare("SELECT * FROM activity WHERE client_id = ? ORDER BY ts DESC LIMIT 30").bind(id),
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_paid),0) AS lifetime,
         COALESCE(SUM(CASE WHEN status='open' THEN amount_remaining END),0) AS owing,
         COALESCE(SUM(CASE WHEN status='open' AND due_at < ? THEN amount_remaining END),0) AS overdue
       FROM invoices WHERE client_id = ?`,
    ).bind(now(), id),
  ]);
  const tot = totals.results[0] as any;
  const subRows = subs.results as any[];
  const mrr = subRows.filter((s) => s.status === "active" || s.status === "past_due").reduce((a, s) => a + s.mrr_cents, 0);

  return page(
    c,
    client.name,
    <>
      <div class="toolbar">
        <h1 style="margin:0">{client.name}</h1>
        <Badge tone={statusTone(client.status)}>{client.status}</Badge>
        <span style="flex:1" />
        <a class="btn ghost" href={`/clients/${id}/edit`}>Edit</a>
        <a class="btn" href={`/projects/new?client_id=${id}`}>New project</a>
      </div>
      <p class="muted" style="margin-top:-6px">
        {client.email ?? "No email"}
        {client.stripe_customer_id ? <> · <a href={`https://dashboard.stripe.com/customers/${client.stripe_customer_id}`} target="_blank" rel="noopener">Stripe</a></> : null}
        {client.clickup_folder_id ? <> · ClickUp folder linked</> : null}
      </p>
      <div class="stats">
        <Stat k="Monthly recurring" v={money(mrr)} />
        <Stat k="Owing" v={money(tot.owing)} s={tot.overdue ? <span style="color:var(--red)">{money(tot.overdue)} overdue</span> : "nothing overdue"} />
        <Stat k="Lifetime paid" v={money(tot.lifetime)} />
        <Stat k="Open tasks" v={tasks.results.length} />
      </div>
      <div class="row">
        <div class="grow" style="flex:2">
          <div class="card">
            <h2>Projects</h2>
            {projects.results.length === 0 ? (
              <p class="muted">No projects. Link a ClickUp folder to this client and its lists become projects automatically.</p>
            ) : (
              <table>
                <thead><tr><th>Project</th><th>Status</th><th>Due</th><th class="num">Open tasks</th></tr></thead>
                <tbody>
                  {(projects.results as any[]).map((p: Project & { open_tasks: number }) => (
                    <tr>
                      <td><a href={`/projects/${p.id}`}>{p.name}</a></td>
                      <td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                      <td>{p.due_date ?? "—"}</td>
                      <td class="num">{p.open_tasks || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div class="card">
            <h2>Open tasks</h2>
            <TaskTable tasks={tasks.results as unknown as Task[]} tz={env.TIMEZONE} showClient={false} />
          </div>
          <div class="card">
            <h2>Invoices</h2>
            <InvoiceTable invoices={invoices.results as unknown as Invoice[]} tz={env.TIMEZONE} showClient={false} />
          </div>
          {subRows.length ? (
            <div class="card">
              <h2>Subscriptions</h2>
              <table>
                <thead><tr><th>Plan</th><th>Status</th><th>Renews</th><th class="num">Monthly</th></tr></thead>
                <tbody>
                  {subRows.map((s) => (
                    <tr>
                      <td>{s.description ?? s.id}</td>
                      <td><Badge tone={statusTone(s.status)}>{s.status}</Badge></td>
                      <td>{s.status === "canceled" ? "—" : fmtDate(s.current_period_end, env.TIMEZONE)}</td>
                      <td class="num">{money(s.mrr_cents, s.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <div class="grow">
          <div class="card">
            <h2>Add a note</h2>
            <form method="post" action={`/clients/${id}/notes`}>
              <textarea name="message" required placeholder="Call notes, decisions, next steps…" />
              <p><button class="btn">Add note</button></p>
            </form>
          </div>
          {client.notes ? <div class="card"><h2>Notes</h2><div style="white-space:pre-wrap">{client.notes}</div></div> : null}
          <div class="card">
            <h2>Activity</h2>
            <ActivityFeed items={feed.results as unknown as Activity[]} tz={env.TIMEZONE} />
          </div>
        </div>
      </div>
    </>,
  );
});

clients.get("/:id{[0-9]+}/edit", async (c) => {
  const client = await c.env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(Number(c.req.param("id"))).first<Client>();
  if (!client) return c.notFound();
  return page(c, `Edit ${client.name}`, <><h1>Edit {client.name}</h1>{await clientForm(c, client)}</>);
});

clients.post("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const v = readClient(await c.req.parseBody());
  try {
    await c.env.DB.prepare(
      `UPDATE clients SET name=?, email=?, status=?, stripe_customer_id=?, clickup_folder_id=?, slack_channel_id=?, notes=?, updated_at=unixepoch() WHERE id=?`,
    )
      .bind(v.name, v.email, v.status, v.stripe_customer_id, v.clickup_folder_id, v.slack_channel_id, v.notes, id)
      .run();
    if (v.stripe_customer_id) {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE invoices SET client_id = ? WHERE stripe_customer_id = ?").bind(id, v.stripe_customer_id),
        c.env.DB.prepare("UPDATE subscriptions SET client_id = ? WHERE stripe_customer_id = ?").bind(id, v.stripe_customer_id),
      ]);
    }
    await applyFolderToClient(c.env, id, v.clickup_folder_id);
    return backWith(c, `/clients/${id}`, { ok: "Saved." });
  } catch (err) {
    return backWith(c, `/clients/${id}/edit`, { err: `Couldn't save: ${(err as Error).message}` });
  }
});

clients.post("/:id{[0-9]+}/notes", async (c) => {
  const id = Number(c.req.param("id"));
  const message = str((await c.req.parseBody()).message);
  if (message) {
    await logActivity(c.env, { kind: "note", client_id: id, message: `📝 ${c.get("user").split("@")[0]}: ${message}` });
  }
  return backWith(c, `/clients/${id}`, { ok: "Note added." });
});
