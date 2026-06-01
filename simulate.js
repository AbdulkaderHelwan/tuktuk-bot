// simulate.js — run this with `npm run simulate` to SEE the matching work,
// before you connect anything to WhatsApp.

const { findNearbyDrivers } = require("./matching");

// Pretend these drivers are online around a Beirut suburb (Dekwaneh-ish).
const drivers = [
  { phone: "9617000001", name: "Ali",    online: true,  location: { lat: 33.8700, lng: 35.5550 } },
  { phone: "9617000002", name: "Hassan", online: true,  location: { lat: 33.8735, lng: 35.5600 } },
  { phone: "9617000003", name: "Khaled", online: false, location: { lat: 33.8690, lng: 35.5540 } }, // offline → ignored
  { phone: "9617000004", name: "Sami",   online: true,  location: { lat: 33.9100, lng: 35.6000 } }, // too far → filtered
];

// A rider drops their pickup pin here.
const riderPickup = { lat: 33.8710, lng: 35.5560 };

console.log("Rider pickup:", riderPickup, "\n");

const nearby = findNearbyDrivers(riderPickup, drivers, { maxKm: 5, limit: 3 });

if (nearby.length === 0) {
  console.log("No tuk-tuks nearby.");
} else {
  console.log("Nearest tuk-tuks:");
  nearby.forEach((d, i) =>
    console.log(`  ${i + 1}. ${d.name}  —  ${d.distanceKm.toFixed(2)} km  (wa.me/${d.phone})`)
  );
}
