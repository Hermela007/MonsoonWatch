import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadAreaFor } from '../src/data/areas';

test('the Guchil recording address loads real nearby street geometry; uncovered points stay unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => new Response(await readFile(new URL(`../public${url}`, import.meta.url), 'utf8'))) as typeof fetch;
  try {
    const area = await loadAreaFor([102.21628, 5.54085]);
    assert.ok(area, 'recording address must have bundled coverage');
    assert.ok(area.buildings.some(b => b.ring.some(([lon, lat]) => Math.hypot((lon - 102.21628) * 110800, (lat - 5.54085) * 110570) < 100)), 'real buildings must be near the selected street');
    assert.ok(area.roads.some(r => r.line.some(([lon, lat]) => Math.hypot((lon - 102.21628) * 110800, (lat - 5.54085) * 110570) < 100)), 'mapped roads must be near the selected street');
    assert.equal(await loadAreaFor([100, 4]), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
