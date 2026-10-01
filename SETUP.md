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

### The overnight read (automatic)

`supabase/functions/overnight-read` runs every night. Each run:
1. Reads the last 3 days of updated orders from Shopify.
2. Keeps the rep orders: POS, draft orders, or anything with a rep's staff
   member or tag.
3. Flags discounts over 5%, shipping charged under its list price, and
   refunds.
4. Checks each discount code against when it was actually live in Shopify.
5. Asks Claude (Opus 5.5) for the suggestion.
6. Loads everything onto the board.

**Without a Claude key it still runs, for free.** If `ANTHROPIC_API_KEY`
isn't set, step 5 is replaced by a rule check worked out from the order
alone: live codes and automatic promos are waived, and manual discounts,
free items and shipping under list price count. The board labels these
**Rules:** (not **AI:**) and offers **Accept suggestion**. Add the key
later and the next run upgrades those orders to a full AI read. An order
that already has an AI read is never downgraded.

An order already read at the same Shopify version is skipped, so it never
pays for the same read twice. Reviewers see when it last ran at the top of
the board, plus any order it couldn't match to a rep.

**One-time setup**

1. **Run `supabase/migrations/0002_overnight_read.sql`** in the SQL Editor.
2. **Secrets.** Under Edge Functions → Secrets, add:

   | Name | Value |
   |---|---|
   | `SHOPIFY_STORE_DOMAIN` | `amahc.myshopify.com` |
   | `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | the Commission Review app in the Shopify Dev Dashboard (read-only scopes: `read_orders, read_all_orders, read_draft_orders, read_customers, read_discounts, read_shipping`) |
   | `ANTHROPIC_API_KEY` | *optional*: console.anthropic.com → API Keys. Leave unset to run on rules only. |
   | `CRON_SECRET` | the value shown by step 5 below |

3. **Let GitHub deploy the function.** Create a Supabase access token at
   https://supabase.com/dashboard/account/tokens. In this repo, add it as an
   Actions secret named `SUPABASE_ACCESS_TOKEN` (Settings → Secrets and
   variables → Actions → New repository secret). Then run **Deploy Supabase
   Edge Functions** from the Actions tab. It runs the tests first, and
   redeploys by itself whenever the function changes.
4. **Match reps to Shopify.** Each rep's `shopify_match` is a list of
   lower-case strings, matched against the order's staff member name and
   email and its tags. Beshoy and Lachy start with their first names and
   work emails. Change a rep's list like this:
   ```sql
   update commission_people set shopify_match = array['lachlan', 'lachlan@amanandhiscave.com'] where id = 'lachy';
   ```
5. **Schedule it.** Run `supabase/schedule-overnight-read.sql`. It ends by
   showing a random secret: copy that into Edge Functions → Secrets as
   `CRON_SECRET`.
6. **Backfill a month by hand (optional).** Each call reads up to 40
   orders with AI and leaves the rest for the next call:
   ```sql
   select net.http_post(
     url := 'https://wumotelrvysafszdxldw.supabase.co/functions/v1/overnight-read?since=2026-09-01',
     headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'overnight_cron_secret')),
     body := '{}'::jsonb, timeout_milliseconds := 150000);
   ```

**Orders that are never commission.** Orders carrying a tag in
`commission_settings.exclude_tags` are skipped entirely; this starts as
`["luca"]` for the creative strategist's creator-programme orders. Run
`supabase/migrations/0003_exclude_tags.sql` once to set it up. Change the
list with:
```sql
update commission_settings set value = '["luca", "cx-ticket"]' where key = 'exclude_tags';
```

**Re-reading orders already on the board.** Add `&force=1` to the backfill
URL. This refreshes the order data and the suggestion, but reps' answers
and decisions are kept.

**Freight is version 1.** It flags shipping charged below the shipping
line's own list price (a discounted or overridden rate). It does not yet
re-quote Shopify's rate for the same service and address. That comparison
is what the "measured against the Shopify rate" figures in the deck need.

**Not wired in yet:** Aircall calls, Fathom meetings and Gmail threads.
Until they are, the AI read says the call wasn't checked, and
`discussed_on_call` stays false.

### Importing by hand

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
