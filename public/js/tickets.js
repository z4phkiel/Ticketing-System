// User page: submit a ticket, list own tickets, view a conversation, reply, reopen.
import {
  $, api, busy, categoryChip, counter, emptyState, fullTime, guard, h, icon, initShell, renderThread,
  setupDrawer, setupHeader, shortId, stagger, statusBadge, timeAgo, toast, watchConnection,
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
    h("button", { class: "ticket-item", type: "button", onclick: () => openTicket(t.id) },
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

async function loadTickets() {
  list.setAttribute("aria-busy", "true");
  try {
    tickets = (await api("/api/tickets")).tickets;
    renderList();
  } catch (err) {
    list.setAttribute("aria-busy", "false");
    list.replaceChildren(err.status === 0
      ? emptyState("wifi-off", "You're offline", "Connect to see your tickets.")
      : emptyState("inbox", "Couldn't load your tickets", err.message));
  }
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
    showTicket(data.ticket, data.messages);
    const t = data.ticket;
    if (t.status === "ai_resolved") toast("Answered instantly by our AI assistant.", "ai");
    else if (t.already_tracked) toast("We're already working on this issue.", "info");
    else toast("Ticket sent. An agent will reply soon.", "success");
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    analyzing(false);
    busy(submitBtn, false);
  }
});

// ---------- Conversation drawer ----------

async function openTicket(id) {
  const cached = tickets.find(t => t.id === id);
  if (cached) showTicket(cached, null);
  try {
    const data = await api(`/api/tickets/${encodeURIComponent(id)}`);
    showTicket(data.ticket, data.messages);
  } catch (err) {
    $("#thread").replaceChildren(h("div", { class: "notice error" }, err.message));
  }
}

function showTicket(ticket, messages) {
  const changed = current && current.id === ticket.id && current.status !== ticket.status;
  current = ticket;
  $("#drawer-id").textContent = `${shortId(ticket.id)} · opened ${fullTime(ticket.created_at)}`;
  $("#drawer-title").textContent = ticket.subject;
  const badge = statusBadge(ticket.status);
  if (changed) badge.classList.add("pop");
  $("#drawer-badges").replaceChildren(badge, categoryChip(ticket.category));

  const notices = [];
  if (ticket.status === "ai_resolved") {
    notices.push(h("div", { class: "notice ai" }, icon("sparkle"),
      h("span", {}, "This answer was written by AI from our help articles. If it didn't help, tell us and an agent will take over.")));
  }
  if (ticket.already_tracked) {
    notices.push(h("div", { class: "notice" }, icon("link"),
      h("span", {}, "Others have reported this too. We're already tracking it and will update you here.")));
  }
  $("#drawer-notice").replaceChildren(...notices);

  if (messages) renderThread($("#thread"), messages, "user");
  else $("#thread").replaceChildren(h("div", { class: "skeleton line" }), h("div", { class: "skeleton line" }));
  renderFooter(ticket);
  if (!drawer.open) drawer.showModal();
  requestAnimationFrame(() => { const b = $(".drawer-body", drawer); b.scrollTop = b.scrollHeight; });
}

function renderFooter(ticket) {
  const foot = $("#drawer-foot");
  if (ticket.status === "closed") {
    foot.replaceChildren(h("p", { class: "muted small" }, "This ticket is closed. Submit a new ticket if you need more help."));
    return;
  }
  const input = h("textarea", { class: "input", id: "reply-input", maxlength: "5000", "aria-label": "Your reply", placeholder: "Write a reply…" });
  const send = h("button", { class: "btn", type: "submit", "data-needs-online": true }, icon("send"), "Send");
  const actions = [send];
  if (ticket.status === "ai_resolved") {
    const reopen = h("button", { class: "btn btn-secondary", type: "button", "data-needs-online": true }, "This didn't solve my problem");
    reopen.addEventListener("click", () => act(reopen, `/api/tickets/${ticket.id}/reopen`, null, "Sent to our support team."));
    actions.unshift(reopen);
  }
  const formEl = h("form", { class: "composer" }, input, h("div", { class: "actions" }, ...actions));
  formEl.addEventListener("submit", e => {
    e.preventDefault();
    if (!input.value.trim()) return input.focus();
    act(send, `/api/tickets/${ticket.id}/reply`, { body: input.value.trim() });
  });
  foot.replaceChildren(formEl);
  send.disabled = !navigator.onLine;
}

async function act(btn, path, body, success) {
  busy(btn, true);
  try {
    const data = await api(path, { method: "POST", body });
    upsert(data.ticket);
    showTicket(data.ticket, data.messages);
    if (success) toast(success, "success");
  } catch (err) {
    busy(btn, false);
    toast(err.message, "error");
  }
}

// ---------- Start ----------

const me = await guard("user");
setupHeader(me);
initShell();
setupDrawer(drawer);
counter($("#subject"), $("#subject-count"));
counter($("#body"), $("#body-count"));
$("#greeting").textContent = me.name ? `Hi ${me.name.split(" ")[0]}, how can we help?` : "How can we help?";
$("#refresh-btn").addEventListener("click", loadTickets);
let wasOffline = !navigator.onLine;
watchConnection(online => {
  if (online && wasOffline) loadTickets();
  wasOffline = !online;
});
loadTickets();
