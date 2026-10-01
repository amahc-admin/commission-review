# Commission Review: setup

## 1. Create a Supabase project for it

This is its **own** Supabase project, separate from the Cave Handbook's,
so commission and pay data never shares a database with anything else.

1. At https://supabase.com, create a new project (the free tier is fine).
2. Under **Project Settings → API**, copy the **Project URL** and the
   **publishable key** (`sb_publishable_...`; older projects call it the **anon / public key**).
3. Put both in `web/js/config.js`, then commit and push. The anon key is
   meant to be public: it grants nothing by itself.

## 2. Run the migration

In the new project's **SQL Editor**, run
`supabase/migrations/0001_commission_review.sql`.
It's safe to re-run. Optionally, also run `supabase/demo-seed.sql`
to load the September orders from the walkthrough deck, so the board isn't
empty on day one. Remove them later with
`delete from commission_flags where period = '2026-09';`.

## 3. Set everyone's passcode

The migration creates Anj and Jaya (reviewers; Jaya is the one Anj
escalates to) and Lachy and Beshoy (reps). Each has the temporary passcode
`changeme-<id>`. Change every one before sharing the link, and give each
person only their own passcode:

```sql
update commission_people set passcode_hash = crypt('their-new-passcode', gen_salt('bf')) where id = 'lachy';
```

Add a rep:

```sql
insert into commission_people (id, name, role, passcode_hash, slack_mention)
values ('newrep', 'Their Name', 'rep', crypt('their-passcode', gen_salt('bf')), '<@SLACKUSERID>');
```

Use `role = 'reviewer'` for a reviewer and `is_approver = true` for whoever
escalations go to. Set `active = false` to remove someone's access without
losing their history.

## 4. Slack: the #commission-review channel

Create a **private** channel, add an Incoming Webhook to it, then:

```sql
select vault.create_secret('https://hooks.slack.com/services/...', 'commission_slack_webhook_url', 'Commission review channel');
select vault.create_secret('https://amahc-admin.github.io/commission-review/', 'commission_board_url', 'Commission board link');
```

Questions to reps, escalations and week sign-offs post there
automatically. The second secret makes the ping's last line a clickable
"Open the board" link.

To post the Monday 8am ping automatically, enable the `pg_cron` extension
(Database → Extensions) and schedule it. pg_cron runs in **UTC**: 8am
Monday Sydney time (AEDT, UTC+11) is Sunday 21:00 UTC. Adjust for your
timezone and for daylight saving.

```sql
select cron.schedule('commission-weekly-ping', '0 21 * * 0', 'select commission_weekly_ping()');
```

Reviewers can also preview the ping, or post it by hand, from the board
(**Monday ping**).

## 5. Getting flags in

The board shows the AI's pre-read but doesn't do it itself. Flags come in
through `commission_import`, which takes a JSON array. Paste one into
**Import flags** on the board, or have the overnight job (Shopify +
Fathom/call recordings + website history) post it to
`POST <supabase-url>/rest/v1/rpc/commission_import` with
`{"p_person_id": "<reviewer id>", "p_passcode": "...", "p_rows": [...]}`.
Re-importing an order refreshes its numbers and AI read. It never
overwrites a rep's answer or a reviewer's decision.

One flag, with every field shown (only `order_no`, `order_date`, `rep`
and `amount` are required):

```json
{
  "order_no": "23544", "kind": "discount", "order_date": "2026-09-01",
  "customer": "Karan Singh", "rep": "Beshoy", "gross": 3027, "amount": 509, "pct": 16.8,
  "order_url": "https://admin.shopify.com/store/.../orders/...",
  "slices": [
    {"type": "code", "label": "B33RMONEY", "note": "live site code — company's", "amount": 27, "side": "company"},
    {"type": "rep custom", "label": "Custom discount", "note": "unnamed, rep-keyed", "amount": 91, "side": "rep"}
  ],
  "ai": {
    "verdict": "partial", "waive_amount": 27, "confidence": 80, "discussed_on_call": true,
    "reviewed_at": "2026-10-01T02:00:00Z",
    "summary": "One line for the call view.",
    "points": ["Code B33RMONEY was live on 1 Sep, so its $27 slice is company-side. Waived."],
    "quotes": [{"speaker": "rep", "text": "you're getting the kit for free", "call_id": "c1", "t": 95}]
  },
  "calls": [
    {"id": "c1", "source": "Fathom", "date": "2026-09-01", "rep": "Beshoy", "minutes": 6, "direction": "inbound",
     "audio_url": null, "url": "https://fathom.video/calls/...",
     "lines": [{"speaker": "rep", "name": "Beshoy", "t": 95, "text": "..."}]}
  ]
}
```

- `kind`: `discount`, `freight`, `refund` or `claim`.
- `amount`: the dollars at stake. For freight it's cost minus charged; a
  negative amount means over-recovered, which shows green and counts for
  the rep. Freight also takes `"details": {"service": "...", "charged": 90, "cost": 350}`.
- `ai.verdict`: `waive`, `partial` (with `waive_amount`), `counts`, or for
  claims `related` / `unrelated`.
- A CSV with a header row
  (`order_no,kind,order_date,customer,rep,gross,amount,pct,order_url`, plus
  `service,charged,cost` for freight) also works for a quick manual load,
  but it carries no AI read or breakdown.


## 6. Turn on GitHub Pages

1. In this repo on GitHub, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
2. Push to `main`, or run the "Deploy Commission Review to GitHub Pages"
   workflow by hand. The site appears at the URL shown in Settings →
   Pages, typically `https://amahc-admin.github.io/commission-review/`.
3. Put that URL in the `commission_board_url` secret (step 4), so the
   Monday ping links straight to it.

## Rules the board enforces

- Reasons that the rule says must be proven (**Osama run**, **Private
  courier**, **Approved by Jaya or Ross**) are refused without a screenshot
  or link attached. This is checked server-side, not just in the form.
- Only a reviewer's click moves money. Every answer, question,
  escalation, decision and reopen is logged with the person's name and
  time, and shown under the order's **History**.
- A week can only be signed off once every flag in it with money at stake
  is decided.
- **Payout totals** and **Export CSV** give accounts the weekly view:
  waived, counted, and still open (which counts as-is at month-end).

## Known limits

- Proof screenshots go to a `commission-proof` storage bucket. Each file
  has a random 128-bit name and the bucket can't be listed, but anyone
  holding a file's exact URL can open it.
- The board shows dollars that count against each rep's commission base.
  It doesn't calculate the commission rate or payout itself, because
  those rules aren't in this repo.
