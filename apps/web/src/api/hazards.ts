import type { Hazards, LngLat, RiskLevel } from '@monsoonwatch/shared';
export interface HazardScenario extends Hazards {
  approximate: true;
  assessedAt: string;
  version: string;
  gauges: { id: string; name: string; lngLat: LngLat; levelM: number; level: RiskLevel; stale: boolean; thresholds: { alert: number } }[];
  gaugesWithoutReading: { id: string; lngLat?: LngLat }[];
  roadStatusCounts: { flooded: number; clear: number; unknown: number; outsideFloodplain: number };
  coverage: { bbox: [number, number, number, number] };
  limitations: string[];
  landslideLabel: string;
}
/** A new selection invalidates both successful and failed responses from an older request. */
export function createScenarioLoader(onResult: (scenario: HazardScenario | null, error?: string) => void, request: typeof fetch = fetch) {
  let controller: AbortController | undefined;
  let revision = 0;
  return {
    clear() { revision++; controller?.abort(); onResult(null); },
    async load(regionId: string, mode: 'live' | 'replay', ts?: string) {
      const mine = ++revision;
      controller?.abort(); controller = new AbortController();
      const activeController = controller;
      onResult(null);
      const timeout = setTimeout(() => activeController.abort(), 30000);
      try {
        const query = new URLSearchParams({ mode, ...(ts ? { ts } : {}) });
        const res = await request(`/api/regions/${encodeURIComponent(regionId)}/hazards?${query}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Hazard model unavailable (HTTP ${res.status})`);
        const data = await res.json() as HazardScenario;
        if (data.regionId !== regionId || data.mode !== mode || !data.gauges || !data.coverage || !data.roadStatusCounts || !data.landslide) throw new Error('Incomplete hazard response');
        if (mine === revision) onResult(data);
      } catch (err) {
        if (mine === revision) onResult(null, err instanceof Error ? err.message : String(err));
      } finally { clearTimeout(timeout); }
    },
  };
}
