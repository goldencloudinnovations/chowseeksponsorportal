// @ts-ignore - browser ESM import is intentionally remote and pinned.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.0?bundle';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';

type Restaurant = { id:string; name:string; slug:string; address:string|null; description:string|null; website:string|null; phone:string|null; latitude:number|null; longitude:number|null; active:boolean; plan_key:string; max_users:number; max_placements:number; feature_flags:Record<string,boolean>; stripe_customer_id:string|null; stripe_subscription_id:string|null; subscription_status:string|null; subscription_price_id:string|null; current_period_end:string|null };
type Membership = { restaurant_id:string; user_id:string; role:'owner'|'editor'|'viewer'; active:boolean };
type Placement = { id:string; restaurant_id:string|null; advertiser_name:string; campaign_name:string|null; name:string; address:string; description:string; latitude:number; longitude:number; active:boolean; starts_at:string; ends_at:string|null; cpm_rate_cents:number; currency:string; impression_count:number; created_at:string };
type AdminUser = { id:string; email:string; created_at:string; last_sign_in_at:string|null; force_password_change:boolean; password_set_by_admin:boolean; memberships:Membership[] };
type PasswordMode = 'recovery'|'forced'|'account';

const FIXED_CPM_CENTS = 2000;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
const $ = <T extends HTMLElement = HTMLElement>(id:string) => document.getElementById(id) as T;
const views = { login:$('login-view'), password:$('password-view'), denied:$('denied-view'), portal:$('portal-view') };
let restaurants:Restaurant[]=[];
let memberships:Membership[]=[];
let placements:Placement[]=[];
let adminUsers:AdminUser[]=[];
let currentUser:any=null;
let selectedRestaurantId='';
let editingPlacementId:string|null=null;
let isAdmin=false;
let adminUsersLoaded=false;
let passwordMode:PasswordMode='account';
let recoveringPassword = location.hash.includes('type=recovery') || new URLSearchParams(location.search).get('type') === 'recovery';

function showOnly(name:keyof typeof views){
  Object.entries(views).forEach(([key,node])=>node.classList.toggle('hidden',key!==name));
  $('sign-out').classList.toggle('hidden',!(name==='portal'||name==='password'));
}
function notice(message='',error=false){ const node=$('notice'); node.textContent=message; node.classList.toggle('hidden',!message); node.classList.toggle('error',error); }
function esc(value:unknown){ return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function currentRestaurant(){ return restaurants.find(r=>r.id===selectedRestaurantId)??null; }
function currentMembership(){ return memberships.find(x=>x.restaurant_id===selectedRestaurantId&&x.active)??null; }
function canEditRestaurant(){ if(isAdmin)return true; const m=currentMembership(); return m?.role==='owner'||m?.role==='editor'; }
function canManageBilling(){ if(isAdmin)return true; return currentMembership()?.role==='owner'; }
function billingActive(r=currentRestaurant()){ return !!r && r.active && ['active','trialing'].includes(r.subscription_status??''); }
function money(cents:number,currency='USD'){ return new Intl.NumberFormat(undefined,{style:'currency',currency:/^[A-Z]{3}$/.test(currency)?currency:'USD'}).format((cents||0)/100); }
function localInput(value?:string|null){ if(!value)return ''; const d=new Date(value); const offset=d.getTimezoneOffset()*60000; return new Date(d.getTime()-offset).toISOString().slice(0,16); }
function iso(value:string){ const d=new Date(value); if(Number.isNaN(d.getTime()))throw new Error('Enter a valid date/time.'); return d.toISOString(); }
function slugify(value:string){ const base=value.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48)||'restaurant'; return `${base}-${crypto.randomUUID().slice(0,6)}`; }
function placementStatus(p:Placement){ const now=Date.now(); if(!p.active)return ['Paused','']; if(!billingActive())return ['Billing inactive','expired']; if(new Date(p.starts_at).getTime()>now)return ['Scheduled','scheduled']; if(p.ends_at&&new Date(p.ends_at).getTime()<=now)return ['Ended','expired']; return ['Serving','active']; }
function spendCents(p:Placement){ return Math.round((Number(p.impression_count||0)*FIXED_CPM_CENTS)/1000); }

async function invoke<T>(name:string,body:Record<string,unknown>={}){
  const {data,error}=await supabase.functions.invoke(name,{body});
  if(error){
    let message=error.message||'Request failed.';
    const response=(error as any)?.context;
    if(response && typeof response.clone==='function'){
      try{
        const payload=await response.clone().json();
        const value=payload?.error;
        if(typeof value==='string')message=value;
        else if(value?.message)message=String(value.message);
      }catch{/* keep the FunctionsHttpError message */}
    }
    throw new Error(message);
  }
  if(data?.error){const value=data.error;throw new Error(typeof value==='string'?value:String(value?.message??'Request failed.'));}
  return data as T;
}

function showPassword(mode:PasswordMode){
  passwordMode=mode;
  const recovery=mode==='recovery';
  const forced=mode==='forced';
  $('password-eyebrow').textContent=forced?'SECURITY REQUIRED':recovery?'PASSWORD RECOVERY':'ACCOUNT SECURITY';
  $('password-title').textContent=forced?'Change your temporary password.':recovery?'Choose a new password.':'Change your password.';
  $('password-copy').textContent=forced?'An administrator created or reset this account with a temporary password. Choose your own password before continuing.':recovery?'Set a new password for your Chowseek restaurant account.':'Enter your current password, then choose a new one.';
  $('current-password-wrap').classList.toggle('hidden',recovery);
  ($('current-password') as HTMLInputElement).required=!recovery;
  $('cancel-password').classList.toggle('hidden',mode!=='account');
  ($('password-form') as HTMLFormElement).reset();
  showOnly('password');
}

async function passwordChangeRequired(){
  const {data,error}=await supabase.rpc('restaurant_password_change_required');
  if(error)throw error;
  return data===true;
}

async function loadAccess(){
  const {data:{user},error}=await supabase.auth.getUser();
  if(error||!user){currentUser=null;showOnly('login');return;}
  currentUser=user;
  $('session-label').textContent=user.email??'';
  if(recoveringPassword){showPassword('recovery');return;}
  if(await passwordChangeRequired()){showPassword('forced');return;}

  const [{data:adminRows,error:adminError},{data:memberRows,error:memberError}]=await Promise.all([
    supabase.from('platform_admins').select('user_id').eq('user_id',user.id),
    supabase.from('restaurant_memberships').select('restaurant_id,user_id,role,active').eq('user_id',user.id).eq('active',true),
  ]);
  if(adminError)throw adminError;
  if(memberError)throw memberError;
  isAdmin=(adminRows?.length??0)>0;
  memberships=(memberRows??[]) as Membership[];

  if(!isAdmin&&!memberships.length){showOnly('denied');return;}
  let restaurantQuery=supabase.from('restaurants').select('*').order('name');
  if(!isAdmin)restaurantQuery=restaurantQuery.eq('id',memberships[0].restaurant_id);
  const {data,error:restaurantsError}=await restaurantQuery;
  if(restaurantsError)throw restaurantsError;
  restaurants=(data??[]) as Restaurant[];
  if(!isAdmin&&!restaurants.length){showOnly('denied');return;}

  selectedRestaurantId=selectedRestaurantId&&restaurants.some(r=>r.id===selectedRestaurantId)?selectedRestaurantId:(restaurants[0]?.id??'');
  showOnly('portal');
  renderShell();
  await loadPlacements();
  if(isAdmin&&!restaurants.length)await openTab('admin');
  else await openTab('restaurant');
}

async function openTab(name:string){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',(x as HTMLElement).dataset.tab===name));
  document.querySelectorAll('.tab-panel').forEach(x=>x.classList.add('hidden'));
  const panel=$(`tab-${name}`); if(panel)panel.classList.remove('hidden');
  if(name==='admin'&&isAdmin&&!adminUsersLoaded){
    try{await loadAdminUsers();}catch(error){notice(error instanceof Error?error.message:String(error),true);}
  }
}

function renderShell(){
  const r=currentRestaurant();
  $('portal-title').textContent=r?.name??'Platform administration';
  $('portal-subtitle').textContent=isAdmin?(r?'Manage this restaurant or open Platform Admin for all accounts.':'Create your first restaurant and account below.'):'Your restaurant profile, sponsored placements, billing, and account security.';
  $('admin-tab-button').classList.toggle('hidden',!isAdmin);
  ['restaurant-tab-button','placements-tab-button','billing-tab-button'].forEach(id=>$(id).classList.toggle('hidden',!r));
  $('restaurant-switcher-wrap').classList.toggle('hidden',!isAdmin||restaurants.length<=1);
  const switcher=$('restaurant-switcher') as HTMLSelectElement;
  switcher.innerHTML=restaurants.map(x=>`<option value="${esc(x.id)}" ${x.id===selectedRestaurantId?'selected':''}>${esc(x.name)}</option>`).join('');
  const userRestaurant=$('create-user-restaurant') as HTMLSelectElement;
  userRestaurant.innerHTML=restaurants.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  ($('create-user-submit') as HTMLButtonElement).disabled=!restaurants.length;
  $('create-user-empty').classList.toggle('hidden',restaurants.length>0);
  renderRestaurant(); renderPlacements(); renderBilling(); renderAccount(); if(isAdmin)renderAdminRestaurants();
}

function renderRestaurant(){
  const r=currentRestaurant(); if(!r)return;
  ($('restaurant-name') as HTMLInputElement).value=r.name;
  ($('restaurant-address') as HTMLInputElement).value=r.address??'';
  ($('restaurant-phone') as HTMLInputElement).value=r.phone??'';
  ($('restaurant-website') as HTMLInputElement).value=r.website??'';
  ($('restaurant-description') as HTMLTextAreaElement).value=r.description??'';
  ($('restaurant-latitude') as HTMLInputElement).value=r.latitude?.toString()??'';
  ($('restaurant-longitude') as HTMLInputElement).value=r.longitude?.toString()??'';
  $('restaurant-status').textContent=r.active?'Active':'Disabled';
  $('restaurant-status').className=`badge ${r.active?'active':'expired'}`;
  const memberCount=isAdmin?(adminUsersLoaded?adminUsers.filter(u=>u.memberships.some(m=>m.restaurant_id===r.id&&m.active)).length:null):1;
  $('stat-plan').textContent='$20 CPM';
  $('stat-users').textContent=`${memberCount===null?'—':memberCount} / ${r.max_users}`;
  $('stat-placements').textContent=`${placements.length} / ${r.max_placements}`;
  Array.from(($('restaurant-form') as HTMLFormElement).elements).forEach(el=>(el as HTMLInputElement).disabled=!canEditRestaurant());
}

async function loadPlacements(){
  if(!selectedRestaurantId){placements=[];renderPlacements();return;}
  const {data,error}=await supabase.from('sponsored_results').select('*').eq('restaurant_id',selectedRestaurantId).order('created_at',{ascending:false});
  if(error)throw error;
  placements=(data??[]) as Placement[];
  renderPlacements(); renderRestaurant();
}

function renderPlacements(){
  let serving=0,impressions=0,spend=0;
  for(const p of placements){if(placementStatus(p)[0]==='Serving')serving++; impressions+=Number(p.impression_count)||0; spend+=spendCents(p);}
  $('stat-serving').textContent=String(serving); $('stat-impressions').textContent=impressions.toLocaleString(); $('stat-spend').textContent=money(spend);
  $('placements-empty').classList.toggle('hidden',placements.length>0);
  $('placements-list').innerHTML=placements.map(p=>{const [status,cls]=placementStatus(p);return `<article class="offer"><div><div class="offer-meta"><span class="badge ${cls}">${status}</span>${p.campaign_name?`<span>Campaign <strong>${esc(p.campaign_name)}</strong></span>`:''}</div><h3>${esc(p.name)}</h3><p class="address-line">${esc(p.address)}</p><p class="offer-note">${esc(p.description)}</p><div class="offer-meta detail-row"><span>${Number(p.impression_count).toLocaleString()} impressions</span><span>${money(spendCents(p))} estimated</span><span>$20 CPM</span></div></div><div class="actions">${canEditRestaurant()?`<button class="secondary edit-placement" data-id="${esc(p.id)}">Edit</button><button class="secondary toggle-placement" data-id="${esc(p.id)}">${p.active?'Pause':'Activate'}</button>${p.impression_count===0?`<button class="danger delete-placement" data-id="${esc(p.id)}">Delete</button>`:''}`:''}</div></article>`;}).join('');
}

function renderBilling(){
  const r=currentRestaurant(); if(!r)return;
  $('billing-status').textContent=r.subscription_status??'not subscribed'; $('billing-plan').textContent='$20 CPM'; $('billing-renewal').textContent=r.current_period_end?new Date(r.current_period_end).toLocaleDateString():'—';
  const manage=$('manage-billing') as HTMLButtonElement; const start=$('start-billing') as HTMLButtonElement;
  manage.disabled=!canManageBilling()||!r.stripe_customer_id;
  const managed=!!r.stripe_subscription_id&&['active','trialing','past_due','unpaid','incomplete','paused'].includes(r.subscription_status??'');
  start.disabled=!canManageBilling()||managed; start.textContent=managed?'Billing active':'Start sponsorship billing';
  $('billing-owner-note').classList.toggle('hidden',canManageBilling());
}

function renderAccount(){
  $('account-email').textContent=currentUser?.email??'—';
  const role=isAdmin?'Platform admin':(currentMembership()?.role??'viewer');
  $('account-role').textContent=role.replace(/^./,x=>x.toUpperCase());
}

async function loadAdminUsers(){
  if(!isAdmin)return;
  const data=await invoke<{users:AdminUser[]}>('restaurant-admin-users',{action:'list'});
  adminUsers=data.users; adminUsersLoaded=true; renderAdminUsers(); renderRestaurant();
}
function renderAdminRestaurants(){
  $('admin-restaurants-empty').classList.toggle('hidden',restaurants.length>0);
  $('admin-restaurants').innerHTML=restaurants.map(r=>`<div class="admin-row"><div><strong>${esc(r.name)}</strong><span>$20 CPM · ${esc(r.subscription_status??'no subscription')}</span></div><div class="admin-controls"><button class="secondary open-restaurant" data-id="${esc(r.id)}">Open</button><label>Users <input class="limit-input admin-limit" data-id="${esc(r.id)}" data-field="max_users" type="number" min="1" value="${r.max_users}" /></label><label>Placements <input class="limit-input admin-limit" data-id="${esc(r.id)}" data-field="max_placements" type="number" min="0" value="${r.max_placements}" /></label><label class="check-row compact-check"><input class="admin-active" data-id="${esc(r.id)}" type="checkbox" ${r.active?'checked':''}/><span>Active</span></label></div></div>`).join('');
}
function renderAdminUsers(){
  $('admin-users-empty').classList.toggle('hidden',adminUsers.length>0);
  $('admin-users').innerHTML=adminUsers.map(u=>{
    const m=u.memberships[0]??null; const restaurant=m?restaurants.find(r=>r.id===m.restaurant_id):null; const isSelf=u.id===currentUser?.id;
    const status=u.force_password_change?'<span class="badge warning">Password change required</span>':'';
    const membership=m?`${esc(restaurant?.name??'Removed restaurant')} · ${esc(m.role)} · ${m.active?'active':'access removed'}`:'Platform administrator';
    const roleControl=m?`<select class="user-role" data-user="${esc(u.id)}" data-restaurant="${esc(m.restaurant_id)}"><option value="owner" ${m.role==='owner'?'selected':''}>Owner</option><option value="editor" ${m.role==='editor'?'selected':''}>Editor</option><option value="viewer" ${m.role==='viewer'?'selected':''}>Viewer</option></select><button class="secondary save-role" data-user="${esc(u.id)}" data-restaurant="${esc(m.restaurant_id)}">Save role</button>`:'';
    const accessControl=m?`<button class="secondary toggle-user-access" data-user="${esc(u.id)}" data-restaurant="${esc(m.restaurant_id)}" data-active="${m.active?'false':'true'}">${m.active?'Remove access':'Restore access'}</button>`:'';
    const reset=m&&!isSelf?`<button class="secondary reset-user-password" data-user="${esc(u.id)}">Set temp password</button>`:'';
    const remove=m&&!isSelf?`<button class="danger delete-user" data-user="${esc(u.id)}">Delete account</button>`:'';
    return `<div class="admin-row"><div><div class="row-title"><strong>${esc(u.email)}</strong>${status}</div><span>${membership}</span></div><div class="actions">${roleControl}${accessControl}${reset}${remove}</div></div>`;
  }).join('');
}

function resetPlacementForm(){ editingPlacementId=null; ($('placement-form') as HTMLFormElement).reset(); ($('starts-at') as HTMLInputElement).value=localInput(new Date().toISOString()); $('placement-form-title').textContent='New placement'; $('save-placement').textContent='Create placement'; $('cancel-placement-edit').classList.add('hidden'); }
function fillPlacement(p:Placement){ editingPlacementId=p.id; ($('campaign-name') as HTMLInputElement).value=p.campaign_name??''; ($('place-name') as HTMLInputElement).value=p.name; ($('place-address') as HTMLInputElement).value=p.address; ($('place-description') as HTMLTextAreaElement).value=p.description; ($('place-latitude') as HTMLInputElement).value=String(p.latitude); ($('place-longitude') as HTMLInputElement).value=String(p.longitude); ($('starts-at') as HTMLInputElement).value=localInput(p.starts_at); ($('ends-at') as HTMLInputElement).value=localInput(p.ends_at); ($('placement-active') as HTMLInputElement).checked=p.active; $('placement-form-title').textContent='Edit placement'; $('save-placement').textContent='Save changes'; $('cancel-placement-edit').classList.remove('hidden'); window.scrollTo({top:0,behavior:'smooth'}); }

$('login-form').addEventListener('submit',async event=>{event.preventDefault();notice();const email=($('login-email') as HTMLInputElement).value.trim();const password=($('login-password') as HTMLInputElement).value;const {error}=await supabase.auth.signInWithPassword({email,password});if(error)return notice(error.message,true);recoveringPassword=false;await loadAccess().catch((e:Error)=>notice(e.message,true));});
$('reset-password').addEventListener('click',async()=>{const email=($('login-email') as HTMLInputElement).value.trim();if(!email)return notice('Enter your email first.',true);const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});notice(error?error.message:'Password reset email sent.',!!error);});
$('password-form').addEventListener('submit',async e=>{e.preventDefault();notice();const next=($('new-password') as HTMLInputElement).value;const confirm=($('confirm-password') as HTMLInputElement).value;if(next.length<12)return notice('Use at least 12 characters.',true);if(next!==confirm)return notice('New passwords do not match.',true);if(passwordMode!=='recovery'){const current=($('current-password') as HTMLInputElement).value;const {data:{user}}=await supabase.auth.getUser();if(!user?.email)return notice('Your session is missing an email address.',true);const {error:verifyError}=await supabase.auth.signInWithPassword({email:user.email,password:current});if(verifyError)return notice('Current password is incorrect.',true);}const {error}=await supabase.auth.updateUser({password:next});if(error)return notice(error.message,true);recoveringPassword=false;history.replaceState({},'',location.pathname);await supabase.auth.signOut();showOnly('login');notice('Password changed. Sign in with your new password.');});
$('cancel-password').addEventListener('click',async()=>{if(passwordMode==='account'){showOnly('portal');await openTab('account');}});
$('change-password').addEventListener('click',()=>showPassword('account'));
$('sign-out').addEventListener('click',async()=>{await supabase.auth.signOut();location.reload();});
$('restaurant-switcher').addEventListener('change',async e=>{selectedRestaurantId=(e.target as HTMLSelectElement).value;resetPlacementForm();renderShell();await loadPlacements();await openTab('restaurant');});
document.querySelectorAll<HTMLButtonElement>('.tab').forEach(button=>button.addEventListener('click',()=>openTab(button.dataset.tab??'restaurant')));

$('restaurant-form').addEventListener('submit',async e=>{e.preventDefault();if(!canEditRestaurant())return;const payload={name:($('restaurant-name') as HTMLInputElement).value.trim(),address:($('restaurant-address') as HTMLInputElement).value.trim()||null,phone:($('restaurant-phone') as HTMLInputElement).value.trim()||null,website:($('restaurant-website') as HTMLInputElement).value.trim()||null,description:($('restaurant-description') as HTMLTextAreaElement).value.trim()||null,latitude:($('restaurant-latitude') as HTMLInputElement).value?Number(($('restaurant-latitude') as HTMLInputElement).value):null,longitude:($('restaurant-longitude') as HTMLInputElement).value?Number(($('restaurant-longitude') as HTMLInputElement).value):null,updated_at:new Date().toISOString()};const {error}=await supabase.from('restaurants').update(payload).eq('id',selectedRestaurantId);if(error)return notice(error.message,true);notice('Restaurant saved.');await loadAccess();});

$('placement-form').addEventListener('submit',async e=>{e.preventDefault();if(!canEditRestaurant())return;const r=currentRestaurant();if(!r)return;try{const wasEditing=!!editingPlacementId;const payload={restaurant_id:r.id,advertiser_name:r.name,campaign_name:($('campaign-name') as HTMLInputElement).value.trim()||null,name:($('place-name') as HTMLInputElement).value.trim(),address:($('place-address') as HTMLInputElement).value.trim(),description:($('place-description') as HTMLTextAreaElement).value.trim(),latitude:Number(($('place-latitude') as HTMLInputElement).value),longitude:Number(($('place-longitude') as HTMLInputElement).value),starts_at:iso(($('starts-at') as HTMLInputElement).value),ends_at:($('ends-at') as HTMLInputElement).value?iso(($('ends-at') as HTMLInputElement).value):null,active:($('placement-active') as HTMLInputElement).checked,updated_at:new Date().toISOString()};const result=editingPlacementId?await supabase.from('sponsored_results').update(payload).eq('id',editingPlacementId):await supabase.from('sponsored_results').insert(payload);if(result.error)throw result.error;notice(wasEditing?'Placement saved.':'Placement created.');resetPlacementForm();await loadPlacements();}catch(error){notice(error instanceof Error?error.message:String(error),true);}});
$('cancel-placement-edit').addEventListener('click',resetPlacementForm);
$('refresh-placements').addEventListener('click',()=>loadPlacements().catch((e:Error)=>notice(e.message,true)));
$('placements-list').addEventListener('click',async event=>{const target=event.target as HTMLElement;const id=(target as HTMLButtonElement).dataset.id;if(!id)return;const p=placements.find(x=>x.id===id);if(!p)return;if(target.classList.contains('edit-placement'))return fillPlacement(p);if(target.classList.contains('toggle-placement')){const {error}=await supabase.from('sponsored_results').update({active:!p.active,updated_at:new Date().toISOString()}).eq('id',id);if(error)return notice(error.message,true);await loadPlacements();}if(target.classList.contains('delete-placement')){if(!confirm(`Delete ${p.name}?`))return;const {error}=await supabase.from('sponsored_results').delete().eq('id',id);if(error)return notice(error.message,true);await loadPlacements();}});

$('start-billing').addEventListener('click',async()=>{const r=currentRestaurant();if(!r||!canManageBilling())return;try{const data=await invoke<{url:string}>('restaurant-stripe-checkout',{restaurant_id:r.id});location.href=data.url;}catch(error){notice(error instanceof Error?error.message:String(error),true);}});
$('manage-billing').addEventListener('click',async()=>{const r=currentRestaurant();if(!r||!canManageBilling())return;try{const data=await invoke<{url:string}>('restaurant-stripe-portal',{restaurant_id:r.id});location.href=data.url;}catch(error){notice(error instanceof Error?error.message:String(error),true);}});

$('create-restaurant-form').addEventListener('submit',async e=>{e.preventDefault();const name=($('new-restaurant-name') as HTMLInputElement).value.trim();if(!name)return;const {error}=await supabase.from('restaurants').insert({name,slug:slugify(name)});if(error)return notice(error.message,true);($('create-restaurant-form') as HTMLFormElement).reset();notice('Restaurant created.');await loadAccess();await openTab('admin');});
$('create-user-form').addEventListener('submit',async e=>{e.preventDefault();try{const email=($('create-user-email') as HTMLInputElement).value.trim();const password=($('create-user-password') as HTMLInputElement).value;const restaurant_id=($('create-user-restaurant') as HTMLSelectElement).value;const role=($('create-user-role') as HTMLSelectElement).value;await invoke('restaurant-admin-users',{action:'create_user',email,password,restaurant_id,role});($('create-user-form') as HTMLFormElement).reset();notice('Account created. The user must change the temporary password at next sign-in.');await loadAdminUsers();}catch(error){notice(error instanceof Error?error.message:String(error),true);}});
$('refresh-admin').addEventListener('click',async()=>{try{await loadAdminUsers();notice('Admin data refreshed.');}catch(error){notice(error instanceof Error?error.message:String(error),true);}});
$('admin-restaurants').addEventListener('click',async e=>{const target=e.target as HTMLElement;if(!target.classList.contains('open-restaurant'))return;const id=(target as HTMLButtonElement).dataset.id;if(!id)return;selectedRestaurantId=id;renderShell();await loadPlacements();await openTab('restaurant');});
$('admin-restaurants').addEventListener('change',async e=>{const target=e.target as HTMLInputElement;const id=target.dataset.id;if(!id)return;try{if(target.classList.contains('admin-limit'))await invoke('restaurant-admin-users',{action:'update_restaurant',restaurant_id:id,[target.dataset.field??'max_users']:Number(target.value)});if(target.classList.contains('admin-active'))await invoke('restaurant-admin-users',{action:'update_restaurant',restaurant_id:id,active:target.checked});notice('Restaurant settings saved.');await loadAccess();await openTab('admin');}catch(error){notice(error instanceof Error?error.message:String(error),true);}});
$('admin-users').addEventListener('click',async e=>{const target=e.target as HTMLButtonElement;const userId=target.dataset.user;if(!userId)return;try{if(target.classList.contains('save-role')){const restaurantId=target.dataset.restaurant??'';const select=document.querySelector<HTMLSelectElement>(`.user-role[data-user="${CSS.escape(userId)}"]`);await invoke('restaurant-admin-users',{action:'set_access',user_id:userId,restaurant_id:restaurantId,active:true,role:select?.value??'viewer'});notice('User role saved.');}else if(target.classList.contains('toggle-user-access')){await invoke('restaurant-admin-users',{action:'set_access',user_id:userId,restaurant_id:target.dataset.restaurant??'',active:target.dataset.active==='true'});notice('User access updated.');}else if(target.classList.contains('reset-user-password')){const password=prompt('Temporary password (12+ characters). The user will be required to change it at next sign-in.');if(!password)return;await invoke('restaurant-admin-users',{action:'reset_password',user_id:userId,password});notice('Temporary password set. Password change will be required at next sign-in.');}else if(target.classList.contains('delete-user')){if(!confirm('Delete this restaurant portal account?'))return;await invoke('restaurant-admin-users',{action:'delete',user_id:userId});notice('Account deleted.');}else return;await loadAdminUsers();}catch(error){notice(error instanceof Error?error.message:String(error),true);}});

supabase.auth.onAuthStateChange((event)=>{if(event==='PASSWORD_RECOVERY'){recoveringPassword=true;queueMicrotask(()=>showPassword('recovery'));}if(event==='SIGNED_OUT'){currentUser=null;queueMicrotask(()=>showOnly('login'));}});

resetPlacementForm();
(async()=>{const {data:{session}}=await supabase.auth.getSession();if(session){await loadAccess().catch((e:Error)=>notice(e.message,true));}else showOnly('login');})();
