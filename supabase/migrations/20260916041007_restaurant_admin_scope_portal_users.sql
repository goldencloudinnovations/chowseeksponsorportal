create or replace function public.restaurant_admin_list_users()
returns table (
  user_id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  force_password_change boolean,
  password_set_by_admin boolean
)
language sql
security definer
set search_path = ''
as $$
  select u.id,
         coalesce(u.email, '(no email)')::text,
         u.created_at,
         u.last_sign_in_at,
         coalesce(s.force_password_change, false),
         (s.admin_password_set_at is not null)
  from auth.users u
  left join chowseek_private.restaurant_user_security s on s.user_id = u.id
  where exists (select 1 from public.restaurant_memberships rm where rm.user_id = u.id)
     or exists (select 1 from public.platform_admins pa where pa.user_id = u.id)
  order by lower(coalesce(u.email, '')), u.created_at;
$$;
revoke all on function public.restaurant_admin_list_users() from public;
grant execute on function public.restaurant_admin_list_users() to service_role;
