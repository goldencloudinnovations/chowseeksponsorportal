import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0?bundle";

const SUPABASE_URL = "https://ugbindlzyqaktejbxalk.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_NoOtqlUoD09Ikhmsmd3ShA_xI9IYmlJ";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

const $ = (id) => document.getElementById(id);
const views = {
  login: $("login-view"),
  password: $("password-view"),
  denied: $("denied-view"),
  portal: $("portal-view"),
};

let currentSponsors = [];
let editingSponsorId = null;
let recoveringPassword = window.location.hash.includes("type=recovery") ||
  new URLSearchParams(window.location.search).get("type") === "recovery";
let passwordRecovery = new URLSearchParams(window.location.hash.slice(1)).get("type") === "recovery";

function showOnly(name) {
  Object.entries(views).forEach(([key, node]) => node.classList.toggle("hidden", key !== name));
  $("sign-out").classList.toggle("hidden", name !== "portal");
}

function setNotice(message, error = false) {
  const node = $("notice");
  if (!message) {
    node.classList.add("hidden");
    node.textContent = "";
    return;
  }
  node.textContent = message;
  node.classList.remove("hidden");
  node.classList.toggle("error", error);
}

function setBusy(button, busy, busyLabel = "Working…") {
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function localDateTimeInput(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function isoToLocalDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : localDateTimeInput(date);
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Enter a valid date and time.");
  return date.toISOString();
}

function formatDate(value) {
  if (!value) return "No end date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function parseNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`);
  return number;
}

function centsFromDollars(value) {
  const dollars = parseNumber(value, "CPM rate");
  if (dollars < 0) throw new Error("CPM rate cannot be negative.");
  return Math.round((dollars + Number.EPSILON) * 100);
}

function formatMoney(cents, currency = "USD") {
  const safeCurrency = /^[A-Z]{3}$/.test(currency || "") ? currency : "USD";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: safeCurrency,
    minimumFractionDigits: 2,
  }).format((Number(cents) || 0) / 100);
}

function calculatedSpendCents(sponsor) {
  return Math.round(((Number(sponsor.impression_count) || 0) * (Number(sponsor.cpm_rate_cents) || 0)) / 1000);
}

function placementStatus(sponsor) {
  const now = Date.now();
  const startsAt = new Date(sponsor.starts_at).getTime();
  const endsAt = sponsor.ends_at ? new Date(sponsor.ends_at).getTime() : null;
  if (!sponsor.active) return ["Paused", ""];
  if (Number.isFinite(startsAt) && startsAt > now) return ["Scheduled", "scheduled"];
  if (endsAt && endsAt <= now) return ["Ended", "expired"];
  return ["Serving", "active"];
}

async function isPortalAdmin() {
  const { data, error } = await supabase.rpc("is_chowseek_portal_admin");
  if (error) throw error;
  return data === true;
}

async function routeAuthenticatedUser() {
  if (recoveringPassword || passwordRecovery) {
    showOnly("password");
    return;
  }

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    showOnly("login");
    return;
  }

  try {
    if (!(await isPortalAdmin())) {
      showOnly("denied");
      setNotice("This account is signed in, but it is not authorized for the Chowseek sponsorship portal.", true);
      return;
    }
    showOnly("portal");
    setNotice("");
    await loadPortal();
  } catch (err) {
    showOnly("denied");
    setNotice(`Could not verify portal access: ${err.message}`, true);
  }
}

async function loadPortal() {
  const { data, error } = await supabase
    .from("sponsored_results")
    .select("id,advertiser_name,campaign_name,name,address,description,latitude,longitude,active,starts_at,ends_at,cpm_rate_cents,currency,impression_count,created_at,updated_at")
    .order("created_at", { ascending: false });

  if (error) throw error;
  currentSponsors = data ?? [];
  renderPortal();
}

function renderPortal() {
  let serving = 0;
  let scheduled = 0;
  let impressions = 0;
  let spendCents = 0;

  for (const sponsor of currentSponsors) {
    const [status] = placementStatus(sponsor);
    if (status === "Serving") serving += 1;
    if (status === "Scheduled") scheduled += 1;
    impressions += Number(sponsor.impression_count) || 0;
    spendCents += calculatedSpendCents(sponsor);
  }

  $("stat-serving").textContent = serving.toLocaleString();
  $("stat-scheduled").textContent = scheduled.toLocaleString();
  $("stat-impressions").textContent = impressions.toLocaleString();
  $("stat-spend").textContent = formatMoney(spendCents, "USD");

  $("sponsors-empty").classList.toggle("hidden", currentSponsors.length !== 0);
  $("sponsors-list").innerHTML = currentSponsors.map((sponsor) => {
    const [status, statusClass] = placementStatus(sponsor);
    const impressionsForSponsor = Number(sponsor.impression_count) || 0;
    const spend = formatMoney(calculatedSpendCents(sponsor), sponsor.currency);
    const campaign = sponsor.campaign_name ? `<span>Campaign: <strong>${html(sponsor.campaign_name)}</strong></span>` : "";
    const deleteDisabled = impressionsForSponsor > 0
      ? 'disabled title="Placements with recorded impressions are retained for reporting history"'
      : "";

    return `<article class="offer" data-sponsor-id="${html(sponsor.id)}">
      <div>
        <div class="offer-meta">
          <span class="badge ${statusClass}">${html(status)}</span>
          <span>Sponsor: <strong>${html(sponsor.advertiser_name)}</strong></span>
          ${campaign}
        </div>
        <h3>${html(sponsor.name)}</h3>
        <p class="address-line">${html(sponsor.address)}</p>
        <p class="offer-note">${html(sponsor.description)}</p>
        <div class="offer-meta detail-row">
          <span>${html(Number(sponsor.latitude).toFixed(5))}, ${html(Number(sponsor.longitude).toFixed(5))}</span>
          <span>${html(formatMoney(sponsor.cpm_rate_cents, sponsor.currency))} CPM</span>
          <span>${impressionsForSponsor.toLocaleString()} impressions</span>
          <span>${html(spend)} estimated spend</span>
        </div>
        <div class="offer-meta detail-row">
          <span>Starts ${html(formatDate(sponsor.starts_at))}</span>
          <span>Ends ${html(formatDate(sponsor.ends_at))}</span>
        </div>
      </div>
      <div class="actions">
        <button class="secondary edit-sponsor" type="button" data-id="${html(sponsor.id)}">Edit</button>
        <button class="secondary toggle-sponsor" type="button" data-id="${html(sponsor.id)}" data-active="${sponsor.active}">${sponsor.active ? "Pause" : "Activate"}</button>
        <button class="danger delete-sponsor" type="button" data-id="${html(sponsor.id)}" ${deleteDisabled}>Delete</button>
      </div>
    </article>`;
  }).join("");
}

function resetSponsorForm() {
  editingSponsorId = null;
  $("sponsor-form").reset();
  $("starts-at").value = localDateTimeInput();
  $("currency").value = "USD";
  $("active").checked = false;
  $("form-eyebrow").textContent = "NEW PLACEMENT";
  $("form-title").textContent = "Add a sponsored result";
  $("save-sponsor").textContent = "Create placement";
  $("save-sponsor").dataset.defaultLabel = "Create placement";
  $("cancel-edit").classList.add("hidden");
}

function beginEdit(id) {
  const sponsor = currentSponsors.find((row) => row.id === id);
  if (!sponsor) return;

  editingSponsorId = id;
  $("advertiser-name").value = sponsor.advertiser_name ?? "";
  $("campaign-name").value = sponsor.campaign_name ?? "";
  $("place-name").value = sponsor.name ?? "";
  $("address").value = sponsor.address ?? "";
  $("description").value = sponsor.description ?? "";
  $("latitude").value = sponsor.latitude ?? "";
  $("longitude").value = sponsor.longitude ?? "";
  $("starts-at").value = isoToLocalDateTimeInput(sponsor.starts_at);
  $("ends-at").value = isoToLocalDateTimeInput(sponsor.ends_at);
  $("cpm-rate").value = ((Number(sponsor.cpm_rate_cents) || 0) / 100).toFixed(2);
  $("currency").value = (sponsor.currency || "USD").toUpperCase();
  $("active").checked = Boolean(sponsor.active);
  $("form-eyebrow").textContent = "EDIT PLACEMENT";
  $("form-title").textContent = sponsor.name;
  $("save-sponsor").textContent = "Save changes";
  $("save-sponsor").dataset.defaultLabel = "Save changes";
  $("cancel-edit").classList.remove("hidden");
  $("advertiser-name").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function sponsorPayloadFromForm() {
  const latitude = parseNumber($("latitude").value, "Latitude");
  const longitude = parseNumber($("longitude").value, "Longitude");
  if (latitude < -90 || latitude > 90) throw new Error("Latitude must be between -90 and 90.");
  if (longitude < -180 || longitude > 180) throw new Error("Longitude must be between -180 and 180.");

  const startsAt = toIsoOrNull($("starts-at").value);
  const endsAt = toIsoOrNull($("ends-at").value);
  if (endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error("Ends at must be later than Starts at.");
  }

  const currency = $("currency").value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter code such as USD.");

  return {
    advertiser_name: $("advertiser-name").value.trim(),
    campaign_name: $("campaign-name").value.trim() || null,
    name: $("place-name").value.trim(),
    address: $("address").value.trim(),
    description: $("description").value.trim(),
    latitude,
    longitude,
    active: $("active").checked,
    starts_at: startsAt,
    ends_at: endsAt,
    cpm_rate_cents: centsFromDollars($("cpm-rate").value),
    currency,
    updated_at: new Date().toISOString(),
  };
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setNotice("");
  const button = $("login-submit");
  setBusy(button, true, "Signing in…");
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await routeAuthenticatedUser();
  } catch (err) {
    setNotice(err.message || "Sign-in failed.", true);
  } finally {
    setBusy(button, false);
  }
});

$("forgot-password").addEventListener("click", async () => {
  const email = $("login-email").value.trim();
  if (!email) {
    setNotice("Enter the admin email first, then request a password reset.", true);
    return;
  }
  try {
    const redirectTo = new URL("./", window.location.href).href;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
    setNotice("If that account exists, Supabase sent a password-reset link. The deployed portal URL must be in Supabase Auth Redirect URLs.");
  } catch (err) {
    setNotice(err.message || "Could not request a password reset.", true);
  }
});

$("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("new-password").value;
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    passwordRecovery = false;
    recoveringPassword = false;
    history.replaceState(null, "", new URL("./", window.location.href).pathname);
    setNotice("Password updated.");
    await routeAuthenticatedUser();
  } catch (err) {
    setNotice(err.message || "Could not update the password.", true);
  }
});

$("sponsor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("save-sponsor");
  setBusy(button, true, editingSponsorId ? "Saving…" : "Creating…");
  setNotice("");

  try {
    const payload = sponsorPayloadFromForm();
    let error;

    if (editingSponsorId) {
      ({ error } = await supabase.from("sponsored_results").update(payload).eq("id", editingSponsorId));
    } else {
      ({ error } = await supabase.from("sponsored_results").insert(payload));
    }

    if (error) throw error;
    const message = editingSponsorId ? "Sponsored placement updated." : "Sponsored placement created.";
    resetSponsorForm();
    setNotice(message);
    await loadPortal();
  } catch (err) {
    setNotice(err.message || "Could not save sponsored placement.", true);
  } finally {
    setBusy(button, false);
  }
});

$("cancel-edit").addEventListener("click", () => {
  resetSponsorForm();
  setNotice("Edit cancelled.");
});

$("sponsors-list").addEventListener("click", async (event) => {
  const edit = event.target.closest(".edit-sponsor");
  const toggle = event.target.closest(".toggle-sponsor");
  const del = event.target.closest(".delete-sponsor");
  if (!edit && !toggle && !del) return;

  if (edit) {
    beginEdit(edit.dataset.id);
    return;
  }

  setNotice("");
  try {
    if (toggle) {
      toggle.disabled = true;
      const id = toggle.dataset.id;
      const next = toggle.dataset.active !== "true";
      const { error } = await supabase
        .from("sponsored_results")
        .update({ active: next, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      setNotice(next ? "Placement activated. It will serve when its schedule is current." : "Placement paused.");
    } else if (del) {
      const id = del.dataset.id;
      if (!window.confirm("Delete this placement? This is only allowed before it has recorded impressions.")) return;
      del.disabled = true;
      const { error } = await supabase.from("sponsored_results").delete().eq("id", id);
      if (error) throw error;
      if (editingSponsorId === id) resetSponsorForm();
      setNotice("Placement deleted.");
    }
    await loadPortal();
  } catch (err) {
    setNotice(err.message || "Could not update sponsored placement.", true);
    await loadPortal();
  }
});

$("refresh").addEventListener("click", async () => {
  try {
    await loadPortal();
    setNotice("Sponsorship data refreshed.");
  } catch (err) {
    setNotice(err.message || "Refresh failed.", true);
  }
});

async function signOut() {
  await supabase.auth.signOut();
  currentSponsors = [];
  editingSponsorId = null;
  $("login-password").value = "";
  $("new-password").value = "";
  window.location.reload();
}

$("sign-out").addEventListener("click", signOut);
$("denied-sign-out").addEventListener("click", signOut);

supabase.auth.onAuthStateChange(async (event) => {
  if (event === "PASSWORD_RECOVERY") {
    passwordRecovery = true;
    showOnly("password");
    setNotice("Choose a new admin password.");
  }
});

resetSponsorForm();
await routeAuthenticatedUser();
