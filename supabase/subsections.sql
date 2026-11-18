-- Purgō Quote: subsections in the customer view. A property split into subsections (data.parentId on
-- each child) is a group: the customer sees its subsections (9.1, 9.2 …), not the group row itself.
-- A group that is excluded hides its subsections too. Safe to re-run.

create or replace function public.site_in_customer_view(s public.portfolio_sites) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((s.data->>'include')::boolean, true) and coalesce(s.data->>'status','') <> 'noquote'
     and coalesce(s.data->'job'->>'status','') <> 'na'
     and not exists (select 1 from portfolio_sites c where c.portfolio_id = s.portfolio_id and c.data->>'parentId' = s.id::text)
     and not exists (select 1 from portfolio_sites p where p.id::text = s.data->>'parentId'
                       and (not coalesce((p.data->>'include')::boolean, true) or coalesce(p.data->>'status','') = 'noquote'))
$$;
revoke execute on function public.site_in_customer_view(public.portfolio_sites) from public, anon;
grant execute on function public.site_in_customer_view(public.portfolio_sites) to authenticated;

create or replace function public.customer_portfolios() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'client', p.client,
    'total', (select count(*) from portfolio_sites s where s.portfolio_id = p.id and public.site_in_customer_view(s)),
    'done',  (select count(*) from portfolio_sites s where s.portfolio_id = p.id and public.site_in_customer_view(s) and s.data->'job'->>'status' = 'done')
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
        'id', s.id, 'ref', s.ref, 'sub', s.data->'sub',
        'group', (select g.name from portfolio_sites g where g.id::text = s.data->>'parentId'),
        'name', s.name, 'address', s.address, 'postcode', s.postcode, 'lat', s.lat, 'lng', s.lng,
        'job', jsonb_build_object('status', s.data->'job'->'status', 'booked', s.data->'job'->'booked',
                                  'done', s.data->'job'->'done', 'reason', s.data->'job'->'reason'),
        'report', case when (s.data->'job'->>'shareReport')::boolean then s.data->'job'->'report' end,
        'photos', coalesce((select jsonb_agg(jsonb_build_object('path', ph->>'path', 'caption', ph->>'caption', 'stage', ph->>'stage', 'added', ph->>'added'))
                            from jsonb_array_elements(public.jarr(s.photos->'job')) ph where (ph->>'share')::boolean), '[]'::jsonb),
        'files', coalesce((select jsonb_agg(jsonb_build_object('path', f->>'path', 'name', f->>'name', 'added', f->>'added'))
                           from jsonb_array_elements(public.jarr(s.photos->'files')) f where (f->>'share')::boolean), '[]'::jsonb)
      ) order by s.ref, coalesce((s.data->>'sub')::numeric, 0))
      from portfolio_sites s
      where s.portfolio_id = p.id and public.site_in_customer_view(s)), '[]'::jsonb)
  ) into r from portfolios p where p.id = pid;
  return r;
end $$;
