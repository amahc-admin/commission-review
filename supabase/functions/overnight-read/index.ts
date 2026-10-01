// Overnight read: Shopify orders -> commission flags + the AI's read,
// loaded onto the Commission Review board. Runs nightly from pg_cron (see
// SETUP.md), or by hand:
//
//   POST /functions/v1/overnight-read?since=2026-09-01&max_ai=25
//   header  x-cron-secret: <CRON_SECRET>
//
// Secrets it reads (Edge Functions -> Secrets): SHOPIFY_STORE_DOMAIN,
// SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, ANTHROPIC_API_KEY, CRON_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// Safe to re-run: flags upsert by order + kind, an order whose Shopify
// version was already read is skipped (no second AI call), and a rep's
// answer or a reviewer's decision is never overwritten.

import { run } from "./run.ts";

Deno.serve(async (req) => {
  // Only pg_cron (or someone holding CRON_SECRET) may start a run -- it
  // spends AI credit and reads every order.
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  const result = await run(new URL(req.url).searchParams);
  return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: { "Content-Type": "application/json" } });
});
