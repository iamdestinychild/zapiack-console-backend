import { cityMapping } from 'city-timezones';

export interface Coordinates {
  lat: number;
  lng: number;
  /** How precise the point is: the city itself, or only the country's main city. */
  precision: 'city' | 'country';
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const byCity = new Map<string, { lat: number; lng: number; pop: number }>();
const byCountry = new Map<string, { lat: number; lng: number; pop: number }>();

// Built once at load. Where two places share a name within a country, the larger wins.
for (const c of cityMapping) {
  // A few rows (Kosovo) carry a numeric placeholder instead of an ISO code.
  if (
    typeof c.iso2 !== 'string' ||
    c.iso2.length !== 2 ||
    !Number.isFinite(c.lat) ||
    !Number.isFinite(c.lng)
  )
    continue;
  const country = c.iso2.toUpperCase();
  const entry = { lat: c.lat, lng: c.lng, pop: c.pop ?? 0 };
  for (const name of [c.city, c.city_ascii]) {
    if (!name) continue;
    const key = `${country}|${norm(name)}`;
    const seen = byCity.get(key);
    if (!seen || entry.pop > seen.pop) byCity.set(key, entry);
  }
  const top = byCountry.get(country);
  if (!top || entry.pop > top.pop) byCountry.set(country, entry);
}

/**
 * Offline lookup for the map. The product's activity log records a city and a country
 * code but no coordinates, so a dot is placed on the named city, or on the country's
 * largest city when the city is missing or unknown. Never calls an external service:
 * nothing about a request leaves the platform to be plotted.
 */
export function geocode(
  country?: string | null,
  city?: string | null,
): Coordinates | null {
  if (!country) return null;
  const cc = country.toUpperCase();
  if (city) {
    const hit = byCity.get(`${cc}|${norm(city)}`);
    if (hit) return { lat: hit.lat, lng: hit.lng, precision: 'city' };
  }
  const fallback = byCountry.get(cc);
  return fallback
    ? { lat: fallback.lat, lng: fallback.lng, precision: 'country' }
    : null;
}
