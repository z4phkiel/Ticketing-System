// Shared app code: Firebase init, api() helper, role guard, PWA shell, and small DOM helpers.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { firebaseConfig, API_BASE } from "./config.js";
import * as config from "./config.js";

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

/** Resolves once Firebase has restored (or not) the saved session. */
export const authReady = new Promise(resolve => {
  const off = onAuthStateChanged(auth, user => { off(); resolve(user); });
});

export const homeFor = role => (role === "admin" ? "/admin" : "/tickets");

/** Username for display. Emails are never shown in the UI. */
export const displayName = u => u?.name || (u?.email || "").split("@")[0] || "User";

// ---------- DOM helpers (text only, never innerHTML, so user and AI text cannot inject markup) ----------

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function icon(name, cls = "icon") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `/icons/sprite.svg?v=5#${name}`);
  svg.append(use);
  return svg;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function stagger(container) {
  [...container.children].forEach((el, i) => el.style.setProperty("--i", Math.min(i, 10)));
}

// ---------- Labels and formatting ----------

export const STATUS = { pending_ai: "AI reviewing", ai_resolved: "Answered by AI", open: "Open", in_progress: "In progress", closed: "Closed" };
export const CATEGORY = { billing: "Billing", technical: "Technical", account: "Account", general: "General", other: "Other" };
export const PRIORITY = { 5: "Critical", 4: "High", 3: "Medium", 2: "Low", 1: "Minimal" };

export const statusBadge = s => h("span", { class: `badge status-${s}` }, STATUS[s] || s);
export const categoryChip = c => h("span", { class: "badge chip" }, CATEGORY[c] || c);
export const priorityBadge = p => h("span", { class: `badge prio prio-${p}`, title: `Priority ${p} of 5` }, `P${p} ${PRIORITY[p] || ""}`);
export const shortId = id => `#${String(id).slice(0, 6).toUpperCase()}`;

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const units = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"]];
  let [div, name] = units[0];
  for (const u of units) if (s >= u[0]) [div, name] = u;
  const n = Math.floor(s / div);
  return n > 4 && name === "week" ? new Date(iso).toLocaleDateString() : `${n} ${name}${n > 1 ? "s" : ""} ago`;
}

export const fullTime = iso => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

// ---------- Toasts ----------

export function toast(message, type = "info", ms = 4200) {
  let box = $(".toasts");
  if (!box) document.body.append(box = h("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  const names = { success: "check", error: "x", ai: "sparkle", info: "inbox" };
  const el = h("div", { class: `toast ${type}` }, icon(names[type] || "inbox"), h("span", {}, message));
  box.append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 300); // after the --fast exit transition
  }, ms);
}

// ---------- API ----------

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Calls the Flask API with the user's ID token. Shows a hint if a sleeping server is slow to wake. */
export async function api(path, { method = "GET", body, wakeHintAfter = 6000 } = {}) {
  if (!navigator.onLine) throw new ApiError("You're offline. Connect to the internet and try again.", 0);
  const user = auth.currentUser;
  if (!user) throw new ApiError("Please sign in again.", 401);
  const token = await user.getIdToken();
  const hint = setTimeout(() => toast("The server is waking up. The first request can take up to a minute.", "info", 8000), wakeHintAfter);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  } finally {
    clearTimeout(hint);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status);
  return data;
}

/** Fetches binary data (images) from the API with the user's token. */
export async function apiBlob(path) {
  const user = auth.currentUser;
  if (!user || !navigator.onLine) throw new ApiError("Not available offline.", 0);
  const res = await fetch(API_BASE + path, { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
  if (!res.ok) throw new ApiError(`Image request failed (${res.status}).`, res.status);
  return res.blob();
}

/** Sends signed-out visitors to login and wrong roles to their own page. Returns the profile. */
export async function guard(role) {
  const user = await authReady;
  const never = new Promise(() => {});
  if (!user) { location.replace("/"); return never; }
  try {
    const me = await api("/api/me");
    if (role && me.role !== role) { location.replace(homeFor(me.role)); return never; }
    return me;
  } catch (err) {
    if (err.status === 0) return { offline: true, email: user.email, role };
    if (err.status === 401) { await signOut(auth); location.replace("/"); return never; }
    throw err;
  }
}

// ---------- PWA shell: service worker, offline banner, install button, header ----------

export function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    // Pages call this after the sign-in check, which can finish after "load" has already fired
    const register = () => navigator.serviceWorker.register("/sw.js");
    if (document.readyState === "complete") register(); else window.addEventListener("load", register);
    // When an updated service worker takes control, reload once to pick up the new files
    let reloaded = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }
}

/** Keeps [data-needs-online] controls disabled while offline and calls onChange(isOnline). */
export function watchConnection(onChange = () => {}) {
  const banner = h("div", { class: "offline-banner", role: "status", hidden: true },
    icon("wifi-off", "icon icon-sm"), "You're offline. Ticket actions are paused until you reconnect.");
  const header = $(".app-header");
  header ? header.after(banner) : document.body.prepend(banner);
  const apply = () => {
    const online = navigator.onLine;
    banner.hidden = online;
    document.querySelectorAll("[data-needs-online]").forEach(el => {
      el.disabled = !online || el.dataset.busy === "1";
      el.title = online ? "" : "You're offline";
    });
    onChange(online);
  };
  window.addEventListener("online", apply);
  window.addEventListener("offline", apply);
  apply();
  return apply;
}

export function setupInstall() {
  const btn = $("#install-btn");
  if (!btn) return;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferred = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; btn.hidden = false; });
  window.addEventListener("appinstalled", () => { btn.hidden = true; toast("App installed.", "success"); });
  if (isIOS && !standalone) btn.hidden = false;
  btn.addEventListener("click", async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      btn.hidden = true;
    } else if (isIOS) {
      toast("To install: tap Share, then \"Add to Home Screen\".", "info", 7000);
    }
  });
}

/** Round avatar: the profile picture if one is set, otherwise the username's first letter. */
export function avatarEl(u, cls = "") {
  return h("span", { class: `avatar${cls ? ` ${cls}` : ""}`, "aria-hidden": "true", "data-uid": u?.uid },
    u?.avatar ? h("img", { src: u.avatar, alt: "" }) : displayName(u)[0].toUpperCase());
}

// Profile pictures of message authors, kept in memory only: uid -> data URL, or null for none.
const avatars = new Map();

/** Fetches pictures for authors not seen yet, then fills in their avatars inside root. */
async function loadAvatars(messages, root) {
  const need = [...new Set(messages.filter(m => m.author_id && !avatars.has(m.author_id)).map(m => m.author_id))];
  if (need.length) {
    need.forEach(uid => avatars.set(uid, null)); // one request per author, even if several renders overlap
    try {
      const data = await api(`/api/avatars?uids=${encodeURIComponent(need.join(","))}`);
      need.forEach(uid => avatars.set(uid, data.avatars[uid] || null));
    } catch {
      need.forEach(uid => avatars.delete(uid)); // try again on the next render
      return;
    }
  }
  root.querySelectorAll(".avatar[data-uid]").forEach(el => {
    const url = avatars.get(el.dataset.uid);
    if (url && el.querySelector("img")?.getAttribute("src") !== url) el.replaceChildren(h("img", { src: url, alt: "" }));
  });
}

/** Header account button (avatar + username). Call again after the profile changes. */
export function renderUserChip(me) {
  const chip = $("#user-chip");
  if (!chip || !(me?.name || me?.email)) return;
  chip.replaceChildren(avatarEl(me), h("span", { class: "chip-name" }, displayName(me)), icon("chevron", "icon icon-sm chevron"));
  chip.setAttribute("aria-label", `Account menu for ${displayName(me)}`);
}

/** Account dropdown: Profile, Dark mode, Sign out. Rebuilt on each open so it shows current details. */
function setupUserMenu(me) {
  const chip = $("#user-chip"), menu = $("#user-menu");
  if (!chip || !menu) return;
  // Notifications are for ticket owners (AI answers, IT replies); the module loads only when configured
  const pushOffered = me?.role === "user" && !!config.VAPID_KEY;
  let push = null;
  if (pushOffered) {
    import("./push.js").then(m => { push = m; m.refreshPush().catch(() => {}); })
      .catch(() => { push = { failed: true }; });
  }
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')];
  const close = (refocus = false) => {
    menu.classList.remove("open");
    chip.setAttribute("aria-expanded", "false");
    if (refocus) chip.focus();
  };
  const build = () => {
    const theme = h("button", { class: "menu-item", type: "button", role: "menuitemcheckbox",
      "aria-checked": String(document.documentElement.dataset.theme === "dark") },
    icon("moon"), "Dark mode", h("span", { class: "switch", "aria-hidden": "true" }));
    theme.addEventListener("click", () => {
      const dark = theme.getAttribute("aria-checked") !== "true";
      theme.setAttribute("aria-checked", String(dark));
      const apply = () => window.setTheme?.(dark);
      document.startViewTransition ? document.startViewTransition(apply) : apply(); // cross-fade the whole page
    });
    let notes = null;
    if (pushOffered) {
      notes = h("button", { class: "menu-item", type: "button", role: "menuitemcheckbox",
        "aria-checked": String(!!push?.pushEnabled?.()) },
      icon("bell"), "Notifications", h("span", { class: "switch", "aria-hidden": "true" }));
      notes.addEventListener("click", async () => {
        const on = notes.getAttribute("aria-checked") !== "true";
        if (!push?.enablePush) {
          return toast(push?.failed ? "Notifications couldn't load. Check your connection and reload." : "One moment, then try again.", "info", 6000);
        }
        const why = on && await push.unsupportedReason();
        if (why) return toast(why, "info", 9000); // explain instead of failing silently
        notes.disabled = true;
        try {
          await (on ? push.enablePush() : push.disablePush());
          notes.setAttribute("aria-checked", String(on));
          toast(on ? "Notifications are on. A test notification is on its way." : "Notifications are off for this device.", "success");
        } catch (err) {
          toast(err.message || "Couldn't change notifications.", "error");
        } finally {
          notes.disabled = false;
        }
      });
    }
    const signOutItem = h("button", { class: "menu-item", type: "button", role: "menuitem" }, icon("logout"), "Sign out");
    signOutItem.addEventListener("click", () => { close(); confirmSignOut(me); });
    menu.replaceChildren(
      h("div", { class: "menu-head" }, avatarEl(me),
        h("span", {}, h("strong", {}, displayName(me)), h("small", {}, me?.role === "admin" ? "IT staff" : "User"))),
      h("a", { class: "menu-item", role: "menuitem", href: "/profile", "aria-current": location.pathname === "/profile" ? "page" : null },
        icon("user"), "Profile"),
      theme,
      notes,
      h("hr"),
      signOutItem);
  };
  chip.addEventListener("click", () => {
    if (menu.classList.contains("open")) return close();
    build();
    menu.classList.add("open");
    chip.setAttribute("aria-expanded", "true");
    items()[0]?.focus();
  });
  chip.parentElement.addEventListener("keydown", e => { // covers the button and the menu
    if (!menu.classList.contains("open")) return;
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus();
    } else if (e.key === "Tab") close();
  });
  document.addEventListener("pointerdown", e => {
    if (menu.classList.contains("open") && !menu.contains(e.target) && !chip.contains(e.target)) close();
  });
}

/** Header account menu and sign-out. Signing out clears in-memory data by leaving the page. */
export function setupHeader(me) {
  if (me?.uid) avatars.set(me.uid, me.avatar || null); // your own messages use your current picture
  renderUserChip(me);
  setupUserMenu(me);
  $("#signout-btn")?.addEventListener("click", () => confirmSignOut(me));
}

async function confirmSignOut(me) {
  const name = displayName(me);
  const choice = await choose({
    lead: h("div", { class: "sheet-user" }, avatarEl(me),
      h("span", {}, h("strong", {}, name), h("small", {}, me?.role === "admin" ? "IT staff" : "Signed in"))),
    title: "Sign out?",
    text: `You'll need to sign in again to see ${me?.role === "admin" ? "the support queue" : "your tickets"}. Anything you haven't sent will be lost.`,
    buttons: [
      { label: "Sign out", value: "signout", icon: "logout", autofocus: true },
      { label: "Cancel", value: "", cls: "btn-ghost" },
    ],
  });
  if (choice !== "signout") return;
  // a shared device must not keep getting the previous person's notifications
  if (localStorage.getItem("pushToken")) await import("./push.js").then(m => m.disablePush()).catch(() => {});
  await signOut(auth);
  location.replace("/");
}

export function initShell() {
  registerServiceWorker();
  setupInstall();
}

// ---------- Shared ticket UI ----------

/** Close a <dialog> drawer from its close buttons or a backdrop click. */
export function setupDrawer(dialog) {
  dialog.addEventListener("click", e => {
    if (e.target === dialog || e.target.closest("[data-close]")) dialog.close();
  });
}

export function emptyState(iconName, title, text) {
  return h("li", { class: "empty" }, icon(iconName), h("strong", {}, title), text ? h("span", {}, text) : null);
}

// ---------- Conversation (live chat) ----------

/** One chat message. ctx = { myUid, ownerName } where ownerName labels older messages without a name. */
export function messageEl(m, ctx, index = 0) {
  const mine = m.author_id && m.author_id === ctx.myUid;
  let who;
  if (m.author_type === "ai") who = ["AI assistant", h("span", { class: "ai-tag" }, icon("sparkle", "icon icon-sm"), "AI-generated")];
  else if (m.author_type === "system") who = ["Help desk"];
  else if (mine) who = ["You"];
  else if (m.author_type === "admin") who = [m.author_name || "IT support", h("span", { class: "ai-tag staff-tag" }, "IT support")];
  else who = [m.author_name || ctx.ownerName || "User"];
  const cls = mine ? "mine" : ["ai", "system"].includes(m.author_type) ? m.author_type : "agent";
  let bubble;
  if (m.deleted) {
    const text = m.removed_by_staff ? "This message was removed by IT support" : mine ? "You deleted this message" : "This message was deleted";
    bubble = h("div", { class: "bubble deleted" }, icon("trash", "icon icon-sm"), h("span", {}, text));
  } else {
    bubble = h("div", { class: `bubble${m.attachment && !m.body ? " image-only" : ""}` },
      m.attachment ? (ctx.imagesGone ? imageGoneEl() : attachmentEl(m.attachment)) : null,
      m.body ? h("span", { class: "text" }, m.body) : null);
  }
  const del = ctx.onDelete ? h("button", { class: "msg-del", type: "button", "aria-label": "Delete message", title: "Delete" }, icon("trash", "icon icon-sm")) : null;
  del?.addEventListener("click", () => ctx.onDelete(m));
  const person = m.author_id && ["user", "admin"].includes(m.author_type)
    ? avatarEl({ uid: m.author_id, name: who[0] === "You" ? m.author_name || "You" : who[0], avatar: avatars.get(m.author_id) }, "sm") : null;
  return h("div", { class: `msg ${cls}`, "data-id": m.id, style: index ? `animation-delay:${Math.min(index, 8) * 40}ms` : null },
    h("div", { class: "who" }, person, ...who, h("time", { datetime: m.created_at, title: fullTime(m.created_at) }, `· ${timeAgo(m.created_at)}`), del),
    bubble);
}

const imageGoneEl = () => h("span", { class: "image-gone" }, icon("image", "icon icon-sm"), "Image deleted after the ticket was closed");

/** True once a closed ticket's images are past their deletion date. */
export const imagesGone = t => !!(t?.images_deleted || (t?.purge_after && new Date(t.purge_after) <= new Date()));

/** Notice about the 3-day image deletion timer on closed tickets. */
export function imageTimerNotice(t) {
  if (imagesGone(t)) {
    return h("div", { class: "notice warn" }, icon("image"), h("span", {}, "Images in this conversation were deleted 3 days after the ticket was closed."));
  }
  if (t.status === "closed" && t.purge_after) {
    return h("div", { class: "notice warn" }, icon("image"), h("span", {}, `This ticket is closed. Its images will be deleted on ${fullTime(t.purge_after)}.`));
  }
  return null;
}

export function renderThread(container, messages, ctx) {
  container.replaceChildren(...messages.map((m, i) => messageEl(m, ctx, i)));
  loadAvatars(messages, container);
}

const byTime = (a, b) => a.created_at.localeCompare(b.created_at);
const stamp = m => m.updated_at || m.created_at;

/** Merges incoming messages into list. Returns { fresh, changed }: new ones and edited ones (e.g. deleted). */
export function syncMessages(list, incoming) {
  const index = new Map(list.map((m, i) => [m.id, i]));
  const fresh = [], changed = [];
  for (const m of incoming) {
    if (!index.has(m.id)) { fresh.push(m); list.push(m); }
    else if (stamp(list[index.get(m.id)]) !== stamp(m)) { list[index.get(m.id)] = m; changed.push(m); }
  }
  list.sort(byTime);
  return { fresh: fresh.sort(byTime), changed };
}

/** Adds messages not seen before (by id) to list; returns only the new ones, oldest first. */
export const mergeMessages = (list, incoming) => syncMessages(list, incoming).fresh;

/** Newest change in the conversation, used to ask the server only for what changed since. */
export const lastUpdate = list => list.reduce((max, m) => (stamp(m) > max ? stamp(m) : max), "") || undefined;

/** Redraws messages that changed (for example, deleted for everyone by the other person). */
export function replaceMessages(container, messages, ctx) {
  for (const m of messages) container.querySelector(`.msg[data-id="${CSS.escape(m.id)}"]`)?.replaceWith(messageEl(m, ctx));
}

let sheet = null;
/**
 * Confirmation panel: a bottom sheet on phones, a centred card on larger screens.
 * buttons: [{ label, value, cls, icon, id, autofocus }]. Resolves to the chosen value, or null
 * when cancelled (Cancel, Esc, or a click outside).
 */
export function choose({ title, text, lead, buttons }) {
  if (!sheet) {
    sheet = h("dialog", { class: "sheet", "aria-labelledby": "sheet-title", "aria-describedby": "sheet-text" },
      h("form", { method: "dialog", class: "sheet-inner" }));
    sheet.addEventListener("click", e => { if (e.target === sheet) sheet.close(""); });
    document.body.append(sheet);
  }
  sheet.firstChild.replaceChildren(
    lead || null,
    h("h2", { id: "sheet-title" }, title),
    h("p", { class: "muted small", id: "sheet-text" }, text || ""),
    ...buttons.map(b => h("button", { class: `btn btn-block${b.cls ? ` ${b.cls}` : ""}`, value: b.value, id: b.id, autofocus: b.autofocus },
      b.icon ? icon(b.icon) : null, b.label)));
  sheet.returnValue = "";
  sheet.showModal();
  return new Promise(resolve => sheet.addEventListener("close", () => resolve(sheet.returnValue || null), { once: true }));
}

/** Asks "delete for me / for everyone". Resolves to "me", "everyone", or null. */
function chooseDeleteScope(canEveryone) {
  return choose({
    title: "Delete message?",
    text: canEveryone
      ? "\"Delete for everyone\" removes the message and any image for everyone in this conversation. \"Delete for me\" only hides it from your view."
      : "This hides the message from your view only. Others in the conversation will still see it.",
    buttons: [
      ...(canEveryone ? [{ label: "Delete for everyone", value: "everyone", cls: "btn-danger", icon: "trash", id: "delete-everyone" }] : []),
      { label: "Delete for me", value: "me", cls: "btn-secondary" },
      { label: "Cancel", value: "", cls: "btn-ghost" },
    ],
  });
}

/** Delete flow for one message: choose scope, call the API, update the conversation in place. */
export async function deleteMessage(ticketId, m, list, container, ctx) {
  const canEveryone = !m.deleted && (ctx.isStaff || m.author_id === ctx.myUid);
  const scope = await chooseDeleteScope(canEveryone);
  if (!scope) return;
  try {
    const data = await api(`/api/tickets/${encodeURIComponent(ticketId)}/messages/${encodeURIComponent(m.id)}?scope=${scope}`, { method: "DELETE" });
    const el = container.querySelector(`.msg[data-id="${CSS.escape(m.id)}"]`);
    const i = list.findIndex(x => x.id === m.id);
    if (scope === "me") {
      if (i > -1) list.splice(i, 1);
      el?.classList.add("removing");
      setTimeout(() => el?.remove(), 260);
      toast("Message deleted for you.", "success");
    } else {
      if (i > -1) list[i] = data.message;
      el?.replaceWith(messageEl(data.message, ctx));
      toast("Message deleted for everyone.", "success");
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

/** Appends new messages and follows them if the reader was already near the bottom (or forced). */
/**
 * Keeps a chat pinned to its newest content while the reader is at the bottom: while the typing
 * bubble unfolds, and when the phone keyboard opens or closes. Scrolling up stops the following.
 */
export function followBottom(scroller) {
  if (scroller._follow) return;
  scroller._follow = true;
  scroller._atBottom = false;
  scroller.addEventListener("scroll", () => {
    scroller._atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }, { passive: true });
  // The keyboard (or rotating the phone) resizes the chat; stay at the bottom if we were there
  new ResizeObserver(() => { if (scroller._atBottom) scroller.scrollTop = scroller.scrollHeight; }).observe(scroller);
}

const isAtBottom = (s, slack = 80) => s._atBottom || s.scrollHeight - s.scrollTop - s.clientHeight < slack;

/** Holds the scroll at the bottom on every frame while content grows (e.g. an unfolding bubble). */
function pinToBottom(scroller, ms) {
  const end = performance.now() + ms;
  const step = () => {
    scroller.scrollTop = scroller.scrollHeight;
    if (performance.now() < end) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function appendMessages(container, scroller, messages, ctx, force = false) {
  if (!messages.length) return;
  const nearBottom = isAtBottom(scroller, 160);
  container.append(...messages.map(m => messageEl(m, ctx)));
  loadAvatars(messages, container);
  if (nearBottom || force) requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }));
}

/**
 * Live updates for one open ticket: polls for messages newer than the last one.
 * Checks every 3 s while a chat is active (new messages or someone typing), slowing to 6 s when quiet;
 * pauses in hidden tabs. onData(data) returns true when there was activity. Returns { stop, kick }.
 */
export function liveTicket(id, getSince, onData) {
  const FAST = 3000, SLOW = 6000;
  let delay = FAST, timer = null, stopped = false, busy = false;
  const schedule = ms => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, ms); };
  async function tick() {
    if (stopped || busy) return;
    if (document.hidden || !navigator.onLine) return schedule(delay);
    busy = true;
    try {
      const since = getSince();
      const q = since ? `?since=${encodeURIComponent(since)}` : "";
      const data = await api(`/api/tickets/${encodeURIComponent(id)}/messages${q}`, { wakeHintAfter: 60000 });
      if (!stopped) delay = onData(data) ? FAST : Math.min(Math.round(delay * 1.5), SLOW);
    } catch {
      delay = Math.min(delay * 2, 30000);
    } finally {
      busy = false;
    }
    schedule(delay);
  }
  const onVisible = () => { if (!document.hidden) { delay = FAST; schedule(0); } };
  document.addEventListener("visibilitychange", onVisible);
  schedule(FAST);
  return {
    stop() { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); },
    kick() { delay = FAST; schedule(FAST); },
  };
}

/** Returns an input handler that tells the server "I'm typing", at most once every 3 s. */
export function typingNotifier(ticketId) {
  let last = 0;
  return e => {
    if (!e.target.value.trim() || !navigator.onLine || Date.now() - last < 3000) return;
    last = Date.now();
    api(`/api/tickets/${encodeURIComponent(ticketId)}/typing`, { method: "POST", wakeHintAfter: 60000 }).catch(() => {});
  };
}

/** Shows or hides the "… is typing" bubble. typing = [{ name, staff }] from the live update. */
export function renderTyping(el, typing, scroller) {
  if (!el) return;
  const open = typing.length > 0;
  if (open) {
    const names = typing.map(t => t.name);
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    const text = `${who} ${names.length === 1 ? "is" : "are"} typing…`;
    const label = el.querySelector(".typing-text");
    if (label.textContent !== text) label.textContent = text;
  }
  if (open === el.classList.contains("open")) return;
  const follow = scroller && isAtBottom(scroller);
  el.classList.toggle("open", open);
  if (open && follow) pinToBottom(scroller, 700); // the bubble unfolds over ~600 ms
}

/** The typing bubble element (starts folded). */
export function typingBubble() {
  return h("div", { class: "reveal typing", id: "typing", "aria-live": "polite" },
    h("div", { class: "reveal-inner" },
      h("div", { class: "typing-bubble" },
        h("span", { class: "dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
        h("span", { class: "typing-text" }))));
}

// ---------- Image attachments ----------

const MAX_UPLOAD = 880_000; // the server accepts up to 900 KB per image
const images = new Map();   // attachment id -> Promise<object URL>; kept in memory only, never on disk

const toBase64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

/**
 * Shrinks and re-encodes a picked or pasted image as JPEG so it fits the size limit.
 * Re-encoding also drops hidden metadata such as GPS location.
 */
export async function prepareImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  if (file.size > 15e6) throw new Error("That image is over 15 MB. Please choose a smaller one.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That file couldn't be read as an image.");
  }
  try {
    for (const [side, quality] of [[1600, 0.85], [1280, 0.8], [1024, 0.75], [800, 0.7]]) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = Object.assign(document.createElement("canvas"), { width, height });
      const g = canvas.getContext("2d");
      g.fillStyle = "#fff"; // transparent PNGs get a white background in JPEG
      g.fillRect(0, 0, width, height);
      g.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
      if (blob && blob.size <= MAX_UPLOAD) return { blob, width, height, type: "image/jpeg", data: await toBase64(blob) };
    }
  } finally {
    bitmap.close();
  }
  throw new Error("That image is too detailed to send. Try a smaller screenshot.");
}

function loadImage(id) {
  if (!images.has(id)) {
    const p = apiBlob(`/api/attachments/${encodeURIComponent(id)}`).then(b => URL.createObjectURL(b));
    p.catch(() => images.delete(id));
    images.set(id, p);
  }
  return images.get(id);
}

/** After sending, reuse the local preview for your own image instead of downloading it again. */
export function rememberSentImage(messages, myUid, url) {
  const m = [...messages].reverse().find(x => x.attachment && x.author_id === myUid);
  if (m && url && !images.has(m.attachment.id)) images.set(m.attachment.id, Promise.resolve(url));
}

function attachmentEl(att) {
  // width/height reserve the space up front, so the chat doesn't jump when the image arrives
  const img = h("img", { class: "shot", alt: "Attached image", width: att.width, height: att.height, decoding: "async" });
  const frame = h("button", { class: "shot-frame loading", type: "button", "aria-label": "Open image" }, img);
  loadImage(att.id)
    .then(url => { img.src = url; img.addEventListener("load", () => frame.classList.remove("loading"), { once: true }); })
    .catch(() => frame.replaceWith(h("span", { class: "small muted" }, navigator.onLine ? "Image couldn't be loaded." : "Image not available offline.")));
  frame.addEventListener("click", () => img.src && openLightbox(img.src));
  return frame;
}

let lightbox = null;
function openLightbox(src) {
  if (!lightbox) {
    lightbox = h("dialog", { class: "lightbox", "aria-label": "Image" },
      h("img", { alt: "Attached image, enlarged" }),
      h("button", { class: "btn btn-icon lightbox-close", type: "button", "aria-label": "Close" }, icon("x")));
    lightbox.addEventListener("click", () => lightbox.close());
    document.body.append(lightbox);
  }
  lightbox.querySelector("img").src = src;
  lightbox.showModal();
}

/**
 * Attach-image controls for a message box: image button, paste, and drag-and-drop.
 * Returns { button, input, preview, get, clear }.
 */
export function attachControls(textarea, form) {
  let current = null; // { data, type, width, height, url, blob }
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  const button = h("button", { class: "btn btn-ghost btn-icon attach-btn", type: "button", "aria-label": "Attach an image", title: "Attach an image (or paste a screenshot)", "data-needs-online": true }, icon("image"));
  const preview = h("div", { class: "reveal attach-reveal" }, h("div", { class: "reveal-inner" }, h("div", { class: "attach-preview" })));
  const box = preview.querySelector(".attach-preview");

  const clear = () => {
    current = null;
    preview.classList.remove("open");
    preview.inert = true;
  };
  const set = async file => {
    if (!file) return;
    button.disabled = true;
    try {
      const img = await prepareImage(file);
      current = { ...img, url: URL.createObjectURL(img.blob) };
      const remove = h("button", { class: "btn btn-ghost btn-icon", type: "button", "aria-label": "Remove image" }, icon("x"));
      remove.addEventListener("click", () => { clear(); textarea.focus(); });
      box.replaceChildren(h("img", { src: current.url, alt: "" }),
        h("span", { class: "small muted" }, `Image ready · ${Math.max(1, Math.round(img.blob.size / 1024))} KB`), remove);
      preview.inert = false;
      preview.classList.add("open");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      button.disabled = !navigator.onLine;
      input.value = "";
    }
  };
  const firstImage = list => [...(list || [])].find(f => f.type.startsWith("image/"));

  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => set(input.files[0]));
  textarea.addEventListener("paste", e => {
    const file = firstImage(e.clipboardData?.files);
    if (file) { e.preventDefault(); set(file); }
  });
  form.addEventListener("dragover", e => { if ([...e.dataTransfer.items].some(i => i.type.startsWith("image/"))) { e.preventDefault(); form.classList.add("dragging"); } });
  form.addEventListener("dragleave", () => form.classList.remove("dragging"));
  form.addEventListener("drop", e => {
    form.classList.remove("dragging");
    const file = firstImage(e.dataTransfer.files);
    if (file) { e.preventDefault(); set(file); }
  });
  clear();
  return { button, input, preview, get: () => current, clear };
}

// ---------- Live lists and notifications ----------

/**
 * Runs task() repeatedly: every `visible` ms while the tab is shown, every `hidden` ms in the
 * background, and right away when the tab comes back. Errors are ignored (next run retries).
 */
export function poller(task, { visible, hidden }) {
  let timer = null, stopped = false, running = false;
  const schedule = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(run, document.hidden ? hidden : visible); };
  async function run() {
    if (stopped || running) return;
    running = true;
    try { if (navigator.onLine) await task(); } catch (err) { console.warn("Live update failed, retrying:", err); } finally { running = false; }
    schedule();
  }
  const onVisible = () => { if (!document.hidden) { clearTimeout(timer); run(); } };
  document.addEventListener("visibilitychange", onVisible);
  schedule();
  return { stop() { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); } };
}

/** "(3) Support queue" in the tab title while the page is in the background; cleared when it's viewed. */
const baseTitle = document.title;
let unseen = 0;
document.addEventListener("visibilitychange", () => { if (!document.hidden) { unseen = 0; document.title = baseTitle; } });
function bumpTitle() {
  if (!document.hidden) return;
  unseen += 1;
  document.title = `(${unseen}) ${baseTitle}`;
}

/** Clickable notification at the top centre. Stays 10 s (paused while hovered or focused). */
export function notify({ title, body, meta, iconName = "inbox", onClick }) {
  let stack = $(".notify-stack");
  if (!stack) document.body.append(stack = h("div", { class: "notify-stack", role: "region", "aria-label": "Notifications", "aria-live": "polite" }));
  const close = h("button", { class: "notify-close", type: "button", "aria-label": "Dismiss notification" }, icon("x", "icon icon-sm"));
  const card = h("div", { class: "notify" },
    h("button", { class: "notify-main", type: "button" },
      h("span", { class: "notify-icon", "aria-hidden": "true" }, icon(iconName)),
      h("span", { class: "notify-text" },
        h("strong", {}, title),
        body ? h("span", { class: "notify-body" }, body) : null,
        meta ? h("span", { class: "notify-meta" }, meta) : null)),
    close);
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    card.classList.add("leaving");
    setTimeout(() => card.remove(), 300);
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(dismiss, 10000); };
  card.querySelector(".notify-main").addEventListener("click", () => { dismiss(); onClick?.(); });
  close.addEventListener("click", dismiss);
  card.addEventListener("mouseenter", () => clearTimeout(timer));
  card.addEventListener("mouseleave", arm);
  card.addEventListener("focusin", () => clearTimeout(timer));
  card.addEventListener("focusout", arm);
  stack.prepend(card);
  while (stack.children.length > 4) stack.lastElementChild.remove();
  arm();
  bumpTitle();
}

/** Enter adds a new line as usual; Ctrl+Enter (Cmd+Enter on Mac) sends. */
export function ctrlEnterToSend(textarea) {
  textarea.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); textarea.form?.requestSubmit(); }
  });
}

/** Character counter for an input with maxlength. */
export function counter(input, out) {
  const max = Number(input.getAttribute("maxlength"));
  const update = () => {
    out.textContent = `${input.value.length} / ${max}`;
    out.classList.toggle("over", input.value.length >= max);
  };
  input.addEventListener("input", update);
  update();
}

/** Button loading state that keeps the same element (no jump cut). */
export function busy(btn, on, text) {
  if (on) {
    btn._original = [...btn.childNodes];
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), text || btn.textContent.trim());
  } else if (btn._original) {
    btn.dataset.busy = "";
    btn.disabled = !navigator.onLine && btn.hasAttribute("data-needs-online");
    btn.replaceChildren(...btn._original);
  }
}
