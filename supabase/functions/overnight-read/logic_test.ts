// deno test supabase/functions/overnight-read/logic_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { attributeRep, flagsForOrder, isExcluded, normalizePhone, isRepOrder, rulesRead, type ShopifyOrder, toAiField } from "./logic.ts";

const m = (n: number) => ({ shopMoney: { amount: String(n) } });
const people = [
  { id: "beshoy", name: "Beshoy", match: ["beshoy"] },
  { id: "lachy", name: "Lachy", match: ["lachlan", "lachy"] },
];
const opts = { timeZone: "Australia/Sydney", storeHandle: "amahc" };

// Order #23544 from the walkthrough deck: a free kit, a named manual
// discount, a custom discount and a live code.
const order23544: ShopifyOrder = {
  id: "gid://shopify/Order/555", name: "#23544",
  createdAt: "2026-08-31T23:30:00Z", // 1 Sep in Sydney
  updatedAt: "2026-09-01T01:00:00Z",
  sourceName: "shopify_draft_order", tags: [], note: null,
  customer: { displayName: "Karan Singh", email: null, phone: null },
  staffMember: { name: "Beshoy Mikhail", email: "beshoy@amanandhiscave.com" },
  lineItems: { nodes: [
    { title: "Pool table", quantity: 1, originalTotalSet: m(2727),
      discountAllocations: [
        { allocatedAmountSet: m(91), discountApplication: { index: 1 } },
        { allocatedAmountSet: m(91), discountApplication: { index: 2 } },
        { allocatedAmountSet: m(27), discountApplication: { index: 3 } },
      ] },
    { title: "Premium Pool Table Accessory Kit", quantity: 1, originalTotalSet: m(300),
      discountAllocations: [{ allocatedAmountSet: m(300), discountApplication: { index: 0 } }] },
  ] },
  shippingLines: { nodes: [{ title: "Home delivery, 2-person", source: "shopify", originalPriceSet: m(350), discountedPriceSet: m(90) }] },
  discountApplications: { nodes: [
    { __typename: "ManualDiscountApplication", index: 0, title: "Custom discount" },
    { __typename: "ManualDiscountApplication", index: 1, title: "Pre order and save" },
    { __typename: "ManualDiscountApplication", index: 2, title: "" },
    { __typename: "DiscountCodeApplication", index: 3, code: "B33RMONEY" },
  ] },
  refunds: [],
};
const windows = { B33RMONEY: { title: "Beer money", startsAt: "2026-08-01T00:00:00Z", endsAt: null } };

Deno.test("attributes the order to the rep by staff member", () => {
  assertEquals(attributeRep(order23544, people), "beshoy");
  assertEquals(isRepOrder(order23544, people), true);
});

Deno.test("an online-store order with no rep is not a rep order", () => {
  const web = { ...order23544, sourceName: "web", staffMember: null, tags: [] };
  assertEquals(isRepOrder(web, people), false);
});

Deno.test("attributes by tag when there's no staff member", () => {
  assertEquals(attributeRep({ ...order23544, staffMember: null, tags: ["Lachlan"] }, people), "lachy");
});

Deno.test("23544 splits into the deck's four slices and raises discount + freight", () => {
  const flags = flagsForOrder(order23544, "beshoy", windows, opts);
  assertEquals(flags.map((f) => f.kind), ["discount", "freight"]);
  const d = flags[0];
  assertEquals(d.order_no, "23544");
  assertEquals(d.order_date, "2026-09-01");
  assertEquals(d.gross, 3027);
  assertEquals(d.amount, 509);
  assertEquals(d.pct, 16.82);
  assertEquals(d.order_url, "https://admin.shopify.com/store/amahc/orders/555");
  assertEquals(d.slices.map((s) => [s.type, s.amount, s.side]), [
    ["free item", 300, "rep"],
    ["named manual", 91, "rep"],
    ["rep custom", 91, "rep"],
    ["code", 27, "company"],
  ]);
  assertEquals(d.slices[3].note, "live site code — company's");
  assertEquals(d.slices[0].note, "100% off a line item — no campaign behind it");
  const f = flags[1];
  assertEquals([f.amount, f.details.charged, f.details.cost], [260, 90, 350]);
});

Deno.test("a code that wasn't live that day is the rep's", () => {
  const flags = flagsForOrder(order23544, "beshoy", { B33RMONEY: { title: "x", startsAt: "2026-09-10T00:00:00Z", endsAt: null } }, opts);
  const code = flags[0].slices.find((s) => s.type === "code")!;
  assertEquals([code.side, code.note], ["rep", "code not active on 1 Sep"]);
});

Deno.test("5% or less raises no discount flag; refunds raise a refund flag", () => {
  const small: ShopifyOrder = {
    ...order23544,
    lineItems: { nodes: [{ title: "Cue", quantity: 1, originalTotalSet: m(1000), discountAllocations: [{ allocatedAmountSet: m(50), discountApplication: { index: 3 } }] }] },
    shippingLines: { nodes: [] },
    refunds: [{ createdAt: "2026-09-03T00:00:00Z", note: "scratched rack", totalRefundedSet: m(220) }],
  };
  const flags = flagsForOrder(small, "beshoy", windows, opts);
  assertEquals(flags.map((f) => [f.kind, f.amount]), [["refund", 220]]);
  assertEquals(flags[0].details.reason, "scratched rack");
});

Deno.test("AI read is clamped and its verdict made consistent with the amount", () => {
  const [d] = flagsForOrder(order23544, "beshoy", windows, opts);
  const at = "2026-10-01T02:00:00Z";
  assertEquals(toAiField(d, { kind: "discount", verdict: "partial", waive_amount: 27, confidence: 80, summary: "s", points: [] }, at).verdict, "partial");
  assertEquals(toAiField(d, { kind: "discount", verdict: "partial", waive_amount: 9999, confidence: 180, summary: "s", points: [] }, at).waive_amount, 509);
  assertEquals(toAiField(d, { kind: "discount", verdict: "waive", waive_amount: 0, confidence: 50, summary: "s", points: [] }, at).verdict, "counts");
  assertEquals(toAiField(d, undefined, at).verdict, null);
});

Deno.test("rule check on 23544: waive the live $27 code, the rest counts", () => {
  const [d, fr] = flagsForOrder(order23544, "beshoy", windows, opts);
  const r = rulesRead(d, "2026-10-01T02:00:00Z");
  assertEquals([r.source, r.verdict, r.waive_amount, r.points.length], ["rules", "partial", 27, 4]);
  assert(r.points.some((p) => p.includes("was live on the site on 1 Sep")));
  assertEquals(rulesRead(fr, "x").verdict, "counts");
});

Deno.test("orders with an excluded tag are left out, whatever the case", () => {
  assertEquals(isExcluded({ ...order23544, tags: ["Creator Program", "LUCA"] }, ["luca"]), true);
  assertEquals(isExcluded(order23544, ["luca"]), false);
});

Deno.test("phone numbers are normalised the way Aircall stores them", () => {
  assertEquals(normalizePhone("0412 345 678"), "+61412345678");
  assertEquals(normalizePhone("+61 412 345 678"), "+61412345678");
  assertEquals(normalizePhone("61412345678"), "+61412345678");
  assertEquals(normalizePhone("412345678"), "+61412345678");
  assertEquals(normalizePhone("(02) 9876 5432"), "+61298765432");
  assertEquals(normalizePhone("n/a"), null);
});
