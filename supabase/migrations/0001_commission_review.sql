-- Commission review board: discounts over 5%, freight charged under cost,
-- refunds and sales claims, reviewed weekly instead of argued at
-- month-end. Run this once in the SQL Editor of this app's own Supabase
-- project (see SETUP.md). Safe to re-run.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;
--
-- How the week works:
--   1. Flags (with the AI's pre-read attached) are loaded in through
--      commission_import -- either pasted into the board by a reviewer or
--      posted nightly by whatever job does the Shopify/call-recording
--      read. This file doesn't do the AI read itself; it stores and
--      shows it.
--   2. Monday 8am, commission_weekly_ping() posts one message to the
--      commission Slack channel: what each rep has to answer, what the
--      reviewer has to sign off.
--   3. Reps answer their own flags (reason + case + proof screenshot).
--   4. A reviewer (Anj / Jaya) accepts the AI's read, waives, counts or
--      overrides each flag -- every decision is logged with their name --
--      and signs the week off.
--   5. Month-end: anything undecided counts against the rep as-is.
--
-- Security model:
--   * Nothing in these tables is publicly readable: RLS is on with no
--     policies at all, and table privileges are revoked from anon /
--     authenticated, so the only way in is through the RPCs below.
--   * Every person has their OWN passcode (not a shared team one), checked
--     server-side on every call. A rep only ever gets back their own
--     flags; only a reviewer sees everyone's, imports, or decides.
--   * Internal helpers (_commission_*) have EXECUTE revoked from the
--     browser roles, so the Slack webhook can't be spammed directly.

-- ============================== tables ==============================

create table if not exists commission_people (
  id text primary key,
  name text not null,
  role text not null check (role in ('rep', 'reviewer')),
  passcode_hash text not null,
  -- e.g. '<@U0A6NFT3W1Y>' so the weekly ping actually @-mentions them;
  -- falls back to the plain name when empty.
  slack_mention text,
  -- The person a reviewer escalates to when they're not sure (Jaya).
  -- "Anything she doesn't know, she pushes forward to me."
  is_approver boolean not null default false,
  active boolean not null default true
);

create table if not exists commission_flags (
  id text primary key,
  order_no text not null,
  kind text not null check (kind in ('discount', 'freight', 'refund', 'claim')),
  -- 'YYYY-MM' -- the commission month this flag pays out in.
  period text not null check (period ~ '^\d{4}-\d{2}$'),
  order_date date not null,
  customer text,
  rep_id text not null references commission_people(id),
  gross numeric(12,2),
  -- Dollars at stake: the discount total, the freight shortfall (cost
  -- minus charged -- negative means over-recovered, which counts FOR the
  -- rep), the refund, or the claimed order's value.
  amount numeric(12,2) not null,
  pct numeric(6,2),
  order_url text,
  -- kind-specific extras, e.g. freight: {"service","charged","cost"}
  details jsonb not null default '{}'::jsonb,
  -- discount breakdown: [{"type","label","note","amount","side":"company"|"rep"}]
  slices jsonb not null default '[]'::jsonb,
  -- the AI's pre-read: {"verdict","waive_amount","confidence","summary",
  -- "points":[...],"discussed_on_call","quotes":[{"speaker","text","call_id","t"}],"reviewed_at"}
  ai jsonb not null default '{}'::jsonb,
  -- [{"id","date","rep","minutes","direction","audio_url","lines":[{"speaker","name","t","text"}]}]
  calls jsonb not null default '[]'::jsonb,

  rep_reason text,
  rep_case text,
  rep_proof jsonb not null default '[]'::jsonb,
  rep_answered_at timestamptz,

  question text,
  question_by text,
  question_at timestamptz,

  escalated_by text,
  escalated_note text,
  escalated_at timestamptz,

  decision text check (decision in ('waive', 'partial', 'counts', 'push', 'reject')),
  waived_amount numeric(12,2),
  decision_note text,
  decided_by text,
  decided_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_no, kind)
);
create index if not exists commission_flags_period_idx on commission_flags (period);
create index if not exists commission_flags_rep_idx on commission_flags (rep_id);

create table if not exists commission_log (
  id bigserial primary key,
  flag_id text references commission_flags(id) on delete cascade,
  actor_id text not null,
  actor_name text not null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists commission_log_flag_idx on commission_log (flag_id);

create table if not exists commission_signoffs (
  period text not null,
  week int not null check (week between 1 and 5),
  signed_by text not null,
  signed_at timestamptz not null default now(),
  primary key (period, week)
);

alter table commission_people enable row level security;
alter table commission_flags enable row level security;
alter table commission_log enable row level security;
alter table commission_signoffs enable row level security;
-- No policies on purpose: RLS with no policy returns nothing. Belt and
-- braces on top of that -- the browser roles get no table privileges.
revoke all on commission_people, commission_flags, commission_log, commission_signoffs from anon, authenticated;
revoke all on sequence commission_log_id_seq from anon, authenticated;

-- Proof screenshots (Osama run bookings, courier costs, sign-offs).
-- Public-by-URL, but with NO select policy,
-- so nobody can list the bucket -- a file is only reachable by its
-- random, unguessable URL, which only lives on the flag row (itself only
-- readable through the passcode-checked RPCs).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('commission-proof', 'commission-proof', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists "anyone can upload commission proof" on storage.objects;
create policy "anyone can upload commission proof"
  on storage.objects for insert
  with check (bucket_id = 'commission-proof');

-- ============================== helpers ==============================

create or replace function _commission_auth(p_person_id text, p_passcode text)
returns commission_people
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people;
begin
  select * into v_person from commission_people where id = p_person_id and active;
  if v_person.id is null or p_passcode is null or crypt(p_passcode, v_person.passcode_hash) <> v_person.passcode_hash then
    raise exception 'wrong name or passcode' using errcode = '28000';
  end if;
  return v_person;
end;
$$;

create or replace function _commission_require_reviewer(p_person commission_people)
returns void
language plpgsql
as $$
begin
  if p_person.role <> 'reviewer' then
    raise exception 'only a reviewer can do this' using errcode = '28000';
  end if;
end;
$$;

-- Week of the month the order landed in: 1-7 = week 1, 8-14 = 2,
-- 15-21 = 3, 22-28 = 4, 29-31 = 5.
create or replace function _commission_week(p_date date)
returns int
language sql
immutable
as $$
  select least(5, ((extract(day from p_date)::int - 1) / 7) + 1);
$$;

-- Does this flag need the rep to say something? Undecided, real money at
-- stake, no case stated yet, and the AI isn't already fully on their side.
create or replace function _commission_needs_case(f commission_flags)
returns boolean
language sql
immutable
as $$
  select f.decision is null
     and f.amount > 0
     and f.rep_case is null
     and coalesce(f.ai->>'verdict', '') not in ('waive', 'related');
$$;

-- Posts to the private #commission-review channel's Incoming Webhook,
-- kept in Supabase Vault (never in a readable column).
--   select vault.create_secret('https://hooks.slack.com/services/...', 'commission_slack_webhook_url', 'Commission review channel');
create or replace function _commission_notify(p_text text)
returns void
language plpgsql
security definer
set search_path = public, extensions, vault, net
as $$
declare
  v_url text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'commission_slack_webhook_url';
  if v_url is null then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('text', p_text)
  );
exception when others then
  -- a notification failure must never block a decision or an answer
  null;
end;
$$;

create or replace function _commission_log(p_flag_id text, p_person commission_people, p_action text, p_detail jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into commission_log (flag_id, actor_id, actor_name, action, detail)
  values (p_flag_id, p_person.id, p_person.name, p_action, coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function _commission_mention(p_person_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(slack_mention, ''), '*' || name || '*') from commission_people where id = p_person_id;
$$;

create or replace function _commission_money(p numeric)
returns text
language sql
immutable
as $$
  select '$' || to_char(round(coalesce(p, 0)), 'FM999,999,990');
$$;

-- ============================== reads ==============================

-- Names and roles only, for the login picker -- no amounts.
create or replace function list_commission_people()
returns table (id text, name text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select id, name, role from commission_people where active order by role desc, name;
$$;

create or replace function commission_login(p_person_id text, p_passcode text)
returns table (id text, name text, role text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
begin
  return query select v_person.id, v_person.name, v_person.role;
end;
$$;

-- Everything the board needs for one commission month, in one call.
-- A rep gets only their own flags; a reviewer gets everyone's plus the
-- decision log. p_period null = the latest month that has flags.
create or replace function commission_board(p_person_id text, p_passcode text, p_period text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  v_is_reviewer boolean := v_person.role = 'reviewer';
  v_period text;
  v_periods jsonb;
begin
  select coalesce(jsonb_agg(p order by p desc), '[]'::jsonb) into v_periods
  from (select distinct period as p from commission_flags where v_is_reviewer or rep_id = v_person.id) s;

  v_period := coalesce(nullif(p_period, ''), v_periods->>0, to_char(now(), 'YYYY-MM'));

  return jsonb_build_object(
    'me', jsonb_build_object('id', v_person.id, 'name', v_person.name, 'role', v_person.role, 'is_approver', v_person.is_approver),
    'period', v_period,
    'periods', v_periods,
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'role', role, 'is_approver', is_approver) order by name), '[]'::jsonb)
               from commission_people where active and (v_is_reviewer or id = v_person.id)),
    'flags', (select coalesce(jsonb_agg(
                to_jsonb(f) - 'created_at' || jsonb_build_object('week', _commission_week(f.order_date))
                order by f.order_date, f.order_no), '[]'::jsonb)
              from commission_flags f
              where f.period = v_period and (v_is_reviewer or f.rep_id = v_person.id)),
    'signoffs', (select coalesce(jsonb_agg(to_jsonb(s) order by s.week), '[]'::jsonb)
                 from commission_signoffs s where s.period = v_period),
    'log', (select coalesce(jsonb_agg(to_jsonb(l) order by l.at desc), '[]'::jsonb)
            from commission_log l join commission_flags f on f.id = l.flag_id
            where f.period = v_period and (v_is_reviewer or f.rep_id = v_person.id))
  );
end;
$$;

-- ============================== rep writes ==============================

-- A rep states their case on one of their own flags. Exceptions that the
-- rule says must be proven (courier runs, sign-offs) are refused without
-- a proof attachment -- one screenshot now beats an argument later.
create or replace function commission_answer(
  p_person_id text, p_passcode text, p_flag_id text, p_reason text, p_case text, p_proof jsonb
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  v_flag commission_flags;
  v_proof jsonb := coalesce(p_proof, '[]'::jsonb);
begin
  select * into v_flag from commission_flags where id = p_flag_id;
  if v_flag.id is null then
    raise exception 'unknown flag';
  end if;
  if v_flag.rep_id <> v_person.id then
    raise exception 'you can only answer your own flags' using errcode = '28000';
  end if;
  if v_flag.decision is not null then
    raise exception 'this one has already been decided -- ask a reviewer to reopen it';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'pick a reason';
  end if;
  if jsonb_typeof(v_proof) <> 'array' then
    raise exception 'proof must be a list of links';
  end if;
  if p_reason in ('Osama run', 'Private courier', 'Approved by Jaya or Ross') and jsonb_array_length(v_proof) = 0 then
    raise exception '"%" needs a screenshot attached as proof', p_reason;
  end if;

  update commission_flags set
    rep_reason = trim(p_reason),
    rep_case = nullif(trim(coalesce(p_case, '')), ''),
    rep_proof = v_proof,
    rep_answered_at = now(),
    updated_at = now()
  where id = p_flag_id;

  -- rep_case is what "case stated" means everywhere else; a reason with
  -- no words still counts as stated.
  update commission_flags set rep_case = rep_reason where id = p_flag_id and rep_case is null;

  perform _commission_log(p_flag_id, v_person, 'answered',
    jsonb_build_object('reason', p_reason, 'case', p_case, 'proof', v_proof));
end;
$$;

-- ============================== reviewer writes ==============================

-- p_decision:
--   'waive'   -- the whole amount is waived (company-side / proven)
--   'counts'  -- the whole amount counts against the rep
--   'partial' -- p_waived of it is waived, the rest counts (Accept AI)
--   'push' / 'reject' -- claims only: push the order to the claimer's
--                        commission, or reject the claim
-- p_decision null reopens the flag (undecides it), logged like any other.
create or replace function commission_decide(
  p_person_id text, p_passcode text, p_flag_id text, p_decision text, p_waived numeric, p_note text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  v_flag commission_flags;
  v_waived numeric;
begin
  perform _commission_require_reviewer(v_person);
  select * into v_flag from commission_flags where id = p_flag_id;
  if v_flag.id is null then
    raise exception 'unknown flag';
  end if;

  if p_decision is null then
    v_waived := null;
  elsif v_flag.kind = 'claim' then
    if p_decision not in ('push', 'reject') then
      raise exception 'a claim is either pushed to commission or rejected';
    end if;
    v_waived := null;
  elsif p_decision = 'waive' then
    v_waived := v_flag.amount;
  elsif p_decision = 'counts' then
    v_waived := 0;
  elsif p_decision = 'partial' then
    if p_waived is null or p_waived < 0 or p_waived > v_flag.amount then
      raise exception 'the waived part has to be between $0 and the flagged amount';
    end if;
    v_waived := round(p_waived, 2);
  else
    raise exception 'unknown decision';
  end if;

  update commission_flags set
    decision = p_decision,
    waived_amount = v_waived,
    decision_note = nullif(trim(coalesce(p_note, '')), ''),
    decided_by = case when p_decision is null then null else v_person.name end,
    decided_at = case when p_decision is null then null else now() end,
    updated_at = now()
  where id = p_flag_id;

  perform _commission_log(p_flag_id, v_person, coalesce('decided:' || p_decision, 'reopened'),
    jsonb_build_object('waived', v_waived, 'amount', v_flag.amount, 'note', p_note, 'ai_verdict', v_flag.ai->>'verdict'));
end;
$$;

-- "Not sure? Ask the rep for their case" -- lands on their board and pings
-- them in the commission channel. No back-and-forth in DMs.
create or replace function commission_ask(
  p_person_id text, p_passcode text, p_flag_id text, p_question text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  v_flag commission_flags;
begin
  perform _commission_require_reviewer(v_person);
  if p_question is null or trim(p_question) = '' then
    raise exception 'write the question';
  end if;
  select * into v_flag from commission_flags where id = p_flag_id;
  if v_flag.id is null then
    raise exception 'unknown flag';
  end if;

  update commission_flags set
    question = trim(p_question), question_by = v_person.name, question_at = now(),
    -- asking again re-opens the rep's side so they can answer
    rep_case = null, rep_answered_at = null,
    updated_at = now()
  where id = p_flag_id;

  perform _commission_log(p_flag_id, v_person, 'asked', jsonb_build_object('question', p_question));
  perform _commission_notify(':speech_balloon: ' || _commission_mention(v_flag.rep_id) || ' -- ' || v_person.name
    || ' has a question on order #' || v_flag.order_no || ': "' || trim(p_question) || '". Answer it on the board.');
end;
$$;

-- "Not sure" on the reviewer side: pushes the flag up to the approver
-- (Jaya) with a note on what's unclear. It stays undecided -- either
-- reviewer can still decide it once it's understood -- but it's marked so
-- the approver sees exactly what needs their call. p_note null clears it.
create or replace function commission_escalate(
  p_person_id text, p_passcode text, p_flag_id text, p_note text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  v_flag commission_flags;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform _commission_require_reviewer(v_person);
  select * into v_flag from commission_flags where id = p_flag_id;
  if v_flag.id is null then
    raise exception 'unknown flag';
  end if;

  update commission_flags set
    escalated_by = case when v_note is null then null else v_person.name end,
    escalated_note = v_note,
    escalated_at = case when v_note is null then null else now() end,
    updated_at = now()
  where id = p_flag_id;

  perform _commission_log(p_flag_id, v_person, case when v_note is null then 'unescalated' else 'escalated' end,
    jsonb_build_object('note', v_note));
  if v_note is not null then
    perform _commission_notify(':arrow_up: ' || coalesce(
        (select string_agg(_commission_mention(id), ', ') from commission_people where is_approver and active), 'Approver')
      || ' -- ' || v_person.name || ' escalated order #' || v_flag.order_no || ' (' || _commission_money(v_flag.amount)
      || ', ' || (select name from commission_people where id = v_flag.rep_id) || '): "' || v_note || '"');
  end if;
end;
$$;

-- Bulk load / refresh flags. p_rows is a JSON array of flag objects (the
-- same field names as the commission_flags columns; see SETUP.md). Upserts
-- on (order_no, kind) and only ever refreshes the ORDER and AI fields --
-- a re-import never wipes a rep's answer or a reviewer's decision.
create or replace function commission_import(p_person_id text, p_passcode text, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  r jsonb;
  v_count int := 0;
  v_kind text;
  v_rep text;
  v_date date;
begin
  perform _commission_require_reviewer(v_person);
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'expected a JSON array of flags';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_kind := coalesce(nullif(r->>'kind', ''), 'discount');
    v_date := (r->>'order_date')::date;
    -- rep can be given as an id or a name
    select id into v_rep from commission_people
    where id = r->>'rep_id' or lower(name) = lower(coalesce(r->>'rep_id', r->>'rep'))
    limit 1;
    if v_rep is null then
      raise exception 'order %: unknown rep "%"', r->>'order_no', coalesce(r->>'rep_id', r->>'rep');
    end if;
    if r->>'order_no' is null or v_date is null or r->>'amount' is null then
      raise exception 'every flag needs order_no, order_date and amount';
    end if;

    insert into commission_flags (id, order_no, kind, period, order_date, customer, rep_id, gross, amount, pct,
                                  order_url, details, slices, ai, calls)
    values (
      v_kind || '-' || (r->>'order_no'), r->>'order_no', v_kind,
      coalesce(nullif(r->>'period', ''), to_char(v_date, 'YYYY-MM')), v_date,
      nullif(r->>'customer', ''), v_rep,
      nullif(r->>'gross', '')::numeric, (r->>'amount')::numeric, nullif(r->>'pct', '')::numeric,
      nullif(r->>'order_url', ''),
      coalesce(r->'details', '{}'::jsonb), coalesce(r->'slices', '[]'::jsonb),
      coalesce(r->'ai', '{}'::jsonb), coalesce(r->'calls', '[]'::jsonb)
    )
    on conflict (order_no, kind) do update set
      period = excluded.period, order_date = excluded.order_date, customer = excluded.customer,
      rep_id = excluded.rep_id, gross = excluded.gross, amount = excluded.amount, pct = excluded.pct,
      order_url = excluded.order_url, details = excluded.details, slices = excluded.slices,
      ai = excluded.ai, calls = excluded.calls, updated_at = now();
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Signs one week of one month off -- only once every flag in it with
-- money at stake is decided -- and posts the result to the channel.
create or replace function commission_sign_off_week(p_person_id text, p_passcode text, p_period text, p_week int)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  v_open int;
  v_total int;
  v_waived numeric;
  v_counted numeric;
begin
  perform _commission_require_reviewer(v_person);
  select count(*) filter (where decision is null), count(*),
         coalesce(sum(waived_amount) filter (where kind <> 'claim'), 0),
         coalesce(sum(amount - coalesce(waived_amount, 0)) filter (where kind <> 'claim' and decision is not null), 0)
    into v_open, v_total, v_waived, v_counted
  from commission_flags
  where period = p_period and _commission_week(order_date) = p_week and amount > 0;

  if v_open > 0 then
    raise exception '% flag(s) in this week still need a decision', v_open;
  end if;

  insert into commission_signoffs (period, week, signed_by) values (p_period, p_week, v_person.name)
  on conflict (period, week) do update set signed_by = excluded.signed_by, signed_at = now();

  perform _commission_notify(':white_check_mark: *' || v_person.name || '* signed off week ' || p_week || ' of '
    || to_char(to_date(p_period, 'YYYY-MM'), 'FMMonth') || ': ' || v_total || ' flag(s), '
    || _commission_money(v_waived) || ' waived, ' || _commission_money(v_counted) || ' counts. Board''s clean for that week.');
end;
$$;

-- ============================== the Monday ping ==============================

-- One message, once a week: what each rep has to answer, what the
-- reviewers have to sign off. Covers every month that still has
-- undecided flags (usually just the current one, plus last month's
-- backlog in its first week).
-- Optional: select vault.create_secret('https://amahc-admin.github.io/commission-review/', 'commission_board_url', 'Commission board link');
-- turns the ping's last line into a clickable "Open the board" link.
create or replace function _commission_weekly_text()
returns text
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  v_lines text := '';
  r record;
  v_reviewer_count int;
  v_escalated int;
begin
  for r in
    select f.rep_id,
           count(*) filter (where f.kind = 'discount') as discounts,
           coalesce(sum(f.amount) filter (where f.kind = 'discount'), 0) as discount_amt,
           count(*) filter (where f.kind = 'freight') as freight,
           count(*) filter (where _commission_needs_case(f)) as no_case,
           coalesce(sum(f.amount) filter (where _commission_needs_case(f)), 0) as no_case_amt,
           count(*) filter (where coalesce(f.ai->>'verdict', '') <> '') as ai_ready,
           count(*) filter (where f.question is not null and f.rep_case is null) as questions
    from commission_flags f
    where f.decision is null and f.amount > 0
    group by f.rep_id
    order by 1
  loop
    v_lines := v_lines || E'\n• ' || _commission_mention(r.rep_id) || ' -- '
      || r.discounts || ' discount(s) (' || _commission_money(r.discount_amt) || ')'
      || case when r.freight > 0 then ' · ' || r.freight || ' freight' else '' end
      || ' · ' || case when r.no_case > 0 then '*' || r.no_case || ' with no case stated* (' || _commission_money(r.no_case_amt) || ' at stake)' else 'all cases stated' end
      || ' · ' || r.ai_ready || ' have an AI suggestion ready'
      || case when r.questions > 0 then ' · ' || r.questions || ' question(s) waiting on you' else '' end;
  end loop;

  if v_lines = '' then
    return ':mag: *Weekly commission review* -- nothing open this week. Board''s clean.';
  end if;

  select count(*) into v_reviewer_count from commission_flags where decision is null and amount > 0;
  select count(*) into v_escalated from commission_flags where decision is null and escalated_at is not null;

  return ':mag: *Weekly commission review -- this week''s block.* The AI has pre-read every order below. '
    || 'Reps: state your case where money''s at stake, by Wednesday.'
    || v_lines
    || E'\n• Reviewers ('
    || coalesce((select string_agg(_commission_mention(id), ', ' order by name) from commission_people where role = 'reviewer' and active), 'none set')
    || ') -- ' || v_reviewer_count || ' to decide'
    || case when v_escalated > 0 then E'\n• ' || coalesce(
         (select string_agg(_commission_mention(id), ', ') from commission_people where is_approver and active), 'Approver')
         || ' -- ' || v_escalated || ' escalated, waiting on your call' else '' end
    || E'\n' || coalesce('<' || (select decrypted_secret from vault.decrypted_secrets where name = 'commission_board_url') || '|Open the board →>',
                         'Open the board.')
    || ' Anything undecided at month-end counts as-is.';
end;
$$;

-- What pg_cron calls every Monday (see SETUP.md). Not callable from the
-- browser -- reviewers use commission_post_weekly_ping instead.
create or replace function commission_weekly_ping()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _commission_notify(_commission_weekly_text());
end;
$$;

-- Lets a reviewer preview the Monday message (p_send false) or post it
-- now (p_send true) from the board.
create or replace function commission_post_weekly_ping(p_person_id text, p_passcode text, p_send boolean)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  v_text text;
begin
  perform _commission_require_reviewer(v_person);
  v_text := _commission_weekly_text();
  if p_send then
    perform _commission_notify(v_text);
  end if;
  return v_text;
end;
$$;

-- ============================== grants ==============================
-- Postgres lets PUBLIC execute every new function by default, and Supabase
-- also grants anon/authenticated on new functions -- so lock everything
-- down first, then open only the passcode-checked entry points.
revoke execute on function _commission_auth(text, text) from public, anon, authenticated;
revoke execute on function _commission_require_reviewer(commission_people) from public, anon, authenticated;
revoke execute on function _commission_needs_case(commission_flags) from public, anon, authenticated;
revoke execute on function _commission_notify(text) from public, anon, authenticated;
revoke execute on function _commission_log(text, commission_people, text, jsonb) from public, anon, authenticated;
revoke execute on function _commission_mention(text) from public, anon, authenticated;
revoke execute on function _commission_weekly_text() from public, anon, authenticated;
revoke execute on function commission_weekly_ping() from public, anon, authenticated;

grant execute on function list_commission_people() to anon, authenticated;
grant execute on function commission_login(text, text) to anon, authenticated;
grant execute on function commission_board(text, text, text) to anon, authenticated;
grant execute on function commission_answer(text, text, text, text, text, jsonb) to anon, authenticated;
grant execute on function commission_decide(text, text, text, text, numeric, text) to anon, authenticated;
grant execute on function commission_ask(text, text, text, text) to anon, authenticated;
grant execute on function commission_escalate(text, text, text, text) to anon, authenticated;
grant execute on function commission_import(text, text, jsonb) to anon, authenticated;
grant execute on function commission_sign_off_week(text, text, text, int) to anon, authenticated;
grant execute on function commission_post_weekly_ping(text, text, boolean) to anon, authenticated;

-- ============================== people ==============================
-- Temporary passcodes -- change every one before sharing the board (see
-- SETUP.md). Add/remove reps the same way.
insert into commission_people (id, name, role, passcode_hash, slack_mention, is_approver) values
  ('anj', 'Anj', 'reviewer', extensions.crypt('changeme-anj', extensions.gen_salt('bf')), '<@U0A6NFT3W1Y>', false),
  ('jaya', 'Jaya', 'reviewer', extensions.crypt('changeme-jaya', extensions.gen_salt('bf')), '<@U0171HNQ9R9>', true),
  ('lachy', 'Lachy', 'rep', extensions.crypt('changeme-lachy', extensions.gen_salt('bf')), null, false),
  ('beshoy', 'Beshoy', 'rep', extensions.crypt('changeme-beshoy', extensions.gen_salt('bf')), null, false)
on conflict (id) do nothing;
