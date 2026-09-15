import { withSupabase } from 'npm:@supabase/server';
import Stripe from 'npm:stripe@22.4.0';
import { corsHeaders, json } from '../_shared/cors.ts';
import { requireRestaurantOwner } from '../_shared/portal_auth.ts';

const stripeKey = Deno.env.get('STRIPE_API_KEY');
if (!stripeKey) throw new Error('STRIPE_API_KEY is required.');
const stripe = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' });

function integrationIdentifier() {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => String.fromCharCode(97 + (n % 26))).join('');
  return `chowseek_restaurant_${suffix}`;
}

Deno.serve(
  withSupabase({ auth: 'user' }, async (req, context) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

    try {
      const body = await req.json();
      const restaurantId = String(body.restaurant_id ?? '');
      if (!restaurantId) throw new Error('Restaurant is required.');

      const admin = context.supabaseAdmin;
      const user = await requireRestaurantOwner(admin, context.userClaims, restaurantId);
      const [{ data: config, error: configError }, { data: restaurant, error: restaurantError }] = await Promise.all([
        admin.rpc('restaurant_billing_get_config').single(),
        admin.from('restaurants').select('*').eq('id', restaurantId).single(),
      ]);
      if (configError) throw configError;
      if (restaurantError) throw restaurantError;
      if (!config?.stripe_price_id) throw new Error('Restaurant billing is still initializing. Try again shortly.');
      if (!restaurant.active) throw new Error('This restaurant is disabled.');

      const managedStatuses = new Set(['active','trialing','past_due','unpaid','incomplete','paused']);
      if (restaurant.stripe_subscription_id && managedStatuses.has(String(restaurant.subscription_status ?? ''))) {
        throw new Error('This restaurant already has sponsorship billing. Use Manage billing instead.');
      }

      let customerId = restaurant.stripe_customer_id as string | null;
      if (!customerId) {
        const found = await stripe.customers.search({
          query: `metadata['restaurant_id']:'${restaurantId}' AND metadata['chowseek_product']:'restaurant_portal'`,
          limit: 10,
        });
        const existingCustomer = found.data.find((customer) => !('deleted' in customer && customer.deleted));
        if (existingCustomer) {
          customerId = existingCustomer.id;
        } else {
          const customer = await stripe.customers.create({
            name: restaurant.name,
            email: user.email ?? undefined,
            metadata: { restaurant_id: restaurantId, chowseek_product: 'restaurant_portal' },
          }, { idempotencyKey: `chowseek_restaurant_customer_${restaurantId}` });
          customerId = customer.id;
        }
        const { error: saveError } = await admin.from('restaurants').update({
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        }).eq('id', restaurantId);
        if (saveError) throw saveError;
      }

      const openSessions = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 20 });
      const existing = openSessions.data.find((session) =>
        session.mode === 'subscription' &&
        session.metadata?.chowseek_product === 'restaurant_portal' &&
        session.metadata?.restaurant_id === restaurantId &&
        !!session.url
      );
      if (existing?.url) return json({ url: existing.url });

      const portalUrl = (Deno.env.get('PORTAL_URL') ?? 'https://sponsor.chowseek.com/').replace(/\/$/, '');
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        payment_method_collection: 'always',
        line_items: [{ price: config.stripe_price_id }],
        success_url: `${portalUrl}/?billing=success`,
        cancel_url: `${portalUrl}/?billing=cancelled`,
        client_reference_id: restaurantId,
        metadata: {
          restaurant_id: restaurantId,
          plan_key: 'cpm_20',
          chowseek_product: 'restaurant_portal',
        },
        subscription_data: {
          metadata: {
            restaurant_id: restaurantId,
            plan_key: 'cpm_20',
            chowseek_product: 'restaurant_portal',
          },
        },
        integration_identifier: integrationIdentifier(),
      }, { idempotencyKey: `chowseek_restaurant_checkout_${restaurantId}_${crypto.randomUUID()}` });
      if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
      return json({ url: session.url });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }),
);
