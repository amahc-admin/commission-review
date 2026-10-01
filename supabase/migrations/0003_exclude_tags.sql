-- Orders that are never commission, by Shopify tag (e.g. "luca": the
-- creative strategist's creator-programme orders). The overnight read skips
-- them entirely, so they don't show as "not matched to a rep" either.
-- Change the list any time:
--   update commission_settings set value = '["luca", "cx-ticket"]' where key = 'exclude_tags';
-- Run once in the SQL Editor after 0002. Safe to re-run.

create table if not exists commission_settings (
  key text primary key,
  value jsonb not null
);
alter table commission_settings enable row level security;
revoke all on commission_settings from anon, authenticated;
grant all on commission_settings to service_role;

insert into commission_settings (key, value) values ('exclude_tags', '["luca"]')
on conflict (key) do nothing;

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
    -- "<shopify updatedAt>|<ai|rules>" per flag, so a rule-checked order can be
    -- upgraded to an AI read once a Claude key is added.
    'seen', (select coalesce(jsonb_object_agg(id, (details->>'shopify_updated_at') || '|' || coalesce(ai->>'source', 'ai')), '{}'::jsonb)
             from commission_flags where details ? 'shopify_updated_at'),
    'exclude_tags', coalesce((select value from commission_settings where key = 'exclude_tags'), '[]'::jsonb)
  );
$$;

revoke execute on function _commission_overnight_context() from public, anon, authenticated;
grant execute on function _commission_overnight_context() to service_role;
