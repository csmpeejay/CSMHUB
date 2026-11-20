import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { AppEnv } from "../types";
import { Layout } from "../views/layout";

/** Renders a page inside the app shell. ?ok= and ?err= in the URL show a message banner. */
export function page(c: Context<AppEnv>, title: string, body: Child) {
  return c.html(
    <Layout
      title={title}
      path={new URL(c.req.url).pathname}
      user={c.get("user")}
      appName={c.env.APP_NAME}
      flash={c.req.query("ok")}
      error={c.req.query("err")}
    >
      {body}
    </Layout>,
  );
}

export const backWith = (c: Context<AppEnv>, path: string, msg: { ok?: string; err?: string }) => {
  const u = new URL(path, c.req.url);
  if (msg.ok) u.searchParams.set("ok", msg.ok);
  if (msg.err) u.searchParams.set("err", msg.err);
  return c.redirect(u.pathname + u.search, 303);
};

export const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

export const centsFrom = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
