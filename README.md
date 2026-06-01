# Tuk-Tuk WhatsApp Bot (MVP)

Matches riders with the nearest available tuk-tuk over WhatsApp. No app to install — everyone uses WhatsApp they already have.

## How it works

- **Driver** sends `online`, then shares their location (📎 → Location). They're now visible.
- **Rider** shares their location. The bot replies with the 1–3 nearest tuk-tuks and pings those drivers with the rider's contact. They coordinate directly.
- Driver sends `offline` to stop.

## See it work in 10 seconds (no setup)

```bash
npm run simulate
```

This runs the matching logic against fake drivers and prints the nearest ones. No WhatsApp account needed — it proves the core works before you connect anything.

## Connect it to WhatsApp (free to start)

1. **Node 18+** required. Install deps: `npm install`
2. Create a free app at **developers.facebook.com** → add the **WhatsApp** product. You get a test phone number, a temporary access token, and a Phone Number ID. (Test mode lets you message up to 5 numbers you whitelist — perfect for piloting. Production needs business verification, but Meta gives you 1,000 free conversations/month.)
3. Set environment variables:
   ```bash
   export WHATSAPP_TOKEN="your_access_token"
   export PHONE_NUMBER_ID="your_phone_number_id"
   export VERIFY_TOKEN="pick_any_secret_string"
   ```
4. Run it: `npm start`
5. Expose it to the internet so Meta can reach your webhook. Easiest while testing:
   ```bash
   npx ngrok http 3000
   ```
   Copy the `https://…ngrok…` URL.
6. In the Meta dashboard → WhatsApp → Configuration → set the **Callback URL** to `https://…ngrok…/webhook`, the **Verify token** to the same `VERIFY_TOKEN`, and **subscribe to the `messages` field**.
7. Test: from a whitelisted phone, message your test number `online` and share a location. From a second phone, send a location — you should get the nearest driver back.

## Honest limitations of this version (and the easy upgrades)

- **Driver locations go stale.** A driver shares a pin, then drives off. For one small zone with short sessions this is fine. **Upgrade:** when a rider requests, broadcast to the nearest few drivers ("ride near X — reply YES") and connect whoever accepts first. This sidesteps stale locations entirely and is the most worthwhile next step.
- **Data resets on restart** (it's in memory). Move `drivers` to Redis or Postgres before any real pilot.
- **Numbers are shared between rider and driver.** That's exactly how the street already works, so it's fine for an MVP — just be transparent about it.
- **No fares, ratings, or payments yet.** Deliberately. Cash on pickup, fixed local fare. Add the rest only once people are actually using it.

## What this is for

Validate the real questions cheaply: do riders request, do drivers show up, what fares stick, what breaks. Run it by hand in one zone first. Build the standalone app only once this is busy enough that you want yourself out of the loop.
