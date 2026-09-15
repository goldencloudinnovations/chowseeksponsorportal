import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

const url = Deno.env.get('SUPABASE_URL')!;
const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
const secret = secretKeys
  ? JSON.parse(secretKeys)['default']
  : Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!secret) throw new Error('No hosted Supabase secret key is available.');

export const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

export async function requireUser(req: Request) {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Missing authorization token.');
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new Error('Invalid session.');
  return user;
}

export async function isPlatformAdmin(userId: string) {
  const { data, error } = await admin.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
  if (error) throw error; return !!data;
}

export async function requirePlatformAdmin(req: Request) {
  const user = await requireUser(req);
  if (!(await isPlatformAdmin(user.id))) throw new Error('Platform admin access required.');
  return user;
}

export async function requireRestaurantOwner(req: Request, restaurantId: string) {
  const user = await requireUser(req);
  if (await isPlatformAdmin(user.id)) return user;
  const { data, error } = await admin.from('restaurant_memberships').select('role,active').eq('restaurant_id', restaurantId).eq('user_id', user.id).eq('active', true).maybeSingle();
  if (error) throw error;
  if (!data || data.role !== 'owner') throw new Error('Restaurant owner access required.');
  return user;
}
