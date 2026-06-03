// server.js — WhatsApp tuk-tuk bot with:
//   - Driver goes online by tapping ONE link (GPS auto-shares from browser)
//   - Rider shares location → nearest drivers pinged → first to ACCEPT wins
//   - Rider gets live tracking map showing tuk-tuk approaching
//   - Cancel/done work for both sides at any stage

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
  OLLAMA_MODEL = "qwen3:4b",  // good Arabic support, fast, free on Ollama Cloud
  PORT = 3000,
  BASE_URL = "",
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0";
const RIDE_TIMEOUT_MS = 3 * 60 * 1000;

// ---- State ----
const drivers = new Map();         // phone -> { phone, name, online, location, lastGPS }
const rides = new Map();           // rideId -> ride object
const pendingOffers = new Map();   // driverPhone -> rideId
const activeDriverRide = new Map();// driverPhone -> rideId

let detectedBaseUrl = "";

// ---- Startup diagnostics ----
async function checkConfig() {
  const tokenPreview = WHATSAPP_TOKEN
    ? `${WHATSAPP_TOKEN.slice(0, 6)}...${WHATSAPP_TOKEN.slice(-4)} (${WHATSAPP_TOKEN.length} chars)`
    : "MISSING!";
  console.log(`== DIAGNOSTICS ==`);
  console.log(`PHONE_NUMBER_ID: ${PHONE_NUMBER_ID || "MISSING!"}`);
  console.log(`WHATSAPP_TOKEN:  ${tokenPreview}`);
  console.log(`VERIFY_TOKEN:    ${VERIFY_TOKEN ? "set" : "MISSING!"}`);
  console.log(`OLLAMA_API_KEY:  ${OLLAMA_API_KEY ? "set" : "not set — AI disabled, keyword-only mode"}`);
  console.log(`OLLAMA_MODEL:    ${OLLAMA_MODEL}`);
  try {
    const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
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

function generateRideId() {
  return "ride_" + crypto.randomBytes(6).toString("hex");
}

// ---- Send WhatsApp text ----
async function sendText(to, body) {
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { preview_url: true, body } }),
  });
  if (!res.ok) console.error(`send failed to ${to}: ${await res.text()}`);
  else console.log(`message sent to ${to}`);
}

// ---- Send WhatsApp location pin ----
async function sendLocation(to, lat, lng, name, address) {
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "location", location: { latitude: lat, longitude: lng, name: name || "Location", address: address || "" } }),
  });
  if (!res.ok) console.error(`location send failed to ${to}: ${await res.text()}`);
  else console.log(`location sent to ${to}`);
}

// ================= AI (Claude Haiku — understands Arabic, English, Arabizi) =================

const AI_SYSTEM_PROMPT = `You are the TukTuk bot 🛺, a friendly tuk-tuk ride assistant in Lebanon.
You speak Arabic, English, and Arabizi (Lebanese Arabic in Latin letters like "kifak", "baddé", "shu").
Always reply in the SAME language the user wrote in. Keep replies SHORT (1-3 sentences max).

Your job: figure out what the user wants and respond helpfully.

You MUST reply with valid JSON only, nothing else. Format:
{"intent": "...", "message": "..."}

Intents:
- "ride_request" — user wants a tuk-tuk ride (any phrasing: "بدي توكتوك", "need a ride", "send me a tuktuk", etc.)
- "driver_online" — user wants to work as a driver ("بدي اشتغل", "I want to drive", "sign me up as driver")
- "accept_ride" — user wants to accept a ride ("ماشي", "yalla", "I'll take it", "أنا جاي")
- "reject_ride" — user wants to skip a ride ("مش فاضي", "skip", "not now")
- "cancel" — user wants to cancel ("الغي", "cancel my ride", "ma baddé")
- "done" — ride is finished ("وصلت", "arrived", "khalas")
- "offline" — driver wants to stop ("بدي وقف", "I'm done for today")
- "status" — user asks about their ride or where the driver is
- "chat" — general conversation, greeting, question about pricing/service, anything else

For "status" intent, include a helpful message. For "chat" intent, be warm and Lebanese-friendly.
For action intents, include a SHORT confirmation message in the user's language.

Examples:
User: "مرحبا" → {"intent": "chat", "message": "أهلاً وسهلاً! 🛺 بدك توكتوك؟ ابعتلي موقعك وبلاقيلك أقرب واحد."}
User: "baddé tuktuk" → {"intent": "ride_request", "message": "يلا! ابعتلي موقعك (📎 → Location) لا لاقيلك أقرب توكتوك 🛺"}
User: "I want to be a driver" → {"intent": "driver_online", "message": "Welcome! Let me set you up as a driver 🛺"}
User: "shu l as3ar?" → {"intent": "chat", "message": "الأسعار بتختلف حسب المسافة، بس بشكل عام أرخص بكتير من التاكسي! ابعتلي موقعك وبقلك 🛺"}
User: "yalla meshé" → {"intent": "accept_ride", "message": "تمام! 🛺"}
User: "khalas wselna" → {"intent": "done", "message": "شكراً! 🎉"}`;

async function askAI(userMessage, context) {
  if (!OLLAMA_API_KEY) {
    console.log("No OLLAMA_API_KEY — falling back to keyword matching");
    return null;
  }
  try {
    const contextNote = context ? `\n[Context: ${context}]` : "";
    const res = await fetch("https://ollama.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OLLAMA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        max_tokens: 200,
        temperature: 0.3,
        messages: [
          { role: "system", content: AI_SYSTEM_PROMPT },
          { role: "user", content: userMessage + contextNote },
        ],
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    // Parse JSON from response (strip markdown fences and thinking tags if present)
    const clean = text
      .replace(/<think>[\s\S]*?<\/think>/g, "")  // remove thinking tags (Qwen uses these)
      .replace(/```json|```/g, "")
      .trim();
    const parsed = JSON.parse(clean);
    console.log(`AI intent: ${parsed.intent} for "${userMessage}"`);
    return parsed;
  } catch (e) {
    console.error("AI error:", e.message);
    return null;
  }
}

// ================= WEBHOOK =================

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;
    const name = value?.contacts?.[0]?.profile?.name || "there";
    console.log(`Incoming ${msg.type} from ${from} (${name})`);

    if (msg.type === "text") {
      await handleText(from, name, msg.text.body.trim().toLowerCase(), req);
    } else if (msg.type === "location") {
      await handleLocation(from, name, { lat: msg.location.latitude, lng: msg.location.longitude }, req);
    }
  } catch (e) { console.error("handler error:", e); }
});

// ================= PAGES =================

app.get("/driver", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "driver.html"));
});

app.get("/track/:rideId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "tracking.html"));
});

// ================= DRIVER GPS API (browser page sends these) =================

// Driver's browser page posts GPS continuously
app.post("/api/driver/location", (req, res) => {
  const { phone, lat, lng } = req.body;
  if (!phone || lat == null || lng == null) return res.json({ error: "missing fields" });

  let driver = drivers.get(phone);
  if (driver) {
    driver.location = { lat, lng };
    driver.online = true;
    driver.lastGPS = Date.now();
  } else {
    driver = { phone, name: phone, online: true, location: { lat, lng }, lastGPS: Date.now() };
    drivers.set(phone, driver);
    console.log(`Driver ${phone} auto-registered via GPS page`);
  }

  // Update active ride tracking too
  const activeRideId = activeDriverRide.get(phone);
  if (activeRideId) {
    const ride = rides.get(activeRideId);
    if (ride && ride.status === "accepted") {
      ride.driverLocation = { lat, lng };
      ride.lastUpdate = Date.now();
    }
  }
  res.json({ ok: true });
});

// Driver page "Go Offline"
app.post("/api/driver/offline", (req, res) => {
  const { phone } = req.body;
  const driver = drivers.get(phone);
  if (driver) { driver.online = false; console.log(`Driver ${phone} offline via page`); }
  res.json({ ok: true });
});

// ================= RIDE TRACKING API (tracking page uses these) =================

app.post("/api/track/:rideId/location", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride || ride.status !== "accepted") return res.json({ error: "ride not active" });
  const { lat, lng } = req.body;
  ride.driverLocation = { lat, lng };
  ride.lastUpdate = Date.now();
  if (ride.acceptedBy) {
    const driver = drivers.get(ride.acceptedBy);
    if (driver) driver.location = { lat, lng };
  }
  res.json({ ok: true });
});

app.get("/api/track/:rideId/status", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.json({ error: "ride not found" });
  res.json({
    driverLocation: ride.driverLocation || null,
    riderLocation: ride.riderLocation,
    driverName: ride.driverName || "Your Driver",
    status: ride.status,
    lastUpdate: ride.lastUpdate || null,
  });
});

// ================= MESSAGE HANDLERS =================

async function handleText(from, name, text, req) {
  // Driver goes online — send them the GPS page link (one tap, done for the day)
  if (["driver", "online", "سائق"].includes(text)) {
    cleanupDriverOffer(from);
    drivers.set(from, { phone: from, name, online: true, location: null, lastGPS: null });
    const base = getBaseUrl(req);
    const driverUrl = `${base}/driver?phone=${from}`;
    return sendText(from,
      `Hi ${name}! 🛺\n\n📍 *Tap this link to go online — it shares your location automatically:*\n${driverUrl}\n\nKeep the page open while you drive. Riders nearby will find you and you'll get ride requests here on WhatsApp.\n\nSend "offline" anytime to stop.`
    );
  }

  if (text === "offline") {
    const d = drivers.get(from);
    if (d) d.online = false;
    cleanupDriverOffer(from);
    return sendText(from, `You're now offline. Send "online" when you're driving again.`);
  }

  if (["accept", "yes", "نعم", "ok", "y"].includes(text)) return handleAccept(from, name, req);
  if (["reject", "no", "لا", "n", "pass"].includes(text)) return handleReject(from);
  if (text === "cancel") return handleCancel(from);
  if (text === "done") return handleDone(from);

  if (["ride", "taxi", "tuktuk", "تكتك"].includes(text)) {
    return sendText(from, `🛺 Share your *location* (📎 → Location) and I'll find you a tuk-tuk.`);
  }

  // ---- AI handles everything else: natural language in Arabic, English, Arabizi ----
  const driver = drivers.get(from);
  const activeRide = [...rides.values()].find(
    r => (r.riderPhone === from || r.acceptedBy === from) && (r.status === "pending" || r.status === "accepted")
  );
  const context = [
    driver?.online ? "User is a registered online driver" : "",
    activeRide?.status === "pending" ? "User has a pending ride request" : "",
    activeRide?.status === "accepted" ? "User has an active ride in progress" : "",
  ].filter(Boolean).join(". ") || "New user, no active ride";

  const ai = await askAI(text, context);

  if (!ai) {
    // AI unavailable — show basic help
    return sendText(from,
      `🛺 *Tuk-Tuk bot*\n\n• Need a ride? Send your *location*\n• Driver? Send "online"\n• Cancel a ride? Send "cancel"\n• Finish a ride? Send "done"`
    );
  }

  // Route AI-detected intents to the right handler
  switch (ai.intent) {
    case "ride_request":
      return sendText(from, ai.message || `🛺 Share your *location* (📎 → Location) and I'll find you a tuk-tuk.`);
    case "driver_online":
      // Trigger the actual online flow
      cleanupDriverOffer(from);
      drivers.set(from, { phone: from, name, online: true, location: null, lastGPS: null });
      const base = getBaseUrl(req);
      const driverUrl = `${base}/driver?phone=${from}`;
      return sendText(from,
        `${ai.message}\n\n📍 *Tap this link to go online:*\n${driverUrl}\n\nKeep the page open while you drive.`
      );
    case "accept_ride":
      return handleAccept(from, name, req);
    case "reject_ride":
      return handleReject(from);
    case "cancel":
      return handleCancel(from);
    case "done":
      return handleDone(from);
    case "offline":
      const d = drivers.get(from);
      if (d) d.online = false;
      cleanupDriverOffer(from);
      return sendText(from, ai.message || `You're now offline.`);
    case "status":
      if (activeRide?.status === "accepted") {
        return sendText(from, ai.message || `Your ride is in progress.`);
      } else if (activeRide?.status === "pending") {
        return sendText(from, ai.message || `Looking for a driver... please wait.`);
      }
      return sendText(from, ai.message || `You don't have an active ride right now.`);
    default:
      // "chat" or unknown — just send the AI's conversational response
      return sendText(from, ai.message);
  }
}

// Rider sends location → find nearest drivers
async function handleLocation(from, name, loc, req) {
  // If a registered online driver sends a WhatsApp location, update them too
  const driver = drivers.get(from);
  if (driver && driver.online) {
    driver.location = loc;
    return sendText(from, `✅ Location updated, ${name}.`);
  }

  // Rider flow
  const nearby = findNearbyDrivers(loc, [...drivers.values()], { maxKm: 5, limit: 3 });
  if (nearby.length === 0) {
    return sendText(from, `😕 No tuk-tuks available near you right now. Please try again in a few minutes.`);
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

  await sendText(from, `🔍 Looking for a tuk-tuk near you... asking ${nearby.length} driver${nearby.length > 1 ? "s" : ""}. You'll hear back shortly.\n\nSend "cancel" to cancel.`);

  for (const d of nearby) {
    await sendText(d.phone,
      `🔔 *Ride request!*\nRider: ${name}\nDistance: ~${d.distanceKm.toFixed(1)} km from you\n\nReply *accept* to take this ride, or *reject* to pass.`
    );
  }
  console.log(`Ride ${rideId}: ${nearby.length} drivers pinged`);
}

// ---- Driver accepts ----
async function handleAccept(driverPhone, driverName, req) {
  const rideId = pendingOffers.get(driverPhone);
  if (!rideId) return sendText(driverPhone, `No pending ride request for you right now.`);

  const ride = rides.get(rideId);
  if (!ride || ride.status !== "pending") {
    pendingOffers.delete(driverPhone);
    return sendText(driverPhone, `Sorry, that ride was already taken or cancelled.`);
  }

  ride.status = "accepted";
  ride.acceptedBy = driverPhone;
  ride.driverName = driverName;
  clearTimeout(ride.timer);

  const driver = drivers.get(driverPhone);
  if (driver?.location) ride.driverLocation = driver.location;

  activeDriverRide.set(driverPhone, rideId);

  // ETA
  const dist = driver?.location ? distanceKm(ride.riderLocation, driver.location) : null;
  let etaText = "", distText = "";
  if (dist !== null) {
    distText = `~${dist.toFixed(1)} km away`;
    const etaMin = Math.max(2, Math.round((dist * 1.4) / 20 * 60));
    etaText = `\n⏱ Estimated arrival: *~${etaMin} minutes*`;
  }

  // Tracking URL for rider
  const base = getBaseUrl(req);
  const riderTrackUrl = `${base}/track/${rideId}?role=rider`;

  // Tell the rider — with live tracking map link
  await sendText(ride.riderPhone,
    `✅ *Driver found!*\n\nYour driver: ${driverName} ${distText}${etaText}\n\n📍 *Track your tuk-tuk live — tap here:*\n${riderTrackUrl}\n\nContact driver: wa.me/${driverPhone}\nSend "cancel" to cancel or "done" when you arrive.`
  );

  // Tell the driver + send pickup pin for navigation
  await sendText(driverPhone,
    `✅ *Ride confirmed!*\n\nRider: ${ride.riderName} ${distText}${etaText}\n\nContact rider: wa.me/${ride.riderPhone}\nSend "done" when the ride is complete.`
  );
  await sendLocation(driverPhone, ride.riderLocation.lat, ride.riderLocation.lng, `📍 ${ride.riderName}'s pickup`, "Tap for directions");

  // Tell other drivers
  for (const p of ride.pingedDrivers) {
    if (p !== driverPhone) {
      pendingOffers.delete(p);
      await sendText(p, `That ride was taken by another driver.`);
    }
  }
  pendingOffers.delete(driverPhone);
  console.log(`Ride ${rideId}: accepted by ${driverPhone}`);
}

// ---- Driver rejects ----
async function handleReject(driverPhone) {
  const rideId = pendingOffers.get(driverPhone);
  if (!rideId) return sendText(driverPhone, `No pending ride request for you right now.`);
  pendingOffers.delete(driverPhone);
  await sendText(driverPhone, `OK, skipped. You'll get the next one.`);

  const ride = rides.get(rideId);
  if (ride && ride.status === "pending") {
    const remaining = ride.pingedDrivers.filter(p => pendingOffers.get(p) === rideId);
    if (remaining.length === 0) {
      ride.status = "rejected";
      clearTimeout(ride.timer);
      await sendText(ride.riderPhone, `😕 No drivers accepted your ride right now. Please try again in a minute.`);
    }
  }
}

// ---- Cancel (pending or accepted, rider or driver) ----
async function handleCancel(from) {
  const riderRide = [...rides.values()].find(r => r.riderPhone === from && (r.status === "pending" || r.status === "accepted"));
  if (riderRide) {
    const wasAccepted = riderRide.status === "accepted";
    riderRide.status = "cancelled";
    clearTimeout(riderRide.timer);
    for (const dp of riderRide.pingedDrivers) {
      if (pendingOffers.get(dp) === riderRide.id) pendingOffers.delete(dp);
    }
    if (wasAccepted && riderRide.acceptedBy) {
      activeDriverRide.delete(riderRide.acceptedBy);
      await sendText(riderRide.acceptedBy, `❌ The rider cancelled the ride. You're back online for new requests.`);
    }
    await sendText(from, `Ride cancelled. Send a new location whenever you need a ride.`);
    return;
  }

  const driverRideId = activeDriverRide.get(from);
  if (driverRideId) {
    const ride = rides.get(driverRideId);
    if (ride && ride.status === "accepted") {
      ride.status = "cancelled";
      activeDriverRide.delete(from);
      await sendText(ride.riderPhone, `❌ Your driver had to cancel. Send your location to find another tuk-tuk.`);
      await sendText(from, `Ride cancelled. You're back online for new requests.`);
      return;
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
    await sendText(from, `🎉 Ride complete! Thanks for using TukTuk. Send a location anytime for your next ride.`);
    if (riderRide.acceptedBy) await sendText(riderRide.acceptedBy, `✅ Ride completed. You're back online.`);
    return;
  }
  const driverRideId = activeDriverRide.get(from);
  if (driverRideId) {
    const ride = rides.get(driverRideId);
    if (ride && ride.status === "accepted") {
      ride.status = "completed";
      activeDriverRide.delete(from);
      await sendText(from, `✅ Ride completed. You're back online.`);
      await sendText(ride.riderPhone, `🎉 Ride complete! Thanks for using TukTuk.`);
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
  for (const dp of ride.pingedDrivers) {
    if (pendingOffers.get(dp) === rideId) pendingOffers.delete(dp);
  }
  await sendText(ride.riderPhone, `⏰ No driver accepted in time. Send your location to try again.`);
}

function cleanupDriverOffer(phone) {
  const rideId = pendingOffers.get(phone);
  if (rideId) pendingOffers.delete(phone);
}

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Tuk-tuk bot listening on :${PORT}`);
  checkConfig();
});
