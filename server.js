// server.js — WhatsApp tuk-tuk bot with broadcast-and-accept ride matching.
// Flow:
//   Driver: sends "online" → shares location → becomes visible. "offline" to stop.
//   Rider:  shares location → bot pings nearest drivers → first to ACCEPT wins →
//           rider gets driver info, driver gets rider info, others told "ride taken".

const express = require("express");
const { findNearbyDrivers } = require("./matching");

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  PORT = 3000,
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0";
const RIDE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes to accept before ride expires

// ---- Startup diagnostics ----
async function checkConfig() {
  const tokenPreview = WHATSAPP_TOKEN
    ? `${WHATSAPP_TOKEN.slice(0, 6)}...${WHATSAPP_TOKEN.slice(-4)} (${WHATSAPP_TOKEN.length} chars)`
    : "MISSING!";
  console.log(`== DIAGNOSTICS ==`);
  console.log(`PHONE_NUMBER_ID: ${PHONE_NUMBER_ID || "MISSING!"}`);
  console.log(`WHATSAPP_TOKEN:  ${tokenPreview}`);
  console.log(`VERIFY_TOKEN:    ${VERIFY_TOKEN ? "set" : "MISSING!"}`);
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

// ---- State stores (in-memory — swap for Redis/Postgres later) ----
const drivers = new Map();       // phone -> { phone, name, online, location }
const rides = new Map();         // rideId -> { id, riderPhone, riderName, riderLocation, status, pingedDrivers, acceptedBy, timer }
const pendingOffers = new Map(); // driverPhone -> rideId (reverse lookup: which ride was this driver pinged for?)

let rideCounter = 0;

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
      text: { body },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`send failed to ${to}: ${errBody}`);
  } else {
    console.log(`message sent to ${to}`);
  }
}

// ---- Webhook verification ----
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---- Incoming messages ----
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
      await handleLocation(from, name, {
        lat: msg.location.latitude,
        lng: msg.location.longitude,
      });
    } else if (msg.type === "text") {
      await handleText(from, name, msg.text.body.trim().toLowerCase());
    }
  } catch (e) {
    console.error("handler error:", e);
  }
});

// ---- Text message handler ----
async function handleText(from, name, text) {
  // Driver goes online
  if (["driver", "online", "سائق"].includes(text)) {
    // Clean up any pending ride offer this driver had
    cleanupDriverOffer(from);
    drivers.set(from, { phone: from, name, online: true, location: null });
    return sendText(
      from,
      `Hi ${name}! You're set as a tuk-tuk driver. 📍 Now share your *current location* (📎 → Location) so nearby riders can find you.\n\nSend "offline" anytime to stop.`
    );
  }

  // Driver goes offline
  if (text === "offline") {
    const d = drivers.get(from);
    if (d) d.online = false;
    cleanupDriverOffer(from);
    return sendText(from, `You're now offline. Send "online" when you're driving again.`);
  }

  // Driver accepts a ride
  if (["accept", "yes", "نعم", "ok", "y"].includes(text)) {
    return handleAccept(from, name);
  }

  // Driver rejects a ride
  if (["reject", "no", "لا", "n", "pass"].includes(text)) {
    return handleReject(from, name);
  }

  // Rider asks for a ride
  if (["ride", "taxi", "tuktuk", "تكتك"].includes(text)) {
    return sendText(from, `🛺 Share your *location* (📎 → Location) and I'll find you a tuk-tuk.`);
  }

  // Rider wants to cancel
  if (text === "cancel") {
    return handleCancel(from);
  }

  // Default help
  return sendText(
    from,
    `🛺 *Tuk-Tuk bot*\n\n• Need a ride? Send your *location* (📎 → Location).\n• Are you a driver? Send "online", then share your location.\n• Cancel a ride? Send "cancel".`
  );
}

// ---- Location handler ----
async function handleLocation(from, name, loc) {
  const driver = drivers.get(from);

  // If an online driver sends a location, update their position.
  if (driver && driver.online) {
    driver.location = loc;
    driver.name = name;
    return sendText(
      from,
      `✅ Location updated, ${name}. You're visible to nearby riders. Re-share when you move to a new area.`
    );
  }

  // Otherwise it's a rider requesting a ride — start the broadcast-and-accept flow.
  const nearby = findNearbyDrivers(loc, [...drivers.values()], { maxKm: 5, limit: 3 });
  if (nearby.length === 0) {
    return sendText(from, `😕 No tuk-tuks available near you right now. Please try again in a few minutes.`);
  }

  // Create a ride request
  const rideId = `ride_${++rideCounter}`;
  const ride = {
    id: rideId,
    riderPhone: from,
    riderName: name,
    riderLocation: loc,
    status: "pending",
    pingedDrivers: nearby.map((d) => d.phone),
    acceptedBy: null,
    timer: null,
  };

  // Set a timeout — if no driver accepts in 3 minutes, expire the ride
  ride.timer = setTimeout(() => expireRide(rideId), RIDE_TIMEOUT_MS);

  rides.set(rideId, ride);

  // Map each pinged driver to this ride (so we know what "accept" means when they reply)
  for (const d of nearby) {
    pendingOffers.set(d.phone, rideId);
  }

  // Tell the rider we're looking
  await sendText(from, `🔍 Looking for a tuk-tuk near you... I'm asking ${nearby.length} nearby driver${nearby.length > 1 ? "s" : ""}. You'll hear back shortly.\n\nSend "cancel" to cancel.`);

  // Ping each nearby driver
  for (const d of nearby) {
    await sendText(
      d.phone,
      `🔔 *Ride request!*\nRider: ${name}\nDistance: ~${d.distanceKm.toFixed(1)} km from you\n\nReply *accept* to take this ride, or *reject* to pass.`
    );
  }

  console.log(`Ride ${rideId}: ${nearby.length} drivers pinged for rider ${from}`);
}

// ---- Driver accepts ----
async function handleAccept(driverPhone, driverName) {
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
  clearTimeout(ride.timer);

  const driver = drivers.get(driverPhone);
  const distKm = driver?.location
    ? require("./matching").distanceKm(ride.riderLocation, driver.location)
    : null;
  const distText = distKm !== null ? `~${distKm.toFixed(1)} km away` : "";

  // Tell the rider
  await sendText(
    ride.riderPhone,
    `✅ *Driver found!*\n\nYour driver: ${driverName} ${distText}\nContact them: wa.me/${driverPhone}\n\nThey're on the way!`
  );

  // Confirm to the driver
  await sendText(
    driverPhone,
    `✅ *Ride confirmed!*\n\nRider: ${ride.riderName}\nContact: wa.me/${ride.riderPhone}\n\nHead to their location. Safe driving!`
  );

  // Tell the other pinged drivers the ride is taken
  for (const otherPhone of ride.pingedDrivers) {
    if (otherPhone !== driverPhone) {
      pendingOffers.delete(otherPhone);
      await sendText(otherPhone, `That ride was taken by another driver.`);
    }
  }
  pendingOffers.delete(driverPhone);

  console.log(`Ride ${rideId}: accepted by ${driverPhone}`);
}

// ---- Driver rejects ----
async function handleReject(driverPhone, driverName) {
  const rideId = pendingOffers.get(driverPhone);
  if (!rideId) {
    return sendText(driverPhone, `No pending ride request for you right now.`);
  }

  pendingOffers.delete(driverPhone);
  await sendText(driverPhone, `OK, skipped. You'll get the next one.`);

  // Check if all drivers have rejected
  const ride = rides.get(rideId);
  if (ride && ride.status === "pending") {
    const remainingDrivers = ride.pingedDrivers.filter((p) => pendingOffers.get(p) === rideId);
    if (remainingDrivers.length === 0) {
      // Everyone rejected
      ride.status = "rejected";
      clearTimeout(ride.timer);
      await sendText(
        ride.riderPhone,
        `😕 No drivers accepted your ride right now. Please try again in a minute — more drivers may come online.`
      );
      console.log(`Ride ${rideId}: all drivers rejected`);
    }
  }
}

// ---- Rider cancels ----
async function handleCancel(riderPhone) {
  // Find this rider's pending ride
  const ride = [...rides.values()].find(
    (r) => r.riderPhone === riderPhone && r.status === "pending"
  );
  if (!ride) {
    return sendText(riderPhone, `You don't have an active ride request to cancel.`);
  }

  ride.status = "cancelled";
  clearTimeout(ride.timer);

  // Notify pinged drivers
  for (const driverPhone of ride.pingedDrivers) {
    if (pendingOffers.get(driverPhone) === ride.id) {
      pendingOffers.delete(driverPhone);
      await sendText(driverPhone, `The rider cancelled the request.`);
    }
  }

  await sendText(riderPhone, `Ride cancelled. Send a new location whenever you need a ride.`);
  console.log(`Ride ${ride.id}: cancelled by rider`);
}

// ---- Ride expires (no one accepted in time) ----
async function expireRide(rideId) {
  const ride = rides.get(rideId);
  if (!ride || ride.status !== "pending") return;

  ride.status = "expired";

  // Clean up pending offers
  for (const driverPhone of ride.pingedDrivers) {
    if (pendingOffers.get(driverPhone) === rideId) {
      pendingOffers.delete(driverPhone);
    }
  }

  await sendText(
    ride.riderPhone,
    `⏰ No driver accepted in time. Please try again — send your location to search for available tuk-tuks.`
  );
  console.log(`Ride ${rideId}: expired`);
}

// ---- Cleanup helper ----
function cleanupDriverOffer(driverPhone) {
  const rideId = pendingOffers.get(driverPhone);
  if (rideId) pendingOffers.delete(driverPhone);
}

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Tuk-tuk bot listening on :${PORT}`);
  checkConfig();
});
