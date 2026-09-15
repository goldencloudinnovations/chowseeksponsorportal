# Chowseek restaurant portal

Full-stack TypeScript portal for restaurant customers and Chowseek platform administrators.

## Hosted backend

This portal intentionally uses the existing Chowseek Supabase project:

```text
ugbindlzyqaktejbxalk
https://ugbindlzyqaktejbxalk.supabase.co
```

There is no separate local Supabase stack to start. `src/config.ts` contains only the hosted project's publishable browser key, so local frontend development talks to the same Chowseek Auth, Postgres/RLS, and deployed `restaurant-*` Edge Functions as production.

The portal's migration has been applied to that project. Existing Chowseek consumer billing remains separate and untouched.

## What changed

- Restaurant users sign in with the existing Chowseek Supabase Auth and can only read their assigned restaurant(s).
- Owners/editors can update restaurant profile data; viewers are read-only.
- Sponsored placements are attached to `restaurant_id` and protected by tenant RLS.
- Existing placements are retained under an admin-only **Legacy / Unassigned** restaurant so nothing disappears during migration.
- Platform admins can see every restaurant, adjust user/placement limits, enable/disable restaurants, invite users, remove access, and delete non-admin accounts.
- Restaurant Stripe Billing uses hosted Checkout and Stripe Customer Portal.
- Database triggers enforce `max_users` and `max_placements` even if a caller bypasses the UI.
- Audit rows are written for restaurant, membership, and sponsored-placement changes. Mobile `impression_count` updates are intentionally excluded from the portal audit trigger.

## Architecture

The browser contains only the Chowseek Supabase publishable key. Normal restaurant/profile/placement CRUD is protected by Postgres RLS. Operations that require Supabase Auth Admin or Stripe credentials run in hosted Supabase Edge Functions.

### Roles

- **platform admin** — all restaurants + privileged account/limit management
- **owner** — edit restaurant, placements, and billing
- **editor** — edit restaurant and placements
- **viewer** — read-only restaurant and placement access

Authorization is stored in `public.platform_admins` and `public.restaurant_memberships`; it does not trust user-editable Auth metadata.

## Local frontend test

Clone/check out the feature branch and run:

```bash
git checkout feat/full-stack-restaurant-portal
npm install
npm run typecheck
npm run dev
```

Open the localhost URL printed by the dev server. That local page uses the existing Chowseek backend directly; do not run `supabase start` or change `src/config.ts` to localhost.

Because this is the live Chowseek database, use test restaurant records rather than modifying real customer data while testing.

## Database

Migration:

```text
supabase/migrations/20260915120000_restaurant_portal.sql
```

It creates the tenant/RBAC tables and RLS policies and adds `restaurant_id` to the existing `public.sponsored_results` table. It also carries forward any users in the old `chowseek_private.portal_admins` allowlist.

If you need to bootstrap a platform admin from an existing Chowseek Auth account:

```sql
insert into public.platform_admins (user_id)
select id from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL@example.com')
on conflict (user_id) do nothing;
```

## Edge Functions

The restaurant portal uses namespaced functions so it does not overwrite Chowseek's existing consumer billing functions:

```text
restaurant-admin-users
restaurant-stripe-checkout
restaurant-stripe-portal
restaurant-stripe-webhook
```

The hosted Chowseek project already provides its Supabase secret-key environment and `STRIPE_API_KEY`; the restaurant functions reuse those rather than introducing another Supabase/Stripe API key.

Restaurant-specific billing still needs these values configured in the hosted project before Checkout/webhook testing:

```text
STRIPE_RESTAURANT_STARTER_PRICE_ID
STRIPE_RESTAURANT_GROWTH_PRICE_ID
RESTAURANT_STRIPE_WEBHOOK_SECRET
PORTAL_URL=https://sponsor.chowseek.com/
```

### Stripe Dashboard

Create a separate Product for each restaurant plan (for example **Chowseek Starter** and **Chowseek Growth**) and a recurring Price for each. Put those Price IDs in the restaurant-specific secrets above.

Register the deployed `restaurant-stripe-webhook` as its own Stripe webhook endpoint and subscribe to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

This endpoint is deliberately separate from Chowseek's existing consumer `stripe-webhook`.

The Checkout code leaves payment methods dynamic rather than hard-coding card-only payments.

## Stripe Tax

Do not turn on `automatic_tax` just because the portal uses Billing. First determine where Chowseek has tax obligations and configure the applicable Stripe Tax registrations. Until registrations exist, enabling automatic tax can create a false sense that tax is being collected when it is not.

## Required Supabase Auth configuration

For password reset and invitations from localhost, add the localhost dev URL to the existing Chowseek project's Authentication redirect allowlist. Keep the production `https://sponsor.chowseek.com/` redirect as well.

## Security notes

- Never ship Supabase secret/service-role keys, `STRIPE_API_KEY`, or webhook secrets to the browser.
- RLS is enabled on every new table in the exposed `public` schema.
- Account deletion is server-only and refuses to delete a platform-admin account.
- Removing restaurant access is usually preferable to deleting the Auth account when a user might belong to another restaurant.
- Restaurant Stripe events use a separate idempotency table from Chowseek's existing consumer billing webhook.
