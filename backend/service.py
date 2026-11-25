"""Ticket logic: submission with AI triage, decision rules, replies, reopen, admin updates."""
import time
from collections import defaultdict, deque

from ai_service import CATEGORIES, AIError
from duplicates import find_candidates
from repo import now_iso

STATUSES = ("pending_ai", "ai_resolved", "open", "in_progress", "closed")
QUEUES = ("billing", "technical", "account", "general")
SUBJECT_LEN, BODY_LEN, REPLY_LEN = (3, 150), (10, 5000), (1, 5000)

MSG_DUPLICATE = "We're already tracking this issue and will update you here."
MSG_ESCALATED = "Thanks for reaching out. Your ticket is with our {queue} team and an agent will reply here soon."
MSG_REOPENED = "Thanks for letting us know. Your ticket is back with our team and an agent will follow up here."


class ServiceError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class RateLimiter:
    """In-memory sliding window per key. Per process, which is fine for a single Render instance."""

    def __init__(self, limit, window):
        self.limit, self.window, self.hits = limit, window, defaultdict(deque)

    def check(self, key):
        now, q = time.monotonic(), self.hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            raise ServiceError("You're sending tickets too quickly. Please wait a few minutes.", 429)
        q.append(now)


def clean_text(value, name, bounds):
    text = (value or "").strip() if isinstance(value, str) else ""
    lo, hi = bounds
    if len(text) < lo:
        raise ServiceError(f"{name} must be at least {lo} characters.")
    if len(text) > hi:
        raise ServiceError(f"{name} must be at most {hi} characters.")
    return text


def queue_for(category):
    return category if category in QUEUES else "general"


def should_auto_resolve(ai, settings):
    return (ai.get("can_auto_resolve") is True
            and bool(ai.get("suggested_response"))
            and ai.get("confidence", 0) >= settings.auto_resolve_threshold
            and ai.get("priority", 5) < settings.escalation_priority)


def urgency_sorted(tickets):
    """Highest priority first, then oldest first."""
    return sorted(tickets, key=lambda t: (-t.get("priority", 3), t.get("created_at", "")))


def message(author_type, author_id, body):
    return {"author_type": author_type, "author_id": author_id, "body": body, "created_at": now_iso()}


def user_view(t):
    """What a ticket owner may see: no AI internals, priority, or links to other tickets."""
    keys = ("id", "subject", "body", "status", "category", "created_at", "updated_at")
    return {**{k: t.get(k) for k in keys}, "already_tracked": bool(t.get("duplicate_of"))}


def _fallback_ai(settings, error, candidates):
    dup = candidates[0][0]["id"] if candidates and candidates[0][1] >= settings.duplicate_fallback_score else None
    return {"category": "general", "priority": 3, "confidence": 0.0, "can_auto_resolve": False,
            "suggested_response": "", "duplicate_of": dup, "reasoning": "",
            "provider": settings.ai_provider, "model": settings.ai_model, "latency_ms": None, "error": error}


def submit_ticket(repo, ai_service, settings, user, subject, body):
    subject = clean_text(subject, "Subject", SUBJECT_LEN)
    body = clean_text(body, "Description", BODY_LEN)
    candidates = find_candidates(subject, body, repo.recent_tickets(100), settings.duplicate_min_score)

    ts = now_iso()
    tid = repo.create_ticket({
        "user_id": user["uid"], "user_email": user.get("email", ""), "subject": subject, "body": body,
        "category": "general", "priority": 3, "status": "pending_ai", "queue": "general",
        "assigned_to": None, "duplicate_of": None, "duplicate_count": 0, "ai": {},
        "created_at": ts, "updated_at": ts,
    })
    repo.add_message(tid, message("user", user["uid"], body))

    try:
        ai = {**ai_service.analyze_ticket(subject, body, candidates), "error": None}
    except AIError as exc:  # the ticket is never lost because the AI is down
        ai = _fallback_ai(settings, str(exc), candidates)
    ai["overridden"] = False

    fields = {"category": ai["category"], "priority": ai["priority"], "queue": queue_for(ai["category"]),
              "ai": ai, "updated_at": now_iso()}
    if ai["duplicate_of"]:
        fields.update(status="open", duplicate_of=ai["duplicate_of"])
        repo.increment_duplicates(ai["duplicate_of"])
        repo.add_message(tid, message("system", None, MSG_DUPLICATE))
    elif should_auto_resolve(ai, settings):
        fields["status"] = "ai_resolved"
        repo.add_message(tid, message("ai", None, ai["suggested_response"]))
    else:
        fields["status"] = "open"
        repo.add_message(tid, message("system", None, MSG_ESCALATED.format(queue=fields["queue"])))
    repo.update_ticket(tid, fields)
    return repo.get_ticket(tid)


def get_visible_ticket(repo, user, tid):
    """Owners and admins only. Others get 404 so ticket IDs cannot be probed."""
    t = repo.get_ticket(tid)
    if not t or (user["role"] != "admin" and t["user_id"] != user["uid"]):
        raise ServiceError("Ticket not found.", 404)
    return t


def reopen_ticket(repo, user, tid):
    t = get_visible_ticket(repo, user, tid)
    if t["user_id"] != user["uid"]:
        raise ServiceError("Ticket not found.", 404)
    if t["status"] != "ai_resolved":
        raise ServiceError("Only tickets answered by the AI can be reopened.", 409)
    repo.update_ticket(tid, {"status": "open", "priority": min(5, t["priority"] + 1), "updated_at": now_iso()})
    repo.add_message(tid, message("system", None, MSG_REOPENED))
    repo.add_audit({"action": "reopen", "ticket_id": tid, "by": user["uid"], "at": now_iso()})
    return repo.get_ticket(tid)


def reply_ticket(repo, user, tid, body):
    t = get_visible_ticket(repo, user, tid)
    body = clean_text(body, "Reply", REPLY_LEN)
    is_owner = t["user_id"] == user["uid"]
    if is_owner and t["status"] == "closed":
        raise ServiceError("This ticket is closed. Please open a new ticket.", 409)
    fields = {"updated_at": now_iso()}
    if is_owner and t["status"] == "ai_resolved":
        fields["status"] = "open"  # a follow-up question needs a human
    elif not is_owner and t["status"] in ("open", "pending_ai"):
        fields["status"] = "in_progress"
    repo.add_message(tid, message("user" if is_owner else "admin", user["uid"], body))
    repo.update_ticket(tid, fields)
    return repo.get_ticket(tid)


def admin_update(repo, admin, tid, changes):
    t = get_visible_ticket(repo, admin, tid)
    fields = {}
    if "status" in changes:
        if changes["status"] not in STATUSES or changes["status"] == "pending_ai":
            raise ServiceError("Invalid status.")
        fields["status"] = changes["status"]
    if "category" in changes:
        if changes["category"] not in CATEGORIES:
            raise ServiceError("Invalid category.")
        fields["category"] = changes["category"]
    if "priority" in changes:
        p = changes["priority"]
        if not isinstance(p, int) or isinstance(p, bool) or not 1 <= p <= 5:
            raise ServiceError("Priority must be a whole number from 1 to 5.")
        fields["priority"] = p
    if "queue" in changes:
        if changes["queue"] not in QUEUES:
            raise ServiceError("Invalid queue.")
        fields["queue"] = changes["queue"]
    if "assigned_to" in changes:
        uid = changes["assigned_to"] or None
        if uid and (repo.get_user(uid) or {}).get("role") != "admin":
            raise ServiceError("Tickets can only be assigned to support staff.")
        fields["assigned_to"] = uid
    if "duplicate_of" in changes:
        dup = changes["duplicate_of"] or None
        if dup and (dup == tid or not repo.get_ticket(dup)):
            raise ServiceError("The original ticket was not found.")
        fields["duplicate_of"] = dup
        if dup and dup != t.get("duplicate_of"):
            repo.increment_duplicates(dup)

    fields = {k: v for k, v in fields.items() if v != t.get(k)}
    if not fields:
        return t
    ai = t.get("ai") or {}
    if ai and any(k in fields and fields[k] != ai.get(k) for k in ("category", "priority")):
        fields["ai"] = {**ai, "overridden": True}
    fields["updated_at"] = now_iso()
    repo.update_ticket(tid, fields)
    changed = {k: v for k, v in fields.items() if k not in ("ai", "updated_at")}
    repo.add_audit({"action": "ticket_update", "ticket_id": tid, "by": admin["uid"],
                    "before": {k: t.get(k) for k in changed}, "after": changed, "at": now_iso()})
    return repo.get_ticket(tid)


def set_role(repo, admin, uid, role):
    if role not in ("user", "admin"):
        raise ServiceError("Role must be user or admin.")
    target = repo.get_user(uid)
    if not target:
        raise ServiceError("User not found.", 404)
    if uid == admin["uid"] and role != "admin":
        raise ServiceError("You can't remove your own admin role.", 409)
    if target.get("role") != role:
        repo.update_user(uid, {"role": role})
        repo.add_audit({"action": "role_change", "user_id": uid, "by": admin["uid"],
                        "before": target.get("role"), "after": role, "at": now_iso()})
    return {**target, "role": role}
