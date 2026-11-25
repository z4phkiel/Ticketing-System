"""Ticket logic: submission with AI triage, decision rules, replies, reopen, admin updates."""
import base64
import binascii
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta

from ai_service import CATEGORIES, AIError
from duplicates import find_candidates
from repo import now_iso

STATUSES = ("pending_ai", "ai_resolved", "open", "in_progress", "closed")
QUEUES = ("billing", "technical", "account", "general")
SUBJECT_LEN, BODY_LEN, REPLY_LEN = (3, 150), (10, 5000), (1, 5000)
MAX_IMAGE_BYTES = 900_000  # stored in one Firestore document (1 MiB limit); the browser compresses first
IMAGE_SIGNATURES = {
    "image/jpeg": lambda b: b[:3] == b"\xff\xd8\xff",
    "image/png": lambda b: b[:8] == b"\x89PNG\r\n\x1a\n",
    "image/webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
}

MSG_DUPLICATE = "We're already tracking this issue and will update you here."
MSG_ESCALATED = "Thanks for reaching out. Your ticket is with our {queue} support team and an IT technician will reply here soon."
MSG_REOPENED = "Thanks for letting us know. Your ticket is back with our team and an IT technician will follow up here."


class ServiceError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class RateLimiter:
    """In-memory sliding window per key. Per process, which is fine for a single Render instance."""

    def __init__(self, limit, window, message="You're sending tickets too quickly. Please wait a few minutes."):
        self.limit, self.window, self.message, self.hits = limit, window, message, defaultdict(deque)
        self.lock = threading.Lock()  # gunicorn runs threads

    def check(self, key):
        with self.lock:
            now, q = time.monotonic(), self.hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                raise ServiceError(self.message, 429)
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


class TypingTracker:
    """Who is typing in which ticket. Kept in memory with a short expiry: no database reads or writes.
    Fine for a single server instance; several instances would need a shared store."""

    TTL = 6.0  # seconds a typing signal stays valid; the browser re-sends every 3 s while typing

    def __init__(self, clock=time.monotonic):
        self.clock, self.lock = clock, threading.Lock()
        self.typing = defaultdict(dict)  # ticket id -> {uid: (expires, name, is_staff)}
        self.allowed = set()             # (ticket id, uid) pairs already permission-checked

    def is_allowed(self, tid, uid):
        return (tid, uid) in self.allowed

    def allow(self, tid, uid):
        with self.lock:
            if len(self.allowed) > 10000:
                self.allowed.clear()
            self.allowed.add((tid, uid))

    def ping(self, tid, user):
        with self.lock:
            self.typing[tid][user["uid"]] = (self.clock() + self.TTL, display_name(user), user.get("role") == "admin")

    def clear(self, tid, uid):
        with self.lock:
            self.typing.get(tid, {}).pop(uid, None)

    def active(self, tid, exclude_uid):
        """People typing in this ticket right now, other than the viewer."""
        now = self.clock()
        with self.lock:
            entries = self.typing.get(tid)
            if not entries:
                return []
            for uid in [u for u, (expires, *_) in entries.items() if expires <= now]:
                del entries[uid]
            if not entries:
                del self.typing[tid]
            return [{"name": name, "staff": staff} for uid, (_, name, staff) in entries.items() if uid != exclude_uid]


def urgency_sorted(tickets):
    """Highest priority first, then oldest first."""
    return sorted(tickets, key=lambda t: (-t.get("priority", 3), t.get("created_at", "")))


def display_name(user):
    """Username shown in the UI; emails are never displayed."""
    return (user.get("name") or user.get("email", "").split("@")[0] or "user")[:40]


def message(author_type, author_id, body, author_name=None):
    return {"author_type": author_type, "author_id": author_id, "author_name": author_name,
            "body": body, "created_at": now_iso()}


def overlap_since(raw):
    """Parse the client's 'since' timestamp and step back 10 s, so a message written a moment
    before a newer one is not skipped. The client de-duplicates by message id."""
    if not raw:
        return None
    try:
        ts = datetime.fromisoformat(raw.strip().replace(" ", "+").replace("Z", "+00:00"))  # "+" may arrive as a space
    except ValueError as exc:
        raise ServiceError("Invalid 'since' timestamp.") from exc
    return (ts - timedelta(seconds=10)).isoformat()


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
        "user_id": user["uid"], "user_email": user.get("email", ""), "user_name": display_name(user),
        "subject": subject, "body": body,
        "category": "general", "priority": 3, "status": "pending_ai", "queue": "general",
        "assigned_to": None, "duplicate_of": None, "duplicate_count": 0, "ai": {},
        "created_at": ts, "updated_at": ts,
    })
    repo.add_message(tid, message("user", user["uid"], body, display_name(user)))

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


def decode_image(image):
    """Validate an uploaded image: allowed type, real image bytes (checked by signature), size limit."""
    if not isinstance(image, dict):
        raise ServiceError("Invalid image.")
    ctype = image.get("type")
    if ctype not in IMAGE_SIGNATURES:
        raise ServiceError("Images must be JPEG, PNG, or WebP.")
    try:
        raw = base64.b64decode(image.get("data") or "", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ServiceError("Invalid image data.") from exc
    if not raw:
        raise ServiceError("Invalid image data.")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ServiceError("That image is too large to send. Try a smaller screenshot.")
    if not IMAGE_SIGNATURES[ctype](raw):
        raise ServiceError("That file isn't a valid image.")
    dims = [image.get(k) for k in ("width", "height")]
    ok = all(isinstance(d, int) and not isinstance(d, bool) and 0 < d <= 10000 for d in dims)
    return raw, ctype, dims if ok else [None, None]


def reply_ticket(repo, user, tid, body, image=None):
    t = get_visible_ticket(repo, user, tid)
    if image is None:
        body = clean_text(body, "Reply", REPLY_LEN)
    else:  # text is optional with an image
        body = body.strip() if isinstance(body, str) else ""
        if len(body) > REPLY_LEN[1]:
            raise ServiceError(f"Reply must be at most {REPLY_LEN[1]} characters.")
    is_owner = t["user_id"] == user["uid"]
    if is_owner and t["status"] == "closed":
        raise ServiceError("This ticket is closed. Please open a new ticket.", 409)
    attachment = None
    if image is not None:
        raw, ctype, (width, height) = decode_image(image)
        aid = repo.add_attachment({"ticket_id": tid, "uploaded_by": user["uid"], "content_type": ctype,
                                   "data": raw, "size": len(raw), "created_at": now_iso()})
        attachment = {"id": aid, "type": ctype, "width": width, "height": height}
    fields = {"updated_at": now_iso()}
    if is_owner and t["status"] == "ai_resolved":
        fields["status"] = "open"  # a follow-up question needs a human
    elif not is_owner and t["status"] in ("open", "pending_ai"):
        fields["status"] = "in_progress"
    msg = message("user" if is_owner else "admin", user["uid"], body, display_name(user))
    if attachment:
        msg["attachment"] = attachment
    repo.add_message(tid, msg)
    repo.update_ticket(tid, fields)
    return repo.get_ticket(tid)


def get_attachment(repo, user, aid):
    """The image, only for people who can see its ticket. Others get 404."""
    a = repo.get_attachment(aid)
    if not a:
        raise ServiceError("Image not found.", 404)
    try:
        get_visible_ticket(repo, user, a["ticket_id"])
    except ServiceError as exc:
        raise ServiceError("Image not found.", 404) from exc
    return a


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
