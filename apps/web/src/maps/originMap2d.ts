import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LngLat } from '../geo/region';

/** A starting-point preview. It never requests a route or stores the address. */
export async function createOriginMap(container: HTMLElement, onMove: (point: LngLat) => void) {
  const map = new maplibregl.Map({ container, style: 'https://tiles.openfreemap.org/styles/positron', center: [102.2, 5.5], zoom: 16, dragRotate: false, pitchWithRotate: false, attributionControl: { compact: true } });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  const loaded = await new Promise<boolean>(resolve => {
    const timeout = setTimeout(() => resolve(false), 10000);
    map.once('load', () => { clearTimeout(timeout); resolve(true); });
    map.once('error', () => { clearTimeout(timeout); resolve(false); });
  });
  if (!loaded) { map.remove(); return null; }
  const element = document.createElement('div'); element.className = 'origin-pin'; element.setAttribute('aria-label', 'Starting point pin');
  const pin = new maplibregl.Marker({ element, draggable: true, anchor: 'bottom' }).setLngLat([102.2, 5.5]).addTo(map);
  pin.on('dragend', () => { const point = pin.getLngLat(); onMove([point.lng, point.lat]); });
  map.on('click', event => { const point: LngLat = [event.lngLat.lng, event.lngLat.lat]; pin.setLngLat(point); onMove(point); });
  return {
    show(point: LngLat, broad: boolean) {
      map.resize(); pin.setLngLat(point);
      const phone = innerWidth < 768;
      map.jumpTo({ center: point, zoom: broad ? 14 : 17, padding: phone ? { top: 60, right: 12, bottom: Math.min(innerHeight * .48, 380), left: 12 } : { top: 70, right: 40, bottom: 40, left: 450 } });
    },
    setPoint(point: LngLat) { pin.setLngLat(point); },
    destroy() { pin.remove(); map.remove(); },
  };
}
