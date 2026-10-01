-- What the overnight read (supabase/functions/overnight-read) needs:
--
--   * commission_people.shopify_match -- which Shopify staff member(s) /
--     order tags belong to each rep, so an order lands on the right board.
--   * _commission_import_rows -- the import loop, split out of
--     commission_import so the overnight job (running with the service
--     role, no passcode) can load flags. Browsers can't call it.
--   * commission_runs -- one row per overnight run, so reviewers can see
--     when it last ran and what it found or couldn't attribute.
--
-- Run once in the SQL Editor after 0001. Safe to re-run.

-- ============================== rep matching ==============================
-- Lower-case strings matched against the order's staff member name and
-- email, and its tags. Any match assigns the order to that rep.
alter table commission_people add column if not exists shopify_match text[] not null default '{}';

update commission_people set shopify_match = array['beshoy', 'beshoy@amanandhiscave.com']
where id = 'beshoy' and shopify_match = '{}';
update commission_people set shopify_match = array['lachlan', 'lachy', 'lachlan@amanandhiscave.com']
where id = 'lachy' and shopify_match = '{}';

-- ============================== import ==============================

create or replace function _commission_import_rows(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r jsonb;
  v_count int := 0;
  v_kind text;
  v_rep text;
  v_date date;
begin
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
    -- Only the ORDER and AI fields refresh -- a rep's answer and a
    -- reviewer's decision are never touched by a re-import.
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

create or replace function commission_import(p_person_id text, p_passcode text, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
begin
  perform _commission_require_reviewer(v_person);
  return _commission_import_rows(p_rows);
end;
$$;

-- What the overnight job needs to know before it spends an AI call: the
-- people it can attribute orders to, and which flags it has already read
-- (and at what Shopify version), so unchanged orders are skipped.
create or replace function _commission_overnight_context()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'match', shopify_match)), '[]'::jsonb)
               from commission_people where active and role = 'rep'),
    'seen', (select coalesce(jsonb_object_agg(id, details->>'shopify_updated_at'), '{}'::jsonb)
             from commission_flags where details ? 'shopify_updated_at')
  );
$$;

-- ============================== run log ==============================

create table if not exists commission_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  -- {"orders_scanned", "flags_written", "ai_reads", "skipped_unchanged",
  --  "unattributed": [{"order_no", "staff", "amount"}], "error"}
  summary jsonb not null default '{}'::jsonb
);
alter table commission_runs enable row level security;
revoke all on commission_runs from anon, authenticated;
revoke all on sequence commission_runs_id_seq from anon, authenticated;

-- The board shows reviewers the last run (when, and anything it couldn't
-- attribute to a rep). Reps don't see run details.
create or replace function commission_last_run(p_person_id text, p_passcode text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
begin
  perform _commission_require_reviewer(v_person);
  return (select to_jsonb(r) from commission_runs r order by id desc limit 1);
end;
$$;

-- ============================== grants ==============================
revoke execute on function _commission_import_rows(jsonb) from public, anon, authenticated;
revoke execute on function _commission_overnight_context() from public, anon, authenticated;
grant execute on function _commission_import_rows(jsonb) to service_role;
grant execute on function _commission_overnight_context() to service_role;
grant all on commission_runs to service_role;
grant usage on sequence commission_runs_id_seq to service_role;
grant execute on function commission_import(text, text, jsonb) to anon, authenticated;
grant execute on function commission_last_run(text, text) to anon, authenticated;
