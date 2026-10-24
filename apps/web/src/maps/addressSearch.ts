import type { LngLat } from '../geo/region';

export interface AddressSuggestion {
  /** e.g. "Jalan Pasar, Kuala Krai" */
  text: string;
  precision?: 'address' | 'street' | 'place';
  /** Resolve to a location. */
  resolve: () => Promise<{ lngLat: LngLat; label: string } | null>;
}

interface PhotonFeature {
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    osm_value?: string;
  };
}

/** A readable one-line address from OSM parts, without repeating itself. */
function describe(p: PhotonFeature['properties']) {
  const first = [p.housenumber, p.street].filter(Boolean).join(' ');
  const parts = [p.name, first, p.district, p.city ?? p.county].filter((x): x is string => !!x);
  return [...new Set(parts)].join(', ');
}

let inFlight: AbortController | null = null;

/**
 * Address search on OpenStreetMap data via Photon (komoot's free geocoder, made for search-as-you-type),
 * limited to Kelantan. Returns [] if the service is unreachable, so the village search still works.
 */
export async function searchAddresses(input: string, bbox: [number, number, number, number]): Promise<AddressSuggestion[]> {
  const q = input.trim();
  if (q.length < 3) return [];
  inFlight?.abort();
  const ctl = new AbortController();
  inFlight = ctl;
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const params = new URLSearchParams({ q, limit: '6', lang: 'en', bbox: bbox.join(',') });
    const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: ctl.signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { features?: PhotonFeature[] };
    const seen = new Set<string>();
    return (json.features ?? []).flatMap((f) => {
      const text = describe(f.properties);
      const [lng, lat] = f.geometry.coordinates;
      if (!text || seen.has(text) || !Number.isFinite(lng) || !Number.isFinite(lat)) return [];
      seen.add(text);
      const precision = f.properties.housenumber && f.properties.street ? 'address' : f.properties.street || f.properties.osm_value === 'residential' || f.properties.osm_value === 'road' ? 'street' : 'place';
      return [{ text, precision: precision as AddressSuggestion['precision'], resolve: async () => ({ lngLat: [lng, lat] as LngLat, label: text }) }];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
