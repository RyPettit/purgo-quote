-- Purgō Quote: portfolio quotes (many properties for one client, e.g. a block management company)
-- Safe to re-run: only creates what is missing and never deletes data.

create table if not exists public.portfolios (
  id uuid primary key default gen_random_uuid(),
  name text not null,                     -- e.g. "Pure Block – gutter cleans"
  client text,
  contact text,
  email text,
  service text not null default 'gutters',
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined')),
  settings jsonb not null default '{}'::jsonb, -- quote ref, frequency, discount, VAT, intro, display options
  created_by uuid default auth.uid() references public.profiles(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portfolio_sites (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  ref int,
  name text,
  address text,
  postcode text,
  lat double precision,
  lng double precision,
  data jsonb not null default '{}'::jsonb,    -- survey: type, storeys, gutter lengths, access, notes, status …
  photos jsonb not null default '{}'::jsonb,  -- {aerial:{path,…}, street:{path,…}, site:[{path,caption,reviewed…}]}
  updated_by uuid default auth.uid(),
  updated_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists portfolio_sites_portfolio_idx on public.portfolio_sites (portfolio_id, ref);

drop trigger if exists portfolios_touch on public.portfolios;
create trigger portfolios_touch before update on public.portfolios for each row execute function public.touch_updated_at();
drop trigger if exists portfolio_sites_touch on public.portfolio_sites;
create trigger portfolio_sites_touch before update on public.portfolio_sites for each row execute function public.touch_updated_at();

alter table public.portfolios      enable row level security;
alter table public.portfolio_sites enable row level security;

drop policy if exists portfolios_read on public.portfolios;
create policy portfolios_read on public.portfolios for select to authenticated using (public.is_staff());
drop policy if exists portfolios_insert on public.portfolios;
create policy portfolios_insert on public.portfolios for insert to authenticated with check (public.is_staff());
drop policy if exists portfolios_update on public.portfolios;
create policy portfolios_update on public.portfolios for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists portfolios_delete on public.portfolios;
create policy portfolios_delete on public.portfolios for delete to authenticated using (public.is_admin());

drop policy if exists portfolio_sites_read on public.portfolio_sites;
create policy portfolio_sites_read on public.portfolio_sites for select to authenticated using (public.is_staff());
drop policy if exists portfolio_sites_insert on public.portfolio_sites;
create policy portfolio_sites_insert on public.portfolio_sites for insert to authenticated with check (public.is_staff());
drop policy if exists portfolio_sites_update on public.portfolio_sites;
create policy portfolio_sites_update on public.portfolio_sites for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists portfolio_sites_delete on public.portfolio_sites;
create policy portfolio_sites_delete on public.portfolio_sites for delete to authenticated using (public.is_admin());

-- Photos: private bucket, signed-in staff only
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portfolio-photos', 'portfolio-photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists portfolio_photos_read on storage.objects;
create policy portfolio_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'portfolio-photos' and public.is_staff());
drop policy if exists portfolio_photos_insert on storage.objects;
create policy portfolio_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'portfolio-photos' and public.is_staff());
drop policy if exists portfolio_photos_update on storage.objects;
create policy portfolio_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'portfolio-photos' and public.is_staff()) with check (bucket_id = 'portfolio-photos' and public.is_staff());
drop policy if exists portfolio_photos_delete on storage.objects;
create policy portfolio_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'portfolio-photos' and public.is_staff());
