-- Discounts on jobs. Safe to re-run.
-- jobs.price stays the amount actually charged (visits, rounds, the diary and totals all read it).
-- base_price is the price before the discount; discount_type is 'pct' (percentage) or 'gbp' (money off).
alter table public.jobs add column if not exists base_price numeric;
alter table public.jobs add column if not exists discount_type text;
alter table public.jobs add column if not exists discount_value numeric not null default 0;
alter table public.jobs add column if not exists discount_note text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_discount_type_check') then
    alter table public.jobs add constraint jobs_discount_type_check check (discount_type is null or discount_type in ('pct','gbp'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jobs_discount_value_check') then
    alter table public.jobs add constraint jobs_discount_value_check check (discount_value >= 0 and (discount_type is distinct from 'pct' or discount_value <= 100));
  end if;
end $$;
