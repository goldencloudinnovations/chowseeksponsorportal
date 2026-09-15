import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';

export function userIDFromClaims(claims: unknown): string | null {
  if (!claims || typeof claims !== 'object') return null;
  const value = claims as Record<string, unknown>;
  const id = value.id ?? value.sub;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function userEmailFromClaims(claims: unknown): string | null {
  if (!claims || typeof claims !== 'object') return null;
  const email = (claims as Record<string, unknown>).email;
  return typeof email === 'string' && email.trim() ? email.trim() : null;
}

export async function isPlatformAdmin(admin: SupabaseClient, userID: string): Promise<boolean> {
  const { data, error } = await admin
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userID)
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

export async function requirePlatformAdmin(admin: SupabaseClient, claims: unknown): Promise<string> {
  const userID = userIDFromClaims(claims);
  if (!userID || !(await isPlatformAdmin(admin, userID))) {
    throw new Error('Platform admin access required.');
  }
  return userID;
}

export async function requireRestaurantOwner(
  admin: SupabaseClient,
  claims: unknown,
  restaurantID: string,
): Promise<{ id: string; email: string | null }> {
  const userID = userIDFromClaims(claims);
  if (!userID) throw new Error('Authentication is required.');
  if (await isPlatformAdmin(admin, userID)) {
    return { id: userID, email: userEmailFromClaims(claims) };
  }

  const { data, error } = await admin
    .from('restaurant_memberships')
    .select('role,active')
    .eq('restaurant_id', restaurantID)
    .eq('user_id', userID)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.role !== 'owner') throw new Error('Restaurant owner access required.');
  return { id: userID, email: userEmailFromClaims(claims) };
}
