create or replace function public.restaurant_admin_require_password_change(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.restaurant_memberships rm where rm.user_id = p_user_id
  ) then
    raise exception 'restaurant portal user not found' using errcode = 'P0001';
  end if;

  insert into chowseek_private.restaurant_user_security (
    user_id,
    force_password_change,
    admin_password_set_at,
    updated_at
  ) values (
    p_user_id,
    true,
    now(),
    now()
  )
  on conflict (user_id) do update
  set force_password_change = true,
      admin_password_set_at = excluded.admin_password_set_at,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.restaurant_admin_require_password_change(uuid) from public;
grant execute on function public.restaurant_admin_require_password_change(uuid) to service_role;
