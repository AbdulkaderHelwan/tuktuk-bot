// server.js — WhatsApp tuk-tuk bot with broadcast-accept matching + live tracking map.
// Flow:
//   Driver: "online" → shares location → visible. "offline" to stop.
//   Rider:  shares location → nearest drivers pinged → first to ACCEPT wins →
//           both get a live tracking map link → rider watches tuk-tuk approach in real time.

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
  PORT = 3000,
  BASE_URL = "",  // e.g. https://tuktuk-bot-1.onrender.com — auto-detected if empty
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0";
const RIDE_TIMEOUT_MS = 3 * 60 * 1000; // 3 min to accept

// ---- State stores (in-memory — swap for Redis/Postgres later) ----
const drivers = new Map();        // phone -> { phone, name, online, location }
const rides = new Map();          // rideId -> { id, riderPhone, riderName, riderLocation, status, pingedDrivers, acceptedBy, driverName, driverLocation, timer, lastUpdate }
const pendingOffers = new Map();  // driverPhone -> rideId
const activeDriverRide = new Map(); // driverPhone -> rideId (for accepted rides, to update location)

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
  console.log(`BASE_URL:        ${BASE_URL || "(will auto-detect from first request)"}`);
  try {
    const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const data = await res.json();
    if (data.error) {
      console.log(`TOKEN TEST FAILED: ${JSON.stringify(data.error)}`);
    } else {
      console.log(`TOKEN TEST PASSED — phone: ${data.display_phone_number}, verified: ${data.verified_name}`);
    }
  } catch (e) {
    console.log(`TOKEN TEST ERROR: ${e.message}`);
  }
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

// ---- Send a WhatsApp text message ----
async function sendText(to, body) {
  const url = `${GRAPH}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { preview_url: true, body },
    }),
  });
  if (!res.ok) {
    console.error(`send failed to ${to}: ${await res.text()}`);
  } else {
    console.log(`message sent to ${to}`);
  }
}

// ---- Send a WhatsApp location pin (tappable — opens Maps for navigation) ----
async function sendLocation(to, lat, lng, name, address) {
  const url = `${GRAPH}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "location",
      location: { latitude: lat, longitude: lng, name: name || "Location", address: address || "" },
    }),
  });
  if (!res.ok) {
    console.error(`location send failed to ${to}: ${await res.text()}`);
  } else {
    console.log(`location sent to ${to}`);
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

    if (msg.type === "location") {
      await handleLocation(from, name, { lat: msg.location.latitude, lng: msg.location.longitude }, req);
    } else if (msg.type === "text") {
      await handleText(from, name, msg.text.body.trim().toLowerCase(), req);
    }
  } catch (e) {
    console.error("handler error:", e);
  }
});

// ================= TRACKING API =================

// Serve tracking page
app.get("/track/:rideId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "tracking.html"));
});

// Driver's browser posts GPS updates
app.post("/api/track/:rideId/location", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride || ride.status !== "accepted") return res.json({ error: "ride not active" });

  const { lat, lng } = req.body;
  ride.driverLocation = { lat, lng };
  ride.lastUpdate = Date.now();

  // Also update the driver's location in the drivers store
  if (ride.acceptedBy) {
    const driver = drivers.get(ride.acceptedBy);
    if (driver) driver.location = { lat, lng };
  }

  res.json({ ok: true });
});

// Rider's browser polls for driver location
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
  if (["driver", "online", "سائق"].includes(text)) {
    cleanupDriverOffer(from);
    drivers.set(from, { phone: from, name, online: true, location: null });
    return sendText(from,
      `Hi ${name}! You're set as a tuk-tuk driver. 📍 Now share your *current location* (📎 → Location) so nearby riders can find you.\n\nSend "offline" anytime to stop.`
    );
  }
  if (text === "offline") {
    const d = drivers.get(from);
    if (d) d.online = false;
    cleanupDriverOffer(from);
    return sendText(from, `You're now offline. Send "online" when you're driving again.`);
  }
  if (["accept", "yes", "نعم", "ok", "y"].includes(text)) {
    return handleAccept(from, name, req);
  }
  if (["reject", "no", "لا", "n", "pass"].includes(text)) {
    return handleReject(from, name);
  }
  if (["ride", "taxi", "tuktuk", "تكتك"].includes(text)) {
    return sendText(from, `🛺 Share your *location* (📎 → Location) and I'll find you a tuk-tuk.`);
  }
  if (text === "cancel") {
    return handleCancel(from);
  }
  if (text === "done") {
    return handleDone(from);
  }
  return sendText(from,
    `🛺 *Tuk-Tuk bot*\n\n• Need a ride? Send your *location*\n• Driver? Send "online" + share location\n• Cancel a ride? Send "cancel"\n• Finish a ride? Send "done"`
  );
}

async function handleLocation(from, name, loc, req) {
  const driver = drivers.get(from);

  if (driver && driver.online) {
    driver.location = loc;
    driver.name = name;

    // Also update tracking for any active ride this driver has
    const activeRideId = activeDriverRide.get(from);
    if (activeRideId) {
      const ride = rides.get(activeRideId);
      if (ride && ride.status === "accepted") {
        ride.driverLocation = loc;
        ride.lastUpdate = Date.now();
      }
    }

    return sendText(from, `✅ Location updated, ${name}. You're visible to nearby riders.`);
  }

  // Rider requesting a ride
  const nearby = findNearbyDrivers(loc, [...drivers.values()], { maxKm: 5, limit: 3 });
  if (nearby.length === 0) {
    return sendText(from, `😕 No tuk-tuks available near you right now. Please try again in a few minutes.`);
  }

  const rideId = generateRideId();
  const ride = {
    id: rideId,
    riderPhone: from,
    riderName: name,
    riderLocation: loc,
    status: "pending",
    pingedDrivers: nearby.map((d) => d.phone),
    acceptedBy: null,
    driverName: null,
    driverLocation: null,
    lastUpdate: null,
    timer: null,
  };
  ride.timer = setTimeout(() => expireRide(rideId), RIDE_TIMEOUT_MS);
  rides.set(rideId, ride);

  for (const d of nearby) {
    pendingOffers.set(d.phone, rideId);
  }

  await sendText(from, `🔍 Looking for a tuk-tuk near you... asking ${nearby.length} driver${nearby.length > 1 ? "s" : ""}. You'll hear back shortly.\n\nSend "cancel" to cancel.`);

  for (const d of nearby) {
    await sendText(d.phone,
      `🔔 *Ride request!*\nRider: ${name}\nDistance: ~${d.distanceKm.toFixed(1)} km from you\n\nReply *accept* to take this ride, or *reject* to pass.`
    );
  }
  console.log(`Ride ${rideId}: ${nearby.length} drivers pinged for rider ${from}`);
}

// ---- Driver accepts ----
async function handleAccept(driverPhone, driverName, req) {
  const rideId = pendingOffers.get(driverPhone);
  if (!rideId) {
    return sendText(driverPhone, `No pending ride request for you right now.`);
  }
  const ride = rides.get(rideId);
  if (!ride || ride.status !== "pending") {
    pendingOffers.delete(driverPhone);
    return sendText(driverPhone, `Sorry, that ride was already taken or cancelled.`);
  }

  // Match!
  ride.status = "accepted";
  ride.acceptedBy = driverPhone;
  ride.driverName = driverName;
  clearTimeout(ride.timer);

  const driver = drivers.get(driverPhone);
  if (driver?.location) {
    ride.driverLocation = driver.location;
  }

  // Track which ride this driver is on
  activeDriverRide.set(driverPhone, rideId);

  // Calculate ETA
  const dist = driver?.location ? distanceKm(ride.riderLocation, driver.location) : null;
  let etaText = "";
  let distText = "";
  if (dist !== null) {
    distText = `~${dist.toFixed(1)} km away`;
    const etaMin = Math.max(1, Math.round((dist * 1.4) / 20 * 60));
    etaText = `\n⏱ Estimated arrival: *~${Math.max(2, etaMin)} minutes*`;
  }

  // Build tracking URLs
  const base = getBaseUrl(req);
  const riderTrackUrl = `${base}/track/${rideId}?role=rider`;
  const driverTrackUrl = `${base}/track/${rideId}?role=driver`;

  // Tell the rider — tracking link opens inside WhatsApp, no separate browser
  await sendText(ride.riderPhone,
    `✅ *Driver found!*\n\nYour driver: ${driverName} ${distText}${etaText}\n\n📍 *Track your tuk-tuk live — tap here:*\n${riderTrackUrl}\n\nContact driver: wa.me/${driverPhone}\n\nSend "cancel" to cancel or "done" when you arrive.`
  );

  // Tell the driver — one tap starts GPS sharing automatically + send pickup pin for navigation
  await sendText(driverPhone,
    `✅ *Ride confirmed!*\n\nRider: ${ride.riderName} ${distText}${etaText}\n\n📍 *Tap to start — shares your location with the rider automatically:*\n${driverTrackUrl}\n\nSend "done" when the ride is complete.`
  );

  // Send the rider's pickup location as a tappable pin — driver taps to open Maps/Waze
  await sendLocation(driverPhone, ride.riderLocation.lat, ride.riderLocation.lng, `📍 ${ride.riderName}'s pickup`, "Tap for directions");

  // Tell other drivers it's taken
  for (const otherPhone of ride.pingedDrivers) {
    if (otherPhone !== driverPhone) {
      pendingOffers.delete(otherPhone);
      await sendText(otherPhone, `That ride was taken by another driver.`);
    }
  }
  pendingOffers.delete(driverPhone);
  console.log(`Ride ${rideId}: accepted by ${driverPhone}, tracking active`);
}

// ---- Driver rejects ----
async function handleReject(driverPhone) {
  const rideId = pendingOffers.get(driverPhone);
  if (!rideId) {
    return sendText(driverPhone, `No pending ride request for you right now.`);
  }
  pendingOffers.delete(driverPhone);
  await sendText(driverPhone, `OK, skipped. You'll get the next one.`);

  const ride = rides.get(rideId);
  if (ride && ride.status === "pending") {
    const remaining = ride.pingedDrivers.filter((p) => pendingOffers.get(p) === rideId);
    if (remaining.length === 0) {
      ride.status = "rejected";
      clearTimeout(ride.timer);
      await sendText(ride.riderPhone, `😕 No drivers accepted your ride right now. Please try again in a minute.`);
      console.log(`Ride ${rideId}: all drivers rejected`);
    }
  }
}

// ---- Cancel (works for pending AND accepted rides) ----
async function handleCancel(from) {
  // Check if this is a rider cancelling
  const ride = [...rides.values()].find(
    (r) => r.riderPhone === from && (r.status === "pending" || r.status === "accepted")
  );
  if (ride) {
    const wasAccepted = ride.status === "accepted";
    ride.status = "cancelled";
    clearTimeout(ride.timer);

    // Clean up pending offers
    for (const dp of ride.pingedDrivers) {
      if (pendingOffers.get(dp) === ride.id) pendingOffers.delete(dp);
    }

    // If ride was already accepted, notify the driver
    if (wasAccepted && ride.acceptedBy) {
      activeDriverRide.delete(ride.acceptedBy);
      await sendText(ride.acceptedBy, `❌ The rider cancelled the ride. You're back online for new requests.`);
    }

    await sendText(from, `Ride cancelled. Send a new location whenever you need a ride.`);
    console.log(`Ride ${ride.id}: cancelled by rider ${wasAccepted ? "(was accepted)" : "(was pending)"}`);
    return;
  }

  // Check if this is a driver cancelling their active ride
  const driverRideId = activeDriverRide.get(from);
  if (driverRideId) {
    const dRide = rides.get(driverRideId);
    if (dRide && dRide.status === "accepted") {
      dRide.status = "cancelled";
      activeDriverRide.delete(from);
      await sendText(dRide.riderPhone, `❌ Your driver had to cancel. Send your location to find another tuk-tuk.`);
      await sendText(from, `Ride cancelled. You're back online for new requests.`);
      console.log(`Ride ${driverRideId}: cancelled by driver`);
      return;
    }
  }

  return sendText(from, `You don't have an active ride to cancel.`);
}

// ---- Done (either party can end the ride) ----
async function handleDone(from) {
  // Check if rider
  const riderRide = [...rides.values()].find(
    (r) => r.riderPhone === from && r.status === "accepted"
  );
  if (riderRide) {
    riderRide.status = "completed";
    if (riderRide.acceptedBy) activeDriverRide.delete(riderRide.acceptedBy);
    await sendText(from, `🎉 Ride complete! Thanks for using TukTuk. Send a location anytime for your next ride.`);
    if (riderRide.acceptedBy) {
      await sendText(riderRide.acceptedBy, `✅ Ride completed. You're back online — send "offline" if you're done for the day.`);
    }
    console.log(`Ride ${riderRide.id}: completed`);
    return;
  }

  // Check if driver
  const driverRideId = activeDriverRide.get(from);
  if (driverRideId) {
    const dRide = rides.get(driverRideId);
    if (dRide && dRide.status === "accepted") {
      dRide.status = "completed";
      activeDriverRide.delete(from);
      await sendText(from, `✅ Ride completed. You're back online — send "offline" if you're done for the day.`);
      await sendText(dRide.riderPhone, `🎉 Ride complete! Thanks for using TukTuk. Send a location anytime for your next ride.`);
      console.log(`Ride ${dRide.id}: completed by driver`);
      return;
    }
  }

  return sendText(from, `You don't have an active ride to complete.`);
}

// ---- Ride expires ----
async function expireRide(rideId) {
  const ride = rides.get(rideId);
  if (!ride || ride.status !== "pending") return;
  ride.status = "expired";
  for (const dp of ride.pingedDrivers) {
    if (pendingOffers.get(dp) === rideId) pendingOffers.delete(dp);
  }
  await sendText(ride.riderPhone, `⏰ No driver accepted in time. Send your location to try again.`);
  console.log(`Ride ${rideId}: expired`);
}

// ---- Cleanup ----
function cleanupDriverOffer(driverPhone) {
  const rideId = pendingOffers.get(driverPhone);
  if (rideId) pendingOffers.delete(driverPhone);
}

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Tuk-tuk bot listening on :${PORT}`);
  checkConfig();
});
