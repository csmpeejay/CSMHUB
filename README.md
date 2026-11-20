# CSM Hub

Commonsense Marketing's internal project hub: clients, projects, tasks and billing on one screen.

- **Stripe** – customers become clients automatically; invoices and subscriptions (monthly recurring revenue) sync every 15 minutes and instantly via webhook.
- **ClickUp** – every list becomes a project; tasks sync every 15 minutes and instantly via webhook. Link a client to a ClickUp folder and all its lists attach to that client.
- **Slack** – alerts for payments, failed payments, overdue invoices, cancelled subscriptions and completed tasks, plus a 7am daily summary.
- **Email** (Resend) – daily summary email.
- Staff login through **Cloudflare Access**; runs on **Cloudflare Workers + D1** (free tier is enough to start).

Pages: Dashboard · Clients (with notes and activity) · Projects · Tasks · Invoices & Subscriptions · Activity · Connections (status, "Sync now", test buttons).

---

## One-time setup

### 1. Create the database
Cloudflare dashboard → **Storage & Databases → D1 SQL Database → Create** → name it `csm-hub-db`.
Copy the **Database ID** and paste it into `wrangler.jsonc` in place of `REPLACE_WITH_D1_DATABASE_ID` (edit the file on GitHub and commit).

### 2. Connect this repo to Cloudflare
**Workers & Pages → Create → Import a repository** → choose `CSMHUB`.

| Setting | Value |
|---|---|
| Project name | `csm-hub` |
| Build command | *(leave empty)* |
| Deploy command | `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy` |
| Production branch | `main` |

Every push to `main` now applies any new database migrations and deploys.
If the migration step fails with a permissions error, edit the build's API token (Settings → Build) and add **D1: Edit**.

### 3. Add the secrets
Worker → **Settings → Variables and Secrets → Add** (type **Secret**):

| Name | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys. Best: a **restricted key** with *Read* on Customers, Invoices, Subscriptions, Products, Prices. |
| `STRIPE_WEBHOOK_SECRET` | Step 4 below (`whsec_...`). |
| `CLICKUP_API_TOKEN` | ClickUp → Settings → Apps → API Token (`pk_...`). |
| `CLICKUP_TEAM_ID` | The number after `app.clickup.com/` in your ClickUp URL. |
| `SLACK_BOT_TOKEN` | Step 5 below (`xoxb-...`). |
| `SLACK_CHANNEL_ID` | Right-click the Slack channel → View channel details → ID at the bottom (`C0...`). |
| `RESEND_API_KEY` | resend.com → API Keys. Verify `commonsensemarketing.com.au` under Domains first (adds SPF/DKIM records). |
| `ACCESS_TEAM_DOMAIN` | Step 6, e.g. `commonsense.cloudflareaccess.com` |
| `ACCESS_AUD` | Step 6 – the Access application's **Application Audience (AUD) Tag** |

Plain settings (app URL, sender address, who gets the daily email, allowed email domain, timezone) live in `vars` in `wrangler.jsonc`.

### 4. Stripe webhook
Stripe → Developers → **Webhooks → Add endpoint**
- URL: `https://hub.commonsensemarketing.com.au/webhooks/stripe`
- Events: `customer.created`, `customer.updated`, `invoice.created`, `invoice.finalized`, `invoice.updated`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### 5. Slack app
api.slack.com/apps → **Create New App → From scratch** → *OAuth & Permissions* → Bot Token Scopes: `chat:write`, `chat:write.public` → **Install to Workspace** → copy the Bot User OAuth Token into `SLACK_BOT_TOKEN`. Invite the bot to your channel (`/invite @YourAppName`).

### 6. Custom domain + staff login
1. Worker → **Settings → Domains & Routes → Add → Custom domain** → `hub.commonsensemarketing.com.au` (the domain's DNS must be on Cloudflare).
2. **Zero Trust → Access → Applications → Add → Self-hosted**
   - Domain: `hub.commonsensemarketing.com.au` (also add `csm-hub.<your-subdomain>.workers.dev`)
   - Policy: *Allow* → Include → Emails ending in `@commonsensemarketing.com.au`
3. Add a second Access application for the **webhook paths** with policy action **Bypass** → Everyone:
   `hub.commonsensemarketing.com.au/webhooks/*` and `/health`.
4. Copy the AUD tag (application overview) and your team domain (Zero Trust → Settings → Custom Pages) into the secrets `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`.

The app verifies the Access token itself, so the dashboard stays locked even if Access is misconfigured.

### 7. First sync
Open the hub → **Connections** → *Sync now* for Stripe and ClickUp → **Register webhook** for ClickUp → *Send test message* for Slack and *Send test email*.
Then on each client, choose their **ClickUp folder** so projects and tasks attach to them.

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars        # fill in test keys; DEV_USER_EMAIL skips Access locally
npm run db:migrate:local
npm run dev                            # http://localhost:8787
npm run typecheck
```

Test cron jobs locally: `npx wrangler dev --test-scheduled`, then open
`http://localhost:8787/__scheduled?cron=*/15+*+*+*+*` (sync) or `...?cron=0+21+*+*+*` (daily summary).

Schema changes: `npx wrangler d1 migrations create DB <name>`, write SQL in the new file, commit — deploys apply it.

## How it fits together

```
src/
  index.ts              routes, webhooks, cron entry point
  auth.ts               Cloudflare Access token check
  jobs.ts               15-minute sync, overdue alerts, daily summary
  integrations/
    stripe.ts           customers → clients, invoices, subscriptions, webhook
    clickup.ts          tasks → projects, folder → client linking, webhook
    slack.ts            chat.postMessage
    email.ts            Resend
  routes/               dashboard, clients, projects, tasks/invoices, connections
  views/                layout + shared tables
migrations/0001_init.sql
```

Schedules (UTC): `*/15 * * * *` sync + alerts, `0 21 * * *` daily summary (7:00am Brisbane).
