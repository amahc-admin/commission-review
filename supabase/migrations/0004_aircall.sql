-- Aircall: what the overnight read and the recording player need.
--
--   * _commission_overnight_context now also says whether each flag's
--     Aircall calls were checked, so a long backfill resumes where it left
--     off instead of starting again.
--   * _commission_call_access -- the call-recording function asks this
--     before fetching a recording: right passcode, and the call belongs to
--     a flag that person may see (a rep: only their own orders).
--
-- Run once in the SQL Editor after 0003. Safe to re-run.

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
    -- "<shopify updatedAt>|<ai|rules>|<c if Aircall was checked>" per flag
    'seen', (select coalesce(jsonb_object_agg(id,
               (details->>'shopify_updated_at') || '|' || coalesce(ai->>'source', 'ai') || '|'
               || case when (ai->>'calls_checked')::boolean then 'c' else '' end), '{}'::jsonb)
             from commission_flags where details ? 'shopify_updated_at'),
    'exclude_tags', coalesce((select value from commission_settings where key = 'exclude_tags'), '[]'::jsonb)
  );
$$;

create or replace function _commission_call_access(p_person_id text, p_passcode text, p_flag_id text, p_aircall_id bigint)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_person commission_people := _commission_auth(p_person_id, p_passcode);
begin
  return exists (
    select 1 from commission_flags f, jsonb_array_elements(f.calls) c
    where f.id = p_flag_id
      and (v_person.role = 'reviewer' or f.rep_id = v_person.id)
      and (c->>'aircall_id')::bigint = p_aircall_id
  );
end;
$$;

revoke execute on function _commission_overnight_context() from public, anon, authenticated;
revoke execute on function _commission_call_access(text, text, text, bigint) from public, anon, authenticated;
grant execute on function _commission_overnight_context() to service_role;
grant execute on function _commission_call_access(text, text, text, bigint) to service_role;
