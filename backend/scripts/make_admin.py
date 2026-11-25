"""One-time bootstrap: give an existing account the admin role.

Usage (from the backend folder): python scripts/make_admin.py someone@example.com
The person must have signed in to the app once so their profile exists.
"""
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
VENV_PY = BACKEND / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
if VENV_PY.exists() and Path(sys.executable).resolve() != VENV_PY.resolve():
    # Started with another Python (double-click, Run button): rerun with the project's environment
    import subprocess
    sys.exit(subprocess.call([str(VENV_PY), __file__, *sys.argv[1:]]))

sys.path.insert(0, str(BACKEND))

from config import Settings  # noqa: E402
from repo import FirestoreRepo, now_iso  # noqa: E402


def main():
    email = (sys.argv[1] if len(sys.argv) > 1 else input("Email of the account to make admin: ")).strip().lower()
    if not email:
        return print("No email given.")
    repo = FirestoreRepo(Settings.from_env())
    user = repo.find_user_by_email(email)
    if not user:
        return print(f"No profile for {email}. Sign in to the app once with this email, then run this again.")
    repo.update_user(user["uid"], {"role": "admin"})
    repo.add_audit({"action": "role_change", "user_id": user["uid"], "by": "make_admin.py",
                    "before": user.get("role"), "after": "admin", "at": now_iso()})
    print(f"{email} is now an admin. Reload the app to open the staff console.")


if __name__ == "__main__":
    main()
    if len(sys.argv) < 2:  # started by double-click or the Run button: keep the window open
        input("Press Enter to close...")
