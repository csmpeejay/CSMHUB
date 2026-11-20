import { Hono } from "hono";
import type { AppEnv, Env } from "./types";
import { requireStaff } from "./auth";
import { handleStripeWebhook } from "./integrations/stripe";
import { handleClickUpWebhook } from "./integrations/clickup";
import { runDailyDigest, runSyncs } from "./jobs";
import { dashboard } from "./routes/dashboard";
import { clients } from "./routes/clients";
import { projects } from "./routes/projects";
import { work } from "./routes/work";
import { connections } from "./routes/connections";

const app = new Hono<AppEnv>();

// Public endpoints — each verifies its own signature. Keep these outside Cloudflare Access (README step 6).
app.get("/health", (c) => c.json({ ok: true, app: c.env.APP_NAME }));
app.post("/webhooks/stripe", (c) => handleStripeWebhook(c.env, c.req.raw));
app.post("/webhooks/clickup", (c) => handleClickUpWebhook(c.env, c.req.raw));

// Everything else is staff-only.
app.use("*", requireStaff);

// Basic CSRF protection for form posts: the request must come from this site.
app.use("*", async (c, next) => {
  if (c.req.method === "POST") {
    const origin = c.req.header("origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.text("Cross-site request blocked", 403);
  }
  await next();
});

app.route("/", dashboard);
app.route("/", work);
app.route("/clients", clients);
app.route("/projects", projects);
app.route("/connections", connections);

app.notFound((c) => c.text("Not found", 404));
app.onError((err, c) => {
  console.error(err);
  return c.text(`Something went wrong: ${err.message}`, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "0 21 * * *") {
      ctx.waitUntil(runDailyDigest(env));
    } else {
      ctx.waitUntil(runSyncs(env));
    }
  },
} satisfies ExportedHandler<Env>;
