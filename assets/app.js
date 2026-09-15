// @ts-ignore - browser ESM import is intentionally remote and pinned.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.0?bundle';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';
const FIXED_CPM_CENTS = 2000;
const LEGACY_RESTAURANT_ID = '00000000-0000-0000-0000-000000000001';
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = (id) => document.getElementById(id);
const views = { login: $('login-view'), password: $('password-view'), denied: $('denied-view'), portal: $('portal-view') };
let restaurants = [];
let memberships = [];
let placements = [];
let adminUsers = [];
let selectedRestaurantId = '';
let editingPlacementId = null;
let isAdmin = false;
let recoveringPassword = location.hash.includes('type=recovery') || new URLSearchParams(location.search).get('type') === 'recovery';
function showOnly(name) { Object.entries(views).forEach(([key, node]) => node.classList.toggle('hidden', key !== name)); $('sign-out').classList.toggle('hidden', name !== 'portal'); }
function notice(message = '', error = false) { const node = $('notice'); node.textContent = message; node.classList.toggle('hidden', !message); node.classList.toggle('error', error); }
function esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function currentRestaurant() { return restaurants.find(r => r.id === selectedRestaurantId) ?? null; }
function canEditRestaurant() { if (isAdmin)
    return true; const m = memberships.find(x => x.restaurant_id === selectedRestaurantId && x.active); return m?.role === 'owner' || m?.role === 'editor'; }
function billingActive(r = currentRestaurant()) { return !!r && (r.id === LEGACY_RESTAURANT_ID || (r.active && ['active', 'trialing'].includes(r.subscription_status ?? ''))); }
function money(cents, currency = 'USD') { return new Intl.NumberFormat(undefined, { style: 'currency', currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD' }).format((cents || 0) / 100); }
function localInput(value) { if (!value)
    return ''; const d = new Date(value); const offset = d.getTimezoneOffset() * 60000; return new Date(d.getTime() - offset).toISOString().slice(0, 16); }
function iso(value) { const d = new Date(value); if (Number.isNaN(d.getTime()))
    throw new Error('Enter a valid date/time.'); return d.toISOString(); }
function placementStatus(p) { const now = Date.now(); if (!p.active)
    return ['Paused', '']; if (p.restaurant_id !== LEGACY_RESTAURANT_ID && !billingActive())
    return ['Billing inactive', 'expired']; if (new Date(p.starts_at).getTime() > now)
    return ['Scheduled', 'scheduled']; if (p.ends_at && new Date(p.ends_at).getTime() <= now)
    return ['Ended', 'expired']; return ['Serving', 'active']; }
function spendCents(p) { return Math.round((Number(p.impression_count || 0) * FIXED_CPM_CENTS) / 1000); }
async function invoke(name, body = {}) { const { data, error } = await supabase.functions.invoke(name, { body }); if (error)
    throw error; if (data?.error) {
    const value = data.error;
    throw new Error(typeof value === 'string' ? value : String(value?.message ?? 'Request failed.'));
} return data; }
async function loadAccess() {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
        showOnly('login');
        return;
    }
    $('session-label').textContent = user.email ?? '';
    const [{ data: adminRows, error: adminError }, { data: memberRows, error: memberError }] = await Promise.all([
        supabase.from('platform_admins').select('user_id').eq('user_id', user.id),
        supabase.from('restaurant_memberships').select('restaurant_id,user_id,role,active').eq('user_id', user.id).eq('active', true),
    ]);
    if (adminError)
        throw adminError;
    if (memberError)
        throw memberError;
    isAdmin = (adminRows?.length ?? 0) > 0;
    memberships = (memberRows ?? []);
    let query = supabase.from('restaurants').select('*').order('name');
    if (!isAdmin)
        query = query.in('id', memberships.map(m => m.restaurant_id));
    const { data, error: restaurantsError } = await query;
    if (restaurantsError)
        throw restaurantsError;
    restaurants = (data ?? []);
    if (!restaurants.length && !isAdmin) {
        showOnly('denied');
        return;
    }
    selectedRestaurantId = selectedRestaurantId && restaurants.some(r => r.id === selectedRestaurantId) ? selectedRestaurantId : restaurants[0]?.id ?? '';
    showOnly('portal');
    renderShell();
    await Promise.all([loadPlacements(), isAdmin ? loadAdminUsers() : Promise.resolve()]);
}
function renderShell() {
    const r = currentRestaurant();
    $('portal-title').textContent = r?.name ?? 'Chowseek admin';
    $('portal-subtitle').textContent = isAdmin ? 'Platform administrator — manage every restaurant, user, limit, and placement.' : 'Your restaurant profile, sponsored placements, and $20 CPM billing.';
    $('admin-tab-button').classList.toggle('hidden', !isAdmin);
    $('restaurant-switcher-wrap').classList.toggle('hidden', restaurants.length <= 1);
    const switcher = $('restaurant-switcher');
    switcher.innerHTML = restaurants.map(x => `<option value="${esc(x.id)}" ${x.id === selectedRestaurantId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    const inviteRestaurant = $('invite-restaurant');
    inviteRestaurant.innerHTML = restaurants.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    renderRestaurant();
    renderBilling();
    if (isAdmin)
        renderAdminRestaurants();
}
function renderRestaurant() {
    const r = currentRestaurant();
    if (!r)
        return;
    $('restaurant-name').value = r.name;
    $('restaurant-address').value = r.address ?? '';
    $('restaurant-phone').value = r.phone ?? '';
    $('restaurant-website').value = r.website ?? '';
    $('restaurant-description').value = r.description ?? '';
    $('restaurant-latitude').value = r.latitude?.toString() ?? '';
    $('restaurant-longitude').value = r.longitude?.toString() ?? '';
    $('restaurant-status').textContent = r.active ? 'Active' : 'Disabled';
    $('restaurant-status').className = `badge ${r.active ? 'active' : 'expired'}`;
    const members = adminUsers.filter(u => u.memberships.some(m => m.restaurant_id === r.id && m.active)).length || memberships.filter(m => m.restaurant_id === r.id && m.active).length;
    $('stat-plan').textContent = '$20 CPM';
    $('stat-users').textContent = `${members} / ${r.max_users}`;
    $('stat-placements').textContent = `${placements.length} / ${r.max_placements}`;
    Array.from($('restaurant-form').elements).forEach(el => el.disabled = !canEditRestaurant());
}
async function loadPlacements() { if (!selectedRestaurantId) {
    placements = [];
    renderPlacements();
    return;
} const { data, error } = await supabase.from('sponsored_results').select('*').eq('restaurant_id', selectedRestaurantId).order('created_at', { ascending: false }); if (error)
    throw error; placements = (data ?? []); renderPlacements(); renderRestaurant(); }
function renderPlacements() {
    let serving = 0, impressions = 0, spend = 0;
    for (const p of placements) {
        if (placementStatus(p)[0] === 'Serving')
            serving++;
        impressions += Number(p.impression_count) || 0;
        spend += spendCents(p);
    }
    $('stat-serving').textContent = String(serving);
    $('stat-impressions').textContent = impressions.toLocaleString();
    $('stat-spend').textContent = money(spend);
    $('placements-empty').classList.toggle('hidden', placements.length > 0);
    $('placements-list').innerHTML = placements.map(p => { const [status, cls] = placementStatus(p); return `<article class="offer"><div><div class="offer-meta"><span class="badge ${cls}">${status}</span>${p.campaign_name ? `<span>Campaign: <strong>${esc(p.campaign_name)}</strong></span>` : ''}</div><h3>${esc(p.name)}</h3><p class="address-line">${esc(p.address)}</p><p class="offer-note">${esc(p.description)}</p><div class="offer-meta detail-row"><span>${Number(p.impression_count).toLocaleString()} impressions</span><span>${money(spendCents(p))} estimated</span><span>$20.00 CPM</span></div></div><div class="actions">${canEditRestaurant() ? `<button class="secondary edit-placement" data-id="${esc(p.id)}">Edit</button><button class="secondary toggle-placement" data-id="${esc(p.id)}">${p.active ? 'Pause' : 'Activate'}</button>${p.impression_count === 0 ? `<button class="danger delete-placement" data-id="${esc(p.id)}">Delete</button>` : ''}` : ''}</div></article>`; }).join('');
}
function renderBilling() { const r = currentRestaurant(); if (!r)
    return; $('billing-status').textContent = r.subscription_status ?? 'not subscribed'; $('billing-plan').textContent = '$20 CPM'; $('billing-renewal').textContent = r.current_period_end ? new Date(r.current_period_end).toLocaleDateString() : '—'; $('manage-billing').disabled = !r.stripe_customer_id; const start = $('start-billing'); start.disabled = !!r.stripe_subscription_id && ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(r.subscription_status ?? ''); start.textContent = start.disabled ? 'Billing active' : 'Start sponsorship billing'; }
async function loadAdminUsers() { if (!isAdmin)
    return; const data = await invoke('restaurant-admin-users', { action: 'list' }); adminUsers = data.users; renderAdminUsers(); renderRestaurant(); }
function renderAdminRestaurants() { $('admin-restaurants').innerHTML = restaurants.map(r => `<div class="admin-row"><div><strong>${esc(r.name)}</strong><span>$20 CPM · ${esc(r.subscription_status ?? 'no subscription')}</span></div><div class="admin-controls"><label>Users <input class="limit-input admin-limit" data-id="${esc(r.id)}" data-field="max_users" type="number" min="1" value="${r.max_users}" /></label><label>Placements <input class="limit-input admin-limit" data-id="${esc(r.id)}" data-field="max_placements" type="number" min="0" value="${r.max_placements}" /></label><label class="check-row compact-check"><input class="admin-active" data-id="${esc(r.id)}" type="checkbox" ${r.active ? 'checked' : ''}/><span>Active</span></label></div></div>`).join(''); }
function renderAdminUsers() { $('admin-users').innerHTML = adminUsers.map(u => `<div class="admin-row"><div><strong>${esc(u.email)}</strong><span>${u.memberships.filter(m => m.active).map(m => `${esc(restaurants.find(r => r.id === m.restaurant_id)?.name ?? 'Unknown')} (${esc(m.role)})`).join(', ') || 'No active restaurant'}</span></div><div class="actions">${u.memberships.map(m => `<button class="secondary revoke-user" data-user="${esc(u.id)}" data-restaurant="${esc(m.restaurant_id)}">${m.active ? 'Remove access' : 'Restore access'}</button>`).join('')}<button class="danger delete-user" data-user="${esc(u.id)}">Delete account</button></div></div>`).join(''); }
function resetPlacementForm() { editingPlacementId = null; $('placement-form').reset(); $('starts-at').value = localInput(new Date().toISOString()); $('placement-form-title').textContent = 'New placement'; $('save-placement').textContent = 'Create placement'; $('cancel-placement-edit').classList.add('hidden'); }
function fillPlacement(p) { editingPlacementId = p.id; $('campaign-name').value = p.campaign_name ?? ''; $('place-name').value = p.name; $('place-address').value = p.address; $('place-description').value = p.description; $('place-latitude').value = String(p.latitude); $('place-longitude').value = String(p.longitude); $('starts-at').value = localInput(p.starts_at); $('ends-at').value = localInput(p.ends_at); $('placement-active').checked = p.active; $('placement-form-title').textContent = 'Edit placement'; $('save-placement').textContent = 'Save changes'; $('cancel-placement-edit').classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
$('login-form').addEventListener('submit', async (event) => { event.preventDefault(); notice(); const email = $('login-email').value.trim(); const password = $('login-password').value; const { error } = await supabase.auth.signInWithPassword({ email, password }); if (error)
    return notice(error.message, true); await loadAccess().catch((e) => notice(e.message, true)); });
$('reset-password').addEventListener('click', async () => { const email = $('login-email').value.trim(); if (!email)
    return notice('Enter your email first.', true); const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); notice(error ? error.message : 'Password reset email sent.', !!error); });
$('password-form').addEventListener('submit', async (e) => { e.preventDefault(); const { error } = await supabase.auth.updateUser({ password: $('new-password').value }); if (error)
    return notice(error.message, true); recoveringPassword = false; history.replaceState({}, '', location.pathname); await loadAccess(); });
$('sign-out').addEventListener('click', async () => { await supabase.auth.signOut(); location.reload(); });
$('restaurant-switcher').addEventListener('change', async (e) => { selectedRestaurantId = e.target.value; resetPlacementForm(); renderShell(); await loadPlacements(); });
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); button.classList.add('active'); document.querySelectorAll('.tab-panel').forEach(x => x.classList.add('hidden')); $(`tab-${button.dataset.tab}`).classList.remove('hidden'); }));
$('restaurant-form').addEventListener('submit', async (e) => { e.preventDefault(); if (!canEditRestaurant())
    return; const payload = { name: $('restaurant-name').value.trim(), address: $('restaurant-address').value.trim() || null, phone: $('restaurant-phone').value.trim() || null, website: $('restaurant-website').value.trim() || null, description: $('restaurant-description').value.trim() || null, latitude: Number($('restaurant-latitude').value) || null, longitude: Number($('restaurant-longitude').value) || null, updated_at: new Date().toISOString() }; const { error } = await supabase.from('restaurants').update(payload).eq('id', selectedRestaurantId); if (error)
    return notice(error.message, true); notice('Restaurant saved.'); await loadAccess(); });
$('placement-form').addEventListener('submit', async (e) => { e.preventDefault(); if (!canEditRestaurant())
    return; const r = currentRestaurant(); if (!r)
    return; try {
    const wasEditing = !!editingPlacementId;
    const payload = { restaurant_id: r.id, advertiser_name: r.name, campaign_name: $('campaign-name').value.trim() || null, name: $('place-name').value.trim(), address: $('place-address').value.trim(), description: $('place-description').value.trim(), latitude: Number($('place-latitude').value), longitude: Number($('place-longitude').value), starts_at: iso($('starts-at').value), ends_at: $('ends-at').value ? iso($('ends-at').value) : null, active: $('placement-active').checked, updated_at: new Date().toISOString() };
    const result = editingPlacementId ? await supabase.from('sponsored_results').update(payload).eq('id', editingPlacementId) : await supabase.from('sponsored_results').insert(payload);
    if (result.error)
        throw result.error;
    resetPlacementForm();
    notice(wasEditing ? 'Placement saved.' : 'Placement created.');
    await loadPlacements();
}
catch (err) {
    notice(err.message, true);
} });
$('cancel-placement-edit').addEventListener('click', resetPlacementForm);
$('refresh-placements').addEventListener('click', () => loadPlacements().catch((e) => notice(e.message, true)));
$('placements-list').addEventListener('click', async (e) => { const target = e.target; const id = target.dataset.id; if (!id)
    return; const p = placements.find(x => x.id === id); if (!p)
    return; if (target.classList.contains('edit-placement'))
    return fillPlacement(p); if (target.classList.contains('toggle-placement')) {
    const { error } = await supabase.from('sponsored_results').update({ active: !p.active, updated_at: new Date().toISOString() }).eq('id', id);
    if (error)
        return notice(error.message, true);
    await loadPlacements();
} if (target.classList.contains('delete-placement')) {
    if (!confirm('Delete this unused placement?'))
        return;
    const { error } = await supabase.from('sponsored_results').delete().eq('id', id);
    if (error)
        return notice(error.message, true);
    await loadPlacements();
} });
$('start-billing').addEventListener('click', async () => { try {
    const data = await invoke('restaurant-stripe-checkout', { restaurant_id: selectedRestaurantId });
    location.href = data.url;
}
catch (e) {
    notice(e.message, true);
} });
$('manage-billing').addEventListener('click', async () => { try {
    const data = await invoke('restaurant-stripe-portal', { restaurant_id: selectedRestaurantId });
    location.href = data.url;
}
catch (e) {
    notice(e.message, true);
} });
$('create-restaurant-form').addEventListener('submit', async (e) => { e.preventDefault(); const name = $('new-restaurant-name').value.trim(); const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 8)}`; const { error } = await supabase.from('restaurants').insert({ name, slug }); if (error)
    return notice(error.message, true); $('new-restaurant-name').value = ''; await loadAccess(); });
$('invite-user-form').addEventListener('submit', async (e) => { e.preventDefault(); try {
    await invoke('restaurant-admin-users', { action: 'invite', email: $('invite-email').value.trim(), restaurant_id: $('invite-restaurant').value, role: $('invite-role').value });
    $('invite-email').value = '';
    notice('Invitation sent.');
    await loadAdminUsers();
}
catch (err) {
    notice(err.message, true);
} });
$('refresh-admin').addEventListener('click', async () => { await loadAccess(); });
$('admin-restaurants').addEventListener('change', async (e) => { const t = e.target; const id = t.dataset.id; if (!id)
    return; const patch = { action: 'update_restaurant', restaurant_id: id }; if (t.classList.contains('admin-limit'))
    patch[t.dataset.field] = Number(t.value); if (t.classList.contains('admin-active'))
    patch.active = t.checked; try {
    await invoke('restaurant-admin-users', patch);
    notice('Restaurant limits updated.');
    await loadAccess();
}
catch (err) {
    notice(err.message, true);
} });
$('admin-users').addEventListener('click', async (e) => { const t = e.target; try {
    if (t.classList.contains('revoke-user')) {
        const u = adminUsers.find(x => x.id === t.dataset.user);
        const m = u?.memberships.find(x => x.restaurant_id === t.dataset.restaurant);
        await invoke('restaurant-admin-users', { action: 'set_access', user_id: t.dataset.user, restaurant_id: t.dataset.restaurant, active: !m?.active });
        await loadAdminUsers();
    }
    if (t.classList.contains('delete-user')) {
        if (!confirm('Permanently delete this user account?'))
            return;
        await invoke('restaurant-admin-users', { action: 'delete', user_id: t.dataset.user });
        await loadAdminUsers();
    }
}
catch (err) {
    notice(err.message, true);
} });
supabase.auth.onAuthStateChange(() => { if (!recoveringPassword)
    void loadAccess().catch((e) => notice(e.message, true)); });
if (recoveringPassword)
    showOnly('password');
else
    void loadAccess().catch((e) => { showOnly('login'); notice(e.message, true); });
resetPlacementForm();
