-- Chowseek restaurant sponsorship billing: one fixed $20 CPM rate.
-- This file is the production DDL source. After applying it to the hosted project,
-- copy it into supabase/migrations using the migration version recorded by Supabase.

create table if not exists chowseek_private.restaurant_billing_config (
  singleton boolean primary key default true check (singleton),
  stripe_product_id text,
  stripe_meter_id text,
  stripe_price_id text,
  stripe_webhook_endpoint_id text,
  meter_event_name text not null default 'chowseek_restaurant_impressions',
  cpm_rate_cents integer not null default 2000 check (cpm_rate_cents = 2000),
  currency text not null default 'USD' check (currency = 'USD'),
  updated_at timestamptz not null default now()
);

insert into chowseek_private.restaurant_billing_config (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists chowseek_private.restaurant_billing_usage_queue (
  id uuid primary key default gen_random_uuid(),
  sponsored_result_id uuid not null references public.sponsored_results(id) on delete cascade,
  app_session_id uuid not null,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  viewed_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','processing','processed')),
  locked_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (sponsored_result_id, app_session_id)
);

create index if not exists restaurant_billing_usage_queue_pending_idx
on chowseek_private.restaurant_billing_usage_queue(status, viewed_at)
where status <> 'processed';

-- One rate, everywhere. Existing rows are normalized but historical impressions are
-- not backfilled into Stripe usage, so this does not retroactively charge anything.
update public.sponsored_results
set cpm_rate_cents = 2000,
    currency = 'USD'
where cpm_rate_cents is distinct from 2000
   or currency is distinct from 'USD';

alter table public.sponsored_results
  alter column cpm_rate_cents set default 2000,
  alter column currency set default 'USD';

alter table public.sponsored_results
  drop constraint if exists sponsored_results_fixed_cpm_check,
  add constraint sponsored_results_fixed_cpm_check check (cpm_rate_cents = 2000),
  drop constraint if exists sponsored_results_fixed_currency_check,
  add constraint sponsored_results_fixed_currency_check check (currency = 'USD');

comment on column public.sponsored_results.cpm_rate_cents is
  'Fixed Chowseek restaurant sponsorship rate: 2000 cents per 1000 impressions ($20 CPM).';

-- Browser users do not get to choose the rate, including platform admins using the portal.
revoke insert(cpm_rate_cents, currency), update(cpm_rate_cents, currency)
on public.sponsored_results from authenticated;

-- Edge Function-only config access. These functions intentionally live in public so
-- PostgREST can call them, but PUBLIC/anon/authenticated execution is revoked.
create or replace function public.restaurant_billing_get_config()
returns table (
  stripe_product_id text,
  stripe_meter_id text,
  stripe_price_id text,
  stripe_webhook_endpoint_id text,
  meter_event_name text,
  cpm_rate_cents integer,
  currency text
)
language sql
security definer
set search_path = ''
as $$
  select c.stripe_product_id, c.stripe_meter_id, c.stripe_price_id,
         c.stripe_webhook_endpoint_id, c.meter_event_name,
         c.cpm_rate_cents, c.currency
  from chowseek_private.restaurant_billing_config c
  where c.singleton;
$$;

create or replace function public.restaurant_billing_set_config(
  p_product_id text default null,
  p_meter_id text default null,
  p_price_id text default null,
  p_webhook_endpoint_id text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update chowseek_private.restaurant_billing_config
  set stripe_product_id = coalesce(p_product_id, stripe_product_id),
      stripe_meter_id = coalesce(p_meter_id, stripe_meter_id),
      stripe_price_id = coalesce(p_price_id, stripe_price_id),
      stripe_webhook_endpoint_id = coalesce(p_webhook_endpoint_id, stripe_webhook_endpoint_id),
      updated_at = now()
  where singleton;
$$;

create or replace function public.restaurant_billing_verify_cron_secret(p_secret text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select p_secret is not null and exists (
    select 1
    from vault.decrypted_secrets s
    where s.name = 'restaurant_usage_cron_secret'
      and s.decrypted_secret = p_secret
  );
$$;

create or replace function public.restaurant_billing_webhook_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select s.decrypted_secret
  from vault.decrypted_secrets s
  where s.name = 'restaurant_stripe_webhook_secret'
  limit 1;
$$;

create or replace function public.restaurant_billing_claim_usage(p_limit integer default 200)
returns table (
  queue_id uuid,
  sponsored_result_id uuid,
  app_session_id uuid,
  restaurant_id uuid,
  viewed_at timestamptz,
  stripe_customer_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  return query
  with picked as (
    select q.id
    from chowseek_private.restaurant_billing_usage_queue q
    join public.restaurants r on r.id = q.restaurant_id
    where (
      q.status = 'pending'
      or (q.status = 'processing' and q.locked_at < now() - interval '10 minutes')
    )
      and r.stripe_customer_id is not null
    order by q.viewed_at, q.id
    limit v_limit
    for update of q skip locked
  ), claimed as (
    update chowseek_private.restaurant_billing_usage_queue q
    set status = 'processing',
        locked_at = now(),
        attempts = q.attempts + 1,
        last_error = null
    from picked p
    where q.id = p.id
    returning q.id, q.sponsored_result_id, q.app_session_id, q.restaurant_id, q.viewed_at
  )
  select c.id, c.sponsored_result_id, c.app_session_id, c.restaurant_id, c.viewed_at,
         r.stripe_customer_id
  from claimed c
  join public.restaurants r on r.id = c.restaurant_id;
end;
$$;

create or replace function public.restaurant_billing_complete_usage(p_ids uuid[])
returns integer
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update chowseek_private.restaurant_billing_usage_queue q
    set status = 'processed',
        processed_at = now(),
        locked_at = null,
        last_error = null
    where q.id = any(coalesce(p_ids, '{}'::uuid[]))
      and q.status = 'processing'
    returning 1
  )
  select count(*)::integer from updated;
$$;

create or replace function public.restaurant_billing_release_usage(p_ids uuid[], p_error text)
returns integer
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update chowseek_private.restaurant_billing_usage_queue q
    set status = 'pending',
        locked_at = null,
        last_error = left(coalesce(p_error, 'unknown error'), 500)
    where q.id = any(coalesce(p_ids, '{}'::uuid[]))
      and q.status = 'processing'
    returning 1
  )
  select count(*)::integer from updated;
$$;

revoke all on function public.restaurant_billing_get_config() from public;
revoke all on function public.restaurant_billing_set_config(text,text,text,text) from public;
revoke all on function public.restaurant_billing_verify_cron_secret(text) from public;
revoke all on function public.restaurant_billing_webhook_secret() from public;
revoke all on function public.restaurant_billing_claim_usage(integer) from public;
revoke all on function public.restaurant_billing_complete_usage(uuid[]) from public;
revoke all on function public.restaurant_billing_release_usage(uuid[],text) from public;

grant execute on function public.restaurant_billing_get_config() to service_role;
grant execute on function public.restaurant_billing_set_config(text,text,text,text) to service_role;
grant execute on function public.restaurant_billing_verify_cron_secret(text) to service_role;
grant execute on function public.restaurant_billing_webhook_secret() to service_role;
grant execute on function public.restaurant_billing_claim_usage(integer) to service_role;
grant execute on function public.restaurant_billing_complete_usage(uuid[]) to service_role;
grant execute on function public.restaurant_billing_release_usage(uuid[],text) to service_role;

-- Only subscribed restaurant inventory is eligible to serve. The legacy bucket is
-- explicitly exempt so existing Chowseek inventory is not silently disabled.
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
  where result.active
    and result.starts_at <= now()
    and (result.ends_at is null or result.ends_at > now())
    and (
      result.restaurant_id = '00000000-0000-0000-0000-000000000001'::uuid
      or exists (
        select 1
        from public.restaurants r
        where r.id = result.restaurant_id
          and r.active
          and r.subscription_status in ('active','trialing')
      )
    )
    and result.latitude between p_south and p_north
    and (
      (p_west <= p_east and result.longitude between p_west and p_east)
      or (p_west > p_east and (result.longitude >= p_west or result.longitude <= p_east))
    )
  order by result.name, result.id
  limit 100;
end;
$$;

-- Use the existing authenticated + deduplicated impression path as the only source
-- of billable usage. New non-legacy impressions are durably queued in the same DB
-- transaction as the impression counter update.
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
    where result.active
      and result.starts_at <= now()
      and (result.ends_at is null or result.ends_at > now())
      and (
        result.restaurant_id = '00000000-0000-0000-0000-000000000001'::uuid
        or exists (
          select 1
          from public.restaurants r
          where r.id = result.restaurant_id
            and r.active
            and r.subscription_status in ('active','trialing')
        )
      )
    on conflict (sponsored_result_id, app_session_id) do nothing
    returning sponsored_result_id, app_session_id, viewed_at
  ), queued as (
    insert into chowseek_private.restaurant_billing_usage_queue (
      sponsored_result_id,
      app_session_id,
      restaurant_id,
      viewed_at
    )
    select i.sponsored_result_id, i.app_session_id, result.restaurant_id, i.viewed_at
    from inserted i
    join public.sponsored_results result on result.id = i.sponsored_result_id
    join public.restaurants r on r.id = result.restaurant_id
    where result.restaurant_id <> '00000000-0000-0000-0000-000000000001'::uuid
      and r.stripe_customer_id is not null
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

-- Cron credentials are random and encrypted in Supabase Vault. No value is ever
-- committed to GitHub or returned to the browser.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'restaurant_usage_cron_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'restaurant_usage_cron_secret',
      'Shared secret for the Chowseek restaurant Stripe usage-sync cron.'
    );
  end if;

  if not exists (select 1 from vault.secrets where name = 'restaurant_usage_function_url') then
    perform vault.create_secret(
      'https://ugbindlzyqaktejbxalk.supabase.co/functions/v1/restaurant-sync-usage',
      'restaurant_usage_function_url',
      'Chowseek restaurant Stripe usage-sync Edge Function URL.'
    );
  end if;

  if exists (select 1 from cron.job where jobname = 'restaurant-billing-usage-sync') then
    perform cron.unschedule('restaurant-billing-usage-sync');
  end if;

  perform cron.schedule(
    'restaurant-billing-usage-sync',
    '* * * * *',
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'restaurant_usage_function_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'restaurant_usage_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 50000
      ) as request_id;
    $cron$
  );
end;
$$;
