# Chowseek restaurant portal

Full-stack TypeScript portal for restaurant customers and Chowseek platform administrators.

## Hosted backend

This portal intentionally uses the existing Chowseek Supabase project:

```text
ugbindlzyqaktejbxalk
https://ugbindlzyqaktejbxalk.supabase.co
```

There is no separate local Supabase stack to start. `src/config.ts` contains only the hosted project's publishable browser key, so local frontend development talks to the same Chowseek Auth, Postgres/RLS, and deployed `restaurant-*` Edge Functions as production.

Existing Chowseek consumer billing remains separate from restaurant sponsorship billing.

## Sponsorship billing

There is exactly one restaurant sponsorship rate:

```text
$20 USD CPM
= $20 per 1,000 deduplicated impressions
= $0.02 per billable impression
```

There are no Starter/Growth tiers and restaurant users cannot choose or override a CPM.

Stripe Billing uses one metered recurring price attached to a Stripe Billing Meter. Each accepted sponsored impression is first deduplicated by Chowseek's existing `(sponsored_result_id, app_session_id)` database constraint, then queued for server-side Stripe reporting. A cron-triggered Edge Function reports those impressions as idempotent meter events. Browser input is never trusted as a billing quantity.

A non-legacy restaurant's sponsored placements serve only while the restaurant is active and its Stripe subscription status is `active` or `trialing`. The existing **Legacy / Unassigned** placements are exempt so the migration does not silently stop existing Chowseek inventory.

## What changed

- Restaurant users sign in with the existing Chowseek Supabase Auth and can only read their assigned restaurant(s).
- Owners/editors can update restaurant profile data; viewers are read-only.
- Sponsored placements are attached to `restaurant_id` and protected by tenant RLS.
- Existing placements are retained under an admin-only **Legacy / Unassigned** restaurant so nothing disappears during migration.
- Platform admins can see every restaurant, adjust user/placement limits, enable/disable restaurants, invite users, remove access, and delete non-admin accounts.
- Restaurant Stripe Billing uses hosted Checkout and Stripe Customer Portal.
- Database triggers enforce `max_users`, `max_placements`, and the fixed $20 CPM rate even if a caller bypasses the UI.
- Audit rows are written for restaurant, membership, and sponsored-placement changes. Mobile `impression_count` updates are intentionally excluded from the portal audit trigger.

## Architecture

The browser contains only the Chowseek Supabase publishable key. Normal restaurant/profile/placement CRUD is protected by Postgres RLS. Privileged operations run in hosted Supabase Edge Functions using the same `@supabase/server` / `context.supabaseAdmin` pattern as Chowseek's existing functions.

### Roles

- **platform admin** — all restaurants + privileged account/limit management
- **owner** — edit restaurant, placements, and billing
- **editor** — edit restaurant and placements
- **viewer** — read-only restaurant and placement access

Authorization is stored in `public.platform_admins` and `public.restaurant_memberships`; it does not trust user-editable Auth metadata.

## Local frontend test

```bash
git checkout feat/full-stack-restaurant-portal
npm install
npm run typecheck
npm run dev
```

Open the localhost URL printed by the dev server. That local page uses the existing Chowseek backend directly; do not run `supabase start` or change `src/config.ts` to localhost.

Because this is the live Chowseek database, use test restaurant records rather than modifying real customer data while testing.

## Database

The portal migrations create the tenant/RBAC model, billing queue/config, fixed-rate enforcement, RLS policies, and cron dispatch. Existing sponsored placements are preserved and users from the old `chowseek_private.portal_admins` allowlist are carried forward.

The billing queue and Stripe configuration live in `chowseek_private`. Only narrowly scoped `SECURITY DEFINER` RPCs granted to `service_role` expose the operations needed by Edge Functions. The browser has no access to the queue, Stripe IDs, cron secret, or webhook secret.

If you need to bootstrap another platform admin from an existing Chowseek Auth account:

```sql
insert into public.platform_admins (user_id)
select id from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL@example.com')
on conflict (user_id) do nothing;
```

## Edge Functions

The restaurant portal uses namespaced functions so it does not overwrite Chowseek consumer billing functions:

```text
restaurant-admin-users
restaurant-stripe-checkout
restaurant-stripe-portal
restaurant-stripe-webhook
restaurant-sync-usage
```

Authenticated functions use `withSupabase({ auth: 'user' })` and `context.supabaseAdmin`. `restaurant-stripe-webhook` has gateway JWT verification disabled because it verifies Stripe's signature. `restaurant-sync-usage` also has gateway JWT verification disabled, but it accepts only the random cron secret stored in Supabase Vault and validates that secret through a service-role-only RPC before doing any work.

The functions reuse Chowseek's existing `STRIPE_API_KEY`. No Stripe secret key, Stripe webhook signing secret, Supabase secret key, or service-role key is committed to this repository or shipped to the browser.

### Stripe objects

The live Stripe account uses one product named **Chowseek Sponsored Impressions**. The secure usage-sync function provisions one Billing Meter and one recurring metered Price if they do not already exist:

- event: `chowseek_restaurant_impressions`
- aggregation: sum
- unit price: `$0.02 USD` per impression
- billing interval: monthly
- lookup key: `chowseek_restaurant_cpm_20`

Stripe Checkout always collects a payment method. Checkout metadata and subscription metadata contain the restaurant ID and `chowseek_product=restaurant_portal`; the webhook rejects restaurant subscription updates that do not use that exact metadata and the configured metered price.

### Stripe webhook

`restaurant-stripe-webhook` is a separate endpoint from any Chowseek consumer billing destination and subscribes only to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Its signing secret is stored in Supabase Vault and fetched only by the server-side webhook function. Webhook event IDs are claimed idempotently; if processing fails, the claim is released so Stripe can safely retry.

## Stripe Tax

Automatic tax is intentionally not enabled by this implementation. Configure applicable Stripe Tax registrations first if Chowseek determines tax must be collected for this service.

## Required Supabase Auth configuration

For password reset and invitations from localhost, add the localhost dev URL to the existing Chowseek project's Authentication redirect allowlist. Keep the production `https://sponsor.chowseek.com/` redirect as well.

## Security notes

- Never ship Supabase secret/service-role keys, `STRIPE_API_KEY`, or webhook secrets to the browser.
- RLS is enabled on every portal table in the exposed `public` schema.
- Billing queue/config and cron credentials are kept outside the exposed browser data model.
- Restaurant users cannot write CPM or currency columns; the database enforces `$20 CPM / USD`.
- Billable usage comes from the same authenticated, deduplicated server-side impression path used by the mobile app.
- Sponsored placements for restaurant tenants do not serve without an active/trialing Stripe subscription.
- Removing restaurant access is usually preferable to deleting the Auth account when a user might belong to another restaurant.
