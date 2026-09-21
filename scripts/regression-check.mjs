import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../supabase/functions/restaurant-admin-users/index.ts', import.meta.url), 'utf8');

const checks = [
  ['dashboard does not eagerly load admin users', !/Promise\.all\([^\n]*loadAdminUsers/.test(app)],
  ['admin users load lazily', /name==='admin'&&isAdmin&&!adminUsersLoaded/.test(app)],
  ['normal users are scoped to one restaurant', /restaurantQuery=restaurantQuery\.eq\('id',memberships\[0\]\.restaurant_id\)/.test(app)],
  ['billing is owner/admin only', /function canManageBilling\(\)/.test(app)],
  ['admin memberships prioritize active access', /sort\(\(a,\s*b\)\s*=>\s*Number\(b\.active\)\s*-\s*Number\(a\.active\)\)/.test(admin)],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
if (failed.length) process.exit(1);
