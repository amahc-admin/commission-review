-- Schedules the overnight read every night. Run once in the SQL Editor
-- AFTER the overnight-read function is deployed (see SETUP.md).
--
-- 1. Makes a random secret, keeps it in Vault for pg_cron, and shows it
--    to you once: copy it into Edge Functions -> Secrets as CRON_SECRET.
-- 2. Schedules the call. pg_cron runs in UTC: 16:00 UTC is 3am in Sydney
--    during daylight saving (2am the rest of the year).
--
-- Needs the pg_cron and pg_net extensions (Database -> Extensions).

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'overnight_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'overnight_cron_secret', 'Shared with the overnight-read function as CRON_SECRET');
  end if;
end $$;

select cron.schedule(
  'commission-overnight-read',
  '0 16 * * *',
  $job$
  select net.http_post(
    url := 'https://wumotelrvysafszdxldw.supabase.co/functions/v1/overnight-read',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'overnight_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- Copy this value into Edge Functions -> Secrets as CRON_SECRET:
select decrypted_secret as cron_secret_copy_this from vault.decrypted_secrets where name = 'overnight_cron_secret';
