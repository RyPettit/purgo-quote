-- Purgō: automatic payment reminders for unpaid invoices.
-- Run after invoices.sql. The invoicing function's 10-minute run emails each unpaid invoice
-- a reminder a set number of days after the work was done (default 3, then 7), between 9am and 6pm, Monday to Saturday.

alter table public.invoice_settings
  add column if not exists remind_days int[] not null default '{3,7}';   -- empty: no reminders

alter table public.invoices
  add column if not exists reminders_sent int not null default 0,
  add column if not exists last_reminded_at timestamptz,
  add column if not exists no_reminders boolean not null default false;

-- invoices already open when reminders were switched on are left to be chased by hand
update public.invoices set reminders_sent = 2
 where status in ('sent','part_paid') and reminders_sent = 0 and created_at < now();
