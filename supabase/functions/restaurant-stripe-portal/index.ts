import { withSupabase } from 'npm:@supabase/server';
import Stripe from 'npm:stripe@22.4.0';
import { corsHeaders, json } from '../_shared/cors.ts';
import { requireRestaurantOwner } from '../_shared/portal_auth.ts';

const stripeKey = Deno.env.get('STRIPE_API_KEY');
if (!stripeKey) throw new Error('STRIPE_API_KEY is required.');
const stripe = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' });

async function ensureRestaurantPortalConfiguration(admin: any, configuredId: string | null): Promise<string> {
  if (configuredId) return configuredId;

  const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  let configuration = configurations.data.find((item) =>
    item.metadata?.chowseek_product === 'restaurant_sponsorship'
  );

  if (!configuration) {
    configuration = await stripe.billingPortal.configurations.create({
      name: 'Chowseek restaurant sponsorship',
      default_return_url: Deno.env.get('PORTAL_URL') ?? 'https://sponsor.chowseek.com/',
      metadata: { chowseek_product: 'restaurant_sponsorship' },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end',
          cancellation_reason: {
            enabled: true,
            options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'],
          },
        },
      },
    });
  }

  const { error } = await admin.rpc('restaurant_billing_set_config', {
    p_portal_configuration_id: configuration.id,
  });
  if (error) throw error;
  return configuration.id;
}

Deno.serve(
  withSupabase({ auth: 'user' }, async (req, context) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

    try {
      const body = await req.json();
      const restaurantId = String(body.restaurant_id ?? '');
      const admin = context.supabaseAdmin;
      await requireRestaurantOwner(admin, context.userClaims, restaurantId);

      const [{ data: restaurant, error: restaurantError }, { data: config, error: configError }] = await Promise.all([
        admin.from('restaurants').select('stripe_customer_id').eq('id', restaurantId).single(),
        admin.rpc('restaurant_billing_get_config').single(),
      ]);
      if (restaurantError) throw restaurantError;
      if (configError) throw configError;
      if (!restaurant.stripe_customer_id) throw new Error('No Stripe customer exists for this restaurant yet.');

      const configurationId = await ensureRestaurantPortalConfiguration(
        admin,
        config?.stripe_portal_configuration_id ?? null,
      );
      const returnUrl = Deno.env.get('PORTAL_URL') ?? 'https://sponsor.chowseek.com/';
      const session = await stripe.billingPortal.sessions.create({
        customer: restaurant.stripe_customer_id,
        configuration: configurationId,
        return_url: returnUrl,
      });
      return json({ url: session.url });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }),
);
