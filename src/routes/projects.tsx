import { Hono } from "hono";
import type { Activity, AppEnv, Client, Project, Task } from "../types";
import { ActivityFeed, Badge, Stat, statusTone, TaskTable } from "../views/components";
import { money, now } from "../util";
import { backWith, centsFrom, page, str } from "./page";

export const projects = new Hono<AppEnv>();

const STATUSES = ["planning", "active", "on_hold", "done"];

projects.get("/", async (c) => {
  const status = c.req.query("status") ?? "open";
  const clientId = c.req.query("client") ?? "";
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status === "open") where.push("p.status != 'done'");
  else if (status !== "all") {
    where.push("p.status = ?");
    binds.push(status);
  }
  if (clientId === "none") where.push("p.client_id IS NULL");
  else if (clientId) {
    where.push("p.client_id = ?");
    binds.push(Number(clientId));
  }
  const [{ results }, clientsRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.*, c.name AS client_name,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.is_closed = 0 AND t.deleted = 0) AS open_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.is_closed = 0 AND t.deleted = 0 AND t.due_at < ?) AS late_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted = 0) AS all_tasks
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY c.name IS NULL, c.name COLLATE NOCASE, p.name COLLATE NOCASE`,
    )
      .bind(now(), ...binds)
      .all<Project & { client_name: string | null; open_tasks: number; late_tasks: number; all_tasks: number }>(),
    c.env.DB.prepare("SELECT id, name FROM clients WHERE status != 'ended' ORDER BY name COLLATE NOCASE").all<{ id: number; name: string }>(),
  ]);

  return page(
    c,
    "Projects",
    <>
      <h1>Projects</h1>
      <form class="toolbar" method="get">
        <select name="status">
          {[["open", "Not done"], ["all", "All"], ...STATUSES.map((s) => [s, s])].map(([v, l]) => (
            <option value={v} selected={v === status}>{l}</option>
          ))}
        </select>
        <select name="client">
          <option value="">All clients</option>
          <option value="none" selected={clientId === "none"}>No client linked</option>
          {clientsRes.results.map((x) => <option value={String(x.id)} selected={String(x.id) === clientId}>{x.name}</option>)}
        </select>
        <button class="btn ghost">Filter</button>
        <span style="flex:1" />
        <a class="btn" href="/projects/new">New project</a>
      </form>
      <div class="card">
        {results.length === 0 ? (
          <p class="muted">No projects. Every ClickUp list becomes a project automatically after the first ClickUp sync.</p>
        ) : (
          <table>
            <thead><tr><th>Project</th><th>Client</th><th>Status</th><th>Due</th><th class="num">Progress</th><th class="num">Open</th></tr></thead>
            <tbody>
              {results.map((p) => {
                const done = p.all_tasks - p.open_tasks;
                const pct = p.all_tasks ? Math.round((done / p.all_tasks) * 100) : 0;
                return (
                  <tr>
                    <td><a href={`/projects/${p.id}`}>{p.name}</a></td>
                    <td>{p.client_id ? <a href={`/clients/${p.client_id}`}>{p.client_name}</a> : <span class="muted">—</span>}</td>
                    <td><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                    <td>{p.due_date ?? "—"}</td>
                    <td class="num">{p.all_tasks ? `${pct}%` : "—"}</td>
                    <td class="num">{p.open_tasks || "—"}{p.late_tasks ? <> <Badge tone="red">{p.late_tasks} late</Badge></> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>,
  );
});

async function projectForm(c: any, p: Partial<Project> | null) {
  const { results: clientList } = await c.env.DB.prepare("SELECT id, name FROM clients ORDER BY name COLLATE NOCASE").all();
  const preset = p?.client_id ?? (c.req.query("client_id") ? Number(c.req.query("client_id")) : null);
  return (
    <form method="post" action={p?.id ? `/projects/${p.id}` : "/projects"} class="card">
      <div class="formgrid">
        <div><label>Name</label><input name="name" required value={p?.name ?? ""} /></div>
        <div>
          <label>Client</label>
          <select name="client_id">
            <option value="">— none —</option>
            {(clientList as Client[]).map((x) => <option value={String(x.id)} selected={x.id === preset}>{x.name}</option>)}
          </select>
        </div>
        <div>
          <label>Status</label>
          <select name="status">{STATUSES.map((s) => <option value={s} selected={(p?.status ?? "active") === s}>{s}</option>)}</select>
        </div>
        <div><label>Budget (AUD)</label><input name="budget" inputmode="decimal" value={p?.budget_cents != null ? String(p.budget_cents / 100) : ""} /></div>
        <div><label>Start date</label><input name="start_date" type="date" value={p?.start_date ?? ""} /></div>
        <div><label>Due date</label><input name="due_date" type="date" value={p?.due_date ?? ""} /></div>
        <div><label>ClickUp list ID</label><input name="clickup_list_id" value={p?.clickup_list_id ?? ""} placeholder="Filled automatically for synced lists" /></div>
      </div>
      <p><button class="btn">{p?.id ? "Save changes" : "Create project"}</button>{" "}
        <a class="btn ghost" href={p?.id ? `/projects/${p.id}` : "/projects"}>Cancel</a></p>
    </form>
  );
}

function readProject(f: Record<string, unknown>) {
  return {
    name: str(f.name) ?? "Untitled project",
    client_id: str(f.client_id) ? Number(f.client_id) : null,
    status: STATUSES.includes(String(f.status)) ? String(f.status) : "active",
    budget_cents: centsFrom(f.budget),
    start_date: str(f.start_date),
    due_date: str(f.due_date),
    clickup_list_id: str(f.clickup_list_id),
  };
}

projects.get("/new", async (c) => page(c, "New project", <><h1>New project</h1>{await projectForm(c, null)}</>));

projects.post("/", async (c) => {
  const v = readProject(await c.req.parseBody());
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO projects (name, client_id, status, budget_cents, start_date, due_date, clickup_list_id) VALUES (?,?,?,?,?,?,?) RETURNING id",
    )
      .bind(v.name, v.client_id, v.status, v.budget_cents, v.start_date, v.due_date, v.clickup_list_id)
      .first<{ id: number }>();
    return backWith(c, `/projects/${row!.id}`, { ok: "Project created." });
  } catch (err) {
    return backWith(c, "/projects/new", { err: `Couldn't create project: ${(err as Error).message}` });
  }
});

projects.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const env = c.env;
  const p = await env.DB.prepare("SELECT p.*, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ?")
    .bind(id)
    .first<Project & { client_name: string | null }>();
  if (!p) return c.notFound();
  const [open, closed, feed] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM tasks WHERE project_id = ? AND is_closed = 0 AND deleted = 0 ORDER BY due_at IS NULL, due_at").bind(id),
    env.DB.prepare("SELECT * FROM tasks WHERE project_id = ? AND is_closed = 1 AND deleted = 0 ORDER BY closed_at DESC LIMIT 25").bind(id),
    env.DB.prepare("SELECT * FROM activity WHERE project_id = ? ORDER BY ts DESC LIMIT 20").bind(id),
  ]);
  const late = (open.results as any[]).filter((t) => t.due_at && t.due_at < now()).length;
  const total = open.results.length + closed.results.length;

  return page(
    c,
    p.name,
    <>
      <div class="toolbar">
        <h1 style="margin:0">{p.name}</h1>
        <Badge tone={statusTone(p.status)}>{p.status}</Badge>
        <span style="flex:1" />
        <a class="btn ghost" href={`/projects/${id}/edit`}>Edit</a>
      </div>
      <p class="muted" style="margin-top:-6px">
        {p.client_id ? <a href={`/clients/${p.client_id}`}>{p.client_name}</a> : "No client linked — edit to assign one"}
        {p.due_date ? <> · due {p.due_date}</> : null}
      </p>
      <div class="stats">
        <Stat k="Open tasks" v={open.results.length} s={late ? <span style="color:var(--red)">{late} overdue</span> : "none overdue"} />
        <Stat k="Completed" v={closed.results.length} s={total ? `${Math.round((closed.results.length / total) * 100)}% of recent tasks` : undefined} />
        <Stat k="Budget" v={p.budget_cents != null ? money(p.budget_cents) : "—"} />
      </div>
      <div class="row">
        <div class="grow" style="flex:2">
          <div class="card"><h2>Open tasks</h2><TaskTable tasks={open.results as unknown as Task[]} tz={env.TIMEZONE} showClient={false} /></div>
          <div class="card"><h2>Recently completed</h2><TaskTable tasks={closed.results as unknown as Task[]} tz={env.TIMEZONE} showClient={false} /></div>
        </div>
        <div class="grow"><div class="card"><h2>Activity</h2><ActivityFeed items={feed.results as unknown as Activity[]} tz={env.TIMEZONE} /></div></div>
      </div>
    </>,
  );
});

projects.get("/:id{[0-9]+}/edit", async (c) => {
  const p = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(Number(c.req.param("id"))).first<Project>();
  if (!p) return c.notFound();
  return page(c, `Edit ${p.name}`, <><h1>Edit {p.name}</h1>{await projectForm(c, p)}</>);
});

projects.post("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const v = readProject(await c.req.parseBody());
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE projects SET name=?, client_id=?, status=?, budget_cents=?, start_date=?, due_date=?, clickup_list_id=?, updated_at=unixepoch() WHERE id=?",
      ).bind(v.name, v.client_id, v.status, v.budget_cents, v.start_date, v.due_date, v.clickup_list_id, id),
      c.env.DB.prepare("UPDATE tasks SET client_id = ? WHERE project_id = ?").bind(v.client_id, id),
    ]);
    return backWith(c, `/projects/${id}`, { ok: "Saved." });
  } catch (err) {
    return backWith(c, `/projects/${id}/edit`, { err: `Couldn't save: ${(err as Error).message}` });
  }
});
