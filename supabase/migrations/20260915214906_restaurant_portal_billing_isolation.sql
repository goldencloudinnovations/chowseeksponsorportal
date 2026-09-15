-- Follow-up hardening for restaurant sponsorship billing.

alter table chowseek_private.restaurant_billing_config
  add column if not exists stripe_portal_configuration_id text;

revoke all on function public.restaurant_billing_get_config() from public;
revoke all on function public.restaurant_billing_set_config(text,text,text,text) from public;
drop function if exists public.restaurant_billing_get_config();
drop function if exists public.restaurant_billing_set_config(text,text,text,text);

create function public.restaurant_billing_get_config()
returns table (
  stripe_product_id text,
  stripe_meter_id text,
  stripe_price_id text,
  stripe_webhook_endpoint_id text,
  stripe_portal_configuration_id text,
  meter_event_name text,
  cpm_rate_cents integer,
  currency text
)
language sql
security definer
set search_path = ''
as $$
  select c.stripe_product_id,
         c.stripe_meter_id,
         c.stripe_price_id,
         c.stripe_webhook_endpoint_id,
         c.stripe_portal_configuration_id,
         c.meter_event_name,
         c.cpm_rate_cents,
         c.currency
  from chowseek_private.restaurant_billing_config c
  where c.singleton;
$$;

create function public.restaurant_billing_set_config(
  p_product_id text default null,
  p_meter_id text default null,
  p_price_id text default null,
  p_webhook_endpoint_id text default null,
  p_portal_configuration_id text default null
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
      stripe_portal_configuration_id = coalesce(p_portal_configuration_id, stripe_portal_configuration_id),
      updated_at = now()
  where singleton;
$$;

revoke all on function public.restaurant_billing_get_config() from public;
revoke all on function public.restaurant_billing_set_config(text,text,text,text,text) from public;
grant execute on function public.restaurant_billing_get_config() to service_role;
grant execute on function public.restaurant_billing_set_config(text,text,text,text,text) to service_role;

revoke all on chowseek_private.restaurant_billing_config from public, anon, authenticated;
revoke all on chowseek_private.restaurant_billing_usage_queue from public, anon, authenticated;
