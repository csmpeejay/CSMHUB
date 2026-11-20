import type { Child } from "hono/jsx";
import { raw } from "hono/html";

const css = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2433;--muted:#6b7280;--line:#e5e7eb;--brand:#0f766e;--brand-ink:#fff;--red:#b91c1c;--amber:#b45309;--green:#15803d;--blue:#1d4ed8}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
.shell{display:flex;min-height:100vh}
nav.side{width:220px;background:#11272b;color:#cfe3e1;padding:18px 12px;flex-shrink:0;position:sticky;top:0;height:100vh}
nav.side .logo{font-weight:700;font-size:17px;color:#fff;padding:4px 10px 18px;letter-spacing:.2px}
nav.side a{display:block;color:#cfe3e1;padding:8px 10px;border-radius:8px;margin-bottom:2px}
nav.side a:hover{background:#1c3a3f;text-decoration:none}nav.side a.on{background:var(--brand);color:#fff}
nav.side .who{position:absolute;bottom:16px;left:22px;right:12px;font-size:12px;color:#86a8a5;word-break:break-all}
main{flex:1;padding:26px 32px;max-width:1280px}
h1{font-size:22px;margin:0 0 18px}h2{font-size:16px;margin:0 0 12px}
.row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}.grow{flex:1;min-width:300px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}.stat .v{font-size:24px;font-weight:650;margin-top:2px}
.stat .s{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.3px;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{color:var(--muted)}.small{font-size:12px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#eef2f7;color:#374151;white-space:nowrap}
.b-green{background:#dcfce7;color:var(--green)}.b-red{background:#fee2e2;color:var(--red)}.b-amber{background:#fef3c7;color:var(--amber)}.b-blue{background:#dbeafe;color:var(--blue)}
.btn{display:inline-block;background:var(--brand);color:var(--brand-ink);border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
.btn:hover{text-decoration:none;filter:brightness(1.08)}.btn.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
form.inline{display:inline}
label{display:block;font-weight:600;margin:10px 0 4px}input,select,textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff}
textarea{min-height:90px}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap}.toolbar input,.toolbar select{width:auto}
.flash{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;padding:10px 14px;border-radius:10px;margin-bottom:16px}
.flash.err{background:#fef2f2;border-color:#fecaca;color:#991b1b}
.feed li{list-style:none;padding:8px 0;border-bottom:1px solid var(--line)}.feed{padding:0;margin:0}.feed li:last-child{border:0}
@media(max-width:800px){.shell{display:block}nav.side{width:auto;height:auto;position:static;display:flex;flex-wrap:wrap;gap:4px}nav.side .who{display:none}main{padding:18px}.formgrid{grid-template-columns:1fr}}
`;

const NAV: [string, string][] = [
  ["/", "Dashboard"],
  ["/clients", "Clients"],
  ["/projects", "Projects"],
  ["/tasks", "Tasks"],
  ["/invoices", "Invoices"],
  ["/activity", "Activity"],
  ["/connections", "Connections"],
];

export function Layout(props: { title: string; path: string; user: string; appName: string; flash?: string | null; error?: string | null; children: Child }) {
  const active = (href: string) => (href === "/" ? props.path === "/" : props.path.startsWith(href));
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{`${props.title} · ${props.appName}`}</title>
          <style>{raw(css)}</style>
        </head>
        <body>
          <div class="shell">
            <nav class="side">
              <div class="logo">{props.appName}</div>
              {NAV.map(([href, label]) => (
                <a href={href} class={active(href) ? "on" : ""}>
                  {label}
                </a>
              ))}
              <div class="who">{props.user}</div>
            </nav>
            <main>
              {props.flash ? <div class="flash">{props.flash}</div> : null}
              {props.error ? <div class="flash err">{props.error}</div> : null}
              {props.children}
            </main>
          </div>
        </body>
      </html>
    </>
  );
}
