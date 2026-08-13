"use strict";

// Web Push - wakes a backgrounded/locked browser for an incoming Comm call
// or chat message, ported from QTI's own push.js. QTI scopes this to a
// per-customer data directory (one process per customer, each with its own
// VAPID keys/subscriptions); Oak is single-tenant today, so this is a
// module-level singleton against orchestrator/'s own data files instead -
// the same simplification already made for config.json/macros.json/
// cameras.json living next to server.js rather than under a per-tenant root.
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const VAPID_FILE = process.env.OAK_VAPID_FILE || path.join(__dirname, "vapid_keys.json");
const SUBS_FILE = process.env.OAK_PUSH_SUBS_FILE || path.join(__dirname, "push_subscriptions.json");

function loadOrGenerateVapidKeys() {
  if (fs.existsSync(VAPID_FILE)) return JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.log(`[push] Generated new VAPID key pair at ${VAPID_FILE}`);
  return keys;
}

const vapidKeys = loadOrGenerateVapidKeys();
webpush.setVapidDetails("mailto:admin@example.com", vapidKeys.publicKey, vapidKeys.privateKey);

function loadSubs() {
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  } catch (e) {
    return {}; // deviceId -> { endpoint, keys: { p256dh, auth } }
  }
}
function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

function getPublicKey() {
  return vapidKeys.publicKey;
}
function subscribe(deviceId, endpoint, keys) {
  const subs = loadSubs();
  subs[deviceId] = { endpoint, keys };
  saveSubs(subs);
}
function unsubscribe(deviceId) {
  const subs = loadSubs();
  delete subs[deviceId];
  saveSubs(subs);
}

async function sendToDevice(deviceId, title, body, data) {
  const subs = loadSubs();
  const sub = subs[deviceId];
  if (!sub) return false;
  const payload = JSON.stringify({ title, body, icon: "/icon-192.png", data: data || {} });
  try {
    await webpush.sendNotification(sub, payload);
    return true;
  } catch (err) {
    // 404/410 = the browser/OS push service says this subscription is
    // permanently gone - clean it up rather than retrying it forever.
    if (err.statusCode === 404 || err.statusCode === 410) {
      delete subs[deviceId];
      saveSubs(subs);
    }
    console.log("[push] send to", deviceId, "failed:", err.statusCode || err.message);
    return false;
  }
}

module.exports = { getPublicKey, subscribe, unsubscribe, sendToDevice };
