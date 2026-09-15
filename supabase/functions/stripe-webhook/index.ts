import Stripe from 'npm:stripe@22.4.0';
import { json } from '../_shared/cors.ts';
import { admin } from '../_shared/server.ts';

const stripeKey = Deno.env.get('STRIPE_RESTRICTED_KEY') ?? Deno.env.get('STRIPE_SECRET_KEY');
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET');
if (!stripeKey || !webhookSecret) throw new Error('Stripe webhook secrets are required.');
const stripe = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' });
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const starterPrice = Deno.env.get('STRIPE_PRICE_STARTER');
const growthPrice = Deno.env.get('STRIPE_PRICE_GROWTH');

function planForPrice(priceId?: string | null) {
  if (priceId && priceId === growthPrice) return 'growth';
  if (priceId && priceId === starterPrice) return 'starter';
  return 'custom';
}
async function syncSubscription(subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const item = subscription.items.data[0];
  const priceId = item?.price?.id ?? null;
  const periodEnd = (item as Stripe.SubscriptionItem | undefined)?.current_period_end ?? null;
  const restaurantId = subscription.metadata.restaurant_id || null;
  const patch = {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    subscription_status: subscription.status,
    subscription_price_id: priceId,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    plan_key: planForPrice(priceId),
    updated_at: new Date().toISOString(),
  };
  let query = admin.from('restaurants').update(patch);
  query = restaurantId ? query.eq('id', restaurantId) : query.eq('stripe_customer_id', customerId);
  const { error } = await query; if (error) throw error;
}

Deno.serve(async (req) => {
  try {
    const signature = req.headers.get('Stripe-Signature');
    if (!signature) return json({ error: 'Missing Stripe signature.' }, 400);
    const rawBody = await req.text();
    const event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret, undefined, cryptoProvider);
    const { error: seenError } = await admin.from('stripe_events').insert({ event_id: event.id, event_type: event.type });
    if (seenError?.code === '23505') return json({ ok: true, duplicate: true });
    if (seenError) throw seenError;

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'subscription' && session.subscription) {
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await syncSubscription(subscription);
        }
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed':
        break;
    }
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
