# Sponsored map results

The mobile app reads sponsored map placements from Supabase and renders them as purple MapKit markers with a megaphone glyph. Apple Maps' own POIs are hidden, so the map only shows the user's location, Chowseek place markers, and Chowseek sponsored markers.

## Storage model

`public.sponsored_results` is the campaign/placement table. It is intended to be managed by a future admin or advertiser portal using a trusted backend/service role, not directly from the mobile app.

| Column | Purpose |
| --- | --- |
| `id` | Placement UUID. |
| `advertiser_name` | Human-readable advertiser/sponsor name shown in the app. |
| `campaign_name` | Optional internal campaign label for the portal. |
| `name` | Sponsored place/business name shown on the map and detail sheet. |
| `address` | Display address shown in the detail sheet. |
| `description` | Sponsored copy. The app displays this as the few-sentence description. |
| `latitude`, `longitude` | Marker location and viewport matching coordinates. |
| `active` | Master on/off switch. New rows default to off. |
| `starts_at`, `ends_at` | Campaign serving window. `ends_at` may be null. |
| `cpm_rate_cents` | CPM rate for reporting/billing. For USD, `2500` means $25.00 CPM. |
| `currency` | Three-letter currency code, default `USD`. |
| `impression_count` | Authoritative billable impression count. Updated only by the impression RPC. |
| `created_at`, `updated_at` | Portal/audit metadata. A portal should set `updated_at = now()` when editing a placement. |

`public.sponsored_result_impressions` is the impression-deduplication/audit table. It stores `sponsored_result_id`, a random `app_session_id`, and `viewed_at`. The session UUID is generated in memory when the app process starts. It is not persisted and is not tied to a user ID.

The composite primary key `(sponsored_result_id, app_session_id)` guarantees that a placement can only count once in a single app process session, even if the map pans away and back or a network request is retried. Fully quitting and reopening the app generates a new session UUID, so the same sponsored result can count again after it is loaded in a visible area.

## Mobile RPCs

The app has no direct table privileges. It uses two authenticated RPCs:

- `sponsored_results_in_bounds(p_south, p_west, p_north, p_east)` returns only public display fields for currently active placements inside the visible viewport. It supports viewports that cross the ±180° longitude boundary and limits a response to 100 placements.
- `record_sponsored_impressions(p_result_ids, p_session_id)` inserts deduplication rows and increments `impression_count` only for newly recorded placement/session pairs. The increment and dedupe happen in one database operation.

The implementation functions live in the non-exposed `sponsorship` schema. The public RPC wrappers are `security invoker`; mobile users cannot select campaign pricing, counters, or raw impression rows directly.

## CPM reporting

For a simple portal report, billable spend for a placement is:

```text
(impression_count / 1000) * (cpm_rate_cents / 100)
```

For example, 12,500 impressions at a $20.00 CPM (`cpm_rate_cents = 2000`) is $250.00.

For day-by-day reporting, aggregate `sponsored_result_impressions.viewed_at` rather than trying to reconstruct history from the cumulative `impression_count` column:

```sql
select
  sponsored_result_id,
  date_trunc('day', viewed_at) as day,
  count(*) as impressions
from public.sponsored_result_impressions
group by sponsored_result_id, date_trunc('day', viewed_at)
order by day desc;
```

## Portal write pattern

This repository includes a static GitHub Pages admin portal. It continues to use the Supabase publishable key, but `SPONSOR_PORTAL_SETUP.sql` adds admin-only RLS policies for `public.sponsored_results`. Every direct browser read/write is therefore checked by `chowseek_private.is_portal_admin()`; no service-role key is shipped to the browser.

The portal creates draft placements with `active = false` by default, supports editing and activation/pausing, and prevents deleting rows after they have recorded impressions. It exposes cumulative `impression_count`, calculated spend, and schedule status without changing the mobile RPC API.

If a separate backend-based advertiser workflow is added later, a server-side client with a service-role/secret key is still appropriate for that trusted backend. Never embed a service-role/secret key in the GitHub Pages site or mobile app.

## Deployment

The schema is defined by `supabase/migrations/20260914200111_sponsored_results.sql`. This migration version matches the migration already applied to the linked Chowseek Supabase project; keeping the file in source control keeps local migration history aligned.
