import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeServer } from '../src/bandlab-server.mjs';

async function fixture(t, options = {}) {
  const bridge = createBridgeServer({ commandTimeoutMs: 100, pollMs: 30, ...options });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const req = async (path, body, headers = {}) => {
    return new Promise((resolve, reject) => {
      const outgoing = http.request(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bridge.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(res.headers), body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const arm = async () => (await req('/v1/arm', { tabId: 3, url: 'https://www.bandlab.com/studio/abc', title: 'Test Studio' })).body.sessionId;
  return { bridge, req, arm };
}
test('requires token, rejects hostile origins/hosts, and never grants CORS', async t => {
  const { req } = await fixture(t);
  assert.equal((await req('/v1/status', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await req('/v1/arm', { tabId: 3, url: 'https://www.bandlab.com/studio' }, { Authorization: '' })).status, 401);
  assert.equal((await req('/v1/status', undefined, { Origin: 'https://www.bandlab.com' })).status, 403);
  assert.equal((await req('/v1/status', undefined, { Host: 'attacker.example' })).status, 403);
  const good = await req('/v1/status'); assert.equal(good.status, 200); assert.equal(good.headers.get('access-control-allow-origin'), null);
});
test('requires explicit Studio arm and recent heartbeat', async t => {
  const { req, arm } = await fixture(t, { heartbeatMs: 15 });
  assert.equal((await req('/v1/command', { action: 'snapshot' })).status, 409);
  assert.equal((await req('/v1/arm', { tabId: 3, url: 'https://www.bandlab.com/feed' })).status, 400);
  await arm(); await new Promise(r => setTimeout(r, 25));
  assert.equal((await req('/v1/command', { action: 'snapshot' })).status, 409);
});
test('queued timeout is not dispatched and cannot be replayed', async t => {
  const { req, arm } = await fixture(t); const sessionId = await arm();
  const expired = await req('/v1/command', { action: 'snapshot' });
  assert.equal(expired.status, 504); assert.equal(expired.body.outcome, 'not_dispatched');
  assert.equal((await req('/v1/poll', { sessionId })).body.command, null);
});
test('delivered timeout quarantines the session and declares outcome unknown', async t => {
  const { req, arm } = await fixture(t); const sessionId = await arm();
  const queued = req('/v1/command', { action: 'snapshot' });
  const polled = await req('/v1/poll', { sessionId }); assert.equal(polled.body.command.action, 'snapshot');
  const expired = await queued; assert.equal(expired.body.outcome, 'unknown'); assert.equal(expired.body.doNotRetry, true);
  assert.equal((await req('/v1/command', { action: 'snapshot' })).status, 409);
  assert.equal((await req('/v1/result', { sessionId, commandId: polled.body.command.id, result: { ok: true } })).status, 409);
});
test('validates snapshot, beforeValue, allowed actions and single flight', async t => {
  const { req, arm } = await fixture(t, { commandTimeoutMs: 1000 }); const sessionId = await arm();
  const queued = req('/v1/command', { action: 'snapshot' });
  const { command } = (await req('/v1/poll', { sessionId })).body;
  assert.equal((await req('/v1/command', { action: 'snapshot' })).status, 409);
  const snapshot = { snapshotId: 'test', fingerprint: 'hash', createdAt: Date.now(), controls: [{ id: 'gain', value: '1', actions: ['set'] }] };
  await req('/v1/result', { sessionId, commandId: command.id, result: { ok: true, snapshot } }); assert.equal((await queued).status, 200);
  const mutation = { action: 'set', snapshotId: 'test', fingerprint: 'hash', controlId: 'gain', beforeValue: '1', afterValue: '2' };
  assert.equal((await req('/v1/command', { ...mutation, snapshotId: 'stale' })).status, 409);
  assert.equal((await req('/v1/command', { ...mutation, beforeValue: '0' })).status, 400);
  assert.equal((await req('/v1/command', { ...mutation, action: 'click' })).status, 400);
  const changing = req('/v1/command', mutation), next = (await req('/v1/poll', { sessionId })).body.command;
  assert.equal(next.action, 'set'); assert.equal('selector' in next, false);
  await req('/v1/result', { sessionId, commandId: next.id, result: { ok: true, verification: { verified: true } } }); assert.equal((await changing).status, 200);
  assert.equal((await req('/v1/command', mutation)).status, 409);
});
test('unknown extension result requires rearm and invalidates snapshot', async t => {
  const { req, arm } = await fixture(t, { commandTimeoutMs: 1000 }); const sessionId = await arm();
  const queued = req('/v1/command', { action: 'snapshot' });
  const { command } = (await req('/v1/poll', { sessionId })).body;
  await req('/v1/result', { sessionId, commandId: command.id, result: { ok: false, outcome: 'unknown', doNotRetry: true, snapshot: { snapshotId: 'untrusted', fingerprint: 'hash', createdAt: Date.now(), controls: [] } } });
  assert.equal((await queued).body.outcome, 'unknown');
  const status = (await req('/v1/status')).body; assert.equal(status.active, false); assert.equal(status.session.requiresRearm, true); assert.equal(status.lastSnapshotAt, null);
  assert.equal((await req('/v1/command', { action: 'snapshot' })).status, 409);
  await arm();
  assert.equal((await req('/v1/command', { action: 'click', snapshotId: 'untrusted', fingerprint: 'hash', controlId: 'a', beforeValue: '', afterValue: null })).status, 409);
});
test('rejects snapshots older than sixty seconds', async t => {
  const { req, arm } = await fixture(t, { commandTimeoutMs: 1000 }); const sessionId = await arm();
  const queued = req('/v1/command', { action: 'snapshot' });
  const { command } = (await req('/v1/poll', { sessionId })).body;
  const snapshot = { snapshotId: 'old', fingerprint: 'hash', createdAt: Date.now() - 61000, controls: [{ id: 'gain', value: '1', actions: ['set'] }] };
  await req('/v1/result', { sessionId, commandId: command.id, result: { ok: true, snapshot } }); await queued;
  assert.equal((await req('/v1/command', { action: 'set', snapshotId: 'old', fingerprint: 'hash', controlId: 'gain', beforeValue: '1', afterValue: '2' })).status, 409);
});
