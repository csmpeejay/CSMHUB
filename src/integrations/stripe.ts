import type { Env } from "../types";
import { batchChunks, claimOnce, getSetting, hmacSha256Hex, logActivity, money, now, safeEqual, setSetting } from "../util";
import { notifySlack } from "./slack";

const API = "https://api.stripe.com/v1";

export const stripeConfigured = (env: Env) => Boolean(env.STRIPE_SECRET_KEY);

async function stripeGet<T = any>(env: Env, path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

/** Iterates every page of a Stripe list endpoint. */
async function* stripeList(env: Env, path: string, params: Record<string, string> = {}, maxPages = 50) {
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const p: Record<string, string> = { limit: "100", ...params };
    if (startingAfter) p.starting_after = startingAfter;
    const data = await stripeGet<{ data: any[]; has_more: boolean }>(env, path, p);
    for (const item of data.data) yield item;
    if (!data.has_more || data.data.length === 0) return;
    startingAfter = data.data[data.data.length - 1].id;
  }
}

// ---------- Upserts ----------

/** Links a Stripe customer to a client: by customer id, else by email, else creates a new client. */
export async function upsertCustomer(env: Env, cust: any): Promise<number | null> {
  if (!cust || cust.deleted) return null;
  const name: string = cust.name || cust.description || cust.email || cust.id;
  const email: string | null = cust.email ?? null;

  const existing = await env.DB.prepare("SELECT id FROM clients WHERE stripe_customer_id = ?").bind(cust.id).first<{ id: number }>();
  if (existing) {
    await env.DB.prepare("UPDATE clients SET email = COALESCE(email, ?), updated_at = unixepoch() WHERE id = ?")
      .bind(email, existing.id)
      .run();
    return existing.id;
  }
  if (email) {
    const byEmail = await env.DB.prepare(
      "SELECT id FROM clients WHERE stripe_customer_id IS NULL AND lower(email) = lower(?) LIMIT 1",
    )
      .bind(email)
      .first<{ id: number }>();
    if (byEmail) {
      await env.DB.prepare("UPDATE clients SET stripe_customer_id = ?, updated_at = unixepoch() WHERE id = ?")
        .bind(cust.id, byEmail.id)
        .run();
      return byEmail.id;
    }
  }
  const created = await env.DB.prepare(
    "INSERT INTO clients (name, email, stripe_customer_id) VALUES (?, ?, ?) RETURNING id",
  )
    .bind(name, email, cust.id)
    .first<{ id: number }>();
  await logActivity(env, { kind: "client_created", client_id: created!.id, message: `New client from Stripe: ${name}` });
  return created!.id;
}

async function clientIdForCustomer(env: Env, customerId: string | null): Promise<number | null> {
  if (!customerId) return null;
  const r = await env.DB.prepare("SELECT id FROM clients WHERE stripe_customer_id = ?").bind(customerId).first<{ id: number }>();
  return r?.id ?? null;
}

function invoiceSubscriptionId(inv: any): string | null {
  // Older API versions: inv.subscription. Newer (2025+): inv.parent.subscription_details.subscription
  const s = inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
  return typeof s === "string" ? s : s?.id ?? null;
}

function invoiceStmt(env: Env, inv: any, clientId: number | null): D1PreparedStatement {
  const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
  const description =
    inv.description ?? inv.lines?.data?.[0]?.description ?? null;
  return env.DB.prepare(
    `INSERT INTO invoices (id, client_id, stripe_customer_id, number, status, currency, total, amount_paid, amount_remaining,
       description, subscription_id, hosted_url, created_at, due_at, paid_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       client_id = COALESCE(excluded.client_id, invoices.client_id), status = excluded.status, number = excluded.number,
       total = excluded.total, amount_paid = excluded.amount_paid, amount_remaining = excluded.amount_remaining,
       description = excluded.description, hosted_url = excluded.hosted_url, due_at = excluded.due_at, paid_at = excluded.paid_at`,
  ).bind(
    inv.id,
    clientId,
    customerId,
    inv.number ?? null,
    inv.status ?? null,
    inv.currency ?? "aud",
    inv.total ?? 0,
    inv.amount_paid ?? 0,
    inv.amount_remaining ?? 0,
    description,
    invoiceSubscriptionId(inv),
    inv.hosted_invoice_url ?? null,
    inv.created ?? null,
    inv.due_date ?? null,
    inv.status_transitions?.paid_at ?? null,
  );
}

/** Normalises a subscription's recurring items to a monthly amount in cents. */
function monthlyCents(sub: any): number {
  let total = 0;
  for (const item of sub.items?.data ?? []) {
    const price = item.price ?? item.plan;
    if (!price) continue;
    const amount = (price.unit_amount ?? price.amount ?? 0) * (item.quantity ?? 1);
    const rec = price.recurring ?? { interval: price.interval, interval_count: price.interval_count };
    const count = rec?.interval_count || 1;
    const perMonth: Record<string, number> = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };
    total += (amount * (perMonth[rec?.interval] ?? 1)) / count;
  }
  // Apply a simple percent-off discount if present.
  const pct = sub.discount?.coupon?.percent_off ?? sub.discounts?.[0]?.coupon?.percent_off;
  if (pct) total = total * (1 - pct / 100);
  return Math.round(total);
}

function subscriptionStmt(env: Env, sub: any, clientId: number | null): D1PreparedStatement {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  const desc = (sub.items?.data ?? [])
    .map((i: any) => i.price?.nickname || i.price?.product?.name || i.plan?.nickname)
    .filter(Boolean)
    .join(", ") || sub.description || null;
  return env.DB.prepare(
    `INSERT INTO subscriptions (id, client_id, stripe_customer_id, status, currency, mrr_cents, description, current_period_end, canceled_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET client_id = COALESCE(excluded.client_id, subscriptions.client_id), status = excluded.status,
       mrr_cents = excluded.mrr_cents, description = excluded.description, current_period_end = excluded.current_period_end,
       canceled_at = excluded.canceled_at`,
  ).bind(
    sub.id,
    clientId,
    customerId,
    sub.status ?? null,
    sub.currency ?? "aud",
    monthlyCents(sub),
    desc,
    periodEnd,
    sub.canceled_at ?? null,
    sub.created ?? null,
  );
}

// ---------- Scheduled sync ----------

export async function syncStripe(env: Env) {
  const summary = { customers: 0, invoices: 0, subscriptions: 0, full: false };
  const lastFull = Number((await getSetting(env, "stripe_last_full_sync")) ?? 0);
  const full = now() - lastFull > 24 * 3600; // full refresh once a day, incremental otherwise
  summary.full = full;

  // Customers → clients
  const customerMap = new Map<string, number | null>();
  for await (const cust of stripeList(env, "/customers")) {
    customerMap.set(cust.id, await upsertCustomer(env, cust));
    summary.customers++;
  }
  const cid = (c: any) => customerMap.get(typeof c === "string" ? c : c?.id) ?? null;

  // Invoices: everything on a full run; recent + still-open on incremental runs.
  const invStmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  const push = (inv: any) => {
    if (seen.has(inv.id)) return;
    seen.add(inv.id);
    invStmts.push(invoiceStmt(env, inv, cid(inv.customer)));
  };
  if (full) {
    for await (const inv of stripeList(env, "/invoices")) push(inv);
  } else {
    const since = String(now() - 40 * 86400);
    for await (const inv of stripeList(env, "/invoices", { "created[gte]": since })) push(inv);
    for await (const inv of stripeList(env, "/invoices", { status: "open" })) push(inv);
  }
  await batchChunks(env, invStmts);
  summary.invoices = invStmts.length;

  // Subscriptions (all statuses, so cancellations are reflected).
  const subStmts: D1PreparedStatement[] = [];
  for await (const sub of stripeList(env, "/subscriptions", { status: "all" })) {
    subStmts.push(subscriptionStmt(env, sub, cid(sub.customer)));
  }
  await batchChunks(env, subStmts);
  summary.subscriptions = subStmts.length;

  if (full) await setSetting(env, "stripe_last_full_sync", String(now()));
  return summary;
}

// ---------- Webhook ----------

async function verifyStripeSignature(secret: string, header: string | null, body: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!t || Math.abs(now() - t) > 300) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  const sigs = header
    .split(",")
    .filter((p) => p.trim().startsWith("v1="))
    .map((p) => p.trim().slice(3));
  return sigs.some((s) => safeEqual(s, expected));
}

export async function handleStripeWebhook(env: Env, req: Request): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Stripe webhook secret not set", { status: 500 });
  const body = await req.text();
  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, req.headers.get("stripe-signature"), body))) {
    return new Response("Invalid signature", { status: 400 });
  }
  const event = JSON.parse(body);
  if (!(await claimOnce(env, "webhook_events", event.id, "stripe"))) return new Response("duplicate", { status: 200 });

  const obj = event.data?.object ?? {};
  const type: string = event.type;

  if (type.startsWith("customer.") && !type.startsWith("customer.subscription")) {
    if (type !== "customer.deleted") await upsertCustomer(env, obj);
  } else if (type.startsWith("invoice.")) {
    const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id ?? null;
    let clientId = await clientIdForCustomer(env, customerId);
    if (!clientId && customerId && stripeConfigured(env)) {
      clientId = await upsertCustomer(env, await stripeGet(env, `/customers/${customerId}`));
    }
    await invoiceStmt(env, obj, clientId).run();
    const client = clientId
      ? await env.DB.prepare("SELECT name, slack_channel_id FROM clients WHERE id = ?").bind(clientId).first<{ name: string; slack_channel_id: string | null }>()
      : null;
    const who = client?.name ?? obj.customer_name ?? obj.customer_email ?? "Unknown customer";
    const link = `${env.APP_URL}/clients/${clientId ?? ""}`;

    if (type === "invoice.paid") {
      const msg = `💰 ${who} paid ${money(obj.amount_paid, obj.currency)}${obj.number ? ` (invoice ${obj.number})` : ""}`;
      await logActivity(env, { kind: "invoice_paid", client_id: clientId, message: msg, link: obj.hosted_invoice_url });
      await notifySlack(env, msg, { link });
    } else if (type === "invoice.payment_failed") {
      const msg = `⚠️ Payment failed: ${who} — ${money(obj.amount_due, obj.currency)}${obj.number ? ` (invoice ${obj.number})` : ""}`;
      await logActivity(env, { kind: "invoice_failed", client_id: clientId, message: msg, link: obj.hosted_invoice_url });
      await notifySlack(env, msg, { link });
    }
  } else if (type.startsWith("customer.subscription.")) {
    const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id ?? null;
    const clientId = await clientIdForCustomer(env, customerId);
    await subscriptionStmt(env, obj, clientId).run();
    if (type === "customer.subscription.deleted") {
      const c = clientId ? await env.DB.prepare("SELECT name FROM clients WHERE id = ?").bind(clientId).first<{ name: string }>() : null;
      const msg = `🔚 Subscription cancelled${c ? ` for ${c.name}` : ""} (${money(monthlyCents(obj), obj.currency)}/mo)`;
      await logActivity(env, { kind: "subscription_cancelled", client_id: clientId, message: msg });
      await notifySlack(env, msg);
    }
  }
  return new Response("ok");
}
