// Shared app code: Firebase init, api() helper, role guard, PWA shell, and small DOM helpers.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { firebaseConfig, API_BASE } from "./config.js";

export const auth = getAuth(initializeApp(firebaseConfig));

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
  use.setAttribute("href", `/icons/sprite.svg#${name}`);
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
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
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

/** Header user chip and sign-out. Clears in-memory data by leaving the page. */
export function setupHeader(me) {
  const chip = $("#user-chip");
  if (chip && (me?.name || me?.email)) {
    const name = displayName(me);
    chip.replaceChildren(
      h("span", { class: "avatar", "aria-hidden": "true" }, name[0].toUpperCase()),
      h("span", {}, name),
    );
  }
  $("#signout-btn")?.addEventListener("click", async () => {
    await signOut(auth);
    location.replace("/");
  });
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
  return h("div", { class: `msg ${cls}`, style: index ? `animation-delay:${Math.min(index, 8) * 40}ms` : null },
    h("div", { class: "who" }, ...who, h("time", { datetime: m.created_at, title: fullTime(m.created_at) }, `· ${timeAgo(m.created_at)}`)),
    h("div", { class: "bubble" }, m.body));
}

export function renderThread(container, messages, ctx) {
  container.replaceChildren(...messages.map((m, i) => messageEl(m, ctx, i)));
}

/** Adds messages not seen before (by id) to list; returns only the new ones, oldest first. */
export function mergeMessages(list, incoming) {
  const seen = new Set(list.map(m => m.id));
  const fresh = incoming.filter(m => !seen.has(m.id));
  list.push(...fresh);
  list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return fresh.sort((a, b) => a.created_at.localeCompare(b.created_at));
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

/** Enter sends, Shift+Enter adds a new line. */
export function enterToSend(textarea) {
  textarea.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); textarea.form?.requestSubmit(); }
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
