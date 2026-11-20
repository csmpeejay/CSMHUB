import type { Env } from "./types";

export const now = () => Math.floor(Date.now() / 1000);

export function money(cents: number | null | undefined, currency = "aud"): string {
  const v = (cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency: currency.toUpperCase() }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

export function fmtDate(ts: number | null | undefined, tz = "Australia/Brisbane"): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(
    new Date(ts * 1000),
  );
}

export function fmtDateTime(ts: number | null | undefined, tz = "Australia/Brisbane"): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  }).format(new Date(ts * 1000));
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = now() - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function logActivity(
  env: Env,
  a: { kind: string; message: string; client_id?: number | null; project_id?: number | null; link?: string | null },
) {
  await env.DB.prepare("INSERT INTO activity (kind, message, client_id, project_id, link) VALUES (?, ?, ?, ?, ?)")
    .bind(a.kind, a.message, a.client_id ?? null, a.project_id ?? null, a.link ?? null)
    .run();
}

/** Returns true the first time a key is seen, false afterwards. Used to avoid duplicate alerts/webhooks. */
export async function claimOnce(env: Env, table: "alerts_sent" | "webhook_events", key: string, source = ""): Promise<boolean> {
  const sql =
    table === "alerts_sent"
      ? "INSERT OR IGNORE INTO alerts_sent (key) VALUES (?)"
      : "INSERT OR IGNORE INTO webhook_events (id, source) VALUES (?, ?)";
  const stmt = table === "alerts_sent" ? env.DB.prepare(sql).bind(key) : env.DB.prepare(sql).bind(key, source);
  const res = await stmt.run();
  return (res.meta.changes ?? 0) > 0;
}

/** Wraps a sync job so each run is recorded in sync_runs (shown on the Connections page). */
export async function recordRun<T>(env: Env, source: string, fn: () => Promise<T>): Promise<T> {
  const started = now();
  const row = await env.DB.prepare("INSERT INTO sync_runs (source, started_at) VALUES (?, ?) RETURNING id")
    .bind(source, started)
    .first<{ id: number }>();
  try {
    const result = await fn();
    await env.DB.prepare("UPDATE sync_runs SET finished_at = ?, ok = 1, summary = ? WHERE id = ?")
      .bind(now(), JSON.stringify(result ?? {}), row!.id)
      .run();
    return result;
  } catch (err) {
    await env.DB.prepare("UPDATE sync_runs SET finished_at = ?, ok = 0, summary = ? WHERE id = ?")
      .bind(now(), String((err as Error)?.message ?? err).slice(0, 1000), row!.id)
      .run();
    throw err;
  }
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** Runs D1 statements in chunks (D1 batches have size limits). */
export async function batchChunks(env: Env, stmts: D1PreparedStatement[], size = 50) {
  for (let i = 0; i < stmts.length; i += size) await env.DB.batch(stmts.slice(i, i + size));
}
