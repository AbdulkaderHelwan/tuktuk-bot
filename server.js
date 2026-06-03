// server.js — WhatsApp tuk-tuk bot with AI-powered intent detection + response polishing.
// AI understands messy input (Arabic, English, Arabizi) and makes bot responses warmer.
// AI is NOT a chatbot — it's a brain (understand) and a voice (polish).

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { findNearbyDrivers, distanceKm } = require("./matching");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  OLLAMA_API_KEY,
  OLLAMA_MODEL = "gemma3:4b",
  PORT = 3000,
  BASE_URL = "",
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0";
const RIDE_TIMEOUT_MS = 3 * 60 * 1000;

// ---- State ----
const drivers = new Map();
const rides = new Map();
const pendingOffers = new Map();
const activeDriverRide = new Map();
let detectedBaseUrl = "";

// ---- Startup diagnostics ----
async function checkConfig() {
  const tp = WHATSAPP_TOKEN ? `${WHATSAPP_TOKEN.slice(0,6)}...${WHATSAPP_TOKEN.slice(-4)} (${WHATSAPP_TOKEN.length} chars)` : "MISSING!";
  console.log(`== DIAGNOSTICS ==`);
  console.log(`PHONE_NUMBER_ID: ${PHONE_NUMBER_ID || "MISSING!"}`);
  console.log(`WHATSAPP_TOKEN:  ${tp}`);
  console.log(`VERIFY_TOKEN:    ${VERIFY_TOKEN ? "set" : "MISSING!"}`);
  console.log(`OLLAMA_API_KEY:  ${OLLAMA_API_KEY ? "set" : "not set — AI disabled"}`);
  console.log(`OLLAMA_MODEL:    ${OLLAMA_MODEL}`);
  try {
    const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    const data = await res.json();
    if (data.error) console.log(`TOKEN TEST FAILED: ${JSON.stringify(data.error)}`);
    else console.log(`TOKEN TEST PASSED — phone: ${data.display_phone_number}, verified: ${data.verified_name}`);
  } catch (e) { console.log(`TOKEN TEST ERROR: ${e.message}`); }
  console.log(`=================`);
}

// ---- Helpers ----
function getBaseUrl(req) {
  if (BASE_URL) return BASE_URL;
  if (detectedBaseUrl) return detectedBaseUrl;
  detectedBaseUrl = `${req.protocol}://${req.get("host")}`;
  return detectedBaseUrl;
}
function generateRideId() { return "ride_" + crypto.randomBytes(6).toString("hex"); }

// ---- WhatsApp send ----
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
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "location", location: { latitude: lat, longitude: lng, name: name || "Location", address: address || "" } }),
  });
  if (!res.ok) console.error(`location send failed: ${await res.text()}`);
}

// ================= AI — two jobs: understand intent + polish responses =================

// Job 1: Detect what the user wants (returns a single word)
const INTENT_PROMPT = `You are an intent classifier for a tuk-tuk ride service in Lebanon.
Users write in English, Arabic, or Arabizi (Lebanese Arabic in Latin script like "kifak", "baddé", "shu").
Detect what the user wants. Reply with ONLY one word — the intent. Nothing else. No punctuation.

ride — wants a tuk-tuk ("baddi tuktuk", "need a ride", "send me one", "بدي توكتوك", "tuktuk please")
driver — wants to be a driver ("I want to drive", "بدي اشتغل", "sign me up")
accept — accepting a ride ("yalla", "ok", "meshé", "ماشي", "sure", "I'll take it")
reject — declining a ride ("no", "skip", "مش فاضي", "pass", "not now")
cancel — cancel something ("cancel", "الغي", "never mind", "ma baddé")
done — ride finished ("khalas", "arrived", "وصلت", "we're here", "done")
offline — stop driving ("stop", "بدي وقف", "done for today", "offline")
status — asking about their ride ("where's my driver", "any update", "وين السواق")
help — greeting, question, or anything else ("hi", "مرحبا", "how much", "shu howe")

Examples: "baddé tuktuk men dekwaneh" → ride | "yo where's my driver" → status | "مرحبا" → help | "yalla ok" → accept`;

// Job 2: Polish bot responses to be warmer (only for key messages)
const POLISH_PROMPT = `You are the voice of TukTuk, a tuk-tuk ride service in Lebanon.
Rewrite the given bot message to sound warmer and more helpful. Add a brief explanation if useful.
Rules:
- English only
- SHORT: 2-3 sentences max
- Keep any links or phone numbers exactly as-is
- Do NOT add false information
- Reply with ONLY the rewritten message — nothing else
- No preamble like "Here's a revised version"
- No questions like "Would you like me to..."
- No commentary or explanation of your changes
- Just the final message text, ready to send to the user`;

async function detectIntent(userMessage) {
  if (!OLLAMA_API_KEY) return null;
  try {
    const res = await fetch("https://ollama.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL, max_tokens: 20, temperature: 0,
        messages: [{ role: "system", content: INTENT_PROMPT }, { role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) { console.error(`AI intent error ${res.status}: ${await res.text()}`); return null; }
    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || "")
      .replace(/<think>[\s\S]*?<\/think>/g, "").trim().toLowerCase().replace(/[^a-z]/g, "");
    console.log(`AI intent: "${raw}" for "${userMessage}"`);
    return raw || null;
  } catch (e) { console.error("AI intent error:", e.message); return null; }
}

async function polish(rawMessage, situation) {
  if (!OLLAMA_API_KEY) return rawMessage;
  try {
    const res = await fetch("https://ollama.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL, max_tokens: 150, temperature: 0.5,
        messages: [
          { role: "system", content: POLISH_PROMPT },
          { role: "user", content: `Situation: ${situation}\nOriginal: ${rawMessage}\n\nRewrite:` },
        ],
      }),
    });
    if (!res.ok) return rawMessage;
    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || "")
      .replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // Strip AI commentary: remove preamble lines and trailing questions
    let polished = raw
      .replace(/^(here'?s?|okay|sure|of course|let me|i'?d be|absolutely)[^\n]*\n*/i, "")
      .replace(/\n*(would you|want me|shall i|let me know|hope this|feel free)[^\n]*/i, "")
      .replace(/^[""]|[""]$/g, "")
      .trim();
    if (polished.length > 10 && polished.length < 500) {
      console.log(`Polished: "${polished.slice(0, 80)}..."`);
      return polished;
    }
    return rawMessage;
  } catch (e) { return rawMessage; }
}

// ================= WEBHOOK =================

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
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
  } catch (e) { console.error("handler error:", e); }
});

// ================= PAGES & APIs =================

app.get("/driver", (req, res) => res.sendFile(path.join(__dirname, "public", "driver.html")));
app.get("/track/:rideId", (req, res) => res.sendFile(path.join(__dirname, "public", "tracking.html")));

app.post("/api/driver/location", (req, res) => {
  const { phone, lat, lng } = req.body;
  if (!phone || lat == null || lng == null) return res.json({ error: "missing" });
  let driver = drivers.get(phone);
  if (driver) { driver.location = { lat, lng }; driver.online = true; driver.lastGPS = Date.now(); }
  else { drivers.set(phone, { phone, name: phone, online: true, location: { lat, lng }, lastGPS: Date.now() }); }
  const rid = activeDriverRide.get(phone);
  if (rid) { const r = rides.get(rid); if (r && r.status === "accepted") { r.driverLocation = { lat, lng }; r.lastUpdate = Date.now(); } }
  res.json({ ok: true });
});

app.post("/api/driver/offline", (req, res) => {
  const d = drivers.get(req.body.phone); if (d) d.online = false; res.json({ ok: true });
});

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
  res.json({ driverLocation: ride.driverLocation, riderLocation: ride.riderLocation, driverName: ride.driverName || "Driver", status: ride.status, lastUpdate: ride.lastUpdate });
});

// ================= MESSAGE HANDLERS =================

async function handleText(from, name, text, req) {
  const lower = text.toLowerCase();

  // Fast path: exact keywords skip AI entirely (instant, free)
  if (["accept", "yes", "ok", "y"].includes(lower)) return handleAccept(from, name, req);
  if (["reject", "no", "n", "pass"].includes(lower)) return handleReject(from);
  if (lower === "cancel") return handleCancel(from);
  if (lower === "done") return handleDone(from);
  if (["offline", "stop"].includes(lower)) {
    const d = drivers.get(from);
    if (d) d.online = false;
    cleanupDriverOffer(from);
    return sendText(from, `You're offline now. Send "online" when you're ready to drive again. 🛺`);
  }
  if (["driver", "online", "سائق"].includes(lower)) {
    cleanupDriverOffer(from);
    drivers.set(from, { phone: from, name, online: true, location: null, lastGPS: null });
    const base = getBaseUrl(req);
    const url = `${base}/driver?phone=${from}`;
    return sendText(from,
      `Welcome, ${name}! 🛺\n\n📍 *Tap this link to go online:*\n${url}\n\nKeep the page open while you drive. You'll get ride requests here on WhatsApp.\n\nSend "offline" to stop.`
    );
  }
  if (["ride", "taxi", "tuktuk", "تكتك", "توكتوك"].includes(lower)) {
    return sendText(from, `🛺 Share your *location* (📎 → Location) and I'll find you the nearest tuk-tuk!`);
  }

  // Try AI intent detection for everything else
  const intent = await detectIntent(text);
  console.log(`Resolved intent: ${intent || "none"}`);

  // Route by intent (AI-detected or fallback)
  switch (intent) {
    case "ride":
      return sendText(from, await polish(
        `Share your location (📎 → Location) and I'll find you the nearest tuk-tuk!`,
        "User wants a ride but hasn't shared their location yet"
      ));

    case "driver": {
      cleanupDriverOffer(from);
      drivers.set(from, { phone: from, name, online: true, location: null, lastGPS: null });
      const base = getBaseUrl(req);
      const url = `${base}/driver?phone=${from}`;
      return sendText(from,
        `Welcome, ${name}! 🛺\n\n📍 *Tap this link to go online:*\n${url}\n\nKeep the page open while you drive. You'll get ride requests here on WhatsApp.\n\nSend "offline" to stop.`
      );
    }

    case "accept": return handleAccept(from, name, req);
    case "reject": return handleReject(from);
    case "cancel": return handleCancel(from);
    case "done": return handleDone(from);

    case "offline": {
      const d = drivers.get(from);
      if (d) d.online = false;
      cleanupDriverOffer(from);
      return sendText(from, `You're offline now. Send "online" when you're ready to drive again. 🛺`);
    }

    case "status": {
      const activeRide = [...rides.values()].find(r => (r.riderPhone === from || r.acceptedBy === from) && (r.status === "pending" || r.status === "accepted"));
      if (activeRide?.status === "accepted") {
        return sendText(from, await polish(`Your ride is in progress. Your driver is on the way.`, "User is checking on their active ride"));
      } else if (activeRide?.status === "pending") {
        return sendText(from, await polish(`We're still looking for a driver for you. Hang tight!`, "User is waiting for a driver to accept"));
      }
      return sendText(from, await polish(`You don't have an active ride right now. Send your location to request one!`, "User asked about ride status but has no active ride"));
    }

    case "help":
    default:
      // Greeting or unrecognized — friendly help message
      return sendText(from, await polish(
        `Welcome to TukTuk! 🛺 Need a ride? Just send your location. Want to drive? Send "online". You can also send "cancel" or "done" during a ride.`,
        "User greeted the bot or asked a general question"
      ));
  }
}

// ---- Rider sends location ----
async function handleLocation(from, name, loc, req) {
  const driver = drivers.get(from);
  if (driver && driver.online) {
    driver.location = loc;
    return sendText(from, `✅ Location updated, ${name}.`);
  }

  const nearby = findNearbyDrivers(loc, [...drivers.values()], { maxKm: 5, limit: 3 });
  if (nearby.length === 0) {
    return sendText(from, await polish(
      `No tuk-tuks available near you right now. Please try again in a few minutes.`,
      "No drivers are online near the rider. This could be because it's a quiet time of day, or drivers haven't gone online in this area yet. The rider should try again soon."
    ));
  }

  const rideId = generateRideId();
  const ride = {
    id: rideId, riderPhone: from, riderName: name, riderLocation: loc,
    status: "pending", pingedDrivers: nearby.map(d => d.phone),
    acceptedBy: null, driverName: null, driverLocation: null, lastUpdate: null, timer: null,
  };
  ride.timer = setTimeout(() => expireRide(rideId), RIDE_TIMEOUT_MS);
  rides.set(rideId, ride);
  for (const d of nearby) pendingOffers.set(d.phone, rideId);

  await sendText(from, await polish(
    `Looking for a tuk-tuk near you... asking ${nearby.length} driver${nearby.length > 1 ? "s" : ""}. You'll hear back shortly. Send "cancel" to cancel.`,
    "We found nearby drivers and are asking them to accept the ride"
  ));

  for (const d of nearby) {
    await sendText(d.phone, `🔔 *Ride request!*\nRider: ${name}\nDistance: ~${d.distanceKm.toFixed(1)} km\n\nReply *accept* to take it, or *reject* to pass.`);
  }
  console.log(`Ride ${rideId}: ${nearby.length} drivers pinged`);
}

// ---- Driver accepts ----
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
  if (dist !== null) {
    distText = `~${dist.toFixed(1)} km away`;
    const etaMin = Math.max(2, Math.round((dist * 1.4) / 20 * 60));
    etaText = `\n⏱ Estimated arrival: *~${etaMin} minutes*`;
  }

  const base = getBaseUrl(req);
  const riderTrackUrl = `${base}/track/${rideId}?role=rider`;

  await sendText(ride.riderPhone, await polish(
    `Driver found! Your driver: ${driverName} ${distText}${etaText}\n\nTrack your tuk-tuk live: ${riderTrackUrl}\n\nContact driver: wa.me/${driverPhone}\nSend "cancel" to cancel or "done" when you arrive.`,
    "A driver accepted the ride. The rider can now track them live."
  ));

  await sendText(driverPhone, `✅ *Ride confirmed!*\n\nRider: ${ride.riderName} ${distText}${etaText}\nContact: wa.me/${ride.riderPhone}\nSend "done" when complete.`);
  await sendLocation(driverPhone, ride.riderLocation.lat, ride.riderLocation.lng, `📍 ${ride.riderName}'s pickup`, "Tap for directions");

  for (const p of ride.pingedDrivers) { if (p !== driverPhone) { pendingOffers.delete(p); await sendText(p, `That ride was taken by another driver.`); } }
  pendingOffers.delete(driverPhone);
  console.log(`Ride ${rideId}: accepted by ${driverPhone}`);
}

// ---- Reject ----
async function handleReject(driverPhone) {
  const rideId = pendingOffers.get(driverPhone);
  if (!rideId) return sendText(driverPhone, `No pending ride request for you right now.`);
  pendingOffers.delete(driverPhone);
  await sendText(driverPhone, `OK, skipped. You'll get the next one.`);
  const ride = rides.get(rideId);
  if (ride && ride.status === "pending") {
    const remaining = ride.pingedDrivers.filter(p => pendingOffers.get(p) === rideId);
    if (remaining.length === 0) {
      ride.status = "rejected"; clearTimeout(ride.timer);
      await sendText(ride.riderPhone, await polish(
        `No drivers accepted your ride right now. Please try again in a minute.`,
        "All nearby drivers declined or didn't respond. The rider should try again — more drivers may come online."
      ));
    }
  }
}

// ---- Cancel ----
async function handleCancel(from) {
  const riderRide = [...rides.values()].find(r => r.riderPhone === from && (r.status === "pending" || r.status === "accepted"));
  if (riderRide) {
    const wasAccepted = riderRide.status === "accepted";
    riderRide.status = "cancelled"; clearTimeout(riderRide.timer);
    for (const dp of riderRide.pingedDrivers) { if (pendingOffers.get(dp) === riderRide.id) pendingOffers.delete(dp); }
    if (wasAccepted && riderRide.acceptedBy) { activeDriverRide.delete(riderRide.acceptedBy); await sendText(riderRide.acceptedBy, `❌ The rider cancelled. You're back online for new requests.`); }
    return sendText(from, `Ride cancelled. Send a new location whenever you need a ride.`);
  }
  const driverRideId = activeDriverRide.get(from);
  if (driverRideId) {
    const ride = rides.get(driverRideId);
    if (ride && ride.status === "accepted") {
      ride.status = "cancelled"; activeDriverRide.delete(from);
      await sendText(ride.riderPhone, await polish(`Your driver had to cancel. Send your location to find another tuk-tuk.`, "The driver cancelled on the rider. Encourage them to try again."));
      return sendText(from, `Ride cancelled. You're back online.`);
    }
  }
  return sendText(from, `You don't have an active ride to cancel.`);
}

// ---- Done ----
async function handleDone(from) {
  const riderRide = [...rides.values()].find(r => r.riderPhone === from && r.status === "accepted");
  if (riderRide) {
    riderRide.status = "completed";
    if (riderRide.acceptedBy) activeDriverRide.delete(riderRide.acceptedBy);
    await sendText(from, await polish(`Ride complete! Thanks for using TukTuk.`, "Ride finished successfully. Thank the rider warmly."));
    if (riderRide.acceptedBy) await sendText(riderRide.acceptedBy, `✅ Ride completed. You're back online.`);
    return;
  }
  const driverRideId = activeDriverRide.get(from);
  if (driverRideId) {
    const ride = rides.get(driverRideId);
    if (ride && ride.status === "accepted") {
      ride.status = "completed"; activeDriverRide.delete(from);
      await sendText(from, `✅ Ride completed. You're back online.`);
      await sendText(ride.riderPhone, await polish(`Ride complete! Thanks for using TukTuk.`, "Ride finished. Thank the rider."));
      return;
    }
  }
  return sendText(from, `You don't have an active ride to complete.`);
}

// ---- Expire ----
async function expireRide(rideId) {
  const ride = rides.get(rideId);
  if (!ride || ride.status !== "pending") return;
  ride.status = "expired";
  for (const dp of ride.pingedDrivers) { if (pendingOffers.get(dp) === rideId) pendingOffers.delete(dp); }
  await sendText(ride.riderPhone, await polish(
    `No driver accepted in time. Send your location to try again.`,
    "The 3-minute timer ran out with no driver accepting. Encourage the rider to try again."
  ));
}

function cleanupDriverOffer(phone) { const rid = pendingOffers.get(phone); if (rid) pendingOffers.delete(phone); }

// ---- Start ----
app.listen(PORT, () => { console.log(`Tuk-tuk bot listening on :${PORT}`); checkConfig(); });
