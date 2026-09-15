import { withSupabase } from 'npm:@supabase/server';
import { json } from '../_shared/cors.ts';

type BillingConfig = {
  stripe_product_id: string | null;
  stripe_meter_id: string | null;
  stripe_price_id: string | null;
  stripe_webhook_endpoint_id: string | null;
  meter_event_name: string;
  cpm_rate_cents: number;
  currency: string;
};

type UsageRow = {
  queue_id: string;
  sponsored_result_id: string;
  app_session_id: string;
  restaurant_id: string;
  viewed_at: string;
  stripe_customer_id: string;
};

const stripeVersion = '2026-07-29.dahlia';

function stripeHeaders(stripeKey: string, idempotencyKey?: string): HeadersInit {
  return {
    Authorization: `Basic ${btoa(`${stripeKey}:`)}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': stripeVersion,
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function stripeGet(stripeKey: string, path: string, query: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com${path}?${query.toString()}`, { headers: stripeHeaders(stripeKey) });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? `Stripe GET ${path} failed.`);
  return data;
}

async function stripePost(stripeKey: string, path: string, body = new URLSearchParams(), idempotencyKey?: string) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: stripeHeaders(stripeKey, idempotencyKey),
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? `Stripe POST ${path} failed.`);
  return data;
}

async function ensureMeter(admin: any, config: BillingConfig, stripeKey: string): Promise<BillingConfig> {
  if (config.stripe_meter_id) return config;

  const meters = await stripeGet(stripeKey, '/v1/billing/meters', new URLSearchParams({ limit: '100' }));
  let meter = (meters.data ?? []).find((item: any) => item.event_name === config.meter_event_name);
  if (meter?.status === 'inactive') {
    meter = await stripePost(stripeKey, `/v1/billing/meters/${encodeURIComponent(meter.id)}/reactivate`, new URLSearchParams(), `chowseek_restaurant_meter_reactivate_${meter.id}`);
  }
  if (!meter) {
    const body = new URLSearchParams();
    body.set('display_name', 'Chowseek Sponsored Impressions');
    body.set('event_name', config.meter_event_name);
    body.set('default_aggregation[formula]', 'sum');
    body.set('value_settings[event_payload_key]', 'value');
    body.set('customer_mapping[type]', 'by_id');
    body.set('customer_mapping[event_payload_key]', 'stripe_customer_id');
    meter = await stripePost(stripeKey, '/v1/billing/meters', body, 'chowseek_restaurant_impression_meter_v1');
  }

  const { error } = await admin.rpc('restaurant_billing_set_config', { p_meter_id: meter.id });
  if (error) throw error;
  return { ...config, stripe_meter_id: meter.id };
}

async function ensurePrice(admin: any, config: BillingConfig, stripeKey: string): Promise<BillingConfig> {
  if (config.stripe_price_id) return config;
  if (!config.stripe_product_id || !config.stripe_meter_id) throw new Error('Billing product or meter is missing.');

  const pricesQuery = new URLSearchParams({ active: 'true', product: config.stripe_product_id, limit: '100' });
  pricesQuery.append('lookup_keys[]', 'chowseek_restaurant_cpm_20');
  const prices = await stripeGet(stripeKey, '/v1/prices', pricesQuery);
  let price = (prices.data ?? []).find((item: any) => item.lookup_key === 'chowseek_restaurant_cpm_20');

  if (!price) {
    const body = new URLSearchParams();
    body.set('currency', 'usd');
    body.set('product', config.stripe_product_id);
    body.set('unit_amount', '2');
    body.set('billing_scheme', 'per_unit');
    body.set('lookup_key', 'chowseek_restaurant_cpm_20');
    body.set('recurring[interval]', 'month');
    body.set('recurring[usage_type]', 'metered');
    body.set('recurring[meter]', config.stripe_meter_id);
    body.set('metadata[chowseek_product]', 'restaurant_sponsorship');
    body.set('metadata[cpm_rate_cents]', '2000');
    price = await stripePost(stripeKey, '/v1/prices', body, 'chowseek_restaurant_cpm20_price_v1');
  }

  const { error } = await admin.rpc('restaurant_billing_set_config', { p_price_id: price.id });
  if (error) throw error;
  return { ...config, stripe_price_id: price.id };
}

async function reportImpression(config: BillingConfig, row: UsageRow, stripeKey: string) {
  const body = new URLSearchParams();
  body.set('event_name', config.meter_event_name);
  body.set('payload[stripe_customer_id]', row.stripe_customer_id);
  body.set('payload[value]', '1');
  body.set('identifier', `chowseek_imp_${row.queue_id}`);
  body.set('timestamp', String(Math.floor(new Date(row.viewed_at).getTime() / 1000)));
  await stripePost(stripeKey, '/v1/billing/meter_events', body, `chowseek_meter_${row.queue_id}`);
}

Deno.serve(
  withSupabase({ auth: 'none' }, async (req, context) => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

    const cronSecret = req.headers.get('x-cron-secret') ?? '';
    const admin = context.supabaseAdmin;
    const { data: allowed, error: verifyError } = await admin.rpc('restaurant_billing_verify_cron_secret', { p_secret: cronSecret });
    if (verifyError || allowed !== true) return json({ error: 'Unauthorized.' }, 401);

    const stripeKey = Deno.env.get('RESTAURANT_STRIPE_API_KEY')?.trim();
    if (!stripeKey) {
      return json({ ok: true, configured: false, reported: 0 });
    }

    try {
      const { data: initialConfig, error: configError } = await admin.rpc('restaurant_billing_get_config').single();
      if (configError) throw configError;
      if (!initialConfig?.stripe_product_id) throw new Error('Stripe restaurant product is not configured.');

      let config = await ensureMeter(admin, initialConfig as BillingConfig, stripeKey);
      config = await ensurePrice(admin, config, stripeKey);

      const { data: rows, error: claimError } = await admin.rpc('restaurant_billing_claim_usage', { p_limit: 200 });
      if (claimError) throw claimError;
      const usageRows = (rows ?? []) as UsageRow[];
      if (!usageRows.length) return json({ ok: true, configured: true, price_id: config.stripe_price_id, reported: 0 });

      const succeeded: string[] = [];
      const failed: Array<{ id: string; message: string }> = [];
      for (let offset = 0; offset < usageRows.length; offset += 10) {
        const chunk = usageRows.slice(offset, offset + 10);
        const results = await Promise.all(chunk.map(async (row) => {
          try {
            await reportImpression(config, row, stripeKey);
            return { id: row.queue_id, ok: true as const };
          } catch (error) {
            return { id: row.queue_id, ok: false as const, message: error instanceof Error ? error.message : String(error) };
          }
        }));
        for (const result of results) {
          if (result.ok) succeeded.push(result.id);
          else failed.push({ id: result.id, message: result.message });
        }
      }

      if (succeeded.length) {
        const { error } = await admin.rpc('restaurant_billing_complete_usage', { p_ids: succeeded });
        if (error) throw error;
      }
      if (failed.length) {
        const message = failed.map((item) => item.message).join('; ').slice(0, 500);
        const { error } = await admin.rpc('restaurant_billing_release_usage', { p_ids: failed.map((item) => item.id), p_error: message });
        if (error) throw error;
      }

      return json({ ok: failed.length === 0, configured: true, price_id: config.stripe_price_id, reported: succeeded.length, failed: failed.length });
    } catch (error) {
      console.error(JSON.stringify({ event: 'restaurant_usage_sync_failed', message: error instanceof Error ? error.message : String(error) }));
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }),
);
