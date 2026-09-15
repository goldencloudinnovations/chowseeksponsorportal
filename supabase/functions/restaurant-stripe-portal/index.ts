import { withSupabase } from 'npm:@supabase/server';
import Stripe from 'npm:stripe@22.4.0';
import { corsHeaders, json } from '../_shared/cors.ts';
import { requireRestaurantOwner } from '../_shared/portal_auth.ts';

const stripeKey = Deno.env.get('STRIPE_API_KEY');
if (!stripeKey) throw new Error('STRIPE_API_KEY is required.');
const stripe = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' });

Deno.serve(
  withSupabase({ auth: 'user' }, async (req, context) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
      const body = await req.json();
      const restaurantId = String(body.restaurant_id ?? '');
      const admin = context.supabaseAdmin;
      await requireRestaurantOwner(admin, context.userClaims, restaurantId);
      const { data: restaurant, error } = await admin.from('restaurants').select('stripe_customer_id').eq('id', restaurantId).single();
      if (error) throw error;
      if (!restaurant.stripe_customer_id) throw new Error('No Stripe customer exists for this restaurant yet.');
      const returnUrl = Deno.env.get('PORTAL_URL') ?? 'https://sponsor.chowseek.com/';
      const session = await stripe.billingPortal.sessions.create({ customer: restaurant.stripe_customer_id, return_url: returnUrl });
      return json({ url: session.url });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }),
);
