export type MembershipRole = 'owner' | 'editor' | 'viewer';

export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  billing_email: string | null;
  status: 'active' | 'suspended';
  plan_code: string;
  max_users: number;
  max_active_placements: number;
  features: Record<string, boolean>;
  stripe_subscription_status: string | null;
  stripe_price_id: string | null;
  current_period_end: string | null;
}

export interface Membership {
  restaurant_id: string;
  user_id: string;
  role: MembershipRole;
  restaurants: Restaurant;
}

export interface Sponsor {
  id: string;
  restaurant_id: string;
  advertiser_name: string;
  campaign_name: string | null;
  name: string;
  address: string;
  description: string;
  latitude: number;
  longitude: number;
  active: boolean;
  starts_at: string;
  ends_at: string | null;
  cpm_rate_cents: number;
  currency: string;
  impression_count: number;
  created_at: string;
  updated_at: string;
}

export interface AdminUser {
  id: string;
  email: string | null;
  banned_until: string | null;
  last_sign_in_at: string | null;
  memberships: Array<{ restaurant_id: string; restaurant_name: string; role: MembershipRole }>;
}
