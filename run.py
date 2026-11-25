"""One-click local run: starts the API (port 8000) and the website (port 5000), then opens the browser.

Double-click this file, or run: py run.py
Close the window or press Ctrl+C to stop both servers.
"""
import functools
import http.server
import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
VENV_PY = BACKEND / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
API_URL, SITE_URL = "http://localhost:8000", "http://localhost:5000"


def ensure_venv():
    """Create the virtual environment and install requirements on first run."""
    if VENV_PY.exists():
        return
    print("First run: setting up the Python environment (takes a minute)...")
    subprocess.run([sys.executable, "-m", "venv", str(BACKEND / ".venv")], check=True)
    subprocess.run([str(VENV_PY), "-m", "pip", "install", "-q", "-r", str(BACKEND / "requirements.txt")], check=True)


def serve_frontend():
    class Handler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")  # always pick up edited files
            super().end_headers()

        def log_message(self, *args):  # keep the console readable
            pass

    handler = functools.partial(Handler, directory=str(ROOT / "public"))
    server = http.server.ThreadingHTTPServer(("localhost", 5000), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def wait_for_api(proc, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            urllib.request.urlopen(f"{API_URL}/api/health", timeout=1)
            return True
        except OSError:
            time.sleep(0.5)
    return False


def main():
    ensure_venv()
    api = subprocess.Popen([str(VENV_PY), "-m", "flask", "--app", "wsgi", "run", "--port", "8000"], cwd=BACKEND)
    try:
        if not wait_for_api(api):
            raise RuntimeError("The API did not start. Check the error above (often a missing "
                               "FIREBASE_CREDENTIALS_JSON in .env, or port 8000 already in use).")
        try:
            site = serve_frontend()
        except OSError as exc:
            raise RuntimeError("Port 5000 is already in use. Close the other program and try again.") from exc

        print(f"\n  AI Support Desk is running at {SITE_URL}\n  API: {API_URL}\n  Press Ctrl+C or close this window to stop.\n")
        webbrowser.open(SITE_URL)
        api.wait()
        site.shutdown()
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        if api.poll() is None:
            api.terminate()
            api.wait(timeout=10)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # keep a double-clicked window open so the error can be read
        print(f"\nError: {exc}")
        input("Press Enter to close...")
        sys.exit(1)
