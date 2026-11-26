-- Purgō: reviews and repeat work (Admin → Reviews & repeat work). Run after messages.sql and sms.sql. Safe to re-run.
--   Review requests: the day after a job, "how did we do?", with a Google review link for happy customers
--                    and private feedback (straight to you) for anyone less happy.
--   Repeat work:     when a one-off service is due again (gutters a year on, say), "shall we book you in?"
--   Win-backs:       customers with nothing booked for a while get a friendly nudge.
-- All are off until switched on in Admin, and every message is an editable template.

create table if not exists public.marketing_settings (
  id int primary key default 1 check (id = 1),
  google_review_url text,                       -- the "write a review" link from your Google Business Profile
  review_on boolean not null default false,
  review_since timestamptz,                     -- only jobs done after reviews were switched on are asked about
  review_hour int not null default 10 check (review_hour between 8 and 19),
  review_gap_days int not null default 180,     -- ask the same customer at most this often
  repeat_on boolean not null default false,
  repeat_months jsonb not null default '{"gutters":12,"roof":24,"pressure":12}'::jsonb,   -- months until each service is due again (0: never)
  winback_on boolean not null default false,
  winback_months int not null default 6,        -- nothing done or booked for this long
  updated_at timestamptz not null default now()
);
insert into public.marketing_settings (id) values (1) on conflict (id) do nothing;
alter table public.marketing_settings enable row level security;
drop policy if exists marketing_settings_read on public.marketing_settings;
create policy marketing_settings_read on public.marketing_settings for select to authenticated using (public.is_staff());
drop policy if exists marketing_settings_write on public.marketing_settings;
create policy marketing_settings_write on public.marketing_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- where customer links point (the Portal's address); set per business so it can be white-labelled
alter table public.business_profile add column if not exists portal_url text;

-- a review request and the customer's answer
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete cascade,
  visit_id uuid references public.visits(id) on delete set null,
  service text,
  channel text,
  sent_at timestamptz,
  opened_at timestamptz,
  rating smallint check (rating between 1 and 5),
  comment text,
  rated_at timestamptz,
  google_clicked_at timestamptz,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists feedback_account on public.feedback (account_id, sent_at desc);
create index if not exists feedback_rated on public.feedback (rated_at desc);
alter table public.feedback enable row level security;
drop policy if exists feedback_staff_read on public.feedback;
create policy feedback_staff_read on public.feedback for select to authenticated using (public.is_staff());
drop policy if exists feedback_staff_update on public.feedback;
create policy feedback_staff_update on public.feedback for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- "due again" and win-back messages, and whether the customer said yes
create table if not exists public.marketing_sends (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  kind text not null check (kind in ('repeat','winback')),
  account_id uuid references public.accounts(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  service text,
  last_date date,
  channel text,
  sent_at timestamptz,
  opened_at timestamptz,
  response text check (response in ('yes','no')),
  response_note text,
  responded_at timestamptz,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists marketing_sends_account on public.marketing_sends (account_id, kind, sent_at desc);
alter table public.marketing_sends enable row level security;
drop policy if exists marketing_sends_staff_read on public.marketing_sends;
create policy marketing_sends_staff_read on public.marketing_sends for select to authenticated using (public.is_staff());
drop policy if exists marketing_sends_staff_update on public.marketing_sends;
create policy marketing_sends_staff_update on public.marketing_sends for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- the messages (switched on and off with the settings above)
insert into public.message_templates (key, name, channel, enabled, subject, body, send_hour, sort) values
('review_request', 'Review request (the day after the job)', 'email', true,
 'How did we do, {first_name}?',
 E'Hi {first_name},\n\nThanks for choosing {business_name} for your {service}. We''d love to know how we did. It takes ten seconds:\n\n{link}\n\nIf anything wasn''t right, tell us and we''ll put it right.\n\n{sign_off}',
 null, 10),
('review_request_sms', 'Review request by text', 'sms', true, null,
 'Hi {first_name}, thanks for choosing {business_name}. How did we do? Tap to tell us (10 seconds): {link}',
 null, 11),
('repeat_prompt', 'Due again (repeat work)', 'email', true,
 'Time for your {service} again?',
 E'Hi {first_name},\n\nIt''s been a while since your {service} on {last_date}, so it''s about due again.\n\nWould you like us to book you in? Just tap below and we''ll be in touch with a date:\n\n{link}\n\nOr reply to this email, or call us on {business_phone}.\n\n{sign_off}',
 null, 12),
('repeat_prompt_sms', 'Due again by text', 'sms', true, null,
 'Hi {first_name}, your {service} from {business_name} is due again. Want us to book you in? Tap here: {link} or call {business_phone}',
 null, 13),
('win_back', 'Win-back (nothing booked for a while)', 'email', true,
 'We''ve missed you, {first_name}',
 E'Hi {first_name},\n\nWe haven''t been out to you since {last_date}, so we thought we''d check in.\n\nIf you''d like anything doing, from windows and gutters to a pressure wash, tap below and we''ll be in touch:\n\n{link}\n\n{sign_off}',
 null, 14),
('win_back_sms', 'Win-back by text', 'sms', true, null,
 'Hi {first_name}, it''s {business_name}. We haven''t seen you since {last_date}. Fancy booking something in? Tap here: {link}',
 null, 15)
on conflict (key) do nothing;
