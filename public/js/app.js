// Shared app code: Firebase init, api() helper, role guard, PWA shell, and small DOM helpers.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { firebaseConfig, API_BASE } from "./config.js";

export const auth = getAuth(initializeApp(firebaseConfig));

/** Resolves once Firebase has restored (or not) the saved session. */
export const authReady = new Promise(resolve => {
  const off = onAuthStateChanged(auth, user => { off(); resolve(user); });
});

export const homeFor = role => (role === "admin" ? "/admin.html" : "/tickets.html");

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
  if (!user) { location.replace("/index.html"); return never; }
  try {
    const me = await api("/api/me");
    if (role && me.role !== role) { location.replace(homeFor(me.role)); return never; }
    return me;
  } catch (err) {
    if (err.status === 0) return { offline: true, email: user.email, role };
    if (err.status === 401) { await signOut(auth); location.replace("/index.html"); return never; }
    throw err;
  }
}

// ---------- PWA shell: service worker, offline banner, install button, header ----------

export function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
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
  if (chip && me?.email) {
    chip.replaceChildren(
      h("span", { class: "avatar", "aria-hidden": "true" }, (me.name || me.email)[0].toUpperCase()),
      h("span", {}, me.email),
    );
  }
  $("#signout-btn")?.addEventListener("click", async () => {
    await signOut(auth);
    location.replace("/index.html");
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

/** Renders a conversation. viewer is "user" or "admin". */
export function renderThread(container, messages, viewer) {
  const label = m => {
    if (m.author_type === "ai") return ["AI assistant", h("span", { class: "ai-tag" }, icon("sparkle", "icon icon-sm"), "AI-generated")];
    if (m.author_type === "system") return ["Support Desk"];
    if (m.author_type === "admin") return [viewer === "admin" ? "Support agent" : "Support team"];
    return [viewer === "admin" ? "Customer" : "You"];
  };
  const cls = m => (m.author_type === "user" ? (viewer === "user" ? "mine" : "agent")
    : m.author_type === "admin" ? (viewer === "admin" ? "mine" : "agent") : m.author_type);
  container.replaceChildren(...messages.map((m, i) =>
    h("div", { class: `msg ${cls(m)}`, style: `animation-delay:${Math.min(i, 8) * 40}ms` },
      h("div", { class: "who" }, ...label(m), h("time", { datetime: m.created_at, title: fullTime(m.created_at) }, `· ${timeAgo(m.created_at)}`)),
      h("div", { class: "bubble" }, m.body))));
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
