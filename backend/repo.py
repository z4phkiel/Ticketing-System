"""All data access. FirestoreRepo for real use, MemoryRepo for tests and local demos."""
import copy
import itertools
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class MemoryRepo:
    def __init__(self):
        self.users, self.tickets, self.messages, self.audit = {}, {}, {}, []
        self._ids = itertools.count(1)

    def _id(self):
        return f"t{next(self._ids):05d}"

    # users
    def get_user(self, uid):
        return copy.deepcopy(self.users.get(uid))

    def create_user(self, uid, data):
        self.users[uid] = {**data, "uid": uid}
        return self.get_user(uid)

    def update_user(self, uid, fields):
        self.users[uid].update(fields)

    def list_users(self):
        return copy.deepcopy(list(self.users.values()))

    def find_user_by_email(self, email):
        return next((copy.deepcopy(u) for u in self.users.values() if u.get("email") == email), None)

    # tickets
    def create_ticket(self, data):
        tid = self._id()
        self.tickets[tid] = {**data, "id": tid}
        self.messages[tid] = []
        return tid

    def get_ticket(self, tid):
        return copy.deepcopy(self.tickets.get(tid))

    def update_ticket(self, tid, fields):
        self.tickets[tid].update(copy.deepcopy(fields))

    def increment_duplicates(self, tid):
        t = self.tickets.get(tid)
        if t:
            t["duplicate_count"] = t.get("duplicate_count", 0) + 1

    def tickets_for_user(self, uid):
        return copy.deepcopy([t for t in self.tickets.values() if t["user_id"] == uid])

    def recent_tickets(self, limit):
        items = sorted(self.tickets.values(), key=lambda t: t["created_at"], reverse=True)
        return copy.deepcopy(items[:limit])

    # messages and audit
    def add_message(self, tid, data):
        self.messages[tid].append({**data, "id": f"m{len(self.messages[tid]) + 1}"})

    def list_messages(self, tid, since=None):
        return copy.deepcopy([m for m in self.messages.get(tid, []) if not since or m["created_at"] > since])

    def add_audit(self, data):
        self.audit.append(data)


class FirestoreRepo:
    def __init__(self, settings):
        import firebase_admin
        from firebase_admin import credentials, firestore

        raw = settings.firebase_credentials.strip()
        if not raw:
            raise RuntimeError("FIREBASE_CREDENTIALS_JSON is not set (service-account JSON or a path to it). "
                               "Set DATA_STORE=memory to run without Firestore.")
        if raw.startswith("{"):
            info = json.loads(raw)
        else:  # a path; relative paths are resolved from the backend folder
            path = Path(os.path.expanduser(raw))
            path = path if path.is_absolute() else Path(__file__).resolve().parent / path
            info = json.loads(path.read_text(encoding="utf-8"))
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(info))
        self._fs = firestore
        self.db = firestore.client()

    def _where(self, col, field, value):
        from google.cloud.firestore_v1.base_query import FieldFilter
        return self.db.collection(col).where(filter=FieldFilter(field, "==", value))

    @staticmethod
    def _doc(snap):
        return {**snap.to_dict(), "id": snap.id} if snap.exists else None

    # users
    def get_user(self, uid):
        snap = self.db.collection("users").document(uid).get()
        return {**snap.to_dict(), "uid": uid} if snap.exists else None

    def create_user(self, uid, data):
        self.db.collection("users").document(uid).set(data)
        return {**data, "uid": uid}

    def update_user(self, uid, fields):
        self.db.collection("users").document(uid).update(fields)

    def list_users(self):
        return [{**s.to_dict(), "uid": s.id} for s in self.db.collection("users").limit(500).stream()]

    def find_user_by_email(self, email):
        snaps = list(self._where("users", "email", email).limit(1).stream())
        return {**snaps[0].to_dict(), "uid": snaps[0].id} if snaps else None

    # tickets
    def create_ticket(self, data):
        ref = self.db.collection("tickets").document()
        ref.set(data)
        return ref.id

    def get_ticket(self, tid):
        return self._doc(self.db.collection("tickets").document(tid).get())

    def update_ticket(self, tid, fields):
        self.db.collection("tickets").document(tid).update(fields)

    def increment_duplicates(self, tid):
        self.db.collection("tickets").document(tid).update({"duplicate_count": self._fs.Increment(1)})

    def tickets_for_user(self, uid):
        return [self._doc(s) for s in self._where("tickets", "user_id", uid).stream()]

    def recent_tickets(self, limit):
        q = self.db.collection("tickets").order_by("created_at", direction="DESCENDING").limit(limit)
        return [self._doc(s) for s in q.stream()]

    # messages and audit
    def add_message(self, tid, data):
        self.db.collection("tickets").document(tid).collection("messages").add(data)

    def list_messages(self, tid, since=None):
        """All messages, or only those newer than 'since' (cheap polling: few document reads)."""
        from google.cloud.firestore_v1.base_query import FieldFilter
        q = self.db.collection("tickets").document(tid).collection("messages")
        if since:
            q = q.where(filter=FieldFilter("created_at", ">", since))
        return [{**s.to_dict(), "id": s.id} for s in q.order_by("created_at").stream()]

    def add_audit(self, data):
        self.db.collection("audit_log").add(data)


def make_repo(settings):
    return MemoryRepo() if settings.data_store == "memory" else FirestoreRepo(settings)
