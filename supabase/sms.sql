-- Purgō: text message reminders. Run after messages.sql. Safe to re-run: it never overwrites text you've edited.
-- Texts go through an SMS provider set in the function secrets (see supabase/functions/_shared/sms.ts):
--   SMS_PROVIDER = smsworks (The SMS Works, UK) or twilio, plus that provider's key.

-- how each customer gets automatic reminders (chosen on the account)
alter table public.accounts add column if not exists remind_by text not null default 'email';
alter table public.accounts drop constraint if exists accounts_remind_by_check;
alter table public.accounts add constraint accounts_remind_by_check check (remind_by in ('email','sms','both','none'));
update public.accounts set remind_by = 'none' where no_reminders and remind_by = 'email';

-- the name texts come from (up to 11 letters and numbers, e.g. "Purgo")
alter table public.business_profile add column if not exists sms_sender text;
update public.business_profile set sms_sender = 'Purgo' where id = 1 and sms_sender is null;

-- the text versions of each reminder (kept short: 160 characters is one text, longer ones cost 2 or more)
insert into public.message_templates (key, name, channel, enabled, subject, body, send_hour, sort) values
('visit_reminder_sms', 'Appointment reminder by text (the day before)', 'sms', true, null,
 'Hi {first_name}, reminder from {business_name}: we''re booked in tomorrow ({date}) for {service} at {address}, {time}. Need to change it? Call {business_phone}',
 null, 4),
('payment_reminder_1_sms', 'Payment reminder by text (first)', 'sms', true, null,
 'Hi {first_name}, a reminder from {business_name} that invoice {invoice_no} for {amount_due} is still to pay. Pay here: {pay_link} Thank you!',
 null, 5),
('payment_reminder_final_sms', 'Payment reminder by text (final)', 'sms', true, null,
 'Hi {first_name}, {business_name} here. Invoice {invoice_no} for {amount_due} is now overdue. Please pay here: {pay_link} or call {business_phone}',
 null, 6)
on conflict (key) do nothing;
