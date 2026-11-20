import type { Env } from "../types";
import { batchChunks, claimOnce, getSetting, hmacSha256Hex, logActivity, now, safeEqual, setSetting } from "../util";
import { notifySlack } from "./slack";

const API = "https://api.clickup.com/api/v2";

export const clickUpConfigured = (env: Env) => Boolean(env.CLICKUP_API_TOKEN && env.CLICKUP_TEAM_ID);

async function cu<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: env.CLICKUP_API_TOKEN!, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`ClickUp ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

const msToSec = (v: any): number | null => (v ? Math.floor(Number(v) / 1000) : null);

/** Finds (or auto-creates) the hub project for a ClickUp list, and works out its client. */
async function projectForList(
  env: Env,
  cache: Map<string, { project_id: number; client_id: number | null }>,
  list: { id: string; name: string },
  folder: { id?: string; name?: string; hidden?: boolean } | undefined,
) {
  const hit = cache.get(list.id);
  if (hit) return hit;

  let row = await env.DB.prepare("SELECT id, client_id FROM projects WHERE clickup_list_id = ?")
    .bind(list.id)
    .first<{ id: number; client_id: number | null }>();

  if (!row) {
    const folderClient = folder?.id
      ? await env.DB.prepare("SELECT id FROM clients WHERE clickup_folder_id = ?").bind(folder.id).first<{ id: number }>()
      : null;
    const name = folder?.name && !folder.hidden ? `${folder.name} › ${list.name}` : list.name;
    row = await env.DB.prepare("INSERT INTO projects (name, clickup_list_id, client_id) VALUES (?, ?, ?) RETURNING id, client_id")
      .bind(name, list.id, folderClient?.id ?? null)
      .first<{ id: number; client_id: number | null }>();
  }
  const v = { project_id: row!.id, client_id: row!.client_id };
  cache.set(list.id, v);
  return v;
}

function taskStmt(env: Env, t: any, link: { project_id: number; client_id: number | null }): D1PreparedStatement {
  const statusType: string = t.status?.type ?? "";
  const isClosed = statusType === "closed" || statusType === "done" ? 1 : 0;
  return env.DB.prepare(
    `INSERT INTO tasks (id, list_id, list_name, folder_id, project_id, client_id, name, status, is_closed, assignees, priority, due_at, url, updated_at, closed_at, deleted)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET list_id = excluded.list_id, list_name = excluded.list_name, folder_id = excluded.folder_id,
       project_id = excluded.project_id, client_id = excluded.client_id, name = excluded.name, status = excluded.status,
       is_closed = excluded.is_closed, assignees = excluded.assignees, priority = excluded.priority, due_at = excluded.due_at,
       url = excluded.url, updated_at = excluded.updated_at, closed_at = excluded.closed_at, deleted = 0`,
  ).bind(
    t.id,
    t.list?.id ?? "",
    t.list?.name ?? null,
    t.folder?.id ?? null,
    link.project_id,
    link.client_id,
    t.name ?? "(untitled)",
    t.status?.status ?? null,
    isClosed,
    (t.assignees ?? []).map((a: any) => a.username || a.email).filter(Boolean).join(", ") || null,
    t.priority?.priority ?? null,
    msToSec(t.due_date),
    t.url ?? null,
    msToSec(t.date_updated),
    msToSec(t.date_closed ?? t.date_done),
  );
}

/** Pulls tasks changed since the last run (everything on the first run). */
export async function syncClickUp(env: Env) {
  const lastMs = Number((await getSetting(env, "clickup_last_sync_ms")) ?? 0);
  const startedMs = Date.now();
  const cache = new Map<string, { project_id: number; client_id: number | null }>();
  const stmts: D1PreparedStatement[] = [];

  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({
      page: String(page),
      include_closed: "true",
      subtasks: "true",
      order_by: "updated",
    });
    if (lastMs) qs.set("date_updated_gt", String(lastMs - 5 * 60 * 1000)); // 5 min overlap for safety
    const data = await cu<{ tasks: any[]; last_page?: boolean }>(env, `/team/${env.CLICKUP_TEAM_ID}/task?${qs}`);
    for (const t of data.tasks) {
      if (!t.list?.id) continue;
      const link = await projectForList(env, cache, t.list, t.folder);
      stmts.push(taskStmt(env, t, link));
    }
    if (data.last_page !== false || data.tasks.length === 0) break;
  }
  await batchChunks(env, stmts);
  await setSetting(env, "clickup_last_sync_ms", String(startedMs));
  return { tasks: stmts.length, incremental: Boolean(lastMs) };
}

/** Lists folders in the workspace so a client can be linked to one (Client edit page). */
export async function listClickUpFolders(env: Env): Promise<{ id: string; name: string; space: string }[]> {
  if (!clickUpConfigured(env)) return [];
  const cached = await getSetting(env, "clickup_folders_cache");
  if (cached) {
    const c = JSON.parse(cached);
    if (now() - c.at < 3600) return c.folders;
  }
  const spaces = await cu<{ spaces: any[] }>(env, `/team/${env.CLICKUP_TEAM_ID}/space?archived=false`);
  const folders: { id: string; name: string; space: string }[] = [];
  for (const s of spaces.spaces) {
    const f = await cu<{ folders: any[] }>(env, `/space/${s.id}/folder?archived=false`);
    for (const x of f.folders) folders.push({ id: x.id, name: x.name, space: s.name });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  await setSetting(env, "clickup_folders_cache", JSON.stringify({ at: now(), folders }));
  return folders;
}

/** Re-links a client's tasks and projects after their ClickUp folder changes. */
export async function applyFolderToClient(env: Env, clientId: number, folderId: string | null) {
  if (!folderId) return;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE projects SET client_id = ? WHERE client_id IS NULL AND clickup_list_id IN (SELECT DISTINCT list_id FROM tasks WHERE folder_id = ?)",
    ).bind(clientId, folderId),
    env.DB.prepare(
      "UPDATE tasks SET client_id = (SELECT client_id FROM projects WHERE projects.id = tasks.project_id) WHERE folder_id = ?",
    ).bind(folderId),
  ]);
}

// ---------- Webhook ----------

const WEBHOOK_EVENTS = ["taskCreated", "taskUpdated", "taskStatusUpdated", "taskDeleted", "taskMoved", "taskAssigneeUpdated", "taskDueDateUpdated"];

/** Registers a ClickUp webhook pointing at this Worker and stores its signing secret. */
export async function registerClickUpWebhook(env: Env) {
  const endpoint = `${env.APP_URL}/webhooks/clickup`;
  const existing = await cu<{ webhooks: any[] }>(env, `/team/${env.CLICKUP_TEAM_ID}/webhook`);
  for (const w of existing.webhooks ?? []) {
    if (w.endpoint === endpoint) await cu(env, `/webhook/${w.id}`, { method: "DELETE" });
  }
  const created = await cu<{ id: string; webhook: { secret: string } }>(env, `/team/${env.CLICKUP_TEAM_ID}/webhook`, {
    method: "POST",
    body: JSON.stringify({ endpoint, events: WEBHOOK_EVENTS }),
  });
  await setSetting(env, "clickup_webhook_secret", created.webhook.secret);
  await setSetting(env, "clickup_webhook_id", created.id);
  return created.id;
}

export async function handleClickUpWebhook(env: Env, req: Request): Promise<Response> {
  const body = await req.text();
  const secret = env.CLICKUP_WEBHOOK_SECRET || (await getSetting(env, "clickup_webhook_secret"));
  if (!secret) return new Response("ClickUp webhook not registered", { status: 500 });
  const expected = await hmacSha256Hex(secret, body);
  if (!safeEqual(req.headers.get("x-signature") ?? "", expected)) return new Response("Invalid signature", { status: 400 });

  const payload = JSON.parse(body);
  const taskId: string | undefined = payload.task_id;
  if (!taskId) return new Response("ok");
  const eventKey = `${payload.webhook_id}:${payload.event}:${taskId}:${payload.history_items?.[0]?.id ?? Date.now()}`;
  if (!(await claimOnce(env, "webhook_events", eventKey, "clickup"))) return new Response("duplicate");

  if (payload.event === "taskDeleted") {
    await env.DB.prepare("UPDATE tasks SET deleted = 1 WHERE id = ?").bind(taskId).run();
    return new Response("ok");
  }

  const before = await env.DB.prepare("SELECT is_closed FROM tasks WHERE id = ?").bind(taskId).first<{ is_closed: number }>();
  const t = await cu(env, `/task/${taskId}`);
  if (!t.list?.id) return new Response("ok");
  const link = await projectForList(env, new Map(), t.list, t.folder);
  await taskStmt(env, t, link).run();

  const nowClosed = t.status?.type === "closed" || t.status?.type === "done";
  if (nowClosed && before && !before.is_closed) {
    const project = await env.DB.prepare(
      "SELECT p.name, c.name AS client, c.slack_channel_id FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ?",
    )
      .bind(link.project_id)
      .first<{ name: string; client: string | null; slack_channel_id: string | null }>();
    const msg = `✅ Done: *${t.name}*${project?.client ? ` — ${project.client}` : ""}${project ? ` (${project.name})` : ""}`;
    await logActivity(env, { kind: "task_done", client_id: link.client_id, project_id: link.project_id, message: msg, link: t.url });
    await notifySlack(env, msg, { link: t.url });
  }
  return new Response("ok");
}
