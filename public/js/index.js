// Login and registration, then redirect by role.
import {
  createUserWithEmailAndPassword, sendPasswordResetEmail, signInWithEmailAndPassword, updateProfile,
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { $, api, auth, authReady, busy, homeFor, initShell, toast, watchConnection } from "./app.js";

const form = $("#auth-form");
const tabs = $(".tabs");
const submitBtn = $("#submit-btn");
const errorEl = $("#form-error");
let mode = "signin";

const AUTH_ERRORS = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/email-already-in-use": "An account with this email already exists. Try signing in.",
  "auth/weak-password": "Use at least 6 characters for your password.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  "auth/network-request-failed": "Can't reach the sign-in service. Check your connection.",
  "auth/missing-password": "Enter your password.",
};
const friendly = err => AUTH_ERRORS[err.code] || err.message || "Something went wrong. Please try again.";

function setMode(next) {
  mode = next;
  const register = mode === "register";
  tabs.dataset.tab = mode;
  $("#tab-signin").setAttribute("aria-selected", String(!register));
  $("#tab-register").setAttribute("aria-selected", String(register));
  $("#name-field").hidden = !register;
  $("#forgot-btn").hidden = register;
  $("#password").autocomplete = register ? "new-password" : "current-password";
  submitBtn.textContent = register ? "Create account" : "Sign in";
  errorEl.textContent = "";
}

async function goHome() {
  const me = await api("/api/me");
  location.replace(homeFor(me.role));
}

function showError(message, field) {
  errorEl.textContent = message;
  form.querySelectorAll(".input").forEach(i => i.removeAttribute("aria-invalid"));
  if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const name = $("#name").value.trim();
  if (!email || !$("#email").checkValidity()) return showError("Enter a valid email address.", $("#email"));
  if (password.length < 6) return showError("Password must be at least 6 characters.", $("#password"));
  if (mode === "register" && !/^[A-Za-z0-9._-]{3,30}$/.test(name)) {
    return showError("Username must be 3-30 characters: letters, numbers, dots, dashes, or underscores.", $("#name"));
  }

  showError("");
  busy(submitBtn, true, mode === "register" ? "Creating account…" : "Signing in…");
  try {
    if (mode === "register") {
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(user, { displayName: name });
      await user.getIdToken(true); // include the name in the token the backend reads
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    await goHome();
  } catch (err) {
    busy(submitBtn, false);
    showError(err.code ? friendly(err) : err.message);
  }
});

$("#tab-signin").addEventListener("click", () => setMode("signin"));
$("#tab-register").addEventListener("click", () => setMode("register"));

$("#forgot-btn").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  if (!email) return showError("Enter your email above, then click \"Forgot password?\".", $("#email"));
  try {
    await sendPasswordResetEmail(auth, email);
    toast("If that email has an account, a reset link is on its way.", "success");
  } catch (err) {
    showError(friendly(err));
  }
});

initShell();
watchConnection();

// Already signed in: skip the form.
authReady.then(user => {
  if (user && navigator.onLine) goHome().catch(() => {});
});
