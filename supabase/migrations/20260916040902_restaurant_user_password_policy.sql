create table if not exists chowseek_private.restaurant_user_security (
  user_id uuid primary key references auth.users(id) on delete cascade,
  force_password_change boolean not null default false,
  admin_password_set_at timestamptz,
  password_changed_at timestamptz,
  updated_at timestamptz not null default now()
);
revoke all on chowseek_private.restaurant_user_security from public, anon, authenticated;

create or replace function chowseek_private.restaurant_password_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update chowseek_private.restaurant_user_security
  set force_password_change = false,
      password_changed_at = now(),
      updated_at = now()
  where user_id = new.id
    and force_password_change;
  return new;
end;
$$;

drop trigger if exists restaurant_password_changed on auth.users;
create trigger restaurant_password_changed
after update of encrypted_password on auth.users
for each row
when (old.encrypted_password is distinct from new.encrypted_password)
execute function chowseek_private.restaurant_password_changed();

create or replace function public.restaurant_password_change_required()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.force_password_change
    from chowseek_private.restaurant_user_security s
    where s.user_id = auth.uid()
  ), false);
$$;
revoke all on function public.restaurant_password_change_required() from public;
grant execute on function public.restaurant_password_change_required() to authenticated;

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
  order by lower(coalesce(u.email, '')), u.created_at;
$$;
revoke all on function public.restaurant_admin_list_users() from public;
grant execute on function public.restaurant_admin_list_users() to service_role;
