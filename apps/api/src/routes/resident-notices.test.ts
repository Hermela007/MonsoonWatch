import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Alert, AreaWarning } from '@monsoonwatch/shared';
import { residentNoticeRoutes } from './resident-notices';
import { registerErrorHandlers } from '../errors';

test('resident reload retrieves approved alerts and district warning IDs without replaying a run', async () => {
  const app = Fastify(); registerErrorHandlers(app);
  const regions: string[] = [];
  await app.register(residentNoticeRoutes, { load: async (region: string) => {
    regions.push(region);
    return { alerts: [{ _id: 'approved-village', status: 'approved' } as Alert], areaWarnings: [{ _id: 'area:approved', status: 'sent' } as AreaWarning] };
  } });
  try {
    const response = await app.inject('/resident-notices?regionId=kelantan');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(regions, ['kelantan']);
    assert.equal(response.json().alerts[0]._id, 'approved-village');
    assert.equal(response.json().areaWarnings[0]._id, 'area:approved');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal((await app.inject('/resident-notices')).statusCode, 400);
  } finally { await app.close(); }
});
