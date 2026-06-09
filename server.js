// server.js — Wasselni tuk-tuk bot
// Persistent: Supabase (users, sessions, drivers, rides)
// Push notifications: Web Push API (VAPID)
// WhatsApp bot + PWA app

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const webpush = require("web-push");
const { createClient } = require("@supabase/supabase-js");
const { findNearbyDrivers, distanceKm } = require("./matching");

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN,
  OLLAMA_API_KEY, OLLAMA_MODEL = "gemma3:4b",
  GOOGLE_MAPS_API_KEY,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL = "mailto:admin@wasselni.app",
  MAX_DRIVERS_PER_RIDE = 5, MAX_RADIUS_KM = 5,
  FARE_BASE_LBP = 100000, FARE_PER_KM_LBP = 100000,
  PORT = 3000, BASE_URL = "",
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0";
const RIDE_TIMEOUT_MS = 3 * 60 * 1000;
const STALE_DRIVER_MS = 10 * 60 * 1000;

// ---- Supabase ----
const db = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// ---- Web Push ----
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// ---- In-memory cache (warm from DB on startup) ----
const drivers = new Map();       // phone -> { phone, name, online, location, lastGPS, pushSub }
const rides = new Map();         // rideId -> ride object
const pendingOffers = new Map(); // driverPhone -> rideId
const activeDriverRide = new Map(); // driverPhone -> rideId
let detectedBaseUrl = "";

// ============================================================
// DB HELPERS
// ============================================================
async function dbSaveUser(phone, name) {
  if (!db) return;
  await db.from("users").upsert({ phone, name }, { onConflict: "phone", ignoreDuplicates: false });
}

async function dbSaveSession(token, phone, name) {
  if (!db) return;
  await db.from("sessions").insert({ token, phone, name });
}

async function dbGetSession(token) {
  if (!db) return null;
  const { data } = await db.from("sessions").select("*").eq("token", token).single();
  return data;
}

async function dbDeleteSession(token) {
  if (!db) return;
  await db.from("sessions").delete().eq("token", token);
}

async function dbSaveDriver(driver) {
  if (!db) return;
  await db.from("drivers").upsert({
    phone: driver.phone, name: driver.name, online: driver.online,
    lat: driver.location?.lat ?? null, lng: driver.location?.lng ?? null,
    last_gps: driver.lastGPS ? new Date(driver.lastGPS).toISOString() : null,
    push_endpoint: driver.pushSub?.endpoint ?? null,
    push_p256dh: driver.pushSub?.keys?.p256dh ?? null,
    push_auth: driver.pushSub?.keys?.auth ?? null,
  }, { onConflict: "phone" });
}

async function dbSaveRide(ride) {
  if (!db) return;
  await db.from("rides").upsert({
    id: ride.id, rider_phone: ride.riderPhone, rider_name: ride.riderName,
    rider_lat: ride.riderLocation.lat, rider_lng: ride.riderLocation.lng,
    ride_type: ride.rideType || "ride", status: ride.status,
    driver_phone: ride.acceptedBy ?? null, driver_name: ride.driverName ?? null,
    driver_lat: ride.driverLocation?.lat ?? null, driver_lng: ride.driverLocation?.lng ?? null,
    fare_lbp: ride.fareEstimateLBP ?? null, pinged_drivers: ride.pingedDrivers ?? [],
  }, { onConflict: "id" });
}

async function dbLoadState() {
  if (!db) { console.log("No DB — using in-memory only"); return; }
  try {
    // Load online drivers
    const { data: dbDrivers } = await db.from("drivers").select("*").eq("online", true);
    (dbDrivers || []).forEach(d => {
      const pushSub = d.push_endpoint ? {
        endpoint: d.push_endpoint,
        keys: { p256dh: d.push_p256dh, auth: d.push_auth }
      } : null;
      drivers.set(d.phone, {
        phone: d.phone, name: d.name, online: true,
        location: d.lat ? { lat: d.lat, lng: d.lng } : null,
        lastGPS: d.last_gps ? new Date(d.last_gps).getTime() : null,
        pushSub,
      });
    });
    console.log(`Loaded ${drivers.size} online driver(s) from DB`);

    // Load active rides
    const { data: dbRides } = await db.from("rides").select("*").in("status", ["pending","accepted"]);
    (dbRides || []).forEach(r => {
      const ride = {
        id: r.id, riderPhone: r.rider_phone, riderName: r.rider_name,
        riderLocation: { lat: r.rider_lat, lng: r.rider_lng },
        rideType: r.ride_type, status: r.status,
        acceptedBy: r.driver_phone, driverName: r.driver_name,
        driverLocation: r.driver_lat ? { lat: r.driver_lat, lng: r.driver_lng } : null,
        fareEstimateLBP: r.fare_lbp, pingedDrivers: r.pinged_drivers || [],
        timer: null, lastUpdate: null,
      };
      rides.set(ride.id, ride);
      if (ride.status === "pending") {
        ride.pingedDrivers.forEach(p => pendingOffers.set(p, ride.id));
      } else if (ride.status === "accepted" && ride.acceptedBy) {
        activeDriverRide.set(ride.acceptedBy, ride.id);
      }
      // Restart timeout for pending rides
      if (ride.status === "pending") {
        ride.timer = setTimeout(() => expireRide(ride.id), RIDE_TIMEOUT_MS);
      }
    });
    console.log(`Loaded ${rides.size} active ride(s) from DB`);
  } catch (e) { console.error("DB load error:", e.message); }
}

// ============================================================
// STARTUP DIAGNOSTICS
// ============================================================
async function checkConfig() {
  const tp = WHATSAPP_TOKEN ? `${WHATSAPP_TOKEN.slice(0,6)}...${WHATSAPP_TOKEN.slice(-4)} (${WHATSAPP_TOKEN.length} chars)` : "MISSING!";
  console.log("== DIAGNOSTICS ==");
  console.log(`PHONE_NUMBER_ID: ${PHONE_NUMBER_ID || "MISSING!"}`);
  console.log(`WHATSAPP_TOKEN:  ${tp}`);
  console.log(`VERIFY_TOKEN:    ${VERIFY_TOKEN ? "set" : "MISSING!"}`);
  console.log(`SUPABASE:        ${db ? "connected" : "not set — in-memory only"}`);
  console.log(`VAPID:           ${VAPID_PUBLIC_KEY ? "set — push notifications enabled" : "not set — push disabled"}`);
  console.log(`OLLAMA:          ${OLLAMA_API_KEY ? "set" : "disabled"} / ${OLLAMA_MODEL}`);
  console.log(`GOOGLE_MAPS:     ${GOOGLE_MAPS_API_KEY ? "set" : "not set"}`);
  console.log(`MATCHING:        ${MAX_DRIVERS_PER_RIDE} drivers, ${MAX_RADIUS_KM}km radius`);
  try {
    const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    const data = await res.json();
    if (data.error) console.log(`TOKEN FAILED: ${JSON.stringify(data.error)}`);
    else console.log(`TOKEN OK — phone: ${data.display_phone_number}`);
  } catch (e) { console.log(`TOKEN CHECK ERROR: ${e.message}`); }
  console.log("=================");
}

// ============================================================
// HELPERS
// ============================================================
function getBaseUrl(req) {
  if (BASE_URL) return BASE_URL;
  if (detectedBaseUrl) return detectedBaseUrl;
  detectedBaseUrl = `${req.protocol}://${req.get("host")}`;
  if (detectedBaseUrl.startsWith("http://") && detectedBaseUrl.includes(".onrender.com"))
    detectedBaseUrl = detectedBaseUrl.replace("http://", "https://");
  return detectedBaseUrl;
}
function generateRideId() { return "ride_" + crypto.randomBytes(6).toString("hex"); }

// ============================================================
// WHATSAPP HELPERS
// ============================================================
async function sendText(to, body) {
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { preview_url: true, body } }),
  });
  if (!res.ok) console.error(`send failed to ${to}: ${await res.text()}`);
  else console.log(`message sent to ${to}`);
}

async function sendLocation(to, lat, lng, name, address) {
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "location",
      location: { latitude: lat, longitude: lng, name: name || "Location", address: address || "" } }),
  });
  if (!res.ok) console.error(`location send failed: ${await res.text()}`);
}

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================
async function sendPush(driverPhone, payload) {
  const driver = drivers.get(driverPhone);
  if (!driver?.pushSub || !VAPID_PUBLIC_KEY) return;
  try {
    await webpush.sendNotification(driver.pushSub, JSON.stringify(payload));
    console.log(`Push sent to driver ${driverPhone}`);
  } catch (e) {
    console.error(`Push failed for ${driverPhone}: ${e.message}`);
    // Remove invalid subscription
    if (e.statusCode === 410 || e.statusCode === 404) {
      driver.pushSub = null;
      dbSaveDriver(driver).catch(() => {});
    }
  }
}

// ============================================================
// AI (intent detection + response polishing)
// ============================================================
const INTENT_PROMPT = `You are an intent classifier for a tuk-tuk ride service in Lebanon.
Detect what the user wants. Reply with ONLY one word.
ride — wants a tuk-tuk | driver — wants to be a driver | accept — accepting a ride
reject — declining | cancel — cancel | done — ride finished | offline — stop driving
status — asking about ride | help — greeting or anything else`;

const POLISH_PROMPT = `You are the voice of Wasselni, a tuk-tuk service in Lebanon.
Rewrite the given message to be warmer and more helpful. English only. 2-3 sentences max.
Keep links/numbers exactly as-is. Reply with ONLY the rewritten message, nothing else.`;

async function detectIntent(msg) {
  if (!OLLAMA_API_KEY) return null;
  try {
    const res = await fetch("https://ollama.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, max_tokens: 20, temperature: 0,
        messages: [{ role: "system", content: INTENT_PROMPT }, { role: "user", content: msg }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().toLowerCase().replace(/[^a-z]/g, "") || null;
  } catch { return null; }
}

async function polish(raw, situation) {
  if (!OLLAMA_API_KEY) return raw;
  try {
    const res = await fetch("https://ollama.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, max_tokens: 150, temperature: 0.5,
        messages: [{ role: "system", content: POLISH_PROMPT },
          { role: "user", content: `Situation: ${situation}\nOriginal: ${raw}\n\nRewrite:` }] }),
    });
    if (!res.ok) return raw;
    const data = await res.json();
    let p = (data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim()
      .replace(/^(here'?s?|okay|sure|of course)[^\n]*\n*/i, "")
      .replace(/\n*(would you|want me|shall i)[^\n]*/i, "").trim();
    return (p.length > 10 && p.length < 500) ? p : raw;
  } catch { return raw; }
}

// ============================================================
// WEBHOOK
// ============================================================
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;
    const from = msg.from, name = value?.contacts?.[0]?.profile?.name || "there";
    console.log(`Incoming ${msg.type} from ${from} (${name})`);
    if (msg.type === "text") await handleText(from, name, msg.text.body.trim(), req);
    else if (msg.type === "location") await handleLocation(from, name, { lat: msg.location.latitude, lng: msg.location.longitude }, req);
  } catch (e) { console.error("webhook error:", e); }
});

// ============================================================
// PAGES & CONFIG
// ============================================================
app.get("/", (req, res) => res.redirect("/app"));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));
app.get("/driver", (req, res) => res.sendFile(path.join(__dirname, "public", "driver.html")));
app.get("/track/:rideId", (req, res) => res.sendFile(path.join(__dirname, "public", "tracking.html")));
app.get("/api/config", (req, res) => res.json({
  googleMapsKey: GOOGLE_MAPS_API_KEY || null,
  vapidPublicKey: VAPID_PUBLIC_KEY || null,
}));

// ============================================================
// AUTH — persistent in Supabase
// ============================================================
app.post("/api/auth/register", async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.json({ error: "Name and phone are required" });
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, "");

  // Check if user is banned
  if (db) {
    const { data: user } = await db.from("users").select("banned").eq("phone", cleanPhone).single();
    if (user?.banned) return res.json({ error: "Account suspended. Contact support." });
  }

  await dbSaveUser(cleanPhone, name.trim());
  const token = crypto.randomBytes(24).toString("hex");
  await dbSaveSession(token, cleanPhone, name.trim());
  console.log(`User registered: ${name.trim()} (${cleanPhone})`);
  res.json({ success: true, token, phone: cleanPhone, name: name.trim() });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) await dbDeleteSession(token);
  res.json({ success: true });
});

// Verify session (for app reload)
app.get("/api/auth/me", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.json({ error: "not logged in" });
  const session = await dbGetSession(token);
  if (!session) return res.json({ error: "invalid session" });
  res.json({ phone: session.phone, name: session.name });
});

// ============================================================
// PUSH SUBSCRIPTIONS
// ============================================================
app.post("/api/push/subscribe", async (req, res) => {
  const { phone, subscription } = req.body;
  if (!phone || !subscription) return res.json({ error: "missing fields" });
  const driver = drivers.get(phone);
  if (driver) {
    driver.pushSub = subscription;
    dbSaveDriver(driver).catch(() => {});
    console.log(`Push subscription saved for driver ${phone}`);
  }
  res.json({ success: true });
});

app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

// ============================================================
// DRIVER GPS API
// ============================================================
app.post("/api/driver/location", async (req, res) => {
  const { phone, lat, lng } = req.body;
  if (!phone || lat == null || lng == null) return res.json({ error: "missing" });
  let driver = drivers.get(phone);
  if (driver) {
    driver.location = { lat, lng };
    driver.online = true;
    driver.lastGPS = Date.now();
  } else {
    driver = { phone, name: phone, online: true, location: { lat, lng }, lastGPS: Date.now(), pushSub: null };
    drivers.set(phone, driver);
  }
  // Update active ride tracking
  const rid = activeDriverRide.get(phone);
  if (rid) {
    const r = rides.get(rid);
    if (r && r.status === "accepted") { r.driverLocation = { lat, lng }; r.lastUpdate = Date.now(); }
  }
  dbSaveDriver(driver).catch(() => {});
  res.json({ ok: true });
});

app.post("/api/driver/offline", async (req, res) => {
  const { phone } = req.body;
  const d = drivers.get(phone);
  if (d) { d.online = false; dbSaveDriver(d).catch(() => {}); }
  res.json({ ok: true });
});

// ============================================================
// RIDE TRACKING API
// ============================================================
app.post("/api/track/:rideId/location", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride || ride.status !== "accepted") return res.json({ error: "not active" });
  const { lat, lng } = req.body;
  ride.driverLocation = { lat, lng }; ride.lastUpdate = Date.now();
  if (ride.acceptedBy) { const d = drivers.get(ride.acceptedBy); if (d) d.location = { lat, lng }; }
  res.json({ ok: true });
});

app.get("/api/track/:rideId/status", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.json({ error: "not found" });
  res.json({ driverLocation: ride.driverLocation, riderLocation: ride.riderLocation,
    driverName: ride.driverName || "Driver", status: ride.status, lastUpdate: ride.lastUpdate });
});

// ============================================================
// APP API
// ============================================================
app.get("/api/nearby", (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.json({ count: 0, drivers: [] });
  const nearby = findNearbyDrivers({ lat: +lat, lng: +lng }, [...drivers.values()], { maxKm: +MAX_RADIUS_KM, limit: 10 });
  res.json({
    count: nearby.length,
    closestKm: nearby.length > 0 ? +nearby[0].distanceKm.toFixed(1) : null,
    closestEta: nearby.length > 0 ? Math.max(2, Math.round((nearby[0].distanceKm * 1.4) / 20 * 60)) : null,
    drivers: nearby.map(d => ({
      name: d.name,
      distanceKm: +d.distanceKm.toFixed(1),
      etaMinutes: Math.max(2, Math.round((d.distanceKm * 1.4) / 20 * 60)),
      lat: Math.round(d.location.lat * 1000) / 1000,
      lng: Math.round(d.location.lng * 1000) / 1000,
    })),
  });
});

app.post("/api/ride/request", async (req, res) => {
  const { riderPhone, riderName, lat, lng, rideType } = req.body;
  if (!riderPhone || !lat || !lng) return res.json({ error: "missing fields" });
  const nearby = findNearbyDrivers({ lat, lng }, [...drivers.values()], { maxKm: +MAX_RADIUS_KM, limit: +MAX_DRIVERS_PER_RIDE });
  if (nearby.length === 0) return res.json({ error: "no_drivers", message: `No tuk-tuks within ${MAX_RADIUS_KM}km` });

  const rideId = generateRideId();
  const fare = Math.round((+FARE_BASE_LBP + distanceKm({ lat, lng }, nearby[0].location) * +FARE_PER_KM_LBP) / 1000) * 1000;
  const ride = {
    id: rideId, riderPhone, riderName: riderName || "Rider", riderLocation: { lat, lng },
    rideType: rideType || "ride", status: "pending", pingedDrivers: nearby.map(d => d.phone),
    acceptedBy: null, driverName: null, driverLocation: null, lastUpdate: null,
    fareEstimateLBP: fare, timer: null,
  };
  ride.timer = setTimeout(() => expireRide(rideId), RIDE_TIMEOUT_MS);
  rides.set(rideId, ride);
  for (const d of nearby) pendingOffers.set(d.phone, rideId);
  dbSaveRide(ride).catch(() => {});

  // Send push notifications to drivers
  for (const d of nearby) {
    const km = d.distanceKm.toFixed(1);
    await sendPush(d.phone, {
      title: "🔔 New Ride Request!",
      body: `${riderName || "Rider"} — ${km}km away. Tap to accept.`,
      rideId, type: "ride_request",
    });
  }

  res.json({ rideId, driversFound: nearby.length });
});

app.get("/api/ride/:rideId", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.json({ error: "not found" });
  const result = {
    id: ride.id, status: ride.status, rideType: ride.rideType || "ride",
    riderName: ride.riderName, riderLocation: ride.riderLocation,
    driverName: ride.driverName, driverPhone: ride.acceptedBy,
    driverLocation: ride.driverLocation, lastUpdate: ride.lastUpdate,
    fareEstimateLBP: ride.fareEstimateLBP,
    fareEstimateUSD: ride.fareEstimateLBP ? +(ride.fareEstimateLBP / 90000).toFixed(1) : null,
  };
  if (ride.driverLocation && ride.riderLocation) {
    const dist = distanceKm(ride.riderLocation, ride.driverLocation);
    result.distanceKm = +dist.toFixed(2);
    result.etaMinutes = Math.max(2, Math.round((dist * 1.4) / 20 * 60));
  }
  res.json(result);
});

app.get("/api/driver/:phone/requests", (req, res) => {
  const phone = req.params.phone;
  const rideId = pendingOffers.get(phone);
  if (!rideId) return res.json({ pending: null });
  const ride = rides.get(rideId);
  if (!ride || ride.status !== "pending") { pendingOffers.delete(phone); return res.json({ pending: null }); }
  const driver = drivers.get(phone);
  const dist = driver?.location ? distanceKm(ride.riderLocation, driver.location) : null;
  const fareLBP = dist ? Math.round((+FARE_BASE_LBP + dist * +FARE_PER_KM_LBP) / 1000) * 1000 : null;
  res.json({ pending: {
    rideId: ride.id, riderName: ride.riderName, riderLocation: ride.riderLocation,
    rideType: ride.rideType || "ride",
    distanceKm: dist ? +dist.toFixed(2) : null,
    etaMinutes: dist ? Math.max(2, Math.round((dist * 1.4) / 20 * 60)) : null,
    fareEstimateLBP: fareLBP,
    fareEstimateUSD: fareLBP ? +(fareLBP / 90000).toFixed(1) : null,
  }});
});

app.post("/api/ride/:rideId/accept", async (req, res) => {
  const { driverPhone, driverName } = req.body;
  const ride = rides.get(req.params.rideId);
  if (!ride || ride.status !== "pending") return res.json({ error: "ride unavailable" });
  ride.status = "accepted"; ride.acceptedBy = driverPhone; ride.driverName = driverName || "Driver";
  clearTimeout(ride.timer);
  const driver = drivers.get(driverPhone);
  if (driver?.location) ride.driverLocation = driver.location;
  activeDriverRide.set(driverPhone, ride.id);
  for (const p of ride.pingedDrivers) { if (p !== driverPhone) pendingOffers.delete(p); }
  pendingOffers.delete(driverPhone);
  dbSaveRide(ride).catch(() => {});
  console.log(`Ride ${ride.id}: accepted by ${driverPhone}`);
  res.json({ success: true, riderName: ride.riderName, riderPhone: ride.riderPhone, riderLocation: ride.riderLocation });
});

app.post("/api/ride/:rideId/reject", (req, res) => {
  const { driverPhone } = req.body;
  pendingOffers.delete(driverPhone);
  const ride = rides.get(req.params.rideId);
  if (ride && ride.status === "pending") {
    const remaining = ride.pingedDrivers.filter(p => pendingOffers.get(p) === ride.id);
    if (remaining.length === 0) { ride.status = "rejected"; clearTimeout(ride.timer); dbSaveRide(ride).catch(() => {}); }
  }
  res.json({ success: true });
});

app.post("/api/ride/:rideId/cancel", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.json({ error: "not found" });
  ride.status = "cancelled"; clearTimeout(ride.timer);
  cleanupRideOffers(ride.id);
  if (ride.acceptedBy) activeDriverRide.delete(ride.acceptedBy);
  dbSaveRide(ride).catch(() => {});
  res.json({ success: true });
});

app.post("/api/ride/:rideId/complete", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.json({ error: "not found" });
  ride.status = "completed";
  if (ride.acceptedBy) activeDriverRide.delete(ride.acceptedBy);
  dbSaveRide(ride).catch(() => {});
  res.json({ success: true });
});

app.get("/api/driver/:phone/active", (req, res) => {
  const rideId = activeDriverRide.get(req.params.phone);
  if (!rideId) return res.json({ active: null });
  const ride = rides.get(rideId);
  if (!ride || ride.status !== "accepted") return res.json({ active: null });
  res.json({ active: { rideId: ride.id, riderName: ride.riderName, riderLocation: ride.riderLocation } });
});

// ============================================================
// WHATSAPP MESSAGE HANDLERS
// ============================================================
async function handleText(from, name, text, req) {
  const lower = text.toLowerCase();
  if (["accept","yes","ok","y"].includes(lower)) return handleAccept(from, name, req);
  if (["reject","no","n","pass"].includes(lower)) return handleReject(from);
  if (lower === "cancel") return handleCancel(from);
  if (lower === "done") return handleDone(from);
  if (["offline","stop"].includes(lower)) {
    const d = drivers.get(from);
    if (d) { d.online = false; dbSaveDriver(d).catch(() => {}); }
    cleanupDriverOffer(from);
    return sendText(from, `You're offline now. Send "online" when ready to drive again.`);
  }
  if (["driver","online","سائق"].includes(lower)) {
    cleanupDriverOffer(from);
    let driver = drivers.get(from);
    if (!driver) { driver = { phone: from, name, online: true, location: null, lastGPS: null, pushSub: null }; drivers.set(from, driver); }
    else { driver.online = true; driver.name = name; }
    await dbSaveUser(from, name);
    await dbSaveDriver(driver);
    const base = getBaseUrl(req);
    return sendText(from, `Welcome, ${name}! 🛺\n\n📍 *Share your location now* (📎 → Location) so riders can find you.\n\nFor automatic GPS tracking: ${base}/driver?phone=${from}\n\nSend "offline" to stop.`);
  }
  if (["ride","taxi","tuktuk","تكتك"].includes(lower))
    return sendText(from, `🛺 Share your *location* (📎 → Location) and I'll find you the nearest tuk-tuk!`);

  const intent = await detectIntent(text);
  switch (intent) {
    case "ride": return sendText(from, `🛺 Share your *location* and I'll find you a tuk-tuk!`);
    case "driver": return sendText(from, `Send "online" to become a driver! 🛺`);
    case "accept": return handleAccept(from, name, req);
    case "reject": return handleReject(from);
    case "cancel": return handleCancel(from);
    case "done": return handleDone(from);
    case "offline": {
      const d = drivers.get(from); if (d) { d.online = false; dbSaveDriver(d).catch(() => {}); }
      return sendText(from, `You're offline now.`);
    }
    default: return sendText(from, await polish(`Welcome to Wasselni! 🛺 Need a ride? Send your location. Want to drive? Send "online". Need help? Send "cancel" or "done" during a ride.`, "General greeting"));
  }
}

async function handleLocation(from, name, loc, req) {
  const driver = drivers.get(from);
  if (driver && driver.online) {
    driver.location = loc;
    dbSaveDriver(driver).catch(() => {});
    const onlineCount = [...drivers.values()].filter(d => d.online && d.location).length;
    return sendText(from, `✅ You're now visible to riders, ${name}! ${onlineCount} driver${onlineCount !== 1 ? "s" : ""} online.\nRe-share your location when you move. Ride requests will come here.`);
  }
  const nearby = findNearbyDrivers(loc, [...drivers.values()], { maxKm: +MAX_RADIUS_KM, limit: +MAX_DRIVERS_PER_RIDE });
  if (nearby.length === 0)
    return sendText(from, await polish(`No tuk-tuks available near you right now. Please try again in a few minutes.`, "No drivers found near rider"));

  const rideId = generateRideId();
  const fare = Math.round((+FARE_BASE_LBP + distanceKm(loc, nearby[0].location) * +FARE_PER_KM_LBP) / 1000) * 1000;
  const ride = {
    id: rideId, riderPhone: from, riderName: name, riderLocation: loc,
    rideType: "ride", status: "pending", pingedDrivers: nearby.map(d => d.phone),
    acceptedBy: null, driverName: null, driverLocation: null, lastUpdate: null,
    fareEstimateLBP: fare, timer: null,
  };
  ride.timer = setTimeout(() => expireRide(rideId), RIDE_TIMEOUT_MS);
  rides.set(rideId, ride);
  for (const d of nearby) pendingOffers.set(d.phone, rideId);
  dbSaveRide(ride).catch(() => {});

  await sendText(from, await polish(`Looking for a tuk-tuk near you... asking ${nearby.length} driver${nearby.length > 1 ? "s" : ""}. You'll hear back shortly. Send "cancel" to cancel.`, "Searching for drivers"));
  for (const d of nearby) {
    const dist = d.distanceKm.toFixed(1);
    await sendText(d.phone, `🔔 *Ride request!*\nRider: ${name}\nDistance: ~${dist} km\n\nReply *accept* or *reject*`);
    await sendPush(d.phone, { title: "🔔 Ride Request!", body: `${name} — ${dist}km away`, rideId, type: "ride_request" });
  }
}

async function handleAccept(driverPhone, driverName, req) {
  const rideId = pendingOffers.get(driverPhone);
  if (!rideId) return sendText(driverPhone, `No pending ride request for you right now.`);
  const ride = rides.get(rideId);
  if (!ride || ride.status !== "pending") { pendingOffers.delete(driverPhone); return sendText(driverPhone, `That ride was already taken or cancelled.`); }
  ride.status = "accepted"; ride.acceptedBy = driverPhone; ride.driverName = driverName;
  clearTimeout(ride.timer);
  const driver = drivers.get(driverPhone);
  if (driver?.location) ride.driverLocation = driver.location;
  activeDriverRide.set(driverPhone, rideId);
  const dist = driver?.location ? distanceKm(ride.riderLocation, driver.location) : null;
  let etaText = "", distText = "";
  if (dist !== null) { distText = `~${dist.toFixed(1)}km away`; const eta = Math.max(2, Math.round((dist*1.4)/20*60)); etaText = `\n⏱ ~${eta} minutes`; }
  const base = getBaseUrl(req);
  await sendText(ride.riderPhone, await polish(`Driver found! ${driverName} ${distText}${etaText}\n\nTrack: ${base}/track/${rideId}?role=rider\nContact: wa.me/${driverPhone}\nSend "cancel" or "done" when done.`, "Driver accepted ride"));
  await sendText(driverPhone, `✅ Ride confirmed!\n\nRider: ${ride.riderName} ${distText}${etaText}\nContact: wa.me/${ride.riderPhone}\nSend "done" when complete.`);
  await sendLocation(driverPhone, ride.riderLocation.lat, ride.riderLocation.lng, `📍 ${ride.riderName}'s pickup`, "Tap for directions");
  for (const p of ride.pingedDrivers) { if (p !== driverPhone) { pendingOffers.delete(p); await sendText(p, `That ride was taken by another driver.`); } }
  pendingOffers.delete(driverPhone);
  dbSaveRide(ride).catch(() => {});
}

async function handleReject(driverPhone) {
  const rideId = pendingOffers.get(driverPhone);
  if (!rideId) return sendText(driverPhone, `No pending ride for you.`);
  pendingOffers.delete(driverPhone);
  await sendText(driverPhone, `OK, skipped. You'll get the next one.`);
  const ride = rides.get(rideId);
  if (ride && ride.status === "pending") {
    const remaining = ride.pingedDrivers.filter(p => pendingOffers.get(p) === rideId);
    if (remaining.length === 0) {
      ride.status = "rejected"; clearTimeout(ride.timer);
      dbSaveRide(ride).catch(() => {});
      await sendText(ride.riderPhone, await polish(`No drivers accepted right now. Please try again in a minute.`, "All drivers declined"));
    }
  }
}

async function handleCancel(from) {
  const riderRide = [...rides.values()].find(r => r.riderPhone === from && (r.status === "pending" || r.status === "accepted"));
  if (riderRide) {
    const wasAccepted = riderRide.status === "accepted";
    riderRide.status = "cancelled"; clearTimeout(riderRide.timer);
    cleanupRideOffers(riderRide.id);
    if (wasAccepted && riderRide.acceptedBy) { activeDriverRide.delete(riderRide.acceptedBy); await sendText(riderRide.acceptedBy, `❌ Rider cancelled. You're back online.`); }
    dbSaveRide(riderRide).catch(() => {});
    return sendText(from, `Ride cancelled. Send a new location whenever you need a ride.`);
  }
  const driverRideId = activeDriverRide.get(from);
  if (driverRideId) {
    const ride = rides.get(driverRideId);
    if (ride && ride.status === "accepted") {
      ride.status = "cancelled"; activeDriverRide.delete(from);
      await sendText(ride.riderPhone, await polish(`Your driver had to cancel. Send your location to find another tuk-tuk.`, "Driver cancelled"));
      dbSaveRide(ride).catch(() => {});
      return sendText(from, `Ride cancelled. You're back online.`);
    }
  }
  return sendText(from, `You don't have an active ride to cancel.`);
}

async function handleDone(from) {
  const riderRide = [...rides.values()].find(r => r.riderPhone === from && r.status === "accepted");
  if (riderRide) {
    riderRide.status = "completed";
    if (riderRide.acceptedBy) activeDriverRide.delete(riderRide.acceptedBy);
    dbSaveRide(riderRide).catch(() => {});
    await sendText(from, await polish(`Ride complete! Thanks for using Wasselni.`, "Ride finished successfully"));
    if (riderRide.acceptedBy) await sendText(riderRide.acceptedBy, `✅ Ride completed. You're back online.`);
    return;
  }
  const driverRideId = activeDriverRide.get(from);
  if (driverRideId) {
    const ride = rides.get(driverRideId);
    if (ride && ride.status === "accepted") {
      ride.status = "completed"; activeDriverRide.delete(from);
      dbSaveRide(ride).catch(() => {});
      await sendText(from, `✅ Ride completed. You're back online.`);
      await sendText(ride.riderPhone, await polish(`Ride complete! Thanks for using Wasselni.`, "Ride finished"));
      return;
    }
  }
  return sendText(from, `You don't have an active ride to complete.`);
}

async function expireRide(rideId) {
  const ride = rides.get(rideId);
  if (!ride || ride.status !== "pending") return;
  ride.status = "expired";
  cleanupRideOffers(rideId);
  dbSaveRide(ride).catch(() => {});
  await sendText(ride.riderPhone, await polish(`No driver accepted in time. Send your location to try again.`, "Ride request timed out"));
}

function cleanupDriverOffer(phone) { const rid = pendingOffers.get(phone); if (rid) pendingOffers.delete(phone); }
function cleanupRideOffers(rideId) { for (const [phone, rid] of pendingOffers) { if (rid === rideId) pendingOffers.delete(phone); } }

// Stale driver cleanup every 2 minutes
setInterval(async () => {
  const now = Date.now();
  for (const [phone, driver] of drivers) {
    if (driver.online && driver.lastGPS && (now - driver.lastGPS > STALE_DRIVER_MS)) {
      driver.online = false;
      console.log(`Driver ${phone} (${driver.name}) marked offline — no GPS for 10min`);
      dbSaveDriver(driver).catch(() => {});
    }
  }
}, 2 * 60 * 1000);

// ============================================================
// START
// ============================================================
app.listen(PORT, async () => {
  console.log(`Wasselni listening on :${PORT}`);
  await checkConfig();
  await dbLoadState();
});
