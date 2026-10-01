// deno test --allow-env supabase/functions/overnight-read/run_test.ts
// A whole run against fake Shopify, Claude and database endpoints.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { run } from "./run.ts";

const m = (n: number) => ({ shopMoney: { amount: String(n) } });
const ORDER = {
  id: "gid://shopify/Order/555", name: "#23544", createdAt: "2026-08-31T23:30:00Z", updatedAt: "2026-09-01T01:00:00Z",
  sourceName: "shopify_draft_order", tags: [], note: null,
  customer: { displayName: "Karan Singh", email: null, phone: null },
  staffMember: { name: "Beshoy Mikhail", email: "beshoy@amanandhiscave.com" },
  lineItems: { nodes: [{ title: "Pool table", quantity: 1, originalTotalSet: m(1000),
    discountAllocations: [{ allocatedAmountSet: m(100), discountApplication: { index: 0 } }] }] },
  shippingLines: { nodes: [] },
  discountApplications: { nodes: [{ __typename: "DiscountCodeApplication", index: 0, code: "B33RMONEY" }] },
  refunds: [],
};
const WEB_ORDER = { ...ORDER, id: "gid://shopify/Order/556", name: "#23545", sourceName: "web", staffMember: null };
const UNKNOWN_REP = { ...ORDER, id: "gid://shopify/Order/557", name: "#23546", staffMember: { name: "Casual Sam", email: null } };

function setup(seen: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({
    SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "eyJservice", SHOPIFY_STORE_DOMAIN: "amahc.myshopify.com",
    SHOPIFY_CLIENT_ID: "cid", SHOPIFY_CLIENT_SECRET: "csecret", ANTHROPIC_API_KEY: "sk-test",
  })) Deno.env.set(k, v);
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const imported: any[] = [];
  const patches: any[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;
    const text = await req.text();
    const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    calls.push({ url, body, headers: req.headers });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/rest/v1/rpc/_commission_overnight_context")) {
      return json({ people: [{ id: "beshoy", name: "Beshoy", match: ["beshoy"] }], seen });
    }
    if (url.endsWith("/rest/v1/commission_runs")) return json([{ id: 7 }], 201);
    if (url.includes("/rest/v1/commission_runs?id=eq.7")) { patches.push(body); return new Response(null, { status: 204 }); }
    if (url.endsWith("/rest/v1/rpc/_commission_import_rows")) { imported.push(...body.p_rows); return json(body.p_rows.length); }
    if (url === "https://amahc.myshopify.com/admin/oauth/access_token") return json({ access_token: "shpat_x" });
    if (url.includes("/admin/api/2026-07/graphql.json")) {
      const q: string = body.query;
      if (q.includes("ianaTimezone")) return json({ data: { shop: { ianaTimezone: "Australia/Sydney" } } });
      if (q.includes("codeDiscountNodeByCode")) {
        return json({ data: { codeDiscountNodeByCode: { codeDiscount: { __typename: "DiscountCodeBasic", title: "Beer", startsAt: "2026-08-01T00:00:00Z", endsAt: null } } } });
      }
      return json({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ORDER, WEB_ORDER, UNKNOWN_REP] } } });
    }
    if (url === "https://api.anthropic.com/v1/messages?beta=true" || url.startsWith("https://api.anthropic.com/v1/messages")) {
      return json({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: JSON.stringify({ reads: [{ kind: "discount", verdict: "waive", waive_amount: 100, confidence: 90, summary: "Live code.", points: ["B33RMONEY was live. Waived."] }] }) }],
      });
    }
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;
  return { calls, imported, patches };
}

Deno.test("a run reads rep orders, asks Claude once per order, and loads the flags", async () => {
  const { calls, imported, patches } = setup();
  const res: any = await run(new URLSearchParams("since=2026-09-01"));
  assertEquals(res.ok, true, JSON.stringify(res));
  assertEquals(res.orders_scanned, 3);
  assertEquals(res.ai_reads, 1);
  assertEquals(res.flags_written, 1);
  // the casual's order is reported, not dropped silently; the web order is ignored
  assertEquals(res.unattributed.map((u: any) => u.order_no), ["#23546"]);

  assertEquals(imported.length, 1);
  const f = imported[0];
  assertEquals([f.kind, f.order_no, f.rep_id, f.order_date, f.amount], ["discount", "23544", "beshoy", "2026-09-01", 100]);
  assertEquals([f.ai.verdict, f.ai.waive_amount, f.ai.confidence], ["waive", 100, 90]);
  assertEquals(f.details.shopify_updated_at, ORDER.updatedAt);

  const ai = calls.find((c) => c.url.startsWith("https://api.anthropic.com"))!;
  assertEquals(ai.body.model, "claude-opus-5-5");
  assertEquals(ai.body.fallbacks, "default");
  assert((ai.headers.get("anthropic-beta") || "").includes("server-side-fallback-2026-07-01"));
  assertEquals(ai.body.output_config.format.type, "json_schema");
  // the Shopify token never reaches Claude
  assert(!JSON.stringify(ai.body).includes("shpat_x"));
  assertEquals(patches.at(-1).status, "ok");
});

Deno.test("an order already read at the same Shopify version is skipped -- no second AI call", async () => {
  const { calls, imported } = setup({ "discount-23544": ORDER.updatedAt });
  const res: any = await run(new URLSearchParams("since=2026-09-01"));
  assertEquals([res.ok, res.skipped_unchanged, res.ai_reads], [true, 1, 0]);
  assertEquals(imported.length, 0);
  assertEquals(calls.filter((c) => c.url.startsWith("https://api.anthropic.com")).length, 0);
});

Deno.test("a failed Shopify login is recorded on the run as an error", async () => {
  const { patches } = setup();
  const real = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) =>
    String(input instanceof Request ? input.url : input).includes("access_token")
      ? Promise.resolve(new Response("bad client", { status: 401 }))
      : real(input, init)) as typeof fetch;
  const res: any = await run(new URLSearchParams(""));
  assertEquals(res.ok, false);
  assert(String(res.error).includes("Shopify token: 401"));
  assertEquals(patches.at(-1).status, "error");
});
