export interface Env {
  DB: D1Database;

  // Plain vars (wrangler.jsonc)
  APP_NAME: string;
  APP_URL: string;
  EMAIL_FROM: string;
  DIGEST_EMAILS: string;
  ALLOWED_EMAIL_DOMAIN?: string;
  TIMEZONE?: string;
  ACCESS_TEAM_DOMAIN?: string; // e.g. commonsense.cloudflareaccess.com
  ACCESS_AUD?: string; // Access application "Application Audience (AUD) Tag"

  // Secrets
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  CLICKUP_API_TOKEN?: string;
  CLICKUP_TEAM_ID?: string;
  CLICKUP_WEBHOOK_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_CHANNEL_ID?: string;
  RESEND_API_KEY?: string;
  DEV_USER_EMAIL?: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: string } };

export interface Client {
  id: number;
  name: string;
  email: string | null;
  status: string;
  stripe_customer_id: string | null;
  clickup_folder_id: string | null;
  slack_channel_id: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface Project {
  id: number;
  client_id: number | null;
  name: string;
  status: string;
  clickup_list_id: string | null;
  budget_cents: number | null;
  start_date: string | null;
  due_date: string | null;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: string;
  list_id: string;
  list_name: string | null;
  folder_id: string | null;
  project_id: number | null;
  client_id: number | null;
  name: string;
  status: string | null;
  is_closed: number;
  assignees: string | null;
  priority: string | null;
  due_at: number | null;
  url: string | null;
  updated_at: number | null;
  closed_at: number | null;
}

export interface Invoice {
  id: string;
  client_id: number | null;
  stripe_customer_id: string | null;
  number: string | null;
  status: string | null;
  currency: string | null;
  total: number;
  amount_paid: number;
  amount_remaining: number;
  description: string | null;
  subscription_id: string | null;
  hosted_url: string | null;
  created_at: number | null;
  due_at: number | null;
  paid_at: number | null;
}

export interface Activity {
  id: number;
  ts: number;
  kind: string;
  client_id: number | null;
  project_id: number | null;
  message: string;
  link: string | null;
}
