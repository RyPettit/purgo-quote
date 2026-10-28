-- Purgō: run the fuel-prices function every morning at 05:30 UK time.
-- Run once in Supabase → SQL Editor, AFTER the fuel-prices function is deployed
-- and its secrets are set. Replace PASTE_THE_SAME_KEY_HERE with the PURGO_CRON_KEY
-- value you saved as a function secret.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- keep the key in the vault rather than in the job text
select vault.create_secret('PASTE_THE_SAME_KEY_HERE', 'purgo_cron_key', 'Shared key for the daily fuel price job')
where not exists (select 1 from vault.secrets where name = 'purgo_cron_key');

create or replace function public.run_fuel_update() returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://iixqkqkmdholetujuqin.supabase.co/functions/v1/fuel-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-purgo-key', (select decrypted_secret from vault.decrypted_secrets where name = 'purgo_cron_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$$;
revoke execute on function public.run_fuel_update() from public, anon, authenticated;

-- cron runs in UTC: 05:30 UTC is 05:30 in winter and 06:30 in summer
select cron.unschedule('purgo-fuel-daily') where exists (select 1 from cron.job where jobname = 'purgo-fuel-daily');
select cron.schedule('purgo-fuel-daily', '30 5 * * *', 'select public.run_fuel_update()');

-- run it once now to test; the result appears in settings → fuel_status within a minute or two
select public.run_fuel_update();
