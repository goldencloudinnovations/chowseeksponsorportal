import Stripe from 'npm:stripe@22.4.0';
import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, requireRestaurantOwner } from '../_shared/server.ts';

const stripeKey = Deno.env.get('STRIPE_API_KEY');
if (!stripeKey) throw new Error('STRIPE_API_KEY is required.');
const stripe = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' });
const priceMap: Record<string, string | undefined> = {
  starter: Deno.env.get('STRIPE_RESTAURANT_STARTER_PRICE_ID'),
  growth: Deno.env.get('STRIPE_RESTAURANT_GROWTH_PRICE_ID'),
};
function integrationIdentifier() {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => String.fromCharCode(97 + (n % 26))).join('');
  return `chowseek_restaurant_${suffix}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json();
    const restaurantId = String(body.restaurant_id ?? '');
    const planKey = String(body.plan_key ?? '');
    const priceId = priceMap[planKey];
    if (!restaurantId || !priceId) throw new Error('Restaurant billing price IDs are not configured yet.');
    const user = await requireRestaurantOwner(req, restaurantId);
    const { data: restaurant, error } = await admin.from('restaurants').select('*').eq('id', restaurantId).single();
    if (error) throw error;
    if (!restaurant.active) throw new Error('This restaurant is disabled.');
    const managedStatuses = new Set(['active','trialing','past_due','unpaid','incomplete','paused']);
    if (restaurant.stripe_subscription_id && managedStatuses.has(String(restaurant.subscription_status ?? ''))) {
      throw new Error('This restaurant already has a subscription. Use Manage billing to change or cancel it.');
    }

    let customerId = restaurant.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: restaurant.name,
        email: user.email ?? undefined,
        metadata: { restaurant_id: restaurantId, chowseek_product: 'restaurant_portal' },
      });
      customerId = customer.id;
      const { error: saveError } = await admin.from('restaurants').update({
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      }).eq('id', restaurantId);
      if (saveError) throw saveError;
    }

    const portalUrl = (Deno.env.get('PORTAL_URL') ?? 'https://sponsor.chowseek.com/').replace(/\/$/, '');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${portalUrl}/?billing=success`,
      cancel_url: `${portalUrl}/?billing=cancelled`,
      client_reference_id: restaurantId,
      metadata: { restaurant_id: restaurantId, plan_key: planKey, chowseek_product: 'restaurant_portal' },
      subscription_data: { metadata: { restaurant_id: restaurantId, plan_key: planKey, chowseek_product: 'restaurant_portal' } },
      integration_identifier: integrationIdentifier(),
    });
    if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
    return json({ url: session.url });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
