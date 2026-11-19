-- Purgō Portal: Jobs, window cleaning rounds and the work calendars (Google Calendar).
--   staff_calendars  one work calendar per person (Jamie, Ryan, Benna); Jamie's is where work is booked by default
--   rounds           window cleaning rounds: a set of customers cleaned in order, every N weeks
--   jobs             the work we do for a customer at an address: a regular clean (every N weeks) or a one-off
--   visits           each booked visit for a job: date, time, whose calendar, done / skipped
-- Visits are copied to Google Calendar by the mail function (it holds the Google connection).
-- Safe to re-run.

create sequence if not exists public.job_no_seq start 1001;

create table if not exists public.staff_calendars (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  profile_id uuid references public.profiles(id) on delete set null,
  share_with text,                 -- Google account that should see this calendar on their phone
  gcal_id text,                    -- the calendar in Google (made by "Set up calendars")
  colour text,
  is_default boolean not null default false,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.staff_calendars (key, name, profile_id, share_with, colour, is_default, sort) values
  ('jamie', 'Jamie', (select id from public.profiles where id = '10b59ccf-0e3e-4f02-a10f-e4c0a86cf5fd'), 'jamie@purgo-clean.com', '#4a86e8', true, 1),
  ('ryan',  'Ryan',  (select id from public.profiles where id = '74b49052-4fec-464d-9f14-70cc10422ff7'), null, '#16a765', false, 2),
  ('benna', 'Benna', (select id from public.profiles where id = 'c35fb5fd-5f3b-4864-bfc6-6cb42995f1aa'), null, '#e07798', false, 3)
on conflict (key) do nothing;
create unique index if not exists staff_calendars_one_default on public.staff_calendars (is_default) where is_default;

create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  frequency_weeks int not null default 4 check (frequency_weeks between 1 and 52),
  calendar_id uuid references public.staff_calendars(id) on delete set null,
  start_time time not null default '08:30',
  notes text,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  job_no bigint unique not null default nextval('public.job_no_seq'),
  account_id uuid not null references public.accounts(id) on delete cascade,
  address_id uuid references public.addresses(id) on delete set null,
  line text,
  postcode text,
  service text not null default 'windows' check (service in ('windows','gutters','roof','pressure','other')),
  title text,                      -- what's included, e.g. "Front & back, conservatory"
  price numeric not null default 0,
  frequency_weeks int check (frequency_weeks is null or frequency_weeks between 1 and 104),   -- empty = one-off
  next_due date,
  round_id uuid references public.rounds(id) on delete set null,
  round_order int,
  calendar_id uuid references public.staff_calendars(id) on delete set null,
  duration_min int not null default 30 check (duration_min between 5 and 1440),
  status text not null default 'active' check (status in ('active','paused','ended')),
  quote_id uuid references public.quotes(id) on delete set null,
  notes text,                      -- access notes for whoever does the work
  squeegee_ref text,
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jobs_account_idx on public.jobs (account_id);
create index if not exists jobs_round_idx on public.jobs (round_id, round_order);
create index if not exists jobs_due_idx on public.jobs (next_due) where status = 'active';

create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  date date not null,
  start_time time,                 -- empty = any time that day
  duration_min int not null default 30 check (duration_min between 5 and 1440),
  calendar_id uuid references public.staff_calendars(id) on delete set null,
  status text not null default 'booked' check (status in ('booked','done','skipped','cancelled')),
  price numeric,
  notes text,
  done_at timestamptz,
  done_by_name text,
  gcal_event_id text,              -- the event in Google Calendar
  gcal_calendar text,              -- which Google calendar it's in (so a move or delete finds it)
  gcal_dirty boolean not null default true,
  gcal_error text,
  gcal_synced_at timestamptz,
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists visits_date_idx on public.visits (date);
create index if not exists visits_job_idx on public.visits (job_id, date desc);
create index if not exists visits_dirty_idx on public.visits (gcal_dirty) where gcal_dirty;

-- events still to be removed from Google Calendar (visit deleted)
create table if not exists public.gcal_trash (
  id bigint generated always as identity primary key,
  gcal_calendar text not null,
  gcal_event_id text not null,
  created_at timestamptz not null default now()
);

alter table public.mail_connection add column if not exists scopes text;

drop trigger if exists rounds_touch on public.rounds;
create trigger rounds_touch before update on public.rounds for each row execute function public.touch_updated_at();
drop trigger if exists jobs_touch on public.jobs;
create trigger jobs_touch before update on public.jobs for each row execute function public.touch_updated_at();
drop trigger if exists visits_touch on public.visits;
create trigger visits_touch before update on public.visits for each row execute function public.touch_updated_at();

-- a visit that changes needs copying to Google Calendar again
create or replace function public.visit_mark_dirty() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.gcal_dirty := true; return new; end if;
  if (new.date, new.start_time, new.duration_min, new.calendar_id, new.status, new.price, coalesce(new.notes,''))
     is distinct from (old.date, old.start_time, old.duration_min, old.calendar_id, old.status, old.price, coalesce(old.notes,''))
     and not (new.gcal_dirty is distinct from old.gcal_dirty) then
    new.gcal_dirty := true;
  end if;
  return new;
end $$;
drop trigger if exists visits_dirty on public.visits;
create trigger visits_dirty before insert or update on public.visits for each row execute function public.visit_mark_dirty();

-- a deleted visit's event is removed from Google Calendar on the next sync
create or replace function public.visit_trash_event() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.gcal_event_id is not null and old.gcal_calendar is not null then
    insert into gcal_trash (gcal_calendar, gcal_event_id) values (old.gcal_calendar, old.gcal_event_id);
  end if;
  return old;
end $$;
drop trigger if exists visits_trash on public.visits;
create trigger visits_trash after delete on public.visits for each row execute function public.visit_trash_event();

-- done or skipped: the job's next clean is due one cycle on; a one-off job is finished
create or replace function public.visit_roll_job() returns trigger language plpgsql set search_path = public as $$
declare j jobs;
begin
  if new.status in ('done','skipped') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    select * into j from jobs where id = new.job_id;
    if j.frequency_weeks is not null then
      if j.next_due is null or j.next_due < new.date + j.frequency_weeks * 7 then
        update jobs set next_due = new.date + j.frequency_weeks * 7 where id = j.id;
      end if;
    elsif new.status = 'done' then
      update jobs set status = 'ended', next_due = null where id = j.id;
    end if;
    if new.status = 'done' then
      update accounts set status = 'active' where id = new.account_id and status = 'lead';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists visits_roll on public.visits;
create trigger visits_roll after insert or update on public.visits for each row execute function public.visit_roll_job();

-- job details change: future bookings are re-sent so the calendar shows the new details
create or replace function public.job_dirty_visits() returns trigger language plpgsql set search_path = public as $$
begin
  if (new.title, new.service, new.line, new.postcode, new.notes, new.account_id) is distinct from (old.title, old.service, old.line, old.postcode, old.notes, old.account_id) then
    update visits set gcal_dirty = true where job_id = new.id and status = 'booked' and date >= current_date;
  end if;
  return new;
end $$;
drop trigger if exists jobs_dirty_visits on public.jobs;
create trigger jobs_dirty_visits after update on public.jobs for each row execute function public.job_dirty_visits();

-- ============ Access: staff only; calendar setup is admin only ============
alter table public.staff_calendars enable row level security;
alter table public.rounds  enable row level security;
alter table public.jobs    enable row level security;
alter table public.visits  enable row level security;
alter table public.gcal_trash enable row level security;     -- server only (no policies)

do $$ declare t text; begin
  foreach t in array array['rounds','jobs','visits'] loop
    execute format('drop policy if exists %1$s_read on public.%1$s', t);
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (public.is_staff())', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.is_staff())', t);
    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.is_staff()) with check (public.is_staff())', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.is_staff())', t);
  end loop;
end $$;
drop policy if exists staff_calendars_read on public.staff_calendars;
create policy staff_calendars_read on public.staff_calendars for select to authenticated using (public.is_staff());
drop policy if exists staff_calendars_write on public.staff_calendars;
create policy staff_calendars_write on public.staff_calendars for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant usage on sequence public.job_no_seq to authenticated;
