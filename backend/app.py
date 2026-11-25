"""Flask JSON API: routes, CORS, and error handlers."""
import logging

from flask import Flask, Response, current_app, g, jsonify, request
from werkzeug.exceptions import HTTPException

import service
from ai_service import AIService
from auth import firebase_verifier, forget_user, role_required
from config import Settings
from repo import make_repo


def create_app(settings=None, repo=None, ai=None, verify_token=None):
    settings = settings or Settings.from_env()
    app = Flask(__name__)
    app.config.update(
        SETTINGS=settings,
        REPO=repo or make_repo(settings),
        AI=ai or AIService(settings),
        VERIFY_TOKEN=verify_token or firebase_verifier(settings.firebase_project_id),
        LIMITER=service.RateLimiter(settings.tickets_per_window, settings.rate_window_seconds),
        REPLY_LIMITER=service.RateLimiter(settings.replies_per_minute, 60,
                                          "You're sending messages too quickly. Please wait a moment."),
        IMAGE_LIMITER=service.RateLimiter(10, 600, "You're sending images too quickly. Please wait a few minutes."),
        TYPING=service.TypingTracker(),
        TYPING_LIMITER=service.RateLimiter(40, 60, "Too many typing updates."),
        MAX_CONTENT_LENGTH=1536 * 1024,  # room for one compressed image (sent as base64) plus text
    )

    @app.after_request
    def cors(res):
        origin = request.headers.get("Origin", "").rstrip("/")
        if origin in settings.frontend_origins:
            res.headers.update({
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
                "Access-Control-Max-Age": "600",
                "Vary": "Origin",
            })
        return res

    @app.errorhandler(service.ServiceError)
    def service_error(exc):
        return jsonify(error=str(exc)), exc.status

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return jsonify(error=exc.description), exc.code

    @app.errorhandler(Exception)
    def server_error(exc):
        logging.exception("Unhandled error")
        return jsonify(error="Something went wrong on our side. Please try again."), 500

    register_routes(app)
    return app


def _repo():
    return current_app.config["REPO"]


def _view(t):
    return t if g.user["role"] == "admin" else service.user_view(t)


def _json():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise service.ServiceError("Expected a JSON body.")
    return data


def register_routes(app):
    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/me")
    @role_required()
    def me():
        u = g.user
        return {"uid": u["uid"], "email": u.get("email"), "name": u.get("name"), "role": u.get("role")}

    @app.post("/api/tickets")
    @role_required("user", "admin")
    def create_ticket():
        data = _json()
        current_app.config["LIMITER"].check(g.user["uid"])
        t = service.submit_ticket(_repo(), current_app.config["AI"], current_app.config["SETTINGS"],
                                  g.user, data.get("subject"), data.get("body"))
        return {"ticket": service.user_view(t), "messages": _repo().list_messages(t["id"])}, 201

    @app.get("/api/tickets")
    @role_required("user")
    def my_tickets():
        items = sorted(_repo().tickets_for_user(g.user["uid"]), key=lambda t: t["created_at"], reverse=True)
        return {"tickets": [service.user_view(t) for t in items]}

    @app.get("/api/tickets/<tid>")
    @role_required("user", "admin")
    def ticket_detail(tid):
        t = service.get_visible_ticket(_repo(), g.user, tid)
        return {"ticket": _view(t), "messages": _repo().list_messages(tid)}

    @app.get("/api/tickets/<tid>/messages")
    @role_required("user", "admin")
    def ticket_messages(tid):
        """Live updates: the ticket plus messages newer than ?since= (polled while a chat is open)."""
        t = service.get_visible_ticket(_repo(), g.user, tid)
        since = service.overlap_since(request.args.get("since"))
        typing = current_app.config["TYPING"].active(tid, g.user["uid"])
        return {"ticket": _view(t), "messages": _repo().list_messages(tid, since), "typing": typing}

    @app.post("/api/tickets/<tid>/typing")
    @role_required("user", "admin")
    def typing(tid):
        """Typing signal, sent at most every few seconds while someone types. Nothing is stored in the database."""
        tracker = current_app.config["TYPING"]
        current_app.config["TYPING_LIMITER"].check(g.user["uid"])
        if not tracker.is_allowed(tid, g.user["uid"]):
            service.get_visible_ticket(_repo(), g.user, tid)  # 404 unless owner or staff
            tracker.allow(tid, g.user["uid"])
        tracker.ping(tid, g.user)
        return {"ok": True}

    @app.post("/api/tickets/<tid>/reply")
    @role_required("user", "admin")
    def reply(tid):
        data = _json()
        current_app.config["REPLY_LIMITER"].check(g.user["uid"])
        if data.get("image") is not None:
            current_app.config["IMAGE_LIMITER"].check(g.user["uid"])
        t = service.reply_ticket(_repo(), g.user, tid, data.get("body"), data.get("image"))
        current_app.config["TYPING"].clear(tid, g.user["uid"])
        return {"ticket": _view(t), "messages": _repo().list_messages(tid)}

    @app.get("/api/attachments/<aid>")
    @role_required("user", "admin")
    def attachment(aid):
        """Image bytes for the ticket owner and staff. no-store: ticket data is not kept on the device."""
        a = service.get_attachment(_repo(), g.user, aid)
        res = Response(bytes(a["data"]), mimetype=a["content_type"])
        res.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                            "Content-Disposition": "inline"})
        return res

    @app.post("/api/tickets/<tid>/reopen")
    @role_required("user", "admin")
    def reopen(tid):
        t = service.reopen_ticket(_repo(), g.user, tid)
        return {"ticket": service.user_view(t), "messages": _repo().list_messages(tid)}

    @app.get("/api/admin/tickets")
    @role_required("admin")
    def admin_tickets():
        items = _repo().recent_tickets(500)
        for key in ("status", "category", "queue"):
            value = request.args.get(key)
            if value:
                items = [t for t in items if t.get(key) == value]
        return {"tickets": service.urgency_sorted(items)}

    @app.patch("/api/admin/tickets/<tid>")
    @role_required("admin")
    def admin_update(tid):
        t = service.admin_update(_repo(), g.user, tid, _json())
        return {"ticket": t, "messages": _repo().list_messages(tid)}

    @app.get("/api/admin/users")
    @role_required("admin")
    def admin_users():
        users = sorted(_repo().list_users(), key=lambda u: (u.get("role") != "admin", u.get("email", "")))
        return {"users": users}

    @app.patch("/api/admin/users/<uid>")
    @role_required("admin")
    def admin_set_role(uid):
        user = service.set_role(_repo(), g.user, uid, _json().get("role"))
        forget_user(uid)  # apply the new role on their next request
        return {"user": user}
