import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { EvacuationRoute } from '@monsoonwatch/shared';
import type { LngLat } from '../geo/region';

// OpenFreeMap: free vector tiles from OpenStreetMap, no key. "Positron" is a quiet light style that suits the app.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const marker = (cls: string, text = '') => {
  const el = document.createElement('div');
  el.className = `m2d ${cls}`;
  if (text) el.textContent = text;
  return el;
};

/**
 * The route screen's map (Citymapper-style): a flat OpenStreetMap street map with the evacuation route on
 * top — a bold line with a white casing, a start dot at home, the centre as the destination, numbered turns.
 * Resolves null if the map can't load (offline): the caller keeps the 3D route view.
 */
export async function createRouteMap2d(container: HTMLElement): Promise<RouteMap2d | null> {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: [102.2, 5.5],
    zoom: 13,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  const ok = await new Promise<boolean>((resolve) => {
    map.once('load', () => resolve(true));
    map.once('error', () => resolve(false));
    setTimeout(() => resolve(map.loaded()), 10000);
  });
  if (!ok) {
    map.remove();
    return null;
  }

  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const lineLayout = { 'line-cap': 'round', 'line-join': 'round' } as const;
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: lineLayout, paint: { 'line-color': '#fbfaf8', 'line-width': 11 } });
  map.addLayer({ id: 'route-core', type: 'line', source: 'route', layout: lineLayout, paint: { 'line-color': '#1d1d1b', 'line-width': 6 } });

  let markers: maplibregl.Marker[] = [];
  let turnEls: HTMLElement[] = [];
  let turnPts: LngLat[] = [];
  let lastPadding: Padding = { top: 0, right: 0, bottom: 0, left: 0 };

  const clear = () => {
    markers.forEach((m) => m.remove());
    markers = [];
    turnEls = [];
    turnPts = [];
    (map.getSource('route') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
  };

  return {
    show(route: EvacuationRoute, home: LngLat, padding: Padding, onTurn: (i: number) => void) {
      clear();
      // Size to the container now that it's visible.
      map.resize();
      const bounds = new maplibregl.LngLatBounds(home, home);
      markers.push(new maplibregl.Marker({ element: marker('m2d-home') }).setLngLat(home).addTo(map));
      if (route.status === 'ok' && route.geometry && route.centre) {
        const coords = route.geometry.coordinates as LngLat[];
        (map.getSource('route') as maplibregl.GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
        coords.forEach((c) => bounds.extend(c));
        turnPts = route.steps.map((s) => coords[Math.min(s.startIndex, coords.length - 1)]);
        turnPts.forEach((p, i) => {
          const el = marker('m2d-turn', String(i + 1));
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            onTurn(i);
          });
          turnEls.push(el);
          markers.push(new maplibregl.Marker({ element: el }).setLngLat(p).addTo(map));
        });
        const end = route.centre.lngLat as LngLat;
        const dest = marker('m2d-dest');
        dest.append(marker('m2d-dest-dot'), marker('m2d-dest-name', route.centre.name));
        markers.push(new maplibregl.Marker({ element: dest, anchor: 'bottom' }).setLngLat(end).addTo(map));
        bounds.extend(end);
      }
      // Extra room on the right and top for the destination's name label.
      lastPadding = { ...padding, right: padding.right + 110, top: padding.top + 30 };
      map.fitBounds(bounds, { padding: lastPadding, maxZoom: 17, duration: 900 });
    },
    selectTurn(i: number) {
      turnEls.forEach((el, k) => el.classList.toggle('on', k === i));
      const p = turnPts[i];
      // Centre it in the visible part of the map (clear of the panel), not behind it.
      if (p) map.easeTo({ center: p, zoom: Math.max(map.getZoom(), 17), padding: lastPadding, duration: 700 });
    },
    clear,
  };
}

export interface RouteMap2d {
  show(route: EvacuationRoute, home: LngLat, padding: Padding, onTurn: (i: number) => void): void;
  selectTurn(i: number): void;
  clear(): void;
}
