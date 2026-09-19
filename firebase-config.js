// ============================================================
//  PASTE YOUR FIREBASE CONFIG HERE  👇👇👇
//  Firebase Console → Project settings → Your apps → Web app
// ============================================================
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY_HERE",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

// Region you deployed Cloud Functions to. Keep as-is unless you changed it.
export const FUNCTIONS_REGION = "us-central1";
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const fns = getFunctions(app, FUNCTIONS_REGION);

/* ---------- tiny shared helpers used by every page ---------- */

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

export function el(id) {
  return document.getElementById(id);
}

export function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function fmtClock(ms) {
  if (ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const m = String(Math.floor(t / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString();
}

// Turns raw Firebase errors into something a student can actually read.
export function friendlyError(e) {
  const code = e?.code || "";
  const map = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/user-not-found": "No admin account with that email.",
    "auth/too-many-requests": "Too many tries. Wait a minute and sign in again.",
    "auth/network-request-failed": "No internet connection. Reconnect and try again.",
    "permission-denied": "You don't have permission to do that.",
    "unavailable": "Can't reach the server. Check your connection."
  };
  return map[code] || e?.message || "Something went wrong. Try again.";
}

export function toast(msg, kind = "info") {
  let box = document.querySelector(".toast-box");
  if (!box) {
    box = document.createElement("div");
    box.className = "toast-box";
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = `toast toast--${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
