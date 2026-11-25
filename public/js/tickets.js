// User page: submit a ticket, list own tickets, view a conversation, reply, reopen.
import {
  $, api, appendMessages, attachControls, busy, categoryChip, counter, displayName, ctrlEnterToSend, emptyState, fullTime, guard, h,
  deleteMessage, followBottom, icon, imageTimerNotice, imagesGone, initShell, lastUpdate, liveTicket, mergeMessages,
  replaceMessages, syncMessages, rememberSentImage, renderThread, renderTyping, setupDrawer, setupHeader, shortId, stagger,
  poller, statusBadge, timeAgo, toast, typingBubble, typingNotifier, watchConnection,
} from "./app.js";

const list = $("#ticket-list");
const form = $("#ticket-form");
const submitBtn = $("#ticket-submit");
const drawer = $("#drawer");
let tickets = [];
let current = null;

const STEPS = ["Reading your ticket…", "Working out the category…", "Checking for similar issues…", "Finding the best answer…"];

function ticketRow(t) {
  return h("li", {},
    h("button", { class: "ticket-item", type: "button", "data-id": t.id, onclick: () => openTicket(t.id) },
      h("div", { class: "row" }, h("span", { class: "subject" }, t.subject), statusBadge(t.status)),
      h("p", { class: "preview" }, t.body),
      h("div", { class: "meta" }, categoryChip(t.category),
        h("time", { datetime: t.created_at, title: fullTime(t.created_at) }, timeAgo(t.created_at)),
        t.already_tracked ? h("span", {}, "· Known issue, being tracked") : null)));
}

function renderList(animate = true) {
  list.setAttribute("aria-busy", "false");
  list.classList.toggle("stagger", animate);
  if (!tickets.length) {
    list.replaceChildren(emptyState("inbox", "No tickets yet", "When you submit a ticket it shows up here."));
    return;
  }
  list.replaceChildren(...tickets.map(ticketRow));
  stagger(list);
}

let listCursor = null; // server time of the last check
let listLive = null;

async function loadTickets() {
  list.setAttribute("aria-busy", "true");
  try {
    const data = await api("/api/tickets");
    tickets = data.tickets;
    listCursor = data.now;
    renderList();
    startListLive();
  } catch (err) {
    list.setAttribute("aria-busy", "false");
    list.replaceChildren(err.status === 0
      ? emptyState("wifi-off", "You're offline", "Connect to see your tickets.")
      : emptyState("inbox", "Couldn't load your tickets", err.message));
  }
}

/** Live list: every 15 s (60 s in a background tab) fetch only my tickets that changed. */
function startListLive() {
  listLive?.stop();
  listLive = poller(async () => {
    if (!listCursor) return;
    const data = await api(`/api/tickets?since=${encodeURIComponent(listCursor)}`, { wakeHintAfter: 60000 });
    listCursor = data.now;
    const changedStatus = [];
    let dirty = false;
    for (const t of data.tickets) {
      const i = tickets.findIndex(x => x.id === t.id);
      if (i === -1) { tickets.unshift(t); dirty = true; }
      else if (tickets[i].updated_at !== t.updated_at) {
        if (tickets[i].status !== t.status) changedStatus.push(t.id);
        tickets[i] = t;
        dirty = true;
      }
    }
    if (!dirty) return;
    tickets.sort((a, b) => b.created_at.localeCompare(a.created_at));
    renderList(false);
    for (const id of changedStatus) list.querySelector(`.ticket-item[data-id="${CSS.escape(id)}"] .badge`)?.classList.add("pop");
  }, { visible: 15000, hidden: 60000 });
}

function upsert(ticket) {
  const i = tickets.findIndex(t => t.id === ticket.id);
  i === -1 ? tickets.unshift(ticket) : (tickets[i] = ticket);
  renderList(i === -1);
}

// ---------- Submit with AI triage ----------

function analyzing(on) {
  const box = $("#analyzing");
  const dots = [...box.querySelectorAll(".steps-dots i")];
  clearInterval(analyzing.timer);
  box.hidden = !on;
  if (!on) return;
  let step = 0;
  const show = () => {
    const el = $("#analyzing-step");
    el.textContent = STEPS[step];
    el.classList.remove("swap");
    void el.offsetWidth; // restart the swap animation
    el.classList.add("swap");
    dots.forEach((d, i) => d.classList.toggle("on", i <= step));
  };
  show();
  analyzing.timer = setInterval(() => { step = Math.min(step + 1, STEPS.length - 1); show(); }, 1500);
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  const subject = $("#subject").value.trim();
  const body = $("#body").value.trim();
  const err = $("#ticket-error");
  $("#subject").removeAttribute("aria-invalid");
  $("#body").removeAttribute("aria-invalid");
  if (subject.length < 3) { $("#subject").setAttribute("aria-invalid", "true"); $("#subject").focus(); return (err.textContent = "Add a subject of at least 3 characters."); }
  if (body.length < 10) { $("#body").setAttribute("aria-invalid", "true"); $("#body").focus(); return (err.textContent = "Describe the problem in at least 10 characters."); }
  err.textContent = "";

  busy(submitBtn, true, "Submitting…");
  analyzing(true);
  try {
    const data = await api("/api/tickets", { method: "POST", body: { subject, body }, wakeHintAfter: 15000 });
    form.reset();
    form.querySelectorAll(".input").forEach(i => i.dispatchEvent(new Event("input")));
    upsert(data.ticket);
    showConversation(data.ticket, data.messages);
    const t = data.ticket;
    if (t.status === "ai_resolved") toast("Answered instantly by our AI assistant.", "ai");
    else if (t.already_tracked) toast("We're already working on this issue.", "info");
    else toast("Ticket sent. An IT technician will reply soon.", "success");
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    analyzing(false);
    busy(submitBtn, false);
  }
});

// ---------- Conversation drawer (live chat) ----------

let chat = null; // { id, messages, live } for the open ticket
let opening = null;
const scroller = () => $(".drawer-body", drawer);
const ctx = () => ({
  myUid: me.uid, ownerName: displayName(me), isStaff: false, imagesGone: imagesGone(current),
  onDelete: m => chat && deleteMessage(chat.id, m, chat.messages, $("#thread"), ctx()),
});

function stopChat() {
  chat?.live.stop();
  chat = null;
  renderTyping($("#typing"), [], null);
}

async function openTicket(id) {
  stopChat();
  opening = id;
  current = null;
  const cached = tickets.find(t => t.id === id);
  if (cached) applyTicket(cached);
  $("#thread").replaceChildren(h("div", { class: "skeleton line" }), h("div", { class: "skeleton line" }));
  if (!drawer.open) drawer.showModal();
  try {
    const data = await api(`/api/tickets/${encodeURIComponent(id)}`);
    if (opening === id && drawer.open) showConversation(data.ticket, data.messages);
  } catch (err) {
    $("#thread").replaceChildren(h("div", { class: "notice error" }, err.message));
  }
}

/** Shows a ticket's full conversation and starts live updates for it. */
function showConversation(ticket, messages) {
  stopChat();
  opening = ticket.id;
  current = null;
  applyTicket(ticket);
  const list = [];
  mergeMessages(list, messages);
  renderThread($("#thread"), list, ctx());
  if (!drawer.open) drawer.showModal();
  requestAnimationFrame(() => { scroller().scrollTop = scroller().scrollHeight; });
  const live = liveTicket(ticket.id, () => lastUpdate(list), data => {
    applyTicket(data.ticket);
    const { fresh, changed } = syncMessages(list, data.messages);
    replaceMessages($("#thread"), changed, ctx());
    appendMessages($("#thread"), scroller(), fresh, ctx());
    const typing = data.typing || [];
    renderTyping($("#typing"), typing, scroller());
    return fresh.length > 0 || changed.length > 0 || typing.length > 0;
  });
  chat = { id: ticket.id, messages: list, live };
}

/** Updates header, notices, list row, and (only when the status changes) the reply box. */
function applyTicket(ticket) {
  const prev = current && current.id === ticket.id ? current : null;
  current = ticket;
  if (!prev || prev.status !== ticket.status || prev.updated_at !== ticket.updated_at) upsert(ticket);
  $("#drawer-id").textContent = `${shortId(ticket.id)} · opened ${fullTime(ticket.created_at)}`;
  $("#drawer-title").textContent = ticket.subject;
  const badge = statusBadge(ticket.status);
  if (prev && prev.status !== ticket.status) badge.classList.add("pop");
  $("#drawer-badges").replaceChildren(badge, categoryChip(ticket.category));

  const notices = [];
  if (ticket.status === "ai_resolved") {
    notices.push(h("div", { class: "notice ai" }, icon("sparkle"),
      h("span", {}, "This answer was written by AI from our IT help articles. If it didn't fix the problem, tell us and a technician will take over.")));
  }
  notices.push(imageTimerNotice(ticket));
  if (ticket.already_tracked) {
    notices.push(h("div", { class: "notice" }, icon("link"),
      h("span", {}, "Others have reported this too. We're already tracking it and will update you here.")));
  }
  $("#drawer-notice").replaceChildren(...notices.filter(Boolean));
  if (!prev || prev.status !== ticket.status) renderFooter(ticket, !!prev);
}

function renderFooter(ticket, keepDraft) {
  const foot = $("#drawer-foot");
  const draft = keepDraft ? $("#reply-input")?.value || "" : "";
  if (ticket.status === "closed") {
    foot.replaceChildren(h("p", { class: "muted small" }, "This ticket is closed. Submit a new ticket if you need more help."));
    return;
  }
  const input = h("textarea", { class: "input", id: "reply-input", maxlength: "5000", "aria-label": "Your message", placeholder: "Type a message… (Ctrl+Enter to send)" });
  input.value = draft;
  const send = h("button", { class: "btn", type: "submit", "data-needs-online": true }, icon("send"), "Send");
  const actions = [send];
  if (ticket.status === "ai_resolved") {
    const reopen = h("button", { class: "btn btn-secondary", type: "button", "data-needs-online": true }, "This didn't solve my problem");
    reopen.addEventListener("click", () => act(reopen, `/api/tickets/${ticket.id}/reopen`, null, "Sent to our IT team."));
    actions.unshift(reopen);
  }
  const formEl = h("form", { class: "composer" });
  const attach = attachControls(input, formEl);
  formEl.append(attach.preview, input, h("div", { class: "actions" }, attach.button, attach.input, ...actions));
  formEl.addEventListener("submit", e => {
    e.preventDefault();
    const img = attach.get();
    if ((!input.value.trim() && !img) || send.disabled) return input.focus();
    const body = { body: input.value.trim() };
    if (img) body.image = { data: img.data, type: img.type, width: img.width, height: img.height };
    act(send, `/api/tickets/${ticket.id}/reply`, body, null, img && { url: img.url, clear: attach.clear });
  });
  ctrlEnterToSend(input);
  input.addEventListener("input", typingNotifier(ticket.id));
  foot.replaceChildren(formEl);
  send.disabled = !navigator.onLine;
}

async function act(btn, path, body, success, sentImage) {
  busy(btn, true);
  try {
    const data = await api(path, { method: "POST", body, wakeHintAfter: sentImage ? 20000 : 6000 });
    if (body && $("#reply-input")) $("#reply-input").value = "";
    if (sentImage) { rememberSentImage(data.messages, me.uid, sentImage.url); sentImage.clear(); }
    applyTicket(data.ticket);
    if (chat) {
      appendMessages($("#thread"), scroller(), mergeMessages(chat.messages, data.messages), ctx(), true);
      chat.live.kick();
    }
    if (success) toast(success, "success");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    busy(btn, false);
    $("#reply-input")?.focus();
  }
}

// ---------- Start ----------

const me = await guard("user");
setupHeader(me);
initShell();
setupDrawer(drawer);
followBottom(scroller());
counter($("#subject"), $("#subject-count"));
counter($("#body"), $("#body-count"));
$("#greeting").textContent = `Hi ${displayName(me)}, how can we help?`;
drawer.addEventListener("close", () => { stopChat(); opening = null; });
$("#thread").after(typingBubble());
$("#refresh-btn").addEventListener("click", loadTickets);
let wasOffline = !navigator.onLine;
watchConnection(online => {
  if (online && wasOffline) loadTickets();
  wasOffline = !online;
});
loadTickets();
