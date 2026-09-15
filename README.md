# Chowseek restaurant portal

Full-stack TypeScript portal for restaurant customers and Chowseek platform administrators.

## Hosted backend

This portal uses the existing Chowseek Supabase project directly:

```text
ugbindlzyqaktejbxalk
https://ugbindlzyqaktejbxalk.supabase.co
```

Local frontend development uses the hosted Chowseek Auth, Postgres/RLS, and deployed `restaurant-*` Edge Functions. Do not run a separate local Supabase stack for normal portal testing.

## Sponsorship billing

There is exactly one restaurant sponsorship rate:

```text
$20 USD CPM
= $20 per 1,000 deduplicated impressions
= $0.02 per billable impression
```

There are no Starter/Growth tiers and restaurant users cannot choose or override the CPM or currency.

Stripe Billing uses one monthly metered Price attached to a Billing Meter. Billable usage comes only from Chowseek's existing authenticated, deduplicated impression path. The browser never supplies impression quantities for billing.

A non-legacy restaurant's sponsored placements serve only while the restaurant is active and its Stripe subscription status is `active` or `trialing`. The existing **Legacy / Unassigned** inventory remains exempt so migration does not silently disable old placements.

## Roles

- **platform admin** — all restaurants plus privileged account/limit management
- **owner** — edit restaurant, placements, and billing
- **editor** — edit restaurant and placements
- **viewer** — read-only restaurant and placement access

Authorization lives in `public.platform_admins` and `public.restaurant_memberships`; user-editable Auth metadata is not trusted for authorization.

## Local frontend test

```bash
git checkout feat/full-stack-restaurant-portal
npm install
npm run typecheck
npm run dev
```

Open the localhost URL printed by the dev server. It talks to the hosted Chowseek backend, so use test restaurant/user records when exercising writes.

## Production migrations

The repository migration versions match the versions recorded by the hosted Supabase project:

```text
20260915205355_restaurant_portal.sql
20260915205745_restaurant_portal_audit_index.sql
20260915214857_restaurant_single_cpm_billing.sql
20260915214906_restaurant_portal_billing_isolation.sql
20260915215914_restaurant_billing_safe_cron_enable.sql
20260915215943_restaurant_billing_queue_restaurant_index.sql
```

The billing migrations create the private usage queue/config, enforce `$20 CPM / USD`, gate restaurant inventory on active billing, queue deduplicated impressions transactionally, store cron/webhook credentials outside the browser data model, and dispatch usage sync once per minute.

## Edge Functions

The restaurant portal is namespaced separately from Chowseek consumer billing:

```text
restaurant-admin-users
restaurant-stripe-checkout
restaurant-stripe-portal
restaurant-stripe-webhook
restaurant-sync-usage
```

Authenticated functions use `withSupabase({ auth: 'user' })` and `context.supabaseAdmin`.

`restaurant-stripe-webhook` has gateway JWT verification disabled because it validates Stripe's signature. `restaurant-sync-usage` also has JWT verification disabled but accepts only the random cron secret stored in Supabase Vault.

### Restaurant Stripe credential

Restaurant sponsorship billing intentionally does **not** reuse Chowseek's existing consumer `STRIPE_API_KEY`. The restaurant functions require a separate live restricted Stripe key:

```text
RESTAURANT_STRIPE_API_KEY=rk_live_...
```

Create it in the live **Chowseek, LLC** Stripe account and store it as a Supabase Edge Function secret. Use least privilege: Customers write, Checkout Sessions write, Customer Portal write, Subscriptions read, Products/Prices write, and Billing Meters/Meter Events write. Do not grant payouts, refunds, disputes, Connect, Issuing, or other unrelated permissions.

The usage-sync cron safely returns `configured:false` until this key exists. After the key is added, the next cron run automatically creates/reuses the Billing Meter and the one live metered Price; no additional SQL deployment is required.

## Stripe objects

Live product:

```text
Chowseek Sponsored Impressions
prod_VGatXf0kAdiSys
```

The usage-sync function provisions:

- event name: `chowseek_restaurant_impressions`
- aggregation: `sum`
- rate: `$0.02 USD` per impression
- interval: monthly
- lookup key: `chowseek_restaurant_cpm_20`

Stripe Checkout always collects a payment method and requires explicit acceptance of the recurring `$20 CPM` usage-billing terms.

### Restaurant webhook

The live restaurant webhook is separate from Chowseek consumer billing:

```text
https://ugbindlzyqaktejbxalk.supabase.co/functions/v1/restaurant-stripe-webhook
```

It subscribes to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Its Stripe signing secret is stored in Supabase Vault and is never committed to GitHub or returned to browser code. Webhook events are idempotently claimed and failed processing releases the claim so Stripe can retry.

### Customer Portal isolation

Restaurant billing creates/uses a dedicated Stripe Customer Portal configuration. It allows invoice history, payment-method changes, and end-of-period cancellation, but does not expose subscription price switching. This prevents restaurant customers from switching onto Chowseek's consumer subscription prices.

## Security notes

- Browser code contains only the Supabase publishable key.
- Secret/service-role Supabase keys and Stripe keys never ship to the browser.
- RLS is enabled on exposed portal tables.
- Private billing tables are explicitly revoked from `PUBLIC`, `anon`, and `authenticated`.
- CPM and currency are enforced by database constraints and column privileges.
- User/placement limits are enforced in the database, not only the UI.
- Usage is generated only after the existing sponsored-impression dedupe succeeds.
- Usage queue claims use row locking and retry-safe Stripe identifiers/idempotency keys.
- Restaurant Stripe webhooks validate signature, restaurant metadata, and the exact configured metered Price.

## Platform admin bootstrap

To add another platform admin from an existing Chowseek Auth account:

```sql
insert into public.platform_admins (user_id)
select id
from auth.users
where lower(email) = lower('YOUR_ADMIN_EMAIL@example.com')
on conflict (user_id) do nothing;
```

## Stripe Tax

Automatic tax is intentionally not enabled. Configure applicable Stripe Tax registrations first if Chowseek determines tax must be collected for this service.
