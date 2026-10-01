-- Any date range on the board, not just one month split into fixed weeks:
--
--   * commission_board_range -- like commission_board, for flags whose
--     order date falls between p_from and p_to (inclusive), across months.
--   * commission_sign_off_range -- signs off whatever range is on screen,
--     once every flag in it with money at stake is decided.
--
-- Run once in the SQL Editor after 0005. Safe to re-run.

create table if not exists commission_range_signoffs (
  from_date date not null,
  to_date date not null,
  signed_by text not null,
  signed_at timestamptz not null default now(),
  primary key (from_date, to_date)
);
alter table commission_range_signoffs enable row level security;
revoke all on commission_range_signoffs from anon, authenticated;

create or replace function commission_board_range(p_person_id text, p_passcode text, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
  v_is_reviewer boolean := v_person.role = 'reviewer';
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'pick a start and end date';
  end if;
  if p_to - p_from > 400 then
    raise exception 'pick a range of a year or less';
  end if;

  return jsonb_build_object(
    'me', jsonb_build_object('id', v_person.id, 'name', v_person.name, 'role', v_person.role, 'is_approver', v_person.is_approver),
    'from', p_from,
    'to', p_to,
    -- earliest / latest order on this person's board, for the calendar
    'bounds', (select jsonb_build_object('min', min(order_date), 'max', max(order_date))
               from commission_flags where v_is_reviewer or rep_id = v_person.id),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'role', role, 'is_approver', is_approver) order by name), '[]'::jsonb)
               from commission_people where active and (v_is_reviewer or id = v_person.id)),
    'flags', (select coalesce(jsonb_agg(
                to_jsonb(f) - 'created_at' || jsonb_build_object('week', _commission_week(f.order_date))
                order by f.order_date, f.order_no), '[]'::jsonb)
              from commission_flags f
              where f.order_date between p_from and p_to and (v_is_reviewer or f.rep_id = v_person.id)),
    'signoff', (select to_jsonb(s) from commission_range_signoffs s where s.from_date = p_from and s.to_date = p_to),
    'log', (select coalesce(jsonb_agg(to_jsonb(l) order by l.at desc), '[]'::jsonb)
            from commission_log l join commission_flags f on f.id = l.flag_id
            where f.order_date between p_from and p_to and (v_is_reviewer or f.rep_id = v_person.id))
  );
end;
$$;

create or replace function commission_sign_off_range(p_person_id text, p_passcode text, p_from date, p_to date)
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
  where order_date between p_from and p_to and amount > 0;

  if v_total = 0 then
    raise exception 'nothing to sign off in this range';
  end if;
  if v_open > 0 then
    raise exception '% flag(s) in this range still need a decision', v_open;
  end if;

  insert into commission_range_signoffs (from_date, to_date, signed_by) values (p_from, p_to, v_person.name)
  on conflict (from_date, to_date) do update set signed_by = excluded.signed_by, signed_at = now();

  perform _commission_notify(':white_check_mark: *' || v_person.name || '* signed off '
    || to_char(p_from, 'FMDD FMMon') || ' – ' || to_char(p_to, 'FMDD FMMon YYYY') || ': ' || v_total || ' flag(s), '
    || _commission_money(v_waived) || ' waived, ' || _commission_money(v_counted) || ' counts. Board''s clean for that range.');
end;
$$;

grant execute on function commission_board_range(text, text, date, date) to anon, authenticated;
grant execute on function commission_sign_off_range(text, text, date, date) to anon, authenticated;
