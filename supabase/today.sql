-- Purgō: the Today page (the day's work on a phone). Run after jobs.sql. Safe to re-run.

-- why a visit was skipped (no access, weather, customer cancelled…)
alter table public.visits add column if not exists skip_reason text;

-- before and after photos taken on the day
create table if not exists public.visit_photos (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.visits(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  kind text not null default 'after' check (kind in ('before','after','other')),
  path text not null,                         -- in the private visit-photos bucket
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists visit_photos_visit on public.visit_photos (visit_id);
create index if not exists visit_photos_account on public.visit_photos (account_id, created_at desc);
alter table public.visit_photos enable row level security;
drop policy if exists visit_photos_staff on public.visit_photos;
create policy visit_photos_staff on public.visit_photos for all to authenticated using (public.is_staff()) with check (public.is_staff());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visit-photos', 'visit-photos', false, 15728640, array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do nothing;
drop policy if exists visit_photos_read on storage.objects;
create policy visit_photos_read on storage.objects for select to authenticated using (bucket_id = 'visit-photos' and public.is_staff());
drop policy if exists visit_photos_insert on storage.objects;
create policy visit_photos_insert on storage.objects for insert to authenticated with check (bucket_id = 'visit-photos' and public.is_staff());
drop policy if exists visit_photos_delete on storage.objects;
create policy visit_photos_delete on storage.objects for delete to authenticated using (bucket_id = 'visit-photos' and public.is_staff());
