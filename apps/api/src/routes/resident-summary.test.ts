import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { alertRoutes } from './alerts';
import { registerErrorHandlers } from '../errors';
import { ALERT_VOICE } from '../agent/speech';

test('resident summaries use Kore Gemini TTS, label replay estimates, and reuse recordings', async () => {
  const app = Fastify(); registerErrorHandlers(app);
  const transcripts: string[] = [];
  await app.register(alertRoutes, { summarySpeaker: async (_run: string, text: string) => { transcripts.push(text); return Buffer.from('WAV'); } });
  try {
    assert.equal(ALERT_VOICE, 'Kore');
    const options = { method: 'POST' as const, url: '/resident-summary/audio', payload: { text: 'Jalan Guchil Jaya. High risk.' } };
    const first = await app.inject(options), second = await app.inject(options);
    assert.equal(first.statusCode, 200); assert.match(first.headers['content-type']!, /audio\/wav/);
    assert.equal(second.body, first.body); assert.equal(transcripts.length, 1);
    assert.match(transcripts[0], /^Historical replay model estimate\./);
    assert.equal((await app.inject({ ...options, payload: { text: '' } })).statusCode, 400);
    assert.equal((await app.inject({ ...options, payload: { text: 'x'.repeat(2401) } })).statusCode, 400);
  } finally { await app.close(); }
});

test('failed speech generation can be retried', async () => {
  const app = Fastify(); registerErrorHandlers(app); let calls = 0;
  await app.register(alertRoutes, { summarySpeaker: async () => { if (++calls === 1) throw new Error('temporary failure'); return Buffer.from('WAV'); } });
  try {
    const options = { method: 'POST' as const, url: '/resident-summary/audio', payload: { text: 'Replay summary' } };
    assert.equal((await app.inject(options)).statusCode, 500);
    assert.equal((await app.inject(options)).statusCode, 200);
  } finally { await app.close(); }
});
