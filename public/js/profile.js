// Profile page: profile picture, username, and password.
import {
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import {
  $, api, auth, avatarEl, busy, guard, homeFor, initShell, renderUserChip, setupHeader, toast, watchConnection,
} from "./app.js";

const USERNAME = /^[A-Za-z0-9._-]{3,30}$/; // same rule as sign-up and the server
const PW_ERRORS = {
  "auth/invalid-credential": "Your current password is incorrect.",
  "auth/wrong-password": "Your current password is incorrect.",
  "auth/weak-password": "Choose a stronger password (at least 6 characters).",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  "auth/network-request-failed": "Can't reach the sign-in service. Check your connection.",
  "auth/requires-recent-login": "Please sign out and sign in again, then change your password.",
};

/** Center-crops the image to a square and re-encodes a small JPEG (also drops photo metadata such as GPS). */
async function squareAvatar(file) {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  if (file.size > 15e6) throw new Error("That image is over 15 MB. Please choose a smaller one.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That file couldn't be read as an image.");
  }
  const side = Math.min(bitmap.width, bitmap.height), size = 256;
  const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff"; // transparent PNGs get a white background in JPEG
  g.fillRect(0, 0, size, size);
  g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

function showProfile() {
  $("#avatar-preview").replaceWith(Object.assign(avatarEl(me, "xl"), { id: "avatar-preview" }));
  $("#photo-remove").hidden = !me.avatar;
  renderUserChip(me);
}

async function saveProfile(changes, btn, success) {
  busy(btn, true);
  try {
    Object.assign(me, await api("/api/me", { method: "PATCH", body: changes }));
    showProfile();
    toast(success, "success");
    return true;
  } catch (err) {
    toast(err.message, "error");
    return false;
  } finally {
    busy(btn, false);
  }
}

// ---------- Picture ----------

$("#photo-btn").addEventListener("click", () => $("#photo-input").click());
$("#photo-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    await saveProfile({ avatar: await squareAvatar(file) }, $("#photo-btn"), "Profile picture updated.");
  } catch (err) {
    toast(err.message, "error");
  }
});
$("#photo-remove").addEventListener("click", () => saveProfile({ avatar: null }, $("#photo-remove"), "Profile picture removed."));

// ---------- Username ----------

$("#name-form").addEventListener("submit", async e => {
  e.preventDefault();
  const input = $("#name"), name = input.value.trim();
  input.removeAttribute("aria-invalid");
  $("#name-error").textContent = "";
  if (!USERNAME.test(name)) {
    input.setAttribute("aria-invalid", "true");
    $("#name-error").textContent = "Username must be 3-30 characters: letters, numbers, dots, dashes, or underscores.";
    return input.focus();
  }
  if (name === me.name) return toast("That's already your username.", "info");
  await saveProfile({ name }, $("#name-save"), "Username saved.");
});

// ---------- Password ----------

$("#password-form").addEventListener("submit", async e => {
  e.preventDefault();
  const [cur, next, confirm] = ["#pw-current", "#pw-new", "#pw-confirm"].map(s => $(s));
  const fail = (input, message) => {
    input.setAttribute("aria-invalid", "true");
    $("#pw-error").textContent = message;
    input.focus();
  };
  [cur, next, confirm].forEach(i => i.removeAttribute("aria-invalid"));
  $("#pw-error").textContent = "";
  if (!cur.value) return fail(cur, "Enter your current password.");
  if (next.value.length < 6) return fail(next, "Your new password must be at least 6 characters.");
  if (next.value === cur.value) return fail(next, "Your new password must be different from the current one.");
  if (confirm.value !== next.value) return fail(confirm, "The new passwords don't match.");

  const btn = $("#pw-save");
  busy(btn, true, "Updating…");
  try {
    const user = auth.currentUser;
    // Firebase requires a recent sign-in to change the password, so confirm the current one first
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur.value));
    await updatePassword(user, next.value);
    e.target.reset();
    toast("Password updated.", "success");
  } catch (err) {
    const wrongCurrent = ["auth/invalid-credential", "auth/wrong-password"].includes(err.code);
    fail(wrongCurrent ? cur : next, PW_ERRORS[err.code] || err.message || "Couldn't update your password.");
  } finally {
    busy(btn, false);
  }
});

// ---------- Start ----------

const me = await guard();
setupHeader(me);
initShell();
watchConnection();
const home = homeFor(me.role);
$("#home-link").href = home;
$("#back-link").href = home;
$("#back-link").textContent = me.role === "admin" ? "Back to queue" : "Back to tickets";
$("#name").value = me.name || "";
showProfile();
