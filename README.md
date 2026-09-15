# Chowseek restaurant portal

Full-stack TypeScript portal for restaurant customers and Chowseek platform administrators.

## What changed

- Restaurant users sign in with Supabase Auth and can only read their assigned restaurant(s).
- Owners/editors can update restaurant profile data; viewers are read-only.
- Sponsored placements are attached to `restaurant_id` and protected by tenant RLS.
- Existing placements are retained under an admin-only **Legacy / Unassigned** restaurant so nothing disappears during migration.
- Platform admins can see every restaurant, adjust user/placement limits, enable/disable restaurants, invite users, remove access, and delete non-admin accounts.
- Stripe Billing uses hosted Checkout for subscription start/change and Stripe Customer Portal for payment methods, invoices, and cancellation.
- Stripe webhook events synchronize subscription state back to the restaurant record and are idempotently recorded.
- Database triggers enforce `max_users` and `max_placements` even if a caller bypasses the UI.
- Audit rows are written for restaurant, membership, and sponsored-placement changes.

## Architecture

The browser contains only the Supabase publishable key. Normal restaurant/profile/placement CRUD is protected by Postgres RLS. Operations that require Supabase Auth Admin or Stripe credentials run in Supabase Edge Functions with server-only secrets.

### Roles

- **platform admin** — all restaurants + privileged account/limit management
- **owner** — edit restaurant, placements, and billing
- **editor** — edit restaurant and placements
- **viewer** — read-only restaurant and placement access

Authorization is stored in `public.platform_admins` and `public.restaurant_memberships`; it does not trust user-editable Auth metadata.

## Database setup

Apply `supabase/migrations/20260915120000_restaurant_portal.sql` to the same Supabase project that contains `public.sponsored_results`.

Bootstrap the first platform admin using an existing Auth user:

```sql
insert into public.platform_admins (user_id)
select id from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL@example.com')
on conflict (user_id) do nothing;
```

The migration intentionally gives browser users no write privileges to memberships, Stripe state, plan keys, feature flags, or account limits. Those fields are only changed by trusted Edge Functions.

## Edge Functions

Deploy:

```bash
supabase functions deploy admin-users
supabase functions deploy stripe-checkout
supabase functions deploy stripe-portal
supabase functions deploy stripe-webhook --no-verify-jwt
```

Set secrets:

```bash
supabase secrets set \
  SUPABASE_SECRET_KEY=sb_secret_... \
  STRIPE_RESTRICTED_KEY=rk_live_... \
  STRIPE_WEBHOOK_SIGNING_SECRET=whsec_... \
  STRIPE_PRICE_STARTER=price_... \
  STRIPE_PRICE_GROWTH=price_... \
  PORTAL_URL=https://sponsor.chowseek.com/
```

Prefer a Stripe restricted key with only the Customer, Checkout Session, Billing Portal, Subscription, and webhook-related permissions this portal needs.

### Stripe Dashboard

Create a separate Product for each plan (for example **Chowseek Starter** and **Chowseek Growth**) and a recurring Price for each. Put the Price IDs in the secrets above. Configure the Customer Portal for the plan changes/cancellation options you want customers to have.

Add the deployed `stripe-webhook` URL as a Stripe webhook endpoint and subscribe to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

The Checkout code intentionally leaves payment methods dynamic rather than hard-coding card-only payments.

## Stripe Tax

Do not turn on `automatic_tax` just because the portal uses Billing. First determine where Chowseek has tax obligations and configure the applicable Stripe Tax registrations. Until registrations exist, enabling automatic tax can create a false sense that tax is being collected when it is not.

## Frontend build

The site follows the lightweight TypeScript build style used by `chowseek.com`:

```bash
npm install
npm run typecheck
npm run build
```

`dist/` can still be deployed to GitHub Pages. The backend is the Supabase database + Edge Functions.

## Required Supabase Auth configuration

Add the production portal URL to Authentication redirect URLs so password reset and user invitations return to the portal. Customize the Invite User email template if desired.

## Security notes

- Never ship `SUPABASE_SECRET_KEY`, a service-role key, Stripe secret/restricted keys, or webhook secrets to the browser.
- RLS is enabled on every new table in the exposed `public` schema.
- Account deletion is server-only and refuses to delete a platform-admin account.
- Removing restaurant access is usually preferable to deleting the Auth account when a user might belong to another restaurant.
- The Stripe webhook verifies the raw request body signature and keeps an event-id table to avoid replaying the same event.
