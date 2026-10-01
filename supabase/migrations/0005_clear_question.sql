-- Lets a reviewer clear a question (commission_ask with an empty question),
-- and tidies the dashes in the question / escalation Slack messages.
-- Run once in the SQL Editor after 0004. Safe to re-run.

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
  select * into v_flag from commission_flags where id = p_flag_id;
  if v_flag.id is null then
    raise exception 'unknown flag';
  end if;

  -- An empty question clears it (asked by mistake, or already sorted).
  -- The rep's answer, if any, is kept; nothing is posted to Slack.
  if p_question is null or trim(p_question) = '' then
    update commission_flags set question = null, question_by = null, question_at = null, updated_at = now()
    where id = p_flag_id;
    perform _commission_log(p_flag_id, v_person, 'question cleared', '{}'::jsonb);
    return;
  end if;

  update commission_flags set
    question = trim(p_question), question_by = v_person.name, question_at = now(),
    -- asking again re-opens the rep's side so they can answer
    rep_case = null, rep_answered_at = null,
    updated_at = now()
  where id = p_flag_id;

  perform _commission_log(p_flag_id, v_person, 'asked', jsonb_build_object('question', p_question));
  perform _commission_notify(':speech_balloon: ' || _commission_mention(v_flag.rep_id) || ' — ' || v_person.name
    || ' has a question on order #' || v_flag.order_no || ': "' || trim(p_question) || '". Answer it on the board.');
end;
$$;

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
      || ' — ' || v_person.name || ' escalated order #' || v_flag.order_no || ' (' || _commission_money(v_flag.amount)
      || ', ' || (select name from commission_people where id = v_flag.rep_id) || '): "' || v_note || '"');
  end if;
end;
$$;

grant execute on function commission_ask(text, text, text, text) to anon, authenticated;
grant execute on function commission_escalate(text, text, text, text) to anon, authenticated;
