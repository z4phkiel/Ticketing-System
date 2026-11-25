// Admin page: urgency-sorted queue, filters, ticket detail with AI analysis, reply, field updates, user roles.
import {
  $, CATEGORY, PRIORITY, STATUS, api, appendMessages, attachControls, busy, categoryChip, ctrlEnterToSend, displayName, fullTime, guard,
  followBottom, h, icon, initShell, liveTicket, mergeMessages, priorityBadge, rememberSentImage, renderThread, renderTyping, setupDrawer, setupHeader,
  shortId, stagger, statusBadge, timeAgo, toast, typingBubble, typingNotifier, watchConnection,
} from "./app.js";

const drawer = $("#drawer");
const tbody = $("#queue-body");
const filters = { search: $("#f-search"), status: $("#f-status"), category: $("#f-category"), queue: $("#f-queue") };
const QUEUES = { billing: "Billing", technical: "Technical", account: "Account", general: "General" };
let me = null;
let all = [];
let users = [];
let current = null;

const userName = uid => { const u = users.find(x => x.uid === uid); return u ? displayName(u) : "Unknown"; };
const ownerName = t => t.user_name || (users.some(u => u.uid === t.user_id) ? userName(t.user_id) : "User");

// ---------- Queue ----------

function matches(t) {
  const q = filters.search.value.trim().toLowerCase();
  if (q && ![t.subject, t.body, ownerName(t)].some(v => (v || "").toLowerCase().includes(q))) return false;
  return ["status", "category", "queue"].every(k => !filters[k].value || t[k] === filters[k].value);
}

function renderStats() {
  const count = fn => String(all.filter(fn).length);
  $("#stat-open").textContent = count(t => t.status === "open");
  $("#stat-progress").textContent = count(t => t.status === "in_progress");
  $("#stat-urgent").textContent = count(t => t.priority >= 4 && ["open", "in_progress"].includes(t.status));
  $("#stat-ai").textContent = count(t => t.status === "ai_resolved");
}

function queueRow(t) {
  const tr = h("tr", { tabindex: "0", "aria-label": `${t.subject}, priority ${t.priority}, ${STATUS[t.status]}` },
    h("td", {}, priorityBadge(t.priority)),
    h("td", { class: "subj" },
      h("strong", {}, t.subject),
      h("span", {}, `${ownerName(t)} · ${shortId(t.id)}`,
        t.duplicate_of ? " · duplicate" : "",
        t.duplicate_count ? ` · ${t.duplicate_count} duplicate report${t.duplicate_count > 1 ? "s" : ""}` : "")),
    h("td", {}, categoryChip(t.category)),
    h("td", { class: "hide-sm" }, QUEUES[t.queue] || t.queue),
    h("td", {}, statusBadge(t.status)),
    h("td", { class: "age" }, h("time", { datetime: t.created_at, title: fullTime(t.created_at) }, timeAgo(t.created_at))));
  tr.addEventListener("click", () => openTicket(t.id));
  tr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTicket(t.id); } });
  return tr;
}

function renderQueue(animate = true) {
  renderStats();
  const rows = all.filter(matches);
  tbody.classList.toggle("stagger", animate);
  tbody.replaceChildren(...(rows.length ? rows.map(queueRow)
    : [h("tr", { class: "empty-row" }, h("td", { colspan: "6" },
        h("div", { class: "empty" }, icon("inbox"), h("strong", {}, all.length ? "No tickets match these filters" : "The queue is empty"))))]));
  stagger(tbody);
}

async function loadQueue() {
  tbody.replaceChildren(...[0, 1, 2].map(() => h("tr", {}, h("td", { colspan: "6" }, h("div", { class: "skeleton line" })))));
  try {
    all = (await api("/api/admin/tickets")).tickets;
    renderQueue();
  } catch (err) {
    tbody.replaceChildren(h("tr", {}, h("td", { colspan: "6" },
      h("div", { class: "empty" }, icon(err.status === 0 ? "wifi-off" : "inbox"),
        h("strong", {}, err.status === 0 ? "You're offline" : "Couldn't load the queue"),
        h("span", {}, err.status === 0 ? "Connect to see tickets." : err.message)))));
  }
}

function upsert(ticket) {
  const i = all.findIndex(t => t.id === ticket.id);
  if (i === -1) all.push(ticket); else all[i] = ticket;
  all.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
  renderQueue(false);
}

// ---------- Ticket drawer (live chat) ----------

let chat = null; // { id, messages, live } for the open ticket
let opening = null;
const scroller = () => $("#drawer-body");
const ctxFor = t => ({ myUid: me.uid, ownerName: ownerName(t) });

function stopChat() {
  chat?.live.stop();
  chat = null;
}

async function openTicket(id) {
  stopChat();
  opening = id;
  current = null;
  const cached = all.find(t => t.id === id);
  if (cached) showTicket(cached);
  try {
    const data = await api(`/api/tickets/${encodeURIComponent(id)}`);
    if (opening !== id || !drawer.open) return;
    upsert(data.ticket);
    showTicket(data.ticket);
    startChat(data.ticket, data.messages);
  } catch (err) {
    toast(err.message, "error");
  }
}

function startChat(t, messages) {
  stopChat();
  const list = [];
  mergeMessages(list, messages);
  renderThread($("#thread"), list, ctxFor(t));
  const live = liveTicket(t.id, () => list.at(-1)?.created_at, data => {
    applyLive(data.ticket);
    const fresh = mergeMessages(list, data.messages);
    appendMessages($("#thread"), scroller(), fresh, ctxFor(data.ticket));
    chat.typing = data.typing || [];
    renderTyping($("#typing"), chat.typing, scroller());
    return fresh.length > 0 || chat.typing.length > 0;
  });
  chat = { id: t.id, messages: list, live };
}

/** Live update: refresh badges and the queue row without rebuilding the panel (keeps edits). */
function applyLive(t) {
  const prev = current;
  if (prev && prev.status === t.status && prev.updated_at === t.updated_at) return;
  current = t;
  renderHeader(t, prev);
  upsert(t);
}

function select(id, options, value) {
  return h("select", { class: "input", id },
    ...Object.entries(options).map(([v, label]) => h("option", { value: v, selected: String(v) === String(value ?? "") }, label)));
}

function analysisCard(t) {
  const ai = t.ai || {};
  if (!ai.model && !ai.error) return null;
  const conf = Math.round((ai.confidence || 0) * 100);
  const card = h("section", { class: "card analysis", "aria-label": "AI analysis" },
    h("h3", {}, icon("sparkle"), "AI analysis", ai.overridden ? h("span", { class: "badge chip" }, "Overridden by staff") : null));
  if (ai.error) {
    card.append(h("div", { class: "notice error" }, `AI triage failed, so defaults were used (General, P3). ${ai.error}`));
    return card;
  }
  card.append(
    h("dl", { class: "kv" },
      h("div", {}, h("dt", {}, "Category"), h("dd", {}, CATEGORY[ai.category] || ai.category)),
      h("div", {}, h("dt", {}, "Priority"), h("dd", {}, `P${ai.priority} ${PRIORITY[ai.priority] || ""}`)),
      h("div", {}, h("dt", {}, "Confidence"), h("dd", {}, `${conf}%`,
        h("div", { class: "meter", role: "img", "aria-label": `${conf} percent` }, h("i", { style: `--v:${conf / 100}` })))),
      h("div", {}, h("dt", {}, "Can auto-answer"), h("dd", {}, ai.can_auto_resolve ? "Yes" : "No")),
    ),
    ai.reasoning ? h("p", { class: "small" }, h("strong", {}, "Why: "), ai.reasoning) : null,
    h("p", { class: "muted small" }, `${ai.model}${ai.latency_ms ? ` · ${(ai.latency_ms / 1000).toFixed(1)}s` : ""}`),
  );
  if (ai.suggested_response && t.status !== "ai_resolved") {
    card.append(h("div", { class: "label" }, "Suggested reply (only visible to staff)"), h("div", { class: "draft" }, ai.suggested_response));
  }
  return card;
}

function fieldsForm(t) {
  const admins = Object.fromEntries([["", "Unassigned"], ...users.filter(u => u.role === "admin").map(u => [u.uid, displayName(u)])]);
  const statuses = Object.fromEntries(Object.entries(STATUS).filter(([k]) => k !== "pending_ai" || t.status === "pending_ai"));
  const priorities = Object.fromEntries([5, 4, 3, 2, 1].map(p => [p, `P${p} ${PRIORITY[p]}`]));
  const field = (label, id, control, full) => h("div", { class: `field${full ? " full" : ""}` }, h("label", { for: id }, label), control);
  const save = h("button", { class: "btn", type: "submit", "data-needs-online": true }, "Save changes");
  const form = h("form", { class: "fields" },
    field("Status", "u-status", select("u-status", statuses, t.status)),
    field("Priority", "u-priority", select("u-priority", priorities, t.priority)),
    field("Category", "u-category", select("u-category", CATEGORY, t.category)),
    field("Queue", "u-queue", select("u-queue", QUEUES, t.queue)),
    field("Assignee", "u-assignee", select("u-assignee", admins, t.assigned_to || ""), true),
    field("Duplicate of (ticket ID)", "u-dup", h("input", { class: "input", id: "u-dup", value: t.duplicate_of || "", placeholder: "Leave empty if not a duplicate", autocomplete: "off" }), true),
    h("div", { class: "full", style: "display:flex;justify-content:flex-end" }, save));
  form.addEventListener("submit", e => {
    e.preventDefault();
    const next = {
      status: $("#u-status").value, priority: Number($("#u-priority").value), category: $("#u-category").value,
      queue: $("#u-queue").value, assigned_to: $("#u-assignee").value || null, duplicate_of: $("#u-dup").value.trim() || null,
    };
    const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== (t[k] ?? null)));
    if (!Object.keys(changes).length) return toast("Nothing changed.", "info");
    patch(save, t.id, changes, "Ticket updated.");
  });
  return h("details", { class: "card card-pad section" }, h("summary", {}, "Update ticket"), form);
}

function renderHeader(t, prev) {
  $("#drawer-id").textContent = `${shortId(t.id)} · ${ownerName(t)} · ${fullTime(t.created_at)}`;
  $("#drawer-title").textContent = t.subject;
  const status = statusBadge(t.status);
  if (prev && prev.id === t.id && prev.status !== t.status) status.classList.add("pop");
  $("#drawer-badges").replaceChildren(...[priorityBadge(t.priority), status, categoryChip(t.category),
    t.assigned_to && h("span", { class: "badge chip" }, `Assigned: ${userName(t.assigned_to)}`)].filter(Boolean));
}

/** Builds the whole panel. The conversation is kept in `chat` and redrawn into the new thread element. */
function showTicket(t) {
  const prev = current;
  current = t;
  renderHeader(t, prev);

  const body = $("#drawer-body");
  const parts = [];
  if (t.duplicate_of) {
    const open = h("button", { class: "link-btn", type: "button" }, `Duplicate of ${shortId(t.duplicate_of)}`);
    open.addEventListener("click", () => openTicket(t.duplicate_of));
    const row = h("div", { class: "notice" }, icon("link"), h("div", { style: "flex:1" }, open,
      h("p", { class: "small" }, "The customer was told the issue is already being tracked.")));
    if (t.status !== "closed") {
      const close = h("button", { class: "btn btn-secondary", type: "button", "data-needs-online": true }, "Close as duplicate");
      close.addEventListener("click", () => patch(close, t.id, { status: "closed" }, "Closed as duplicate."));
      row.append(close);
    }
    parts.push(row);
  }
  if (t.duplicate_count) {
    parts.push(h("div", { class: "notice warn" }, icon("layers"),
      h("span", {}, `${t.duplicate_count} other report${t.duplicate_count > 1 ? "s" : ""} linked to this ticket. This may be a wider incident.`)));
  }
  parts.push(analysisCard(t), fieldsForm(t),
    h("section", { "aria-label": "Conversation" }, h("h3", { style: "margin-bottom:12px" }, "Conversation"),
      h("div", { class: "thread", id: "thread" }, h("div", { class: "skeleton line" })), typingBubble()),
    h("details", { class: "small muted" }, h("summary", {}, "Original description"), h("p", { style: "white-space:pre-wrap;margin-top:8px" }, t.body)));
  const keepScroll = drawer.open && prev?.id === t.id ? body.scrollTop : 0;
  body.replaceChildren(...parts.filter(Boolean));
  if (chat && chat.id === t.id) {
    renderThread($("#thread"), chat.messages, ctxFor(t));
    renderTyping($("#typing"), chat.typing || [], null);
  }

  if (!(prev && prev.id === t.id && drawer.open)) renderComposer(t);
  if (!drawer.open) drawer.showModal();
  body.scrollTop = keepScroll;
}

function renderComposer(t) {
  const input = h("textarea", { class: "input", maxlength: "5000", "aria-label": "Message to user", placeholder: "Message the user… (Ctrl+Enter to send)" });
  const send = h("button", { class: "btn", type: "submit", "data-needs-online": true }, icon("send"), "Send");
  const actions = [send];
  const draft = t.ai?.suggested_response;
  if (draft && t.status !== "ai_resolved") {
    const use = h("button", { class: "btn btn-ai", type: "button" }, icon("sparkle"), "Use AI draft");
    use.addEventListener("click", () => { input.value = draft; input.focus(); });
    actions.unshift(use);
  }
  const form = h("form", { class: "composer" });
  const attach = attachControls(input, form);
  form.append(attach.preview, input, h("div", { class: "actions" }, attach.button, attach.input, ...actions));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const img = attach.get();
    if ((!input.value.trim() && !img) || send.disabled) return input.focus();
    const body = { body: input.value.trim() };
    if (img) body.image = { data: img.data, type: img.type, width: img.width, height: img.height };
    busy(send, true);
    try {
      const data = await api(`/api/tickets/${t.id}/reply`, { method: "POST", body, wakeHintAfter: img ? 20000 : 6000 });
      input.value = "";
      if (img) { rememberSentImage(data.messages, me.uid, img.url); attach.clear(); }
      applyLive(data.ticket);
      if (chat) {
        appendMessages($("#thread"), scroller(), mergeMessages(chat.messages, data.messages), ctxFor(data.ticket), true);
        chat.live.kick();
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      busy(send, false);
      input.focus();
    }
  });
  ctrlEnterToSend(input);
  input.addEventListener("input", typingNotifier(t.id));
  $("#drawer-foot").replaceChildren(form);
  send.disabled = !navigator.onLine;
}

async function patch(btn, id, changes, success) {
  busy(btn, true);
  try {
    const data = await api(`/api/admin/tickets/${encodeURIComponent(id)}`, { method: "PATCH", body: changes });
    if (chat) mergeMessages(chat.messages, data.messages);
    upsert(data.ticket);
    showTicket(data.ticket);
    toast(success, "success");
  } catch (err) {
    busy(btn, false);
    toast(err.message, "error");
  }
}

// ---------- Users ----------

async function loadUsers() {
  try {
    users = (await api("/api/admin/users")).users;
  } catch (err) {
    if (err.status !== 0) toast(err.message, "error");
  }
  renderUsers();
}

function renderUsers() {
  const body = $("#users-body");
  body.classList.add("stagger");
  body.replaceChildren(...users.map(u => {
    const self = u.uid === me.uid;
    const role = h("select", { class: "input", "aria-label": `Role for ${displayName(u)}`, disabled: self, "data-needs-online": !self },
      h("option", { value: "user", selected: u.role === "user" }, "User"),
      h("option", { value: "admin", selected: u.role === "admin" }, "Support staff"));
    role.addEventListener("change", async () => {
      try {
        const data = await api(`/api/admin/users/${encodeURIComponent(u.uid)}`, { method: "PATCH", body: { role: role.value } });
        Object.assign(u, data.user);
        toast(`${displayName(u)} is now ${role.value === "admin" ? "support staff" : "a user"}.`, "success");
      } catch (err) {
        role.value = u.role;
        toast(err.message, "error");
      }
    });
    return h("tr", {},
      h("td", { class: "uname" }, displayName(u), self ? h("span", { class: "muted small" }, " (you)") : null),
      h("td", { class: "muted small hide-sm" }, u.created_at ? new Date(u.created_at).toLocaleDateString() : "–"),
      h("td", {}, role));
  }));
  stagger(body);
}

// ---------- Views ----------

function route() {
  const view = location.hash === "#users" ? "users" : "queue";
  $("#queue-view").hidden = view !== "queue";
  $("#users-view").hidden = view !== "users";
  $("#nav-queue").removeAttribute("aria-current");
  $("#nav-users").removeAttribute("aria-current");
  $(`#nav-${view}`).setAttribute("aria-current", "page");
  $(".seg").dataset.view = view;
  $("#view-title").textContent = view === "users" ? "Users and roles" : "Support queue";
  $("#view-sub").textContent = view === "users"
    ? "Promote teammates to support staff. You can't remove your own admin role."
    : "Sorted by urgency: highest priority first, then oldest.";
  if (view === "users") renderUsers();
}

// ---------- Start ----------

me = await guard("admin");
setupHeader(me);
initShell();
setupDrawer(drawer);
followBottom(scroller());
drawer.addEventListener("close", () => { stopChat(); opening = null; });
Object.values(filters).forEach(el => el.addEventListener("input", () => renderQueue(false)));
window.addEventListener("hashchange", route);
let wasOffline = !navigator.onLine;
watchConnection(online => {
  if (online && wasOffline) { loadQueue(); loadUsers(); }
  wasOffline = !online;
});
route();
await loadUsers();
loadQueue();
