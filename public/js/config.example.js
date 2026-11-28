// Copy this file to config.js and fill in your Firebase web config
// (Firebase console > Project settings > Your apps). config.js is git-ignored.
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
  measurementId: "",
};

// Flask API. Local dev uses the backend on port 8000; replace with your Render URL after deploying.
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
export const API_BASE = LOCAL ? "http://localhost:8000" : "https://YOUR-SERVICE.onrender.com";

// Push notifications: Firebase console > Project settings > Cloud Messaging > Web Push certificates >
// "Generate key pair", then paste the public key here. Leave empty to turn notifications off.
export const VAPID_KEY = "";
