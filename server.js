// server.js — minimal WhatsApp bot (Meta Cloud API) that matches riders to nearby tuk-tuks.
// Flow:
//   Driver: sends "online" → shares location → becomes visible. "offline" to stop.
//   Rider:  shares location → gets the nearest tuk-tuks + drivers get pinged.

const express = require("express");
const { findNearbyDrivers } = require("./matching");

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,   // access token from Meta
  PHONE_NUMBER_ID,  // your WhatsApp Cloud API phone number ID
  VERIFY_TOKEN,     // any secret string you pick; used once for webhook setup
  PORT = 3000,
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0";

// ---- Startup diagnostics — prints what the bot is actually using ----
async function checkConfig() {
  const tokenPreview = WHATSAPP_TOKEN
    ? `${WHATSAPP_TOKEN.slice(0, 6)}...${WHATSAPP_TOKEN.slice(-4)} (${WHATSAPP_TOKEN.length} chars)`
    : "MISSING!";
  console.log(`== DIAGNOSTICS ==`);
  console.log(`PHONE_NUMBER_ID: ${PHONE_NUMBER_ID || "MISSING!"}`);
  console.log(`WHATSAPP_TOKEN:  ${tokenPreview}`);
  console.log(`VERIFY_TOKEN:    ${VERIFY_TOKEN ? "set" : "MISSING!"}`);

  // Test the token by asking Meta for the phone number info
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

// ---- Super-simple in-memory store. Resets on restart. Swap for Redis/Postgres later. ----
const drivers = new Map(); // phone -> { phone, name, online, location:{lat,lng} }

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
    console.error(`  URL was: ${url}`);
    console.error(`  Token starts with: ${WHATSAPP_TOKEN?.slice(0, 6)}`);
  } else {
    console.log(`message sent to ${to}`);
  }
}

// ---- Webhook verification (Meta calls this once when you connect the webhook) ----
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---- Incoming messages ----
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // acknowledge fast or Meta retries
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // sender's phone, e.g. "9617xxxxxxx"
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

async function handleText(from, name, text) {
  if (["driver", "online", "سائق"].includes(text)) {
    drivers.set(from, { phone: from, name, online: true, location: null });
    return sendText(
      from,
      `Hi ${name}! You're set as a tuk-tuk driver. 📍 Now share your *current location* (📎 → Location) so nearby riders can find you.\n\nSend "offline" anytime to stop.`
    );
  }
  if (text === "offline") {
    const d = drivers.get(from);
    if (d) d.online = false;
    return sendText(from, `You're now offline. Send "online" when you're driving again.`);
  }
  if (["ride", "taxi", "tuktuk", "تكتك"].includes(text)) {
    return sendText(from, `🛺 Share your *location* (📎 → Location) and I'll find the nearest tuk-tuk.`);
  }
  return sendText(
    from,
    `🛺 *Tuk-Tuk bot*\n\n• Need a ride? Send your *location* (📎 → Location).\n• Are you a driver? Send "online", then share your location.`
  );
}

async function handleLocation(from, name, loc) {
  const driver = drivers.get(from);

  // If an online driver sends a location, it's a position update.
  if (driver && driver.online) {
    driver.location = loc;
    driver.name = name;
    return sendText(
      from,
      `✅ Location updated, ${name}. You're visible to nearby riders. Re-share your location when you move to a new area.`
    );
  }

  // Otherwise it's a rider requesting a ride.
  const nearby = findNearbyDrivers(loc, [...drivers.values()], { maxKm: 5, limit: 3 });
  if (nearby.length === 0) {
    return sendText(from, `😕 No tuk-tuks available near you right now. Please try again in a few minutes.`);
  }

  const list = nearby
    .map((d, i) => `${i + 1}. ${d.name} — ${d.distanceKm.toFixed(1)} km away\n   wa.me/${d.phone}`)
    .join("\n");
  await sendText(from, `🛺 Nearest tuk-tuks:\n\n${list}\n\nTap a link to message a driver, or they'll reach out to you.`);

  // Ping each nearby driver about the request.
  for (const d of nearby) {
    await sendText(
      d.phone,
      `🔔 Ride request ~${d.distanceKm.toFixed(1)} km from you.\nRider: ${name}\nMessage them: wa.me/${from}`
    );
  }
}

app.listen(PORT, () => {
  console.log(`Tuk-tuk bot listening on :${PORT}`);
  checkConfig();
});
