// The overnight read itself -- see index.ts for how it is triggered.

import Anthropic from "npm:@anthropic-ai/sdk@0.129";
import {
  AI_SCHEMA, AI_SYSTEM, aiPayload, type AiRead, attributeRep, type CodeWindow, type FlagDraft, flagsForOrder,
  isExcluded, isRepOrder, type Person, rulesRead, type ShopifyOrder, toAiField,
} from "./logic.ts";

const SHOPIFY_API_VERSION = "2026-07";
const MODEL = "claude-opus-5-5";
const AI_CONCURRENCY = 4;
// Edge Functions have a wall-clock limit; stop starting new AI reads after
// this and let the next run pick up the rest.
const TIME_BUDGET_MS = 110_000;

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing secret ${k}`);
  return v;
};

// ============================== Supabase ==============================

async function db(path: string, init: RequestInit = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(env("SUPABASE_URL") + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: key,
      ...(key.startsWith("eyJ") ? { Authorization: "Bearer " + key } : {}),
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`database ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const rpc = (fn: string, args: unknown) => db("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });

// ============================== Shopify ==============================

async function shopifyToken(shop: string): Promise<string> {
  // Client credentials grant: the Dev Dashboard app installed on our own
  // store exchanges its client ID + secret for a short-lived Admin token.
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env("SHOPIFY_CLIENT_ID"),
      client_secret: env("SHOPIFY_CLIENT_SECRET"),
    }),
  });
  if (!res.ok) throw new Error(`Shopify token: ${res.status} ${await res.text()} -- is the app installed on ${shop}?`);
  return (await res.json()).access_token;
}

async function gql(shop: string, token: string, query: string, variables: Record<string, unknown> = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    const throttled = res.status === 429 || (body.errors || []).some((e: any) => e?.extensions?.code === "THROTTLED");
    if (throttled && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok || body.errors) throw new Error(`Shopify: ${res.status} ${JSON.stringify(body.errors || body).slice(0, 500)}`);
    return body.data;
  }
}

const MONEY = "shopMoney { amount }";
const orderFields = (withStaff: boolean) => `
  id name createdAt updatedAt sourceName tags note
  customer { displayName email phone }
  ${withStaff ? "staffMember { name email }" : ""}
  lineItems(first: 50) { nodes { title quantity originalTotalSet { ${MONEY} }
    discountAllocations { allocatedAmountSet { ${MONEY} } discountApplication { index } } } }
  shippingLines(first: 5) { nodes { title source originalPriceSet { ${MONEY} } discountedPriceSet { ${MONEY} } } }
  discountApplications(first: 15) { nodes { __typename index
    ... on DiscountCodeApplication { code }
    ... on ManualDiscountApplication { title description }
    ... on AutomaticDiscountApplication { title }
    ... on ScriptDiscountApplication { title } } }
  refunds(first: 5) { createdAt note totalRefundedSet { ${MONEY} } }`;

async function fetchOrders(shop: string, token: string, sinceIso: string) {
  let withStaff = true;
  const orders: ShopifyOrder[] = [];
  let after: string | null = null;
  for (;;) {
    const query = `query($q: String!, $after: String) {
      orders(first: 10, after: $after, query: $q, sortKey: UPDATED_AT) {
        pageInfo { hasNextPage endCursor }
        nodes { ${orderFields(withStaff)} } } }`;
    let data;
    try {
      data = await gql(shop, token, query, { q: `updated_at:>='${sinceIso}'`, after });
    } catch (e) {
      // staffMember needs staff access; carry on without it rather than fail
      if (withStaff && /staffMember|access denied|ACCESS_DENIED/i.test(String(e))) { withStaff = false; continue; }
      throw e;
    }
    orders.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return { orders, withStaff };
}

async function codeWindows(shop: string, token: string, codes: string[]) {
  const out: Record<string, CodeWindow> = {};
  const q = `query($code: String!) { codeDiscountNodeByCode(code: $code) { codeDiscount { __typename
    ... on DiscountCodeBasic { title startsAt endsAt }
    ... on DiscountCodeBxgy { title startsAt endsAt }
    ... on DiscountCodeFreeShipping { title startsAt endsAt }
    ... on DiscountCodeApp { title startsAt endsAt } } } }`;
  for (const code of codes) {
    try {
      const d = await gql(shop, token, q, { code });
      const c = d.codeDiscountNodeByCode?.codeDiscount;
      out[code.toUpperCase()] = c ? { title: c.title, startsAt: c.startsAt, endsAt: c.endsAt } : null;
    } catch {
      out[code.toUpperCase()] = null;
    }
  }
  return out;
}

// ============================== the AI read ==============================

async function aiRead(order: ShopifyOrder, flags: FlagDraft[]): Promise<AiRead[]> {
  const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // On a safety decline, the API re-runs the request on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: AI_SCHEMA } },
    system: AI_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(aiPayload(order, flags)) }],
  });
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return [];
  const text = response.content.find((b: any) => b.type === "text") as any;
  if (!text) return [];
  try {
    return JSON.parse(text.text).reads || [];
  } catch {
    return [];
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ============================== the run ==============================

export async function run(params: URLSearchParams) {
  const started = Date.now();
  const shop = env("SHOPIFY_STORE_DOMAIN").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const since = params.get("since") || new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  const maxAi = Number(params.get("max_ai") || 40);
  const dry = params.get("dry") === "1";
  // No Claude key yet (or ?ai=0): still flag everything, with a rule-based
  // suggestion instead of an AI read. Free; upgraded once a key is added.
  const useAi = !!Deno.env.get("ANTHROPIC_API_KEY") && params.get("ai") !== "0";

  const [runRow] = dry ? [{ id: null }] : await db("commission_runs", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({}),
  });
  const summary: Record<string, unknown> = { mode: useAi ? "ai" : "rules", since, orders_scanned: 0, flags_written: 0, ai_reads: 0, skipped_unchanged: 0, deferred: 0, unattributed: [] as unknown[] };
  try {
    const ctx = await rpc("_commission_overnight_context", {});
    const people: Person[] = ctx.people;
    const seen: Record<string, string> = ctx.seen || {};
    const excludeTags: string[] = ctx.exclude_tags || [];
    // ?force=1 re-reads orders already on the board (e.g. after the rule
    // wording changes). Reps' answers and decisions are still kept.
    const force = params.get("force") === "1";

    const token = await shopifyToken(shop);
    const shopInfo = await gql(shop, token, `{ shop { ianaTimezone } }`);
    const timeZone = shopInfo.shop.ianaTimezone || "Australia/Sydney";
    const { orders, withStaff } = await fetchOrders(shop, token, since + "T00:00:00Z");
    summary.orders_scanned = orders.length;
    if (!withStaff) summary.note = "staff member not readable -- attributing by order tags only";

    const codes = [...new Set(orders.flatMap((o) => o.discountApplications.nodes.filter((a) => a.code).map((a) => a.code!)))];
    const windows = await codeWindows(shop, token, codes);

    // Orders that raise flags and haven't been read at this Shopify version
    const todo: { order: ShopifyOrder; flags: FlagDraft[] }[] = [];
    for (const order of orders) {
      if (!isRepOrder(order, people) || isExcluded(order, excludeTags)) continue;
      const repId = attributeRep(order, people);
      const probe = flagsForOrder(order, repId || "?", windows, { timeZone, storeHandle });
      if (!probe.length) continue;
      if (!repId) {
        (summary.unattributed as unknown[]).push({ order_no: order.name, staff: order.staffMember?.name || null, tags: order.tags, amount: probe.reduce((s, f) => s + f.amount, 0) });
        continue;
      }
      // seen = "<shopify updatedAt>|<ai|rules>". Rules mode skips anything
      // read at this version; AI mode only skips AI reads, so rule-checked
      // orders get upgraded once a key is added.
      const done = (f: FlagDraft) => {
        const v = seen[`${f.kind}-${f.order_no}`] || "";
        return useAi ? v === `${order.updatedAt}|ai` : v.startsWith(order.updatedAt + "|");
      };
      if (!force && probe.every(done)) {
        (summary.skipped_unchanged as number)++;
        continue;
      }
      todo.push({ order, flags: probe });
    }

    const batch = useAi ? todo.slice(0, maxAi) : todo;
    summary.deferred = todo.length - batch.length;
    const rows: unknown[] = [];
    await pool(batch, AI_CONCURRENCY, async ({ order, flags }) => {
      const at = new Date().toISOString();
      if (!useAi) {
        for (const f of flags) rows.push({ ...f, ai: rulesRead(f, at) });
        return;
      }
      if (Date.now() - started > TIME_BUDGET_MS) { (summary.deferred as number)++; return; }
      let reads: AiRead[] = [];
      try {
        reads = await aiRead(order, flags);
        (summary.ai_reads as number)++;
      } catch (e) {
        if (e instanceof Anthropic.APIError) summary.ai_error = `${e.status}: ${e.message}`.slice(0, 300);
        else throw e;
      }
      for (const f of flags) rows.push({ ...f, ai: toAiField(f, reads.find((r) => r.kind === f.kind), at) });
    });

    if (rows.length && !dry) summary.flags_written = await rpc("_commission_import_rows", { p_rows: rows });
    else summary.flags_written = 0;
    if (dry) summary.preview = rows;

    if (!dry) await db(`commission_runs?id=eq.${runRow.id}`, { method: "PATCH", body: JSON.stringify({ status: "ok", finished_at: new Date().toISOString(), summary }) });
    return { ok: true, ...summary };
  } catch (e) {
    summary.error = String(e).slice(0, 1000);
    if (!dry) await db(`commission_runs?id=eq.${runRow.id}`, { method: "PATCH", body: JSON.stringify({ status: "error", finished_at: new Date().toISOString(), summary }) }).catch(() => {});
    return { ok: false, ...summary };
  }
}

