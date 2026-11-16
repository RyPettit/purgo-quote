-- Purgō Quote: customer portal for portfolios.
-- Customers sign in with their own account and see ONLY what staff choose to share for the
-- portfolios they are linked to: job progress, ticked job photos, shared reports/files and the
-- published quote. They never read the staff tables directly – everything comes through
-- customer_portfolio(), which builds a filtered copy server-side.
-- Safe to re-run.

-- 1. Roles: customers are never staff -------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin','staff','customer'));

-- Staff = an active Staff or Admin account. Every staff table's rules use this, so customer
-- accounts get nothing from them.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role in ('admin','staff'))
$$;

-- New accounts: the role can only be set server-side (app_metadata), never by the person signing up.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, role)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
          case when new.raw_app_meta_data->>'purgo_role' = 'customer' then 'customer' else 'staff' end)
  on conflict (id) do nothing;
  return new;
end $$;

-- 2. Which customer accounts can see which portfolio ----------------------------------------
create table if not exists public.portfolio_customers (
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_by_name text,
  created_at timestamptz not null default now(),
  primary key (portfolio_id, user_id)
);
alter table public.portfolio_customers enable row level security;
drop policy if exists portfolio_customers_read on public.portfolio_customers;
create policy portfolio_customers_read on public.portfolio_customers for select to authenticated using (public.is_staff());
drop policy if exists portfolio_customers_admin on public.portfolio_customers;
create policy portfolio_customers_admin on public.portfolio_customers for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Published quote (a snapshot staff choose to share) and portfolio-wide documents
alter table public.portfolios add column if not exists customer_quote jsonb;
alter table public.portfolios add column if not exists files jsonb not null default '[]'::jsonb;

create or replace function public.is_portfolio_customer(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from portfolio_customers pc join profiles p on p.id = pc.user_id
                 where pc.portfolio_id = pid and pc.user_id = auth.uid() and p.active and p.role = 'customer')
$$;

-- jsonb array or empty array (photos/files may be missing on older rows)
create or replace function public.jarr(j jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end
$$;

-- 3. What a customer can read -----------------------------------------------------------------
create or replace function public.customer_portfolios() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'client', p.client,
    'total', (select count(*) from portfolio_sites s where s.portfolio_id = p.id
                and coalesce((s.data->>'include')::boolean, true) and coalesce(s.data->>'status','') <> 'noquote'
                and coalesce(s.data->'job'->>'status','') <> 'na'),
    'done',  (select count(*) from portfolio_sites s where s.portfolio_id = p.id
                and coalesce((s.data->>'include')::boolean, true) and coalesce(s.data->>'status','') <> 'noquote'
                and s.data->'job'->>'status' = 'done')
  ) order by p.name), '[]'::jsonb)
  from portfolios p
  where public.is_portfolio_customer(p.id)
$$;

create or replace function public.customer_portfolio(pid uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not (public.is_portfolio_customer(pid) or public.is_staff()) then
    raise exception 'This portfolio is not available to your account.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'client', p.client,
    'quote', p.customer_quote,
    'files', coalesce((select jsonb_agg(jsonb_build_object('path', f->>'path', 'name', f->>'name', 'added', f->>'added'))
                       from jsonb_array_elements(public.jarr(p.files)) f where (f->>'share')::boolean), '[]'::jsonb),
    'sites', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'ref', s.ref, 'name', s.name, 'address', s.address, 'postcode', s.postcode, 'lat', s.lat, 'lng', s.lng,
        'job', jsonb_build_object('status', s.data->'job'->'status', 'booked', s.data->'job'->'booked',
                                  'done', s.data->'job'->'done', 'reason', s.data->'job'->'reason'),
        'report', case when (s.data->'job'->>'shareReport')::boolean then s.data->'job'->'report' end,
        'photos', coalesce((select jsonb_agg(jsonb_build_object('path', ph->>'path', 'caption', ph->>'caption', 'stage', ph->>'stage', 'added', ph->>'added'))
                            from jsonb_array_elements(public.jarr(s.photos->'job')) ph where (ph->>'share')::boolean), '[]'::jsonb),
        'files', coalesce((select jsonb_agg(jsonb_build_object('path', f->>'path', 'name', f->>'name', 'added', f->>'added'))
                           from jsonb_array_elements(public.jarr(s.photos->'files')) f where (f->>'share')::boolean), '[]'::jsonb)
      ) order by s.ref)
      from portfolio_sites s
      where s.portfolio_id = p.id
        and coalesce((s.data->>'include')::boolean, true) and coalesce(s.data->>'status','') <> 'noquote'
        and coalesce(s.data->'job'->>'status','') <> 'na'), '[]'::jsonb)
  ) into r from portfolios p where p.id = pid;
  return r;
end $$;

-- A customer may open a stored file only if it is shared on a portfolio they are linked to.
create or replace function public.customer_can_see_file(obj text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare pid uuid; sid text;
begin
  begin pid := split_part(obj, '/', 1)::uuid; exception when others then return false; end;
  if not public.is_portfolio_customer(pid) then return false; end if;
  sid := split_part(obj, '/', 2);
  if sid = '_portfolio' then
    return exists (select 1 from portfolios p, jsonb_array_elements(public.jarr(p.files)) f
                   where p.id = pid and f->>'path' = obj and (f->>'share')::boolean);
  end if;
  return exists (select 1 from portfolio_sites s
                 where s.portfolio_id = pid and s.id::text = sid
                   and (exists (select 1 from jsonb_array_elements(public.jarr(s.photos->'job')) ph where ph->>'path' = obj and (ph->>'share')::boolean)
                     or exists (select 1 from jsonb_array_elements(public.jarr(s.photos->'files')) f where f->>'path' = obj and (f->>'share')::boolean)));
end $$;

revoke execute on function public.customer_portfolios() from public, anon;
revoke execute on function public.customer_portfolio(uuid) from public, anon;
revoke execute on function public.customer_can_see_file(text) from public, anon;
revoke execute on function public.is_portfolio_customer(uuid) from public, anon;
grant execute on function public.customer_portfolios() to authenticated;
grant execute on function public.customer_portfolio(uuid) to authenticated;
grant execute on function public.customer_can_see_file(text) to authenticated;
grant execute on function public.is_portfolio_customer(uuid) to authenticated;

-- 4. Storage: PDFs allowed (reports); customers read shared files only -----------------------
update storage.buckets set file_size_limit = 20971520,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf']
where id = 'portfolio-photos';

drop policy if exists portfolio_photos_customer_read on storage.objects;
create policy portfolio_photos_customer_read on storage.objects for select to authenticated
  using (bucket_id = 'portfolio-photos' and public.customer_can_see_file(name));
