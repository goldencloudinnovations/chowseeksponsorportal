import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, requirePlatformAdmin } from '../_shared/server.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const actor = await requirePlatformAdmin(req);
    const body = await req.json();
    const action = String(body.action ?? '');

    if (action === 'list') {
      const [{ data: authData, error: authError }, { data: memberships, error: membershipError }] = await Promise.all([
        admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
        admin.from('restaurant_memberships').select('restaurant_id,user_id,role,active'),
      ]);
      if (authError) throw authError;
      if (membershipError) throw membershipError;
      const users = authData.users.map((u) => ({
        id: u.id,
        email: u.email ?? '(no email)',
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        memberships: (memberships ?? []).filter((m) => m.user_id === u.id),
      }));
      return json({ users });
    }

    if (action === 'invite') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const restaurantId = String(body.restaurant_id ?? '');
      const role = String(body.role ?? 'viewer');
      if (!email || !restaurantId || !['owner','editor','viewer'].includes(role)) throw new Error('Invalid invitation.');
      const redirectTo = Deno.env.get('PORTAL_URL') ?? 'https://sponsor.chowseek.com/';
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (error) throw error;
      if (!data.user?.id) throw new Error('Supabase did not return the invited user.');
      const { error: memberError } = await admin.from('restaurant_memberships').upsert({
        restaurant_id: restaurantId,
        user_id: data.user.id,
        role,
        active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'restaurant_id,user_id' });
      if (memberError) throw memberError;
      return json({ ok: true, user_id: data.user.id });
    }

    if (action === 'set_access') {
      const userId = String(body.user_id ?? '');
      const restaurantId = String(body.restaurant_id ?? '');
      const patch: Record<string, unknown> = { active: Boolean(body.active), updated_at: new Date().toISOString() };
      if (body.role && ['owner','editor','viewer'].includes(String(body.role))) patch.role = String(body.role);
      const { error } = await admin.from('restaurant_memberships').update(patch).eq('restaurant_id', restaurantId).eq('user_id', userId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === 'delete') {
      const userId = String(body.user_id ?? '');
      if (!userId || userId === actor.id) throw new Error('You cannot delete your own admin account.');
      const { data: protectedAdmin } = await admin.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
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
      if (body.plan_key !== undefined) updates.plan_key = String(body.plan_key);
      if (body.feature_flags !== undefined) updates.feature_flags = body.feature_flags;
      const { error } = await admin.from('restaurants').update(updates).eq('id', restaurantId);
      if (error) throw error;
      return json({ ok: true });
    }

    throw new Error('Unknown admin action.');
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
