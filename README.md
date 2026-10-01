# Commission Review

A weekly board for A Man & His Cave's sales commission. It covers discounts
over 5%, freight charged under the Shopify rate, refunds and sales claims.
Each one gets reviewed while the call is still fresh, not argued about at
month-end.

- **Reps** get a numbered list of what needs their answer. They pick a
  reason, write a line, and attach proof by dropping, pasting or linking a
  screenshot.
- **The reviewer (Anj)** sees each order's discount breakdown, the AI's
  pre-read with call quotes, and the full transcript. She accepts, waives,
  counts, asks the rep or escalates to **the approver (Jaya)**, then signs
  the week off.
- **Slack** gets one Monday 8am message in `#commission-review` saying
  what each person has to do. Questions, escalations and sign-offs post
  there too.
- **Accounts** get weekly payout totals and a CSV export.

The AI only suggests, with its evidence attached. A named person's click
moves every dollar, and every action is logged with who did it and when.

## How it's built

- **`web/`** is the whole app: a static site (`index.html`, `js/app.js`,
  `js/api.js`, `css/app.css`). GitHub Pages deploys it on every push to
  `main`.
- **`supabase/migrations/0001_commission_review.sql`** holds the database:
  tables, the passcode-checked functions behind every read and write, the
  Slack posting, and the Monday message.
- **`supabase/demo-seed.sql`** is optional demo data: the September orders
  from the walkthrough deck.

**Security model:** none of the data is publicly readable. Every person
has their own passcode, which is checked in Postgres on every call. A rep
only ever gets their own orders back, and only reviewers can import,
decide, ask or escalate.

- **`supabase/functions/overnight-read`** is the nightly job: it reads
  Shopify orders, has Claude write the suggestion, and loads the flags.
  Tests: `deno test --allow-env supabase/functions/overnight-read/`.
  Aircall, Fathom and Gmail evidence aren't wired in yet.

**See [SETUP.md](SETUP.md) to stand it up.**

## Running locally

```
cd web
python3 -m http.server 8000
```

Then point `web/js/config.js` at the Supabase project.
