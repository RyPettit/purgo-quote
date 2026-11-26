-- Purgō Portal: invoices, payments, and the link to Sage Accounting and Stripe.
--   invoice_settings       how invoices look and work (payment terms, bank details, VAT, auto-invoicing). Staff read, admin changes.
--   invoices               one per bill: account, dates, totals, status, the customer's secret link, Sage and Stripe references
--   invoice_lines          what's on the invoice; a line can be a done visit (so it can't be invoiced twice)
--   payments               money received: card (Stripe), bank transfer, cash, direct debit. Copied to Sage.
--   accounting_connection  the Sage sign-in and choices (server only: no app user can read it)
-- Prices are what the customer pays (VAT included when VAT applies), the same as quotes and jobs.
-- The invoicing function copies invoices and payments to Sage every 10 minutes and reads back payments matched in Sage
-- (bank transfers from the Tide feed). Run after jobs.sql and email.sql. Safe to re-run.

create sequence if not exists public.invoice_no_seq start 1001;

-- ============ Settings (one row) ============
create table if not exists public.invoice_settings (
  id int primary key default 1 check (id = 1),
  terms_days int not null default 14 check (terms_days between 0 and 120),   -- days to pay
  bank_name text,                        -- shown on invoices for bank transfers
  bank_sort_code text,
  bank_account_no text,
  bank_account_name text,
  vat_registered boolean not null default false,
  vat_rate numeric not null default 20,
  auto_invoice text not null default 'off' check (auto_invoice in ('off','draft','send')),   -- when a visit is marked done
  footer text,                           -- e.g. "Thank you for choosing Purgō"
  updated_at timestamptz not null default now()
);
alter table public.invoice_settings add column if not exists klarna_min numeric;   -- offer Klarna on card payments from this amount (blank: never)
insert into public.invoice_settings (id) values (1) on conflict (id) do nothing;

-- ============ Invoices ============
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_no bigint unique not null default nextval('public.invoice_no_seq'),
  account_id uuid not null references public.accounts(id) on delete restrict,
  quote_id uuid references public.quotes(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','sent','part_paid','paid','void')),
  issue_date date not null default current_date,
  due_date date,
  bill_name text,                        -- who it's to, as at invoicing
  bill_address text,
  email text,                            -- where it was / will be sent
  sub numeric not null default 0,        -- before VAT
  vat numeric not null default 0,
  total numeric not null default 0,
  paid numeric not null default 0,
  notes text,                            -- shown on the invoice
  share_token uuid unique not null default gen_random_uuid(),   -- the secret in the customer's link
  send_requested boolean not null default false,               -- the scheduled job emails it (auto-invoicing)
  sent_at timestamptz,
  viewed_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  sage_id text,                          -- the sales invoice in Sage
  sage_dirty boolean not null default true,
  sage_error text,
  sage_synced_at timestamptz,
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invoices_account_idx on public.invoices (account_id, issue_date desc);
create index if not exists invoices_status_idx on public.invoices (status);
create index if not exists invoices_sage_dirty_idx on public.invoices (sage_dirty) where sage_dirty;
alter sequence public.invoice_no_seq owned by public.invoices.invoice_no;

create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  sort int not null default 0,
  description text not null,
  qty numeric not null default 1 check (qty > 0),
  unit_price numeric not null default 0,  -- per item, as charged (inc VAT if any)
  vat_rate numeric not null default 0,    -- 0 when not VAT registered
  amount numeric not null default 0,      -- qty × unit price (set by the database)
  vat numeric not null default 0,         -- the VAT inside amount (set by the database)
  visit_id uuid references public.visits(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  service_date date,
  created_at timestamptz not null default now()
);
create index if not exists invoice_lines_inv_idx on public.invoice_lines (invoice_id, sort);
create index if not exists invoice_lines_visit_idx on public.invoice_lines (visit_id) where visit_id is not null;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  amount numeric not null check (amount > 0),
  method text not null default 'bank' check (method in ('card','bank','cash','dd','other')),
  source text not null default 'manual' check (source in ('manual','stripe','sage')),   -- who recorded it
  paid_on date not null default current_date,
  reference text,
  stripe_ref text unique,                -- Stripe payment (stops a payment being counted twice)
  sage_id text,                          -- the payment in Sage
  sage_dirty boolean not null default true,
  sage_error text,
  created_by uuid default auth.uid(),
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists payments_invoice_idx on public.payments (invoice_id);
create index if not exists payments_sage_dirty_idx on public.payments (sage_dirty) where sage_dirty;

alter table public.accounts add column if not exists sage_contact_id text;

-- ============ Sage connection (server only) ============
create table if not exists public.accounting_connection (
  id int primary key default 1 check (id = 1),
  provider text not null default 'sage',
  refresh_token text,
  refresh_expires_at timestamptz,
  business_id text,
  business_name text,
  sales_ledger_id text,                  -- Sales ledger account invoices go to (e.g. 4000 Sales)
  sales_ledger_name text,
  bank_account_id text,                  -- bank transfers, cash and direct debits are paid into (Tide)
  bank_account_name text,
  card_account_id text,                  -- card payments from Stripe are paid into (ideally a "Stripe" account in Sage)
  card_account_name text,
  tax_standard_id text,                  -- VAT rate ids in Sage
  tax_none_id text,
  connected_by_name text,
  connected_at timestamptz,
  last_sync timestamptz,
  last_error text,
  oauth_state text,
  oauth_state_at timestamptz,
  oauth_return text,
  cron_key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
insert into public.accounting_connection (id) values (1) on conflict (id) do nothing;
alter table public.accounting_connection enable row level security;   -- no policies: only the server can use it
revoke all on public.accounting_connection from anon, authenticated;

-- ============ Sums and status ============
-- a line's amount and the VAT inside it
create or replace function public.invoice_line_calc() returns trigger language plpgsql set search_path = public as $$
begin
  new.amount := round(new.qty * new.unit_price, 2);
  new.vat := case when new.vat_rate > 0 then round(new.amount - new.amount / (1 + new.vat_rate / 100), 2) else 0 end;
  return new;
end $$;
drop trigger if exists invoice_lines_calc on public.invoice_lines;
create trigger invoice_lines_calc before insert or update on public.invoice_lines for each row execute function public.invoice_line_calc();

-- the invoice's totals, what's been paid and its status
create or replace function public.invoice_refresh(p_invoice uuid) returns void language plpgsql security definer set search_path = public as $$
declare t numeric; v numeric; p numeric; st text; inv invoices;
begin
  select * into inv from invoices where id = p_invoice;
  if inv.id is null then return; end if;
  select coalesce(sum(amount),0), coalesce(sum(vat),0) into t, v from invoice_lines where invoice_id = p_invoice;
  select coalesce(sum(amount),0) into p from payments where invoice_id = p_invoice;
  st := case when inv.status in ('draft','void') then inv.status
             when t > 0 and p >= t then 'paid' when p > 0 then 'part_paid' else 'sent' end;
  update invoices set total = t, vat = v, sub = t - v, paid = p, status = st,
    paid_at = case when st = 'paid' then coalesce(inv.paid_at, now()) else null end,
    sage_dirty = case when (t, v) is distinct from (inv.total, inv.vat) then true else inv.sage_dirty end
  where id = p_invoice;
end $$;
revoke execute on function public.invoice_refresh(uuid) from public, anon, authenticated;

create or replace function public.invoice_lines_changed() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform invoice_refresh(coalesce(new.invoice_id, old.invoice_id));
  if tg_op = 'UPDATE' and new.invoice_id is distinct from old.invoice_id then perform invoice_refresh(old.invoice_id); end if;
  return null;
end $$;
revoke execute on function public.invoice_lines_changed() from public, anon, authenticated;
drop trigger if exists invoice_lines_sum on public.invoice_lines;
create trigger invoice_lines_sum after insert or update or delete on public.invoice_lines for each row execute function public.invoice_lines_changed();
drop trigger if exists payments_sum on public.payments;
create trigger payments_sum after insert or update or delete on public.payments for each row execute function public.invoice_lines_changed();

-- invoices can't be changed once sent, other than through the Portal's own steps; a sent invoice keeps its lines
create or replace function public.invoice_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.invoice_no := old.invoice_no;
    new.share_token := old.share_token;
    if old.status = 'void' and new.status <> 'void' then raise exception 'A void invoice can''t be reopened.'; end if;
    if new.status = 'void' and old.status <> 'void' then
      if not public.is_admin() and auth.uid() is not null then raise exception 'Only the admin can void an invoice.' using errcode = '42501'; end if;
      new.voided_at := now(); new.sage_dirty := true;
    end if;
    if (new.bill_name, new.bill_address, new.issue_date, new.due_date, coalesce(new.notes,''), new.status)
       is distinct from (old.bill_name, old.bill_address, old.issue_date, old.due_date, coalesce(old.notes,''), old.status) then
      new.sage_dirty := true;
    end if;
  end if;
  if new.due_date is null then
    new.due_date := new.issue_date + (select terms_days from invoice_settings where id = 1);
  end if;
  return new;
end $$;
drop trigger if exists invoices_guard on public.invoices;
create trigger invoices_guard before insert or update on public.invoices for each row execute function public.invoice_guard();
drop trigger if exists invoices_touch on public.invoices;
create trigger invoices_touch before update on public.invoices for each row execute function public.touch_updated_at();

create or replace function public.invoice_lines_guard() returns trigger language plpgsql set search_path = public as $$
declare st text;
begin
  select status into st from invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if st is not null and st <> 'draft' and auth.uid() is not null then
    raise exception 'This invoice has been sent, so its lines can''t be changed. Void it and make a new one.';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists invoice_lines_guard on public.invoice_lines;
create trigger invoice_lines_guard before insert or update or delete on public.invoice_lines for each row execute function public.invoice_lines_guard();

-- a payment that changes needs copying to Sage again
create or replace function public.payment_mark_dirty() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.sage_dirty := new.source <> 'sage'; return new; end if;   -- payments read from Sage are already there
  if (new.amount, new.paid_on, new.method) is distinct from (old.amount, old.paid_on, old.method) then new.sage_dirty := true; end if;
  return new;
end $$;
drop trigger if exists payments_dirty on public.payments;
create trigger payments_dirty before insert or update on public.payments for each row execute function public.payment_mark_dirty();

-- ============ Making invoices ============
-- an invoice for done visits (all for the same customer). p_send: email it on the next scheduled run.
create or replace function public.invoice_from_visits(p_visits uuid[], p_send boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare acc uuid; n int; inv uuid; s invoice_settings; a accounts; who text;
begin
  if auth.uid() is not null and not public.is_staff() then raise exception 'Not allowed' using errcode = '42501'; end if;
  select count(distinct account_id), min(account_id::text)::uuid into n, acc from visits where id = any(p_visits);
  if n = 0 then raise exception 'Those visits weren''t found.'; end if;
  if n > 1 then raise exception 'Those visits are for different customers.'; end if;
  if exists (select 1 from invoice_lines l join invoices i on i.id = l.invoice_id where l.visit_id = any(p_visits) and i.status <> 'void') then
    raise exception 'Some of that work is already on an invoice.';
  end if;
  if exists (select 1 from visits where id = any(p_visits) and status <> 'done') then raise exception 'Only done visits can be invoiced.'; end if;
  select * into s from invoice_settings where id = 1;
  select * into a from accounts where id = acc;
  select name into who from profiles where id = auth.uid();
  insert into invoices (account_id, bill_name, bill_address, email, created_by_name)
    values (acc, a.name, nullif(concat_ws(', ', a.billing_line, a.billing_postcode), ''), a.email, coalesce(who, 'Auto'))
    returning id into inv;
  insert into invoice_lines (invoice_id, sort, description, qty, unit_price, vat_rate, visit_id, job_id, service_date)
  select inv, row_number() over (order by v.date, j.job_no),
    concat_ws(' – ', coalesce(nullif(j.title,''), initcap(j.service)), nullif(concat_ws(', ', j.line, j.postcode), '')) || ' (' || to_char(v.date, 'FMDD Mon YYYY') || ')',
    1, coalesce(v.price, j.price, 0), case when s.vat_registered then s.vat_rate else 0 end, v.id, j.id, v.date
  from visits v join jobs j on j.id = v.job_id where v.id = any(p_visits);
  perform invoice_refresh(inv);
  -- emailed on the next scheduled run, if there's an address to send it to
  if p_send and a.email is not null then
    update invoices set status = 'sent', send_requested = true where id = inv;
    perform invoice_refresh(inv);
  end if;
  return inv;
end $$;
revoke execute on function public.invoice_from_visits(uuid[], boolean) from public, anon;
grant execute on function public.invoice_from_visits(uuid[], boolean) to authenticated;

-- staff press Send: the invoice is final (lines locked) and the Portal emails it
create or replace function public.invoice_issue(p_invoice uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv invoices;
begin
  if not public.is_staff() then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into inv from invoices where id = p_invoice;
  if inv.id is null then raise exception 'Invoice not found'; end if;
  if inv.status = 'void' then raise exception 'This invoice is void.'; end if;
  if inv.total <= 0 then raise exception 'Add something to the invoice first.'; end if;
  if inv.status = 'draft' then
    update invoices set status = 'sent', issue_date = case when issue_date < current_date then current_date else issue_date end,
      due_date = null, sage_dirty = true where id = p_invoice;   -- due date is worked out again from today
    perform invoice_refresh(p_invoice);
  end if;
  return inv.share_token;
end $$;
revoke execute on function public.invoice_issue(uuid) from public, anon;
grant execute on function public.invoice_issue(uuid) to authenticated;

-- auto-invoicing: a visit marked done becomes an invoice (Admin → Invoicing decides: off, draft, or draft and email)
create or replace function public.visit_auto_invoice() returns trigger language plpgsql security definer set search_path = public as $$
declare mode text;
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    select auto_invoice into mode from invoice_settings where id = 1;
    if mode in ('draft','send') and coalesce(new.price, (select price from jobs where id = new.job_id), 0) > 0
       and not exists (select 1 from invoice_lines where visit_id = new.id) then
      perform invoice_from_visits(array[new.id], mode = 'send');
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.visit_auto_invoice() from public, anon, authenticated;
drop trigger if exists visits_auto_invoice on public.visits;
create trigger visits_auto_invoice after insert or update on public.visits for each row execute function public.visit_auto_invoice();

-- an undone visit that's only on a draft invoice comes off it
create or replace function public.visit_undo_invoice() returns trigger language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  if old.status = 'done' and new.status <> 'done' then
    select array_agg(distinct l.invoice_id) into ids from invoice_lines l join invoices i on i.id = l.invoice_id where l.visit_id = new.id and i.status = 'draft';
    if ids is not null then
      delete from invoice_lines where visit_id = new.id and invoice_id = any(ids);
      delete from invoices i where i.id = any(ids) and not exists (select 1 from invoice_lines where invoice_id = i.id);
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.visit_undo_invoice() from public, anon, authenticated;
drop trigger if exists visits_undo_invoice on public.visits;
create trigger visits_undo_invoice after update on public.visits for each row execute function public.visit_undo_invoice();

-- ============ Access ============
alter table public.invoice_settings enable row level security;
alter table public.invoices      enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.payments      enable row level security;

drop policy if exists invoice_settings_read on public.invoice_settings;
create policy invoice_settings_read on public.invoice_settings for select to authenticated using (public.is_staff());
drop policy if exists invoice_settings_write on public.invoice_settings;
create policy invoice_settings_write on public.invoice_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

do $$ declare t text; begin
  foreach t in array array['invoices','invoice_lines','payments'] loop
    execute format('drop policy if exists %1$s_read on public.%1$s', t);
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (public.is_staff())', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.is_staff())', t);
    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.is_staff()) with check (public.is_staff())', t);
  end loop;
end $$;
-- drafts can be deleted by staff; payments by the admin; sent invoices are voided, never deleted
drop policy if exists invoices_delete on public.invoices;
create policy invoices_delete on public.invoices for delete to authenticated using (public.is_staff() and status = 'draft');
drop policy if exists invoice_lines_delete on public.invoice_lines;
create policy invoice_lines_delete on public.invoice_lines for delete to authenticated using (public.is_staff());
drop policy if exists payments_delete on public.payments;
create policy payments_delete on public.payments for delete to authenticated using (public.is_admin() and sage_id is null);
grant usage on sequence public.invoice_no_seq to authenticated;

-- notifications: invoice paid / viewed
alter table public.account_comms drop constraint if exists account_comms_kind_check;
alter table public.account_comms add constraint account_comms_kind_check check (kind in ('note','call','sms','email','visit','quote','invoice'));
alter table public.account_comms add column if not exists invoice_id uuid references public.invoices(id) on delete set null;

-- ============ Copy to Sage every 10 minutes (needs pg_cron + pg_net, and purgo_project_url in the vault: see email.sql) ============
create or replace function public.run_invoicing_sync() returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'purgo_project_url') || '/functions/v1/invoicing',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-purgo-key', (select cron_key from public.accounting_connection where id = 1)),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 120000);
$$;
revoke execute on function public.run_invoicing_sync() from public, anon, authenticated;
select cron.unschedule('purgo-invoicing-sync') where exists (select 1 from cron.job where jobname = 'purgo-invoicing-sync');
select cron.schedule('purgo-invoicing-sync', '*/10 * * * *', 'select public.run_invoicing_sync()');
