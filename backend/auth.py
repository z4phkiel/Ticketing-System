"""Firebase ID token verification and role checks. Roles come only from the repo."""
import time
from functools import wraps

from flask import current_app, g, jsonify, request

from repo import now_iso

ROLES = ("user", "admin")


def firebase_verifier(project_id):
    import firebase_admin
    from firebase_admin import auth

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": project_id})
    return lambda token: auth.verify_id_token(token, clock_skew_seconds=10)


# Profiles are cached for a minute so live-chat polling doesn't read the user document on every request.
# Role changes made in the app call forget_user(); changes made by make_admin.py apply within a minute.
PROFILE_TTL = 60
_profiles = {}


def forget_user(uid):
    _profiles.pop(uid, None)


def load_user(claims):
    """Return the stored profile, creating it with role 'user' on first login."""
    repo = current_app.config["REPO"]
    uid = claims["uid"]
    cached = _profiles.get(uid)
    if cached and cached[0] > time.monotonic() and cached[2] is repo:
        return dict(cached[1])
    user = repo.get_user(uid)
    if not user:
        email = claims.get("email", "")
        user = repo.create_user(uid, {
            "email": email,
            "name": (claims.get("name") or email.split("@")[0])[:40],
            "role": "user",
            "created_at": now_iso(),
        })
    _profiles[uid] = (time.monotonic() + PROFILE_TTL, dict(user), repo)
    return user


def role_required(*roles):
    """Require a valid token; if roles are given, the stored role must be one of them."""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            header = request.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return jsonify(error="Sign in required."), 401
            try:
                claims = current_app.config["VERIFY_TOKEN"](header[7:])
            except Exception:
                return jsonify(error="Your session has expired. Please sign in again."), 401
            g.user = load_user(claims)
            if roles and g.user.get("role") not in roles:
                return jsonify(error="You don't have access to this."), 403
            return fn(*args, **kwargs)
        return wrapper
    return decorator
