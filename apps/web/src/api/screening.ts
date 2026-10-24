import type { Hazards } from '@monsoonwatch/shared';
import { replayDate } from '../data/replay2014';
import { getJson } from './client';
import { buildRunoutTimeline, type ScreenRunout } from '../terrain/screening';

// Replay hours (from 15 Dec 00:00 MYT) of the hazards snapshots: daily, denser around the 20–24 Dec rain.
const DAYS = [16, 18, 20, 21, 22, 23, 24, 26, 28];
export const SCREEN_HOURS = DAYS.map((d) => (d - 15) * 24);

let loading: Promise<ScreenRunout[] | null> | null = null;

/**
 * The agent's landslide runouts across the replay, from GET /regions/:id/hazards (one region-wide snapshot per
 * day, loaded once and shared by every place). Null if the hazards API is unavailable — callers then fall back
 * to the local terrain estimate, labelled as such.
 */
export function loadScreening(regionId: string): Promise<ScreenRunout[] | null> {
  if (loading) return loading;
  loading = (async () => {
    const snaps = await Promise.all(
      SCREEN_HOURS.map(async (hour) => {
        const ts = replayDate(hour).toISOString();
        const h = await getJson<Hazards>(`/regions/${encodeURIComponent(regionId)}/hazards?mode=replay&ts=${encodeURIComponent(ts)}`, 20000);
        return h ? { hour, landslide: h.landslide } : null;
      }),
    );
    const ok = snaps.filter((s): s is NonNullable<typeof s> => !!s);
    return ok.length ? buildRunoutTimeline(ok) : null;
  })();
  loading.then((r) => r === null && (loading = null)); // retry next time if the API was down
  return loading;
}
