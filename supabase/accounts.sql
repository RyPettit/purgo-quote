-- Purgō Portal: Accounts (CRM phase 1)
-- One account per customer (residential or commercial). Quotes, properties,
-- contacts and communications all hang off the account; invoices will too.
-- Safe to re-run.

create extension if not exists pg_trgm with schema extensions;
create sequence if not exists public.account_no_seq start 1001;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  account_no bigint unique not null default nextval('public.account_no_seq'),
  name text not null,
  kind text not null default 'res' check (kind in ('res','com')),   -- residential / commercial
  status text not null default 'lead' check (status in ('lead','active','inactive')),
  email text,
  phone text,
  billing_line text,
  billing_postcode text,
  notes text,
  tags text[] not null default '{}',
  source text,                 -- how they found us
  squeegee_ref text,           -- customer ref in Squeegee while we run both
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists accounts_email_idx on public.accounts (lower(email));
create index if not exists accounts_name_idx on public.accounts (lower(name));

create table if not exists public.account_contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  is_primary boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists account_contacts_acc_idx on public.account_contacts (account_id);

-- Every contact with the customer: notes, calls, texts, and emails (manual now, synced from the mailbox later)
create table if not exists public.account_comms (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note','call','sms','email','visit')),
  direction text check (direction in ('in','out')),
  subject text,
  body text,
  from_addr text,
  to_addr text,
  quote_id uuid references public.quotes(id) on delete set null,
  message_id text unique,      -- mailbox message id once email sync is on (stops duplicates)
  thread_id text,
  meta jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists account_comms_acc_idx on public.account_comms (account_id, occurred_at desc);

alter table public.quotes    add column if not exists account_id uuid references public.accounts(id) on delete set null;
alter table public.addresses add column if not exists account_id uuid references public.accounts(id) on delete set null;
create index if not exists quotes_account_idx on public.quotes (account_id);
create index if not exists addresses_account_idx on public.addresses (account_id);

drop trigger if exists accounts_touch on public.accounts;
create trigger accounts_touch before update on public.accounts for each row execute function public.touch_updated_at();

-- ============ Matching: find the customer's account, or open a new one ============
create or replace function public.match_account(p_name text, p_email text, p_phone text, p_postcode text, p_line text, p_kind text default 'res', p_create boolean default true)
returns uuid language plpgsql set search_path = public as $$
declare
  v uuid;
  em text := nullif(lower(trim(coalesce(p_email,''))), '');
  ph text := nullif(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), '');
  nm text := nullif(trim(coalesce(p_name,'')), '');
  pc text := nullif(upper(regexp_replace(coalesce(p_postcode,''), '\s', '', 'g')), '');
begin
  if em is not null then
    select id into v from accounts where lower(email) = em order by created_at limit 1;
    if v is null then select account_id into v from account_contacts where lower(email) = em limit 1; end if;
  end if;
  if v is null and ph is not null and length(ph) >= 10 then
    select id into v from accounts where regexp_replace(coalesce(phone,''), '\D', '', 'g') = ph order by created_at limit 1;
    if v is null then select account_id into v from account_contacts where regexp_replace(coalesce(phone,''), '\D', '', 'g') = ph limit 1; end if;
  end if;
  if v is null and nm is not null and pc is not null then
    select a.id into v from accounts a
      where lower(a.name) = lower(nm)
        and (upper(regexp_replace(coalesce(a.billing_postcode,''), '\s', '', 'g')) = pc
             or exists (select 1 from addresses d where d.account_id = a.id and upper(regexp_replace(coalesce(d.postcode,''), '\s', '', 'g')) = pc))
      order by a.created_at limit 1;
  end if;
  if v is null and p_create and (nm is not null or nullif(trim(coalesce(p_line,'')),'') is not null) then
    insert into accounts (name, kind, email, phone, billing_line, billing_postcode, created_by_name)
    values (coalesce(nm, trim(p_line)), case when p_kind = 'com' then 'com' else 'res' end,
            em, nullif(trim(coalesce(p_phone,'')),''), nullif(trim(coalesce(p_line,'')),''), nullif(trim(coalesce(p_postcode,'')),''),
            (select name from profiles where id = auth.uid()))
    returning id into v;
  end if;
  return v;
end $$;

-- new or updated quotes join their customer's account automatically (works for offline uploads too)
create or replace function public.quote_link_account() returns trigger language plpgsql set search_path = public as $$
begin
  if new.account_id is null then
    new.account_id := public.match_account(new.customer, new.email, new.phone, new.postcode, new.address, new.job_type, true);
  end if;
  -- the account fills in details it was missing
  if new.account_id is not null then
    update accounts set
      email = coalesce(email, nullif(lower(trim(coalesce(new.email,''))),'')),
      phone = coalesce(phone, nullif(trim(coalesce(new.phone,'')),'')),
      status = case when new.status = 'accepted' and status = 'lead' then 'active' else status end
    where id = new.account_id;
  end if;
  return new;
end $$;
drop trigger if exists quotes_link_account on public.quotes;
create trigger quotes_link_account before insert or update on public.quotes for each row execute function public.quote_link_account();

-- saved addresses (properties) attach to the account of the latest quote at that address
create or replace function public.address_link_account() returns trigger language plpgsql set search_path = public as $$
begin
  -- an address taken off an account stays off: only new or never-linked addresses are auto-linked
  if new.account_id is null and (tg_op = 'INSERT' or old.account_id is null) then
    select q.account_id into new.account_id from quotes q
      where q.account_id is not null and lower(coalesce(q.address,'')) = lower(coalesce(new.line,''))
        and upper(regexp_replace(coalesce(q.postcode,''), '\s', '', 'g')) = upper(regexp_replace(coalesce(new.postcode,''), '\s', '', 'g'))
      order by q.updated_at desc limit 1;
    if new.account_id is null then
      new.account_id := public.match_account(new.customer, new.email, new.phone, new.postcode, new.line, 'res', false);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists addresses_link_account on public.addresses;
create trigger addresses_link_account before insert or update on public.addresses for each row execute function public.address_link_account();

-- ============ Access: staff and admin only (customer logins never see this) ============
alter table public.accounts         enable row level security;
alter table public.account_contacts enable row level security;
alter table public.account_comms    enable row level security;

do $$ declare t text; begin
  foreach t in array array['accounts','account_contacts','account_comms'] loop
    execute format('drop policy if exists %1$s_read on public.%1$s', t);
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (public.is_staff())', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.is_staff())', t);
    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.is_staff()) with check (public.is_staff())', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.is_admin())', t);
  end loop;
end $$;
grant usage on sequence public.account_no_seq to authenticated;

-- ============ Back-fill: an account for every existing customer ============
-- portfolio clients first (commercial accounts)
alter table public.portfolios add column if not exists account_id uuid references public.accounts(id) on delete set null;
create index if not exists portfolios_account_idx on public.portfolios (account_id);
do $$ declare p record; v uuid; begin
  for p in select * from public.portfolios where account_id is null loop
    insert into public.accounts (name, kind, status, email, created_by_name)
    values (coalesce(nullif(p.client,''), p.name), 'com', case when p.status='accepted' then 'active' else 'lead' end, nullif(lower(p.email),''), p.created_by_name)
    returning id into v;
    update public.portfolios set account_id = v where id = p.id;
  end loop;
end $$;

-- then every quote, oldest first, so repeat customers land on one account
-- (quotes keep their "last changed" date: the touch trigger is paused for the back-fill)
alter table public.quotes disable trigger quotes_touch;
do $$ declare r record; begin
  for r in select id from public.quotes where account_id is null order by created_at loop
    update public.quotes set account_id = null where id = r.id;   -- fires the link trigger
  end loop;
end $$;
alter table public.quotes enable trigger quotes_touch;
update public.addresses set account_id = null where account_id is null;   -- fires the link trigger

-- ============ Duplicate warning: possible existing accounts for a customer ============
create or replace function public.account_candidates(p_name text, p_email text, p_phone text, p_postcode text, p_line text)
returns table (id uuid, account_no bigint, name text, kind text, phone text, email text, place text, reason text)
language sql stable set search_path = public, extensions as $$
  with i as (
    select nullif(lower(trim(coalesce(p_email,''))),'') em,
           nullif(right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10),'') ph,
           nullif(lower(trim(coalesce(p_name,''))),'') nm,
           nullif(upper(regexp_replace(coalesce(p_postcode,''), '\s', '', 'g')),'') pc,
           nullif(lower(regexp_replace(trim(coalesce(p_line,'')), '\s+', ' ', 'g')),'') ln
  ),
  addr as (
    select a.id acc, upper(regexp_replace(coalesce(a.billing_postcode,''), '\s', '', 'g')) pc, lower(regexp_replace(trim(coalesce(a.billing_line,'')), '\s+', ' ', 'g')) ln from accounts a
    union all
    select d.account_id, upper(regexp_replace(coalesce(d.postcode,''), '\s', '', 'g')), lower(regexp_replace(trim(coalesce(d.line,'')), '\s+', ' ', 'g')) from addresses d where d.account_id is not null
  ),
  hits as (
    select a.id, 1 pri, 'Same email' reason from accounts a, i where i.em is not null and lower(a.email) = i.em
    union all select c.account_id, 1, 'Same email (contact)' from account_contacts c, i where i.em is not null and lower(c.email) = i.em
    union all select a.id, 2, 'Same phone number' from accounts a, i where length(i.ph) >= 10 and right(regexp_replace(coalesce(a.phone,''), '\D', '', 'g'), 10) = i.ph
    union all select c.account_id, 2, 'Same phone number (contact)' from account_contacts c, i where length(i.ph) >= 10 and right(regexp_replace(coalesce(c.phone,''), '\D', '', 'g'), 10) = i.ph
    union all select d.acc, 3, 'Same address' from addr d, i where i.pc is not null and i.ln is not null and d.pc = i.pc and (d.ln = i.ln or (length(i.ln) > 4 and similarity(d.ln, i.ln) > 0.5))
    union all select a.id, 4, 'Similar name, same postcode' from accounts a join addr d on d.acc = a.id, i where i.nm is not null and i.pc is not null and d.pc = i.pc and similarity(lower(a.name), i.nm) > 0.3
    union all select a.id, 5, 'Similar name' from accounts a, i where i.nm is not null and length(i.nm) > 3
      and (similarity(lower(a.name), i.nm) > 0.55 or lower(a.name) like i.nm || ' %' or i.nm like lower(a.name) || ' %')
  ),
  best as (select distinct on (h.id) h.id, h.pri, h.reason from hits h where h.id is not null order by h.id, h.pri)
  select a.id, a.account_no, a.name, a.kind, a.phone, a.email,
         concat_ws(', ', nullif(a.billing_line,''), nullif(a.billing_postcode,'')) place, b.reason
  from best b join accounts a on a.id = b.id
  where public.is_staff()
  order by b.pri, a.name
  limit 6
$$;
grant execute on function public.account_candidates(text, text, text, text, text) to authenticated;

-- ============ Merge two accounts (admin only) ============
create or replace function public.merge_accounts(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = public as $$
declare f accounts;
begin
  if not public.is_admin() then raise exception 'Only the admin can merge accounts' using errcode = '42501'; end if;
  if p_from = p_into then raise exception 'Pick a different account to merge into'; end if;
  select * into f from accounts where id = p_from;
  if not found or not exists (select 1 from accounts where id = p_into) then raise exception 'Account not found'; end if;
  alter table quotes disable trigger quotes_touch;
  update quotes set account_id = p_into where account_id = p_from;
  alter table quotes enable trigger quotes_touch;
  update addresses set account_id = p_into where account_id = p_from;
  update account_contacts set account_id = p_into where account_id = p_from;
  update account_comms set account_id = p_into where account_id = p_from;
  update portfolios set account_id = p_into where account_id = p_from;
  update accounts t set
    email = coalesce(t.email, f.email), phone = coalesce(t.phone, f.phone),
    billing_line = coalesce(t.billing_line, f.billing_line), billing_postcode = coalesce(t.billing_postcode, f.billing_postcode),
    source = coalesce(t.source, f.source), squeegee_ref = coalesce(t.squeegee_ref, f.squeegee_ref),
    tags = (select coalesce(array_agg(distinct x), '{}') from unnest(t.tags || f.tags) x),
    notes = nullif(concat_ws(E'\n', t.notes, f.notes), ''),
    status = case when 'active' in (t.status, f.status) then 'active' when t.status = 'inactive' and f.status = 'lead' then 'lead' else t.status end
  where t.id = p_into;
  insert into account_comms (account_id, kind, body, created_by_name)
  values (p_into, 'note', 'Merged in account AC-' || f.account_no || ' (' || f.name || ')', (select name from profiles where id = auth.uid()));
  delete from accounts where id = p_from;
end $$;
revoke execute on function public.merge_accounts(uuid, uuid) from public, anon;
grant execute on function public.merge_accounts(uuid, uuid) to authenticated;
