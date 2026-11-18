-- Purgō Portal: emailing quotes, online quote acceptance, notifications and the Gmail connection.
-- Run after accounts.sql. Safe to re-run.

-- ============ Quotes the customer can open online ============
alter table public.quotes add column if not exists share_token uuid unique;      -- the secret in the customer's link
alter table public.quotes add column if not exists customer_html text;           -- the quote exactly as the customer was sent it
alter table public.quotes add column if not exists shared_at timestamptz;
alter table public.quotes add column if not exists viewed_at timestamptz;        -- first time the customer opened it
alter table public.quotes add column if not exists accepted_at timestamptz;
alter table public.quotes add column if not exists accepted_name text;
alter table public.quotes add column if not exists declined_at timestamptz;
alter table public.quotes add column if not exists response_note text;           -- what the customer wrote when replying online

-- staff press "Email quote": get the quote's link (p_html null), then on sending store the customer's copy (the same link is reused)
create or replace function public.share_quote(p_quote uuid, p_html text) returns uuid
language plpgsql set search_path = public as $$
declare t uuid;
begin
  if not public.is_staff() then raise exception 'Not allowed' using errcode = '42501'; end if;
  update quotes set share_token = coalesce(share_token, gen_random_uuid()), customer_html = coalesce(p_html, customer_html), shared_at = case when p_html is null then shared_at else now() end
  where id = p_quote returning share_token into t;
  if t is null then raise exception 'Quote not found'; end if;
  return t;
end $$;
grant execute on function public.share_quote(uuid, text) to authenticated;

-- communication log: online responses to a quote
alter table public.account_comms drop constraint if exists account_comms_kind_check;
alter table public.account_comms add constraint account_comms_kind_check check (kind in ('note','call','sms','email','visit','quote'));

-- ============ Notifications shown in the Portal (bell) ============
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                 -- quote_accepted, quote_declined, quote_question, email_in
  title text not null,
  body text,
  quote_id uuid references public.quotes(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  read_at timestamptz,
  read_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists notifications_created_idx on public.notifications (created_at desc);
alter table public.notifications enable row level security;
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (public.is_staff());
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete to authenticated using (public.is_admin());
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
exception when undefined_object then null;
end $$;

-- ============ Gmail connection (server only: no app user can read it) ============
create table if not exists public.mail_connection (
  id int primary key default 1 check (id = 1),
  provider text not null default 'gmail',
  address text,
  refresh_token text,
  history_id text,
  connected_by_name text,
  connected_at timestamptz,
  last_sync timestamptz,
  last_error text,
  oauth_state text,                   -- one-time value while connecting
  oauth_state_at timestamptz,
  oauth_return text,
  cron_key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')   -- the scheduled sync job sends this
);
alter table public.mail_connection add column if not exists cron_key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
insert into public.mail_connection (id) values (1) on conflict (id) do nothing;
alter table public.mail_connection enable row level security;   -- no policies: only the server (service role) can use it
revoke all on public.mail_connection from anon, authenticated;

-- ============ Check the mailbox every 2 minutes (needs pg_cron + pg_net) ============
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
-- this project's address, kept in the vault (live: https://iixqkqkmdholetujuqin.supabase.co, dev: https://mzqgazqbkmenssrdbuiq.supabase.co)
-- select vault.create_secret('https://<project>.supabase.co', 'purgo_project_url', 'Supabase project URL for scheduled jobs');
create or replace function public.run_mail_sync() returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'purgo_project_url') || '/functions/v1/mail',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-purgo-key', (select cron_key from public.mail_connection where id = 1)),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 60000);
$$;
revoke execute on function public.run_mail_sync() from public, anon, authenticated;
select cron.unschedule('purgo-mail-sync') where exists (select 1 from cron.job where jobname = 'purgo-mail-sync');
select cron.schedule('purgo-mail-sync', '*/2 * * * *', 'select public.run_mail_sync()');
