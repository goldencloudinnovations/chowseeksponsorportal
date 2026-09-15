import { withSupabase } from 'npm:@supabase/server';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';
import Stripe from 'npm:stripe@22.4.0';
import { json } from '../_shared/cors.ts';

const stripeKey = Deno.env.get('STRIPE_API_KEY');
if (!stripeKey) throw new Error('STRIPE_API_KEY is required.');
const stripe = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' });
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function syncSubscription(admin: SupabaseClient, subscription: Stripe.Subscription, expectedPriceId: string) {
  const restaurantId = subscription.metadata.restaurant_id ?? '';
  if (subscription.metadata.chowseek_product !== 'restaurant_portal' || !UUID.test(restaurantId)) return;

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const item = subscription.items.data[0];
  const priceId = item?.price?.id ?? null;
  if (priceId !== expectedPriceId) throw new Error('Restaurant subscription uses an unexpected Stripe price.');

  const periodEnd = (item as Stripe.SubscriptionItem | undefined)?.current_period_end ?? null;
  const patch = {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    subscription_status: subscription.status,
    subscription_price_id: priceId,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    plan_key: 'cpm_20',
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin.from('restaurants').update(patch).eq('id', restaurantId).select('id').single();
  if (error) throw error;
}

Deno.serve(
  withSupabase({ auth: 'none' }, async (req, context) => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

    const signature = req.headers.get('Stripe-Signature');
    if (!signature) return json({ error: 'Missing Stripe signature.' }, 400);

    const admin = context.supabaseAdmin;
    const [{ data: webhookSecret, error: secretError }, { data: config, error: configError }] = await Promise.all([
      admin.rpc('restaurant_billing_webhook_secret'),
      admin.rpc('restaurant_billing_get_config').single(),
    ]);
    if (secretError || !webhookSecret) return json({ error: 'Webhook secret is not configured.' }, 503);
    if (configError || !config?.stripe_price_id) return json({ error: 'Restaurant billing price is not configured.' }, 503);

    const rawBody = await req.text();
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret, undefined, cryptoProvider);
    } catch {
      return json({ error: 'Invalid Stripe signature.' }, 400);
    }

    const { error: seenError } = await admin.from('restaurant_stripe_events').insert({ event_id: event.id, event_type: event.type });
    if (seenError?.code === '23505') return json({ ok: true, duplicate: true });
    if (seenError) return json({ error: seenError.message }, 500);

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await syncSubscription(admin, event.data.object as Stripe.Subscription, config.stripe_price_id);
          break;
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.metadata?.chowseek_product !== 'restaurant_portal' || !UUID.test(session.metadata?.restaurant_id ?? '')) break;
          if (session.mode === 'subscription' && session.subscription) {
            const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            await syncSubscription(admin, subscription, config.stripe_price_id);
          }
          break;
        }
        case 'invoice.paid':
        case 'invoice.payment_failed':
          break;
      }
      return json({ ok: true });
    } catch (error) {
      await admin.from('restaurant_stripe_events').delete().eq('event_id', event.id);
      console.error(JSON.stringify({ event: 'restaurant_stripe_webhook_failed', stripe_event_id: event.id, message: error instanceof Error ? error.message : String(error) }));
      return json({ error: 'Webhook processing failed.' }, 500);
    }
  }),
);
