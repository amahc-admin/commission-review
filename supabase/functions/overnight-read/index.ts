// Overnight read: Shopify orders -> commission flags + the AI's read,
// loaded onto the Commission Review board. Runs nightly from pg_cron (see
// SETUP.md), or by hand:
//
//   POST /functions/v1/overnight-read?since=2026-09-01&max_ai=25
//   header  x-cron-secret: <CRON_SECRET>
//
// or from the board's "Sync from Shopify" button, with a reviewer's own
// passcode in the body: { "person_id", "passcode" }.
//
// Secrets it reads (Edge Functions -> Secrets): SHOPIFY_STORE_DOMAIN,
// SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, ANTHROPIC_API_KEY, CRON_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// Safe to re-run: flags upsert by order + kind, an order whose Shopify
// version was already read is skipped (no second AI call), and a rep's
// answer or a reviewer's decision is never overwritten.

import { run } from "./run.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function db(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/" + path, {
    ...init,
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: "Bearer " + key } : {}), "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// Only pg_cron (holding CRON_SECRET) or a reviewer (their own passcode)
// may start a run -- it reads every order and can spend AI credit.
async function allowed(req: Request): Promise<boolean> {
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") === secret) return true;
  try {
    const { person_id, passcode } = await req.clone().json();
    if (!person_id || !passcode) return false;
    const res = await db("rpc/commission_login", { method: "POST", body: JSON.stringify({ p_person_id: person_id, p_passcode: passcode }) });
    if (!res.ok) return false;
    const [who] = await res.json();
    return who?.role === "reviewer";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!(await allowed(req))) return json({ ok: false, error: "forbidden" }, 403);

  // One run at a time (the nightly run and a button press could overlap,
  // and Aircall only allows 60 requests a minute).
  const recent = new Date(Date.now() - 4 * 60_000).toISOString();
  const busy = await db(`commission_runs?status=eq.running&started_at=gte.${recent}&select=id`).then((r) => r.ok ? r.json() : []);
  if (busy.length) return json({ ok: false, busy: true, error: "a sync is already running — try again in a couple of minutes" }, 409);

  const result = await run(new URL(req.url).searchParams);
  return json(result, result.ok ? 200 : 500);
});
