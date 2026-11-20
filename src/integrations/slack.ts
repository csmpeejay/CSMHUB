import type { Env } from "../types";

export const slackConfigured = (env: Env) => Boolean(env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID);

/**
 * Posts a message to the team channel (SLACK_CHANNEL_ID) or a specific channel.
 * Never throws — a Slack outage should not break syncs or webhooks.
 */
export async function notifySlack(
  env: Env,
  text: string,
  opts: { channel?: string | null; link?: string } = {},
): Promise<boolean> {
  const channel = opts.channel || env.SLACK_CHANNEL_ID;
  if (!env.SLACK_BOT_TOKEN || !channel) return false;
  const blocks: any[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (opts.link) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${opts.link}|Open in ${env.APP_NAME}>` }],
    });
  }
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, blocks, unfurl_links: false }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) console.error("Slack error", data.error);
    return data.ok;
  } catch (err) {
    console.error("Slack request failed", err);
    return false;
  }
}

/** Checks the bot token is valid (used on the Connections page). */
export async function slackAuthTest(env: Env): Promise<{ ok: boolean; team?: string; error?: string }> {
  if (!env.SLACK_BOT_TOKEN) return { ok: false, error: "SLACK_BOT_TOKEN not set" };
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  return res.json();
}
