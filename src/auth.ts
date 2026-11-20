import type { MiddlewareHandler } from "hono";
import type { AppEnv, Env } from "./types";

/**
 * Staff login is handled by Cloudflare Access (Zero Trust) in front of the Worker.
 * Access adds a signed JWT (Cf-Access-Jwt-Assertion) to every request; we verify it here,
 * so the dashboard stays locked even if someone reaches the workers.dev URL directly.
 */

type Jwk = JsonWebKey & { kid: string };
let certCache: { at: number; keys: Jwk[] } | null = null;

async function accessKeys(teamDomain: string): Promise<Jwk[]> {
  if (certCache && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  const data = (await res.json()) as { keys: Jwk[] };
  certCache = { at: Date.now(), keys: data.keys };
  return data.keys;
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifyAccessJwt(env: Env, token: string): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN!.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));

  const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;

  const aud: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD!)) return null;
  if (payload.exp && payload.exp < Date.now() / 1000) return null;
  if (payload.iss && payload.iss !== `https://${team}`) return null;
  return (payload.email as string) ?? null;
}

export const requireStaff: MiddlewareHandler<AppEnv> = async (c, next) => {
  const env = c.env;
  let email: string | null = null;

  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = c.req.header("cf-access-jwt-assertion");
    if (token) {
      try {
        email = await verifyAccessJwt(env, token);
      } catch (err) {
        console.error("Access JWT check failed", err);
      }
    }
  } else if (env.DEV_USER_EMAIL) {
    // Local development only — set in .dev.vars, never in production.
    email = env.DEV_USER_EMAIL;
  }

  if (!email) {
    return c.html(
      `<!doctype html><meta name="viewport" content="width=device-width"><title>Locked</title>
       <body style="font-family:system-ui;max-width:560px;margin:15vh auto;padding:0 20px;color:#1f2937">
       <h1>CSM Hub is locked</h1>
       <p>Staff sign-in runs through Cloudflare Access. If you're setting this up, add an Access application for this
       hostname, then set <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code> in the Worker's variables.
       See the README for the exact steps.</p></body>`,
      401,
    );
  }
  const domain = env.ALLOWED_EMAIL_DOMAIN?.toLowerCase();
  if (domain && !email.toLowerCase().endsWith(`@${domain}`)) {
    return c.text(`${email} is not allowed to use this app.`, 403);
  }
  c.set("user", email);
  await next();
};
