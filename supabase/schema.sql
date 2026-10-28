-- Purgō Quote: database schema
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run: it only creates what is missing and never deletes data.

create extension if not exists pgcrypto;

-- ============ People ============
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  role text not null default 'staff' check (role in ('admin','staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- profiles for anyone created before this script ran
insert into public.profiles (id, email, name)
select id, email, split_part(email, '@', 1) from auth.users
on conflict (id) do nothing;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin')
$$;

-- ============ Price list (admin only) ============
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.chemicals (
  id text primary key default ('c' || substr(md5(random()::text), 1, 8)),
  name text not null,
  cost numeric not null default 0,      -- £ per litre of concentrate
  cover numeric not null default 10,    -- m² per litre at working dilution
  markup numeric not null default 0,    -- %
  sort int not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ============ Customers & quotes (all staff) ============
create table if not exists public.addresses (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,             -- normalised postcode + first line
  line text,
  postcode text,
  customer text,
  phone text,
  notes text,
  lat double precision,
  lng double precision,
  last_quoted timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null,
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined')),
  customer text,
  address text,
  postcode text,
  phone text,
  job_type text,
  sub numeric,
  vat numeric,
  total numeric,
  lines jsonb,                          -- customer-facing line items
  state jsonb not null,                 -- everything needed to reopen the quote
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists quotes_created_at_idx on public.quotes (created_at desc);

-- costs and profit live apart from quotes so staff never receive them
create table if not exists public.quote_costs (
  quote_id uuid primary key references public.quotes(id) on delete cascade,
  cost_total numeric,
  profit numeric,
  margin numeric,
  costs jsonb,
  computed_at timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists quotes_touch on public.quotes;
create trigger quotes_touch before update on public.quotes for each row execute function public.touch_updated_at();
drop trigger if exists chemicals_touch on public.chemicals;
create trigger chemicals_touch before update on public.chemicals for each row execute function public.touch_updated_at();

-- staff cannot change who made a quote or when
create or replace function public.protect_quote_owner() returns trigger language plpgsql as $$
begin
  if not public.is_admin() then
    new.created_by = old.created_by; new.created_by_name = old.created_by_name; new.created_at = old.created_at;
  end if;
  return new;
end $$;
drop trigger if exists quotes_protect on public.quotes;
create trigger quotes_protect before update on public.quotes for each row execute function public.protect_quote_owner();

-- ============ Row level security ============
alter table public.profiles    enable row level security;
alter table public.settings    enable row level security;
alter table public.chemicals   enable row level security;
alter table public.addresses   enable row level security;
alter table public.quotes      enable row level security;
alter table public.quote_costs enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
drop policy if exists profiles_admin on public.profiles;
create policy profiles_admin on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists chemicals_admin on public.chemicals;
create policy chemicals_admin on public.chemicals for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists addresses_read on public.addresses;
create policy addresses_read on public.addresses for select to authenticated using (public.is_staff());
drop policy if exists addresses_insert on public.addresses;
create policy addresses_insert on public.addresses for insert to authenticated with check (public.is_staff());
drop policy if exists addresses_update on public.addresses;
create policy addresses_update on public.addresses for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists addresses_delete on public.addresses;
create policy addresses_delete on public.addresses for delete to authenticated using (public.is_admin());

drop policy if exists quotes_read on public.quotes;
create policy quotes_read on public.quotes for select to authenticated using (public.is_staff());
drop policy if exists quotes_insert on public.quotes;
create policy quotes_insert on public.quotes for insert to authenticated
  with check (public.is_staff() and created_by = auth.uid());
drop policy if exists quotes_update on public.quotes;
create policy quotes_update on public.quotes for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists quotes_delete on public.quotes;
create policy quotes_delete on public.quotes for delete to authenticated using (public.is_admin());

drop policy if exists quote_costs_admin on public.quote_costs;
create policy quote_costs_admin on public.quote_costs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============ Price book ============
-- Staff get selling prices only: no labour pay, margins, sand or chemical costs, fuel or mpg.
create or replace function public.price_book() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb; f jsonb; ch jsonb;
begin
  if not public.is_staff() then
    raise exception 'Your account is not active. Ask Purgō to switch it on.' using errcode = '42501';
  end if;
  select value into r from settings where key = 'rates';
  r := coalesce(r, '{}'::jsonb);
  if public.is_admin() then
    select value || jsonb_build_object('status', (select value from settings where key = 'fuel_status')) into f from settings where key = 'fuel';
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'cost', cost, 'cover', cover, 'markup', markup) order by sort, name), '[]'::jsonb)
      into ch from chemicals where active;
    return jsonb_build_object('role', 'admin', 'rates', r, 'chems', ch, 'fuel', f);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'cover', cover, 'sell', round(cost * (1 + markup / 100), 4)) order by sort, name), '[]'::jsonb)
    into ch from chemicals where active;
  return jsonb_build_object(
    'role', 'staff',
    'rates', (r - array['labourPaid','targetMargin','sandBag','sandMarkup','vanMpg','rigLph','waterCost'])
             || jsonb_build_object('sandBagSell', round(coalesce((r->>'sandBag')::numeric, 0) * (1 + coalesce((r->>'sandMarkup')::numeric, 0) / 100), 4)),
    'chems', ch);
end $$;

revoke execute on function public.price_book() from public, anon;
grant execute on function public.price_book() to authenticated;

-- ============ Starting prices (only if none saved yet) ============
insert into public.settings (key, value) values
  ('rates', '{"labour":30,"labourPaid":20,"targetMargin":35,"pwRate":3,"heavySoil":1,"pwSetup":0,"pwSetupTime":0.33,"pwMin":90,"sf_block":55,"sf_concrete":70,"sf_tarmac":55,"sf_stone":40,"sf_imprint":60,"sf_porcelain":65,"sf_deck":35,"sandBag":5.49,"sandCover":10,"sandRate":80,"sandMarkup":20,"chemLabour":0.5,"chemApp":200,"gutRate":3,"gutRate3":4,"gutMin":60,"guard":8,"fascia":4,"gutSpeed":40,"gutSpeed3":28,"fasSpeed":25,"gutSetup":0.25,"perWin":1.5,"priceT":13,"priceS":15,"priceD":20,"stdT":8,"stdS":10,"stdD":14,"sillT":5,"sillS":8,"sillD":12,"firstClean":50,"winMins":1.5,"winSetup":8,"waterPerWin":3,"waterCost":0.07,"scrape":6,"lpw":5,"steepUp":20,"mossModUp":10,"mossHeavyUp":25,"scrapeRate":12,"lpwRate":25,"roofSetup":0.5,"towerDay":50,"towerErect":0.75,"towerDismantle":0.5,"dayHours":7.5,"freeMiles":10,"perMile":1,"roadFactor":1.3,"avgMph":28,"vanMpg":32,"rigLph":2.5,"minRes":40,"minCom":150,"rams":40,"ooh":25,"vat":20,"cx_hose":0.5,"cx_water":0.5,"cx_steps":0.25,"cx_move":0.5,"cx_weeds":0.75,"cx_stain":0.5,"cx_narrow":0.25,"cx_parking":0.25,"cx_gtCons":0.25,"cx_gtHeavy":0.5,"cx_ind":1,"cx_bar":0.5}'::jsonb),
  ('fuel', '{"diesel":1.992,"petrol":1.741,"date":"2026-10-26","source":"UK weekly average (PetrolPrices fuel price index)"}'::jsonb)
on conflict (key) do nothing;

insert into public.chemicals (id, name, cost, cover, markup, sort)
select * from (values
  ('c1', 'Patio pre-treat (TBC)', 0, 10, 0, 1),
  ('c2', 'Roof biocide (TBC)', 0, 10, 0, 2),
  ('c3', 'Post-treat / algae inhibitor (TBC)', 0, 10, 0, 3)
) v(id, name, cost, cover, markup, sort)
where not exists (select 1 from public.chemicals);
