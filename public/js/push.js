// Push notifications (Firebase Cloud Messaging). Loaded on demand from the account menu.
// The service worker (sw.js) shows the notifications; this file only turns them on and off.
import { deleteToken, getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-messaging.js";
import { api, firebaseApp } from "./app.js";
import * as config from "./config.js";

const KEY = "pushToken"; // this device's token, so we can turn it off again (also on sign-out)

export async function pushAvailable() {
  return !!config.VAPID_KEY && "Notification" in window && "serviceWorker" in navigator
    && await isSupported().catch(() => false);
}

export const pushEnabled = () => Notification.permission === "granted" && !!localStorage.getItem(KEY);

async function deviceToken() {
  const registration = await navigator.serviceWorker.ready;
  return getToken(getMessaging(firebaseApp), { vapidKey: config.VAPID_KEY, serviceWorkerRegistration: registration });
}

export async function enablePush() {
  if (await Notification.requestPermission() !== "granted") {
    throw new Error("Notifications are blocked. Allow them for this site in your browser settings.");
  }
  const token = await deviceToken();
  await api("/api/push/subscribe", { method: "POST", body: { token } });
  localStorage.setItem(KEY, token);
}

export async function disablePush() {
  const token = localStorage.getItem(KEY);
  localStorage.removeItem(KEY);
  if (!token) return;
  await api("/api/push/subscribe", { method: "DELETE", body: { token } }).catch(() => {});
  await deleteToken(getMessaging(firebaseApp)).catch(() => {});
}

/** Browsers can rotate the token; keep the server's copy current. */
export async function refreshPush() {
  if (!pushEnabled()) return;
  const token = await deviceToken();
  if (token !== localStorage.getItem(KEY)) {
    await api("/api/push/subscribe", { method: "POST", body: { token } });
    localStorage.setItem(KEY, token);
  }
}
