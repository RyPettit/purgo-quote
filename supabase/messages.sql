-- Purgō: business details and editable customer messages (Admin → Reminders).
-- Run after jobs.sql, invoices.sql and reminders.sql. Safe to re-run: it never overwrites text you've edited.
--
-- Built so the Portal can be white-labelled: every customer-facing message is a template with {placeholders},
-- and the business name, phone, email, website and sign-off come from business_profile, not from the code.

-- ============ The business (one row) ============
create table if not exists public.business_profile (
  id int primary key default 1 check (id = 1),
  trading_name text not null default 'Purgō',
  legal_name text,
  phone text,
  email text,
  website text,
  sign_off text,                   -- how messages end, e.g. "Kind regards,\nThe Purgō team"
  updated_at timestamptz not null default now()
);
insert into public.business_profile (id, trading_name, legal_name, phone, email, website, sign_off)
values (1, 'Purgō', 'Purgō Clean Ltd', '07930 877034', 'hello@purgo-clean.com', 'www.purgo-clean.com', E'Kind regards,\nPurgō')
on conflict (id) do nothing;
alter table public.business_profile enable row level security;
drop policy if exists business_profile_read on public.business_profile;
create policy business_profile_read on public.business_profile for select to authenticated using (public.is_staff());
drop policy if exists business_profile_write on public.business_profile;
create policy business_profile_write on public.business_profile for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ============ Message templates ============
-- key: what it's for. send_hour: for scheduled messages, the hour (UK time) they go out.
create table if not exists public.message_templates (
  key text primary key,
  name text not null,
  channel text not null default 'email' check (channel in ('email','sms')),
  enabled boolean not null default true,
  subject text,
  body text not null,
  send_hour int check (send_hour between 0 and 23),
  sort int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by_name text
);
insert into public.message_templates (key, name, enabled, subject, body, send_hour, sort) values
('visit_reminder', 'Appointment reminder (the day before)', true,
 'Reminder: {business_name} visit tomorrow, {date}',
 E'Hi {first_name},\n\nJust a reminder that we''re booked in tomorrow, {date}, for:\n\n{visit_list}\n\nThere''s no need for you to be in, but please make sure we can get to the property (side gates unlocked, and cars moved off the drive if we''re working there).\n\nIf you need to move the date, just reply to this email or call us on {business_phone}.\n\n{sign_off}',
 16, 1),
('payment_reminder_1', 'Payment reminder (first)', true,
 'Reminder: {business_name} invoice {invoice_no}',
 E'Hi {first_name},\n\nJust a friendly reminder that invoice {invoice_no} for {amount_due} (work done on {work_date}) is still to be paid.\n\n{how_to_pay}\n\nIf you''ve already paid, thank you, and please ignore this email.\n\n{sign_off}',
 null, 2),
('payment_reminder_final', 'Payment reminder (final)', true,
 'Final reminder: {business_name} invoice {invoice_no}',
 E'Hi {first_name},\n\nWe still haven''t received payment of {amount_due} for invoice {invoice_no} (work done on {work_date}), so this is a final reminder.\n\n{how_to_pay}\n\nIf there''s a problem with the work or the invoice, please call us on {business_phone} and we''ll sort it out.\n\n{sign_off}',
 null, 3)
on conflict (key) do nothing;
alter table public.message_templates enable row level security;
drop policy if exists message_templates_read on public.message_templates;
create policy message_templates_read on public.message_templates for select to authenticated using (public.is_staff());
drop policy if exists message_templates_write on public.message_templates;
create policy message_templates_write on public.message_templates for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ============ Appointment reminders ============
alter table public.visits add column if not exists reminder_sent_at timestamptz;
-- customers who don't want reminders (appointments or payments)
alter table public.accounts add column if not exists no_reminders boolean not null default false;

-- every 10 minutes the reminders function sends anything due (needs pg_cron + pg_net and purgo_project_url in the vault: see email.sql)
create or replace function public.run_reminders() returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'purgo_project_url') || '/functions/v1/reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-purgo-key', (select cron_key from public.accounting_connection where id = 1)),
    body := '{"action":"run"}'::jsonb,
    timeout_milliseconds := 120000);
$$;
revoke execute on function public.run_reminders() from public, anon, authenticated;
select cron.unschedule('purgo-reminders') where exists (select 1 from cron.job where jobname = 'purgo-reminders');
select cron.schedule('purgo-reminders', '5-59/10 * * * *', 'select public.run_reminders()');
