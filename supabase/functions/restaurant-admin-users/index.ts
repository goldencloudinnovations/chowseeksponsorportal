import { withSupabase } from 'npm:@supabase/server';
import { corsHeaders, json } from '../_shared/cors.ts';
import { requirePlatformAdmin } from '../_shared/portal_auth.ts';

type ListedUser = {
  user_id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  force_password_change: boolean;
  password_set_by_admin: boolean;
};

async function requirePortalMember(admin: any, userId: string) {
  const { data, error } = await admin
    .from('restaurant_memberships')
    .select('user_id')
    .eq('user_id', userId)
    .limit(1);
  if (error) throw error;
  if (!data?.length) throw new Error('Restaurant portal user not found.');
}

async function requirePasswordChange(admin: any, userId: string) {
  const { error } = await admin.rpc('restaurant_admin_require_password_change', { p_user_id: userId });
  if (error) throw error;
}

Deno.serve(
  withSupabase({ auth: 'user' }, async (req, context) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

    try {
      const admin = context.supabaseAdmin;
      const actorID = await requirePlatformAdmin(admin, context.userClaims);
      const body = await req.json();
      const action = String(body.action ?? '');

      if (action === 'list') {
        const [{ data: authRows, error: authError }, { data: memberships, error: membershipError }] = await Promise.all([
          admin.rpc('restaurant_admin_list_users'),
          admin.from('restaurant_memberships').select('restaurant_id,user_id,role,active'),
        ]);
        if (authError) throw authError;
        if (membershipError) throw membershipError;
        const users = ((authRows ?? []) as ListedUser[]).map((u) => ({
          id: u.user_id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
          force_password_change: u.force_password_change,
          password_set_by_admin: u.password_set_by_admin,
          memberships: (memberships ?? []).filter((m) => m.user_id === u.user_id),
        }));
        return json({ users });
      }

      if (action === 'create_user') {
        const email = String(body.email ?? '').trim().toLowerCase();
        const password = String(body.password ?? '');
        const restaurantId = String(body.restaurant_id ?? '');
        const role = String(body.role ?? 'viewer');
        if (!email || !restaurantId || !['owner','editor','viewer'].includes(role)) throw new Error('Invalid account details.');
        if (password.length < 12) throw new Error('Temporary password must be at least 12 characters.');

        const { data: restaurant, error: restaurantError } = await admin.from('restaurants').select('id').eq('id', restaurantId).maybeSingle();
        if (restaurantError) throw restaurantError;
        if (!restaurant) throw new Error('Restaurant not found.');

        const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) throw error;
        if (!data.user?.id) throw new Error('Supabase did not return the created user.');
        try {
          const { error: memberError } = await admin.from('restaurant_memberships').insert({
            restaurant_id: restaurantId,
            user_id: data.user.id,
            role,
            active: true,
          });
          if (memberError) throw memberError;
          await requirePasswordChange(admin, data.user.id);
        } catch (setupError) {
          try { await admin.auth.admin.deleteUser(data.user.id, false); } catch { /* best-effort cleanup */ }
          throw setupError;
        }
        return json({ ok: true, user_id: data.user.id, force_password_change: true });
      }

      if (action === 'reset_password') {
        const userId = String(body.user_id ?? '');
        const password = String(body.password ?? '');
        if (!userId || password.length < 12) throw new Error('Choose a temporary password of at least 12 characters.');
        if (userId === actorID) throw new Error('Use Account settings to change your own password.');
        await requirePortalMember(admin, userId);
        const { data: protectedAdmin, error: protectedError } = await admin.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
        if (protectedError) throw protectedError;
        if (protectedAdmin) throw new Error('Platform-admin passwords must be changed by the account owner.');
        const { error } = await admin.auth.admin.updateUserById(userId, { password });
        if (error) throw error;
        await requirePasswordChange(admin, userId);
        return json({ ok: true, force_password_change: true });
      }

      if (action === 'set_access') {
        const userId = String(body.user_id ?? '');
        const restaurantId = String(body.restaurant_id ?? '');
        const active = Boolean(body.active);
        if (!userId || !restaurantId) throw new Error('User and restaurant are required.');
        await requirePortalMember(admin, userId);
        if (active) {
          const { error: deactivateError } = await admin
            .from('restaurant_memberships')
            .update({ active: false, updated_at: new Date().toISOString() })
            .eq('user_id', userId)
            .neq('restaurant_id', restaurantId);
          if (deactivateError) throw deactivateError;
        }
        const patch: Record<string, unknown> = {
          restaurant_id: restaurantId,
          user_id: userId,
          active,
          updated_at: new Date().toISOString(),
        };
        if (body.role && ['owner','editor','viewer'].includes(String(body.role))) patch.role = String(body.role);
        const { error } = await admin.from('restaurant_memberships').upsert(patch, { onConflict: 'restaurant_id,user_id' });
        if (error) throw error;
        return json({ ok: true });
      }

      if (action === 'delete') {
        const userId = String(body.user_id ?? '');
        if (!userId || userId === actorID) throw new Error('You cannot delete your own admin account.');
        await requirePortalMember(admin, userId);
        const { data: protectedAdmin, error: protectedError } = await admin.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
        if (protectedError) throw protectedError;
        if (protectedAdmin) throw new Error('Remove platform-admin status before deleting this account.');
        const { error } = await admin.auth.admin.deleteUser(userId, false);
        if (error) throw error;
        return json({ ok: true });
      }

      if (action === 'update_restaurant') {
        const restaurantId = String(body.restaurant_id ?? '');
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.max_users !== undefined) updates.max_users = Math.max(1, Number(body.max_users));
        if (body.max_placements !== undefined) updates.max_placements = Math.max(0, Number(body.max_placements));
        if (body.active !== undefined) updates.active = Boolean(body.active);
        if (body.feature_flags !== undefined) updates.feature_flags = body.feature_flags;
        const { error } = await admin.from('restaurants').update(updates).eq('id', restaurantId);
        if (error) throw error;
        return json({ ok: true });
      }

      throw new Error('Unknown admin action.');
    } catch (error) {
      console.error(JSON.stringify({ event: 'restaurant_admin_users_failed', message: error instanceof Error ? error.message : String(error) }));
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }),
);
