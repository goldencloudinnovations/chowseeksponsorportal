-- Run this once in the linked Chowseek Supabase project's SQL Editor.
-- It keeps the GitHub Pages portal on the publishable key while allowing only
-- authenticated users accepted by chowseek_private.is_portal_admin() to manage
-- public.sponsored_results.

alter table public.sponsored_results enable row level security;

grant select, insert, update, delete on table public.sponsored_results to authenticated;

-- Keep policy names portal-specific so this can coexist with mobile serving
-- policies/RPCs from the sponsored-results migration.
drop policy if exists "portal admins can read sponsored results" on public.sponsored_results;
create policy "portal admins can read sponsored results"
on public.sponsored_results
for select
to authenticated
using (chowseek_private.is_portal_admin());

drop policy if exists "portal admins can create sponsored results" on public.sponsored_results;
create policy "portal admins can create sponsored results"
on public.sponsored_results
for insert
to authenticated
with check (chowseek_private.is_portal_admin());

drop policy if exists "portal admins can update sponsored results" on public.sponsored_results;
create policy "portal admins can update sponsored results"
on public.sponsored_results
for update
to authenticated
using (chowseek_private.is_portal_admin())
with check (chowseek_private.is_portal_admin());

drop policy if exists "portal admins can delete unused sponsored results" on public.sponsored_results;
create policy "portal admins can delete unused sponsored results"
on public.sponsored_results
for delete
to authenticated
using (
  chowseek_private.is_portal_admin()
  and coalesce(impression_count, 0) = 0
);
