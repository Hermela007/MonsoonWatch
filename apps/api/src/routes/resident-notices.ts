import type { FastifyInstance } from 'fastify';
import { COLLECTIONS, type Alert, type AreaWarning } from '@monsoonwatch/shared';
import { getDb } from '../db/client';
import { env } from '../env';
import { HttpError } from '../errors';

export interface ResidentNotices { alerts: Alert[]; areaWarnings: AreaWarning[] }
export async function loadResidentNotices(regionId: string): Promise<ResidentNotices> {
  if (env.mock) return { alerts: [], areaWarnings: [] };
  const db = await getDb();
  const filter = { regionId, status: { $in: ['approved', 'sent'] as const } };
  const [alerts, areaWarnings] = await Promise.all([
    db.collection<Alert>(COLLECTIONS.alerts).find(filter).sort({ approvedAt: -1 }).limit(500).toArray(),
    db.collection<AreaWarning>(COLLECTIONS.areaWarnings).find(filter).sort({ approvedAt: -1 }).limit(500).toArray(),
  ]);
  return { alerts, areaWarnings };
}

export async function residentNoticeRoutes(app: FastifyInstance, opts: { load?: typeof loadResidentNotices } = {}) {
  app.get<{ Querystring: { regionId?: string } }>('/resident-notices', async (req, reply) => {
    const regionId = req.query.regionId?.trim();
    if (!regionId) throw new HttpError(400, 'bad_request', 'regionId is required');
    reply.header('cache-control', 'no-store');
    return (opts.load ?? loadResidentNotices)(regionId);
  });
}
