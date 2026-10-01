// Pure logic for the overnight read: which orders become flags, whose
// call each discount slice was, and how the AI's answer is folded in.
// No network here, so it can be tested on its own (logic_test.ts).

export type Money = { shopMoney: { amount: string } };

export type DiscountApplication = {
  __typename: string; // DiscountCodeApplication | ManualDiscountApplication | AutomaticDiscountApplication | ScriptDiscountApplication
  index: number;
  code?: string;
  title?: string;
  description?: string | null;
};

type Allocation = { allocatedAmountSet: Money; discountApplication: { index: number } };

export type ShopifyOrder = {
  id: string; // gid://shopify/Order/123
  name: string; // #23544
  createdAt: string;
  updatedAt: string;
  sourceName: string | null;
  tags: string[];
  note: string | null;
  customer: { displayName: string; email: string | null; phone: string | null } | null;
  billingAddress?: { phone: string | null } | null;
  shippingAddress?: { phone: string | null } | null;
  staffMember?: { name: string; email: string | null } | null;
  lineItems: { nodes: { title: string; quantity: number; originalTotalSet: Money; discountAllocations: Allocation[] }[] };
  shippingLines: {
    nodes: { title: string; source: string | null; originalPriceSet: Money; discountedPriceSet: Money }[];
  };
  discountApplications: { nodes: DiscountApplication[] };
  refunds: { createdAt: string; note: string | null; totalRefundedSet: Money }[];
};

// When each discount code was live, keyed by upper-cased code.
export type CodeWindow = { title: string; startsAt: string | null; endsAt: string | null } | null;

export type Person = { id: string; name: string; match: string[] };

export type Slice = { type: string; label: string; note: string; amount: number; side: "company" | "rep" };

export type FlagDraft = {
  kind: "discount" | "freight" | "refund";
  order_no: string;
  order_date: string; // YYYY-MM-DD in the shop's timezone
  customer: string | null;
  rep_id: string;
  gross: number;
  amount: number;
  pct: number | null;
  order_url: string;
  details: Record<string, unknown>;
  slices: Slice[];
  calls?: CallRecord[];
};

// One Aircall call as the board shows it (the "contact trail"). lines is
// the transcript, when Aircall has one; empty otherwise.
export type CallRecord = {
  id: string; // "aircall-<id>"
  aircall_id: number;
  source: "Aircall";
  date: string; // YYYY-MM-DD, shop timezone
  started_at: string; // ISO
  rep: string | null;
  minutes: number;
  direction: string;
  answered: boolean;
  has_recording: boolean;
  lines: { speaker: "rep" | "customer"; name: string; t: number; text: string }[];
};

// Australian numbers as Aircall stores them (+61...). null if it doesn't
// look like a phone number.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const plus = raw.trim().startsWith("+");
  const d = raw.replace(/\D/g, "");
  if (d.length < 8) return null;
  if (plus) return "+" + d;
  if (d.startsWith("61")) return "+" + d;
  if (d.startsWith("0") && d.length === 10) return "+61" + d.slice(1);
  if (d.length === 9 && d.startsWith("4")) return "+61" + d; // mobile without the leading 0
  return "+" + d;
}

export function orderPhones(order: ShopifyOrder): string[] {
  return [...new Set([order.customer?.phone, order.billingAddress?.phone, order.shippingAddress?.phone]
    .map(normalizePhone).filter((p): p is string => !!p))];
}

export const DISCOUNT_THRESHOLD_PCT = 5;
const REP_CHANNELS = new Set(["pos", "shopify_draft_order"]);

const amt = (m: Money | undefined | null) => Number(m?.shopMoney?.amount ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function localDate(iso: string, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

// Which rep an order belongs to: any of a person's match strings found in
// the order's staff member name/email or its tags. null = not a rep order
// we can attribute.
export function attributeRep(order: ShopifyOrder, people: Person[]): string | null {
  const hay = [order.staffMember?.name, order.staffMember?.email, ...(order.tags || [])]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  for (const p of people) {
    if ((p.match || []).some((m) => m && hay.some((h) => h.includes(m.toLowerCase())))) return p.id;
  }
  return null;
}

// Orders carrying one of these tags are never commission (e.g. "luca":
// creator-programme orders handled by the creative strategist). Set in
// commission_settings.exclude_tags; matched case-insensitively.
export function isExcluded(order: ShopifyOrder, excludeTags: string[]): boolean {
  const tags = (order.tags || []).map((t) => t.toLowerCase());
  return excludeTags.some((x) => tags.includes(x.toLowerCase()));
}

// Commission only covers orders a rep handled: POS, draft orders (quotes),
// or anything carrying a rep's staff member or tag.
export function isRepOrder(order: ShopifyOrder, people: Person[]): boolean {
  return REP_CHANNELS.has(order.sourceName || "") || !!order.staffMember || attributeRep(order, people) !== null;
}

function codeLiveOn(win: CodeWindow, dateIso: string): boolean | null {
  if (!win) return null; // code not found (deleted, or a one-off)
  const t = new Date(dateIso).getTime();
  if (win.startsAt && new Date(win.startsAt).getTime() > t) return false;
  if (win.endsAt && new Date(win.endsAt).getTime() < t) return false;
  return true;
}

// Splits the order's discount into one slice per discount application, and
// decides the default side: site-wide automatic promos and codes that were
// live that day are company-side; manual discounts and codes that weren't
// live are the rep's. The AI read can still argue either way (e.g. a rep
// who pushed a code on the call).
export function discountSlices(order: ShopifyOrder, codeWindows: Record<string, CodeWindow>, dateLabel: string): Slice[] {
  const byIndex = new Map<number, number>();
  const freeItems = new Map<number, string[]>();
  for (const li of order.lineItems.nodes) {
    const original = amt(li.originalTotalSet);
    for (const a of li.discountAllocations || []) {
      const i = a.discountApplication.index;
      const v = amt(a.allocatedAmountSet);
      byIndex.set(i, (byIndex.get(i) || 0) + v);
      if (original > 0 && Math.abs(v - original) < 0.01) freeItems.set(i, [...(freeItems.get(i) || []), li.title]);
    }
  }
  const slices: Slice[] = [];
  for (const app of order.discountApplications.nodes) {
    const amount = round2(byIndex.get(app.index) || 0);
    if (amount <= 0) continue; // shipping-only discounts are handled as freight
    const free = freeItems.get(app.index);
    if (app.__typename === "AutomaticDiscountApplication" || app.__typename === "ScriptDiscountApplication") {
      slices.push({ type: "promo", label: app.title || "Automatic discount", note: "site-wide automatic promo", amount, side: "company" });
    } else if (app.__typename === "DiscountCodeApplication") {
      const code = (app.code || "").toUpperCase();
      const live = codeLiveOn(codeWindows[code] ?? null, order.createdAt);
      slices.push({
        type: "code", label: app.code || "code", amount,
        note: live === true ? "live site code — company's" : live === false ? `code not active on ${dateLabel}` : "code not found in Shopify",
        side: live === true ? "company" : "rep",
      });
    } else {
      const title = (app.title || "").trim();
      const named = title && !/^custom( discount)?$/i.test(title);
      slices.push({
        type: free ? "free item" : named ? "named manual" : "rep custom",
        label: free ? `100% off — ${free.join(", ")}` : named ? title : "Custom discount",
        note: free ? "100% off a line item — no campaign behind it" : named ? "manual, named — no matching automatic promo" : "unnamed, rep-keyed",
        amount, side: "rep",
      });
    }
  }
  return slices;
}

// Turns one Shopify order into the flags it raises (0-3).
export function flagsForOrder(
  order: ShopifyOrder,
  repId: string,
  codeWindows: Record<string, CodeWindow>,
  opts: { timeZone: string; storeHandle: string },
): FlagDraft[] {
  const orderNo = order.name.replace(/^#/, "");
  const date = localDate(order.createdAt, opts.timeZone);
  const [y, m, d] = date.split("-");
  const dateLabel = `${Number(d)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}`;
  const gross = round2(order.lineItems.nodes.reduce((s, li) => s + amt(li.originalTotalSet), 0));
  const base = {
    order_no: orderNo, order_date: date, customer: order.customer?.displayName || null, rep_id: repId, gross,
    order_url: `https://admin.shopify.com/store/${opts.storeHandle}/orders/${order.id.split("/").pop()}`,
  };
  const common = {
    shopify_updated_at: order.updatedAt, source: order.sourceName, tags: order.tags, note: order.note,
    staff: order.staffMember?.name || null, year: y,
  };
  const flags: FlagDraft[] = [];

  const slices = discountSlices(order, codeWindows, dateLabel);
  const discount = round2(slices.reduce((s, x) => s + x.amount, 0));
  const pct = gross > 0 ? round2((100 * discount) / gross) : null;
  if (pct !== null && pct > DISCOUNT_THRESHOLD_PCT) {
    flags.push({ ...base, kind: "discount", amount: discount, pct, details: common, slices });
  }

  // Freight v1: shipping charged below the shipping line's own list price
  // (a discounted or overridden rate). Comparing against a freshly quoted
  // Shopify rate for the same service is not done yet -- see SETUP.md.
  let charged = 0, listed = 0;
  const services: string[] = [];
  for (const sl of order.shippingLines.nodes) {
    charged += amt(sl.discountedPriceSet);
    listed += amt(sl.originalPriceSet);
    services.push(sl.title);
  }
  const shortfall = round2(listed - charged);
  if (shortfall > 0.5) {
    flags.push({
      ...base, kind: "freight", amount: shortfall, pct: null, slices: [],
      details: { ...common, service: services.join(" + ") || "—", charged: round2(charged), cost: round2(listed), basis: "shipping line list price" },
    });
  }

  const refunded = round2(order.refunds.reduce((s, r) => s + amt(r.totalRefundedSet), 0));
  if (refunded > 0) {
    const reasons = order.refunds.map((r) => r.note).filter(Boolean).join("; ");
    flags.push({ ...base, kind: "refund", amount: refunded, pct: null, slices: [], details: { ...common, reason: reasons || null } });
  }
  return flags;
}

// ============================== the AI read ==============================

export const AI_SYSTEM = `You pre-read sales orders for A Man & His Cave's weekly commission review. A reviewer (Anj, escalating to Jaya) decides every dollar; you only suggest, with your reasons.

The rules:
- Freight is one-to-one: what Shopify quotes for the service the customer takes is what the customer pays. Charging under it counts against the rep's commission like a discount, unless proven (an Osama run or private courier booking, or a sign-off from Jaya or Ross, attached by the rep).
- Every discount over 5% needs a reason. Company promos are waived: site-wide automatic discounts, and discount codes that were live on the site that day. The rep's own calls count: manual or custom discounts, free items with no campaign behind them, codes that weren't live.
- A code the rep pushed on the call counts as the rep's, even if it was live. If the customer raised it, it stays company-side.
- You may get the customer's Aircall calls (rep, date, length) and, where Aircall has one, the transcript. Use transcripts as evidence: was the discount or the shipping price discussed, and who raised it? Set discussed_on_call accordingly. Quote the exact words (speaker, text, call_id, t in seconds) for anything you rely on, at most 3 quotes. With no transcript, say the call wasn't read, and don't guess what was said.
- Refunds: say what the order shows (amount, note) and what the reviewer should check. Most refunds have no rep fault; suggest "counts" only if the order clearly shows a rep-caused refund, otherwise "waive" with low confidence.

How to answer:
- One read per flag you are given, same kind. Quotes must be copied word for word from a transcript you were given; never paraphrase into a quote.
- verdict: "waive" (all company-side or proven), "counts" (all the rep's), or "partial" (waive_amount waived, the rest counts). waive_amount is in dollars, between 0 and the flag amount.
- confidence: 0-100. Be conservative; missing evidence lowers it.
- summary: one plain sentence for the reviewer.
- points: 1-4 short sentences, one per slice or fact, each ending "Waived." or "Counts." where it applies. Use the order's own names, codes and dates.
- Never invent evidence. If something isn't in the data, say it isn't there.
Write in plain Australian English.`;

export const AI_SCHEMA = {
  type: "object",
  properties: {
    reads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["discount", "freight", "refund"] },
          verdict: { type: "string", enum: ["waive", "partial", "counts"] },
          waive_amount: { type: "number" },
          confidence: { type: "integer" },
          summary: { type: "string" },
          points: { type: "array", items: { type: "string" } },
          discussed_on_call: { type: "boolean" },
          quotes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                speaker: { type: "string", enum: ["rep", "customer"] },
                text: { type: "string" },
                call_id: { type: "string" },
                t: { type: "number" },
              },
              required: ["speaker", "text", "call_id", "t"],
              additionalProperties: false,
            },
          },
        },
        required: ["kind", "verdict", "waive_amount", "confidence", "summary", "points", "discussed_on_call", "quotes"],
        additionalProperties: false,
      },
    },
  },
  required: ["reads"],
  additionalProperties: false,
} as const;

export type AiRead = {
  kind: string; verdict: string; waive_amount: number; confidence: number; summary: string; points: string[];
  discussed_on_call?: boolean;
  quotes?: { speaker: string; text: string; call_id: string; t: number }[];
};

// What the AI sees for one order: the flags and only the facts behind them.
export function aiPayload(order: ShopifyOrder, flags: FlagDraft[]) {
  return {
    order: order.name,
    date: flags[0]?.order_date,
    channel: order.sourceName,
    staff_member: order.staffMember?.name || null,
    tags: order.tags,
    order_note: order.note,
    line_items: order.lineItems.nodes.map((li) => ({ title: li.title, qty: li.quantity, price: amt(li.originalTotalSet) })),
    shipping: order.shippingLines.nodes.map((s) => ({ service: s.title, list_price: amt(s.originalPriceSet), charged: amt(s.discountedPriceSet) })),
    refunds: order.refunds.map((r) => ({ date: r.createdAt.slice(0, 10), amount: amt(r.totalRefundedSet), note: r.note })),
    flags: flags.map((f) => ({ kind: f.kind, amount: f.amount, pct: f.pct, slices: f.slices, details: f.details })),
    // Aircall calls with this customer around the order date. Transcripts
    // are capped so one long call can't crowd out the rest.
    calls: (flags[0]?.calls || []).map((c) => ({
      call_id: c.id, date: c.date, rep: c.rep, minutes: c.minutes, direction: c.direction, answered: c.answered,
      transcript: c.lines.length ? c.lines.slice(0, 400).map((l) => `[${l.t}s] ${l.speaker}: ${l.text}`).join("\n") : null,
    })),
  };
}

// Folds the AI's read into the flag's ai field, keeping the numbers sane
// whatever the model returned.
export function toAiField(flag: FlagDraft, read: AiRead | undefined, reviewedAt: string) {
  if (!read) return { source: "ai", verdict: null, summary: "The AI read didn't come back for this order.", points: [], quotes: [], reviewed_at: reviewedAt };
  const w = Math.min(Math.max(Number(read.waive_amount) || 0, 0), flag.amount);
  const verdict = w <= 0.005 ? "counts" : w >= flag.amount - 0.005 ? "waive" : "partial";
  return {
    source: "ai",
    verdict,
    waive_amount: round2(verdict === "counts" ? 0 : verdict === "waive" ? flag.amount : w),
    confidence: Math.min(Math.max(Math.round(Number(read.confidence) || 0), 0), 100),
    summary: read.summary,
    points: (read.points || []).slice(0, 6),
    discussed_on_call: !!read.discussed_on_call,
    // keep only quotes that point at a call we actually gave it
    quotes: (read.quotes || [])
      .filter((q) => (flag.calls || []).some((c) => c.id === q.call_id) && q.text)
      .slice(0, 3)
      .map((q) => ({ speaker: q.speaker === "rep" ? "rep" : "customer", text: q.text, call_id: q.call_id, t: Math.max(0, Math.round(q.t || 0)) })),
    reviewed_at: reviewedAt,
  };
}

// ============================== no-AI mode ==============================

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-AU");

function callsNote(calls: CallRecord[]): string {
  const withT = calls.filter((c) => c.lines.length).length;
  return `${calls.length} Aircall call(s) with this customer around the order date${withT ? ` (${withT} with a transcript)` : ""} — open them in the contact trail; the rule check doesn't read calls.`;
}

// The suggestion the rules alone support, for when there's no Claude key
// (or ?ai=0). Labelled source "rules" so the board shows it as a rule
// check, not an AI read, and the next AI-enabled run upgrades it.
export function rulesRead(flag: FlagDraft, reviewedAt: string) {
  const base = { source: "rules", confidence: null, discussed_on_call: false, quotes: [], reviewed_at: reviewedAt };
  if (flag.kind === "discount") {
    const [, mm, dd] = flag.order_date.split("-");
    const date = `${Number(dd)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(mm) - 1]}`;
    const points = flag.slices.map((sl) => {
      if (sl.type === "promo") return `${sl.label} is a site-wide automatic promo — company's. Waived.`;
      if (sl.type === "code" && sl.side === "company") return `Code ${sl.label} was live on the site on ${date} — company's. Waived.`;
      if (sl.type === "code") return `Code ${sl.label}: ${sl.note}. Counts unless the rep shows otherwise.`;
      if (sl.type === "free item") return `${sl.label}: no campaign behind it in Shopify. Counts unless the rep states a case.`;
      if (sl.type === "named manual") return `"${sl.label}" (${money(sl.amount)}) was keyed in by hand, not an automatic promo. Counts unless the rep states a case.`;
      return `Unnamed custom discount of ${money(sl.amount)} — the rep's own call. Counts.`;
    });
    if (flag.calls?.length) points.push(callsNote(flag.calls));
    const waived = round2(flag.slices.filter((x) => x.side === "company").reduce((a, x) => a + x.amount, 0));
    const verdict = waived <= 0.005 ? "counts" : waived >= flag.amount - 0.005 ? "waive" : "partial";
    return {
      ...base, verdict, waive_amount: verdict === "counts" ? 0 : verdict === "waive" ? flag.amount : waived,
      summary: `From the order alone: ${money(waived)} company-side, ${money(flag.amount - waived)} the rep's. Calls weren't checked.`,
      points,
    };
  }
  if (flag.kind === "freight") {
    const d = flag.details as { charged?: number; cost?: number; service?: string };
    return {
      ...base, verdict: "counts", waive_amount: 0,
      summary: `Shipping charged ${money(d.charged || 0)} against a ${money(d.cost || 0)} list price.`,
      points: [`${d.service || "Shipping"}: ${money(flag.amount)} under the list price. Counts unless proven (Osama run, courier booking or a sign-off).`,
        ...(flag.calls?.length ? [callsNote(flag.calls)] : [])],
    };
  }
  const reason = (flag.details as { reason?: string | null }).reason;
  return {
    ...base, verdict: null, waive_amount: 0,
    summary: `Refund of ${money(flag.amount)}${reason ? ` — "${reason}"` : " with no note on the order"}. The rule check can't tell whose fault it was; check the reason.`,
    points: [],
  };
}
