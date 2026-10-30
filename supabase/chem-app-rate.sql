-- Purgō: per-chemical application rate (m² per hour). Safe to run more than once.
alter table public.chemicals add column if not exists app_rate numeric;

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
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'cost', cost, 'cover', cover, 'markup', markup, 'app', app_rate) order by sort, name), '[]'::jsonb)
      into ch from chemicals where active;
    return jsonb_build_object('role', 'admin', 'rates', r, 'chems', ch, 'fuel', f);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'cover', cover, 'sell', round(cost * (1 + markup / 100), 4), 'app', app_rate) order by sort, name), '[]'::jsonb)
    into ch from chemicals where active;
  return jsonb_build_object(
    'role', 'staff',
    'rates', (r - array['labourPaid','targetMargin','sandBag','sandMarkup','vanMpg','rigLph','waterCost'])
             || jsonb_build_object('sandBagSell', round(coalesce((r->>'sandBag')::numeric, 0) * (1 + coalesce((r->>'sandMarkup')::numeric, 0) / 100), 4)),
    'chems', ch);
end $$;

revoke execute on function public.price_book() from public, anon;
grant execute on function public.price_book() to authenticated;
