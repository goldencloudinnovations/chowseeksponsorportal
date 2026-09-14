# Chowseek sponsorship portal

This folder is a static sponsorship-admin site designed to deploy directly to GitHub Pages. It uses Supabase Auth plus the project **publishable** key in the browser; it never embeds a service-role/secret key.

The portal manages the existing `public.sponsored_results` model documented in `SPONSORED_RESULTS.md`:

- advertiser and optional campaign name
- sponsored place/business name, address, and description
- latitude/longitude used by the mobile map viewport query
- start/end schedule and active switch
- CPM rate and currency
- impression count and calculated estimated spend

Admins can create, edit, activate/pause, and delete unused placements. Once a placement has recorded impressions, the portal keeps it for reporting history instead of deleting it.

## One-time database setup

The sponsored-results migration intentionally keeps normal mobile clients away from direct table access. For a static GitHub Pages admin portal, run `SPONSOR_PORTAL_SETUP.sql` once in the linked Supabase project's SQL Editor.

That setup grants `authenticated` table operations but protects every operation with RLS using the existing private portal-admin check:

```text
chowseek_private.is_portal_admin()
```

This is what makes browser-side CRUD safe with the publishable key: possession of the key alone does not grant sponsorship access.

## Admin bootstrap

Use the same private portal-admin allowlist as the trial portal. Choose an existing Supabase Auth account with a password, then add it from the SQL Editor if needed:

```sql
insert into chowseek_private.portal_admins (user_id)
select id
from auth.users
where lower(email) = lower('YOUR_ADMIN_EMAIL@example.com')
on conflict (user_id) do nothing;
```

There is intentionally no public sign-up flow in this portal.

## GitHub Pages

There is no build step. Publish this directory as the Pages site root, or copy its files into a repository `docs/` directory and configure Pages to deploy that directory.

The Supabase client import is pinned to `@supabase/supabase-js@2.95.0` through `esm.sh`.

If password reset is used, add the deployed Pages URL to **Supabase → Authentication → URL Configuration → Redirect URLs**. A project-pages pattern typically looks like:

```text
https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY/**
```

## Serving behavior

Creating a placement does not necessarily make it visible in the mobile app. It must satisfy all of the serving rules already described in `SPONSORED_RESULTS.md`:

1. `active = true`
2. `starts_at` is in the past/current time
3. `ends_at` is null or still in the future
4. its coordinates are inside the app's current map viewport

The portal defaults new placements to inactive so an admin can review them before publishing.

## Reporting

The overview and each placement use the table's authoritative cumulative `impression_count`. Estimated spend is calculated as:

```text
(impression_count / 1000) * (cpm_rate_cents / 100)
```

For detailed day-by-day reporting, continue to aggregate `public.sponsored_result_impressions.viewed_at` as described in `SPONSORED_RESULTS.md`; this static portal does not request raw impression-audit rows.
