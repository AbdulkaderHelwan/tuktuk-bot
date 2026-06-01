// matching.js — the heart of "find a nearby tuk-tuk".
// No WhatsApp code here on purpose, so this part is easy to test and reuse.

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Haversine distance in kilometres between two {lat, lng} points.
function distanceKm(a, b) {
  const R = 6371; // Earth radius in km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Given a pickup point and all drivers, return the nearest online ones.
function findNearbyDrivers(pickup, drivers, { maxKm = 5, limit = 3 } = {}) {
  return drivers
    .filter((d) => d.online && d.location)
    .map((d) => ({ ...d, distanceKm: distanceKm(pickup, d.location) }))
    .filter((d) => d.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

module.exports = { distanceKm, findNearbyDrivers };
