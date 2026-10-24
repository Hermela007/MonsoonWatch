import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAddresses } from '../src/maps/addressSearch';

test('address search distinguishes buildings, streets and place centres; resolves the selected coordinates', async t => {
  const requests: string[] = [];
  const features = [
    { geometry: { type: 'Point', coordinates: [102.2, 5.53] }, properties: { housenumber: '12', street: 'Jalan Pasar', city: 'Kuala Krai' } },
    { geometry: { type: 'Point', coordinates: [102.21, 5.54] }, properties: { street: 'Jalan Pasar', city: 'Kuala Krai' } },
    { geometry: { type: 'Point', coordinates: [102.19, 5.52] }, properties: { name: 'Kuala Krai', osm_value: 'town' } },
  ];
  t.mock.method(globalThis, 'fetch', async (url: string) => { requests.push(String(url)); return Response.json({ features }); });
  const suggestions = await searchAddresses('Jalan Pasar', [101.3,4.53,102.7,6.27]);
  assert.deepEqual(suggestions.map(s => s.precision), ['address', 'street', 'place']);
  assert.match(suggestions[0].text, /^12 Jalan Pasar/);
  assert.deepEqual(await suggestions[0].resolve(), { lngLat: [102.2,5.53], label: '12 Jalan Pasar, Kuala Krai' });
  assert.equal(requests.length, 1, 'confirming a result does not geocode a second, potentially different point');
  const query = new URL(requests[0]).searchParams;
  assert.equal(query.get('bbox'), '101.3,4.53,102.7,6.27');
});

test('unavailable address provider leaves village and map fallback available', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  assert.deepEqual(await searchAddresses('Jalan Pasar', [101.3,4.53,102.7,6.27]), []);
});
