-- Remove the public Legacy / Unassigned bucket while preserving its historical data privately.
create table if not exists chowseek_private.legacy_sponsored_results_archive (
  id uuid primary key,
  row_data jsonb not null,
  impressions jsonb not null default '[]'::jsonb,
  archived_at timestamptz not null default now()
);
revoke all on chowseek_private.legacy_sponsored_results_archive from public, anon, authenticated;

insert into chowseek_private.legacy_sponsored_results_archive (id, row_data, impressions)
select s.id,
       to_jsonb(s),
       coalesce(jsonb_agg(to_jsonb(i)) filter (where i.sponsored_result_id is not null), '[]'::jsonb)
from public.sponsored_results s
left join public.sponsored_result_impressions i on i.sponsored_result_id = s.id
where s.restaurant_id = '00000000-0000-0000-0000-000000000001'::uuid
group by s.id
on conflict (id) do update
set row_data = excluded.row_data,
    impressions = excluded.impressions,
    archived_at = now();

delete from public.sponsored_results
where restaurant_id = '00000000-0000-0000-0000-000000000001'::uuid;

delete from public.restaurants
where id = '00000000-0000-0000-0000-000000000001'::uuid;

-- A restaurant portal user can have at most one active restaurant.
create unique index if not exists restaurant_memberships_one_active_user_idx
on public.restaurant_memberships(user_id)
where active;

-- Service-role-only Auth directory projection used by the platform-admin function.
create or replace function public.restaurant_admin_list_users()
returns table (
  user_id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  force_password_change boolean,
  password_set_by_admin boolean
)
language sql
security definer
set search_path = ''
as $$
  select u.id,
         coalesce(u.email, '(no email)')::text,
         u.created_at,
         u.last_sign_in_at,
         false,
         false
  from auth.users u
  order by lower(coalesce(u.email, '')), u.created_at;
$$;
revoke all on function public.restaurant_admin_list_users() from public;
grant execute on function public.restaurant_admin_list_users() to service_role;

-- Only real, active, subscribed restaurant inventory can serve.
create or replace function sponsorship.sponsored_results_in_bounds_impl(
  p_south double precision,
  p_west double precision,
  p_north double precision,
  p_east double precision
)
returns table(
  id uuid,
  advertiser_name text,
  name text,
  address text,
  description text,
  latitude double precision,
  longitude double precision
)
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_south < -90 or p_south > 90
     or p_north < -90 or p_north > 90
     or p_west < -180 or p_west > 180
     or p_east < -180 or p_east > 180
     or p_north < p_south then
    raise exception 'invalid map bounds' using errcode = '22023';
  end if;

  return query
  select result.id, result.advertiser_name, result.name, result.address,
         result.description, result.latitude, result.longitude
  from public.sponsored_results result
  join public.restaurants r on r.id = result.restaurant_id
  where result.active
    and result.starts_at <= now()
    and (result.ends_at is null or result.ends_at > now())
    and r.active
    and r.subscription_status in ('active','trialing')
    and result.latitude between p_south and p_north
    and (
      (p_west <= p_east and result.longitude between p_west and p_east)
      or (p_west > p_east and (result.longitude >= p_west or result.longitude <= p_east))
    )
  order by result.name, result.id
  limit 100;
end;
$$;

create or replace function sponsorship.record_sponsored_impressions_impl(
  p_result_ids uuid[],
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  recorded_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_session_id is null then
    raise exception 'app session id is required' using errcode = '22023';
  end if;
  if p_result_ids is null or cardinality(p_result_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_result_ids) > 100 then
    raise exception 'too many sponsored result ids' using errcode = '22023';
  end if;

  with requested as (
    select distinct unnest(p_result_ids) as sponsored_result_id
  ), inserted as (
    insert into public.sponsored_result_impressions (sponsored_result_id, app_session_id)
    select result.id, p_session_id
    from requested
    join public.sponsored_results result on result.id = requested.sponsored_result_id
    join public.restaurants r on r.id = result.restaurant_id
    where result.active
      and result.starts_at <= now()
      and (result.ends_at is null or result.ends_at > now())
      and r.active
      and r.subscription_status in ('active','trialing')
    on conflict (sponsored_result_id, app_session_id) do nothing
    returning sponsored_result_id, app_session_id, viewed_at
  ), queued as (
    insert into chowseek_private.restaurant_billing_usage_queue (
      sponsored_result_id, app_session_id, restaurant_id, viewed_at
    )
    select i.sponsored_result_id, i.app_session_id, result.restaurant_id, i.viewed_at
    from inserted i
    join public.sponsored_results result on result.id = i.sponsored_result_id
    join public.restaurants r on r.id = result.restaurant_id
    where r.stripe_customer_id is not null
      and r.stripe_subscription_id is not null
      and r.subscription_status in ('active','trialing')
    on conflict (sponsored_result_id, app_session_id) do nothing
    returning sponsored_result_id
  ), bumped as (
    update public.sponsored_results result
    set impression_count = result.impression_count + 1
    from inserted
    where result.id = inserted.sponsored_result_id
    returning result.id
  )
  select count(*)::integer into recorded_count from bumped;
  return recorded_count;
end;
$$;
