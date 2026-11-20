import type { Env } from "../types";

export const emailConfigured = (env: Env) => Boolean(env.RESEND_API_KEY);

/** Sends an email through Resend (https://resend.com). Never throws. */
export async function sendEmail(
  env: Env,
  msg: { to: string | string[]; subject: string; html: string; text?: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const to = (Array.isArray(msg.to) ? msg.to : msg.to.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (to.length === 0) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject: msg.subject, html: msg.html, text: msg.text }),
    });
    if (!res.ok) console.error("Resend error", res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error("Email send failed", err);
    return false;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
