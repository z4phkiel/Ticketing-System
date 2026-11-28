"""Push notifications to a user's devices through Firebase Cloud Messaging (uses firebase-admin)."""
import logging
import threading

# FCM errors meaning the device token is gone for good, so it is removed from the user
DEAD_TOKEN_ERRORS = ("UnregisteredError", "SenderIdMismatchError", "InvalidArgumentError")


def fcm_sender(tokens, data):
    """Sends a data-only web push to each token; returns the tokens that no longer work.
    The service worker builds the visible notification from `data`."""
    from firebase_admin import messaging

    messages = [messaging.Message(token=t, data=data,
                                  webpush=messaging.WebpushConfig(headers={"Urgency": "high", "TTL": "86400"}))
                for t in tokens]
    result = messaging.send_each(messages)
    return [t for t, r in zip(tokens, result.responses)
            if not r.success and type(r.exception).__name__ in DEAD_TOKEN_ERRORS]


def notify(sender, repo, uid, title, body, ticket_id=None, token=None, force=False):
    """Notifies a user in the background, so a slow or failing push never delays or breaks the request.
    token: send to that one device only. force: show it even while the app is open (test notification)."""
    if not sender:
        return

    def run():
        try:
            tokens = [token] if token else (repo.get_user(uid) or {}).get("push_tokens") or []
            if not tokens:
                return
            data = {"title": title, "body": body,
                    "tag": f"ticket-{ticket_id}" if ticket_id else "push-test",
                    "url": f"/tickets?ticket={ticket_id}" if ticket_id else "/tickets"}
            if force:
                data["force"] = "1"
            dead = sender(tokens, data)
            if dead:
                current = (repo.get_user(uid) or {}).get("push_tokens") or []
                repo.update_user(uid, {"push_tokens": [t for t in current if t not in dead]})
        except Exception:
            logging.exception("Push notification failed")

    threading.Thread(target=run, daemon=True).start()
