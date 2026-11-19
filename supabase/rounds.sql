-- Purgō Portal: window cleaning round dates.
-- A round (an area) has a next date; it repeats every 4 weeks (or its own frequency) from there.
-- Each round date is one event in Google Calendar ("Window round – Hessle"), and every customer on the
-- round gets a booked visit on it (those visits don't get calendar events of their own).
-- The Portal plans the dates ahead (about 6 months) whenever a round or its customers change.
-- Safe to re-run.

alter table public.rounds add column if not exists next_date date;

create table if not exists public.round_dates (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  date date not null,
  moved_from date,                 -- the date in the cycle, if this one was moved
  start_time time not null default '08:30',
  calendar_id uuid references public.staff_calendars(id) on delete set null,
  status text not null default 'planned' check (status in ('planned','cancelled')),
  notes text,
  gcal_event_id text,
  gcal_calendar text,
  gcal_dirty boolean not null default true,
  gcal_error text,
  gcal_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists round_dates_cycle on public.round_dates (round_id, coalesce(moved_from, date));
create index if not exists round_dates_date on public.round_dates (date);
create index if not exists round_dates_dirty on public.round_dates (gcal_dirty) where gcal_dirty;

alter table public.visits add column if not exists round_date_id uuid references public.round_dates(id) on delete set null;
create index if not exists visits_round_date on public.visits (round_date_id);
create unique index if not exists visits_one_per_round_date on public.visits (job_id, round_date_id) where round_date_id is not null;
-- a customer's round visit moved to another day: it gets its own calendar event and the round leaves it alone
alter table public.visits add column if not exists detached boolean not null default false;

drop trigger if exists round_dates_touch on public.round_dates;
create trigger round_dates_touch before update on public.round_dates for each row execute function public.touch_updated_at();

-- any change to a round date (other than the calendar bookkeeping) means re-sending its event
create or replace function public.round_date_mark_dirty() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.gcal_dirty := true; return new; end if;
  if (new.date, new.start_time, new.calendar_id, new.status, coalesce(new.notes,'')) is distinct from (old.date, old.start_time, old.calendar_id, old.status, coalesce(old.notes,''))
     and not (new.gcal_dirty is distinct from old.gcal_dirty) then new.gcal_dirty := true; end if;
  return new;
end $$;
drop trigger if exists round_dates_dirty on public.round_dates;
create trigger round_dates_dirty before insert or update on public.round_dates for each row execute function public.round_date_mark_dirty();

-- a customer added, moved, done or removed on a round date changes that date's event
create or replace function public.visit_dirty_round_date() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' and old.round_date_id is not null then update round_dates set gcal_dirty = true where id = old.round_date_id; end if;
  if tg_op <> 'DELETE' and new.round_date_id is not null and (tg_op = 'INSERT' or new.round_date_id is distinct from old.round_date_id
     or (new.date, new.start_time, new.duration_min, new.status) is distinct from (old.date, old.start_time, old.duration_min, old.status)) then
    update round_dates set gcal_dirty = true where id = new.round_date_id;
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function public.visit_dirty_round_date() from public, anon, authenticated;
drop trigger if exists visits_round_date_dirty on public.visits;
create trigger visits_round_date_dirty after insert or update or delete on public.visits for each row execute function public.visit_dirty_round_date();

-- round renamed: its future events need the new name
create or replace function public.round_dirty_dates() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.name is distinct from old.name then update round_dates set gcal_dirty = true where round_id = new.id and date >= current_date; end if;
  return new;
end $$;
revoke execute on function public.round_dirty_dates() from public, anon, authenticated;
drop trigger if exists rounds_dirty_dates on public.rounds;
create trigger rounds_dirty_dates after update on public.rounds for each row execute function public.round_dirty_dates();

-- a deleted round date's event is removed from Google Calendar on the next sync
create or replace function public.round_date_trash_event() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.gcal_event_id is not null and old.gcal_calendar is not null then
    insert into gcal_trash (gcal_calendar, gcal_event_id) values (old.gcal_calendar, old.gcal_event_id);
  end if;
  return old;
end $$;
revoke execute on function public.round_date_trash_event() from public, anon, authenticated;
drop trigger if exists round_dates_trash on public.round_dates;
create trigger round_dates_trash after delete on public.round_dates for each row execute function public.round_date_trash_event();

alter table public.round_dates enable row level security;
drop policy if exists round_dates_read on public.round_dates;
create policy round_dates_read on public.round_dates for select to authenticated using (public.is_staff());
drop policy if exists round_dates_insert on public.round_dates;
create policy round_dates_insert on public.round_dates for insert to authenticated with check (public.is_staff());
drop policy if exists round_dates_update on public.round_dates;
create policy round_dates_update on public.round_dates for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists round_dates_delete on public.round_dates;
create policy round_dates_delete on public.round_dates for delete to authenticated using (public.is_staff());
