import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 17845;
export function resolveRuntimePath(override = process.env.AUDIO_BRIDGE_RUNTIME) {
  if (!override) return resolve(dirname(fileURLToPath(import.meta.url)), '../work/audio-control-bridge/bandlab-runtime.json');
  // Windows paths rooted only at a separator still depend on the current drive.
  const fullyQualifiedWindowsPath = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/;
  if (typeof override !== 'string' || !isAbsolute(override)
    || (process.platform === 'win32' && !fullyQualifiedWindowsPath.test(override))) {
    throw new Error('AUDIO_BRIDGE_RUNTIME must be an absolute path to the pairing JSON file.');
  }
  return resolve(override);
}
export const runtimePath = resolveRuntimePath();
const studioURL = value => { try { const u = new URL(value); return u.protocol === 'https:' && ['www.bandlab.com', 'bandlab.com'].includes(u.hostname) && /^\/(studio|mix-editor)(\/|$)/.test(u.pathname); } catch { return false; } };
const equalSecret = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createBridgeServer({ token = randomBytes(32).toString('hex'), commandTimeoutMs = 12000, heartbeatMs = 45000, pollMs = 15000 } = {}) {
  let session = null, pending = null, poll = null, lastSnapshot = null;
  const active = () => session && !session.requiresRearm && Date.now() - session.seenAt < heartbeatMs;
  const send = (res, status, body) => { if (!res.writableEnded && !res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); } };
  const endPoll = body => { if (poll) { clearTimeout(poll.timer); send(poll.res, 200, body); poll = null; } };
  const settle = (status, result) => { if (!pending) return; clearTimeout(pending.timer); send(pending.res, status, result); pending = null; };
  const deliver = () => { if (pending && !pending.delivered && poll) { pending.delivered = true; endPoll({ command: pending.command }); } };
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, { error: 'Host rejected' });
      const origin = req.headers.origin;
      // Extension fetches are privileged. Websites receive neither CORS access nor a preflight grant.
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return send(res, 403, { error: 'Origin rejected' });
      if (!equalSecret(req.headers.authorization, `Bearer ${token}`)) return send(res, 401, { error: 'Authentication required' });
      if (req.method === 'OPTIONS') return send(res, 405, { error: 'Preflight not supported' });
      const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
      let body = {};
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
        let bytes = 0, chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 524288) { send(res, 413, { error: 'Request too large' }); req.destroy(); return; } chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return send(res, 400, { error: 'Object required' });
      }
      if (path === '/v1/status' && req.method === 'GET') return send(res, 200, { service: 'BandLab local DOM bridge', active: !!active(), session: session ? { title: session.title, url: session.url, requiresRearm: session.requiresRearm, heartbeatAgeMs: Date.now() - session.seenAt } : null, busy: !!pending, lastSnapshotAt: lastSnapshot?.createdAt || null });
      if (path === '/v1/arm' && req.method === 'POST') {
        if (!studioURL(body.url) || !Number.isInteger(body.tabId)) return send(res, 400, { error: 'A BandLab Studio tab is required' });
        if (pending) return send(res, 409, { error: 'Wait for the current command before arming a tab' });
        endPoll({ error: 'Session replaced' });
        session = { id: randomBytes(24).toString('hex'), seenAt: Date.now(), url: body.url, title: String(body.title || '').slice(0, 200), requiresRearm: false };
        lastSnapshot = null;
        return send(res, 200, { sessionId: session.id });
      }
      if (['/v1/disarm', '/v1/poll', '/v1/result'].includes(path) && req.method === 'POST') {
        if (!session || !equalSecret(body.sessionId, session.id)) return send(res, 409, { error: 'Session is not armed' });
        if (path === '/v1/disarm') { endPoll({ error: 'Disarmed' }); settle(409, { error: 'Disarmed during command', outcome: 'unknown', doNotRetry: true }); session = null; lastSnapshot = null; return send(res, 200, { active: false }); }
        if (path === '/v1/poll') {
          if (poll) return send(res, 409, { error: 'Only one poll is permitted' });
          session.seenAt = Date.now();
          if (session.requiresRearm) return send(res, 409, { error: 'Command outcome unknown; inspect the Studio and reconnect before further commands' });
          poll = { res, timer: setTimeout(() => endPoll({ command: null }), pollMs) };
          res.on('close', () => { if (poll?.res === res) { clearTimeout(poll.timer); poll = null; } });
          deliver(); return;
        }
        if (!pending || body.commandId !== pending.command.id || !pending.delivered) return send(res, 409, { error: 'Command expired or is not in flight' });
        const result = body.result;
        if (!result || typeof result !== 'object') return send(res, 400, { error: 'Result required' });
        const snap = result.snapshot;
        if (result.outcome === 'unknown') { session.requiresRearm = true; lastSnapshot = null; }
        else if (snap && typeof snap.snapshotId === 'string' && typeof snap.fingerprint === 'string' && Array.isArray(snap.controls) && snap.controls.length <= 250 && Number.isFinite(snap.createdAt)) lastSnapshot = snap;
        settle(200, result); return send(res, 200, { received: true });
      }
      if (path === '/v1/command' && req.method === 'POST') {
        if (!active()) return send(res, 409, { error: 'Connect a BandLab Studio tab in the extension first' });
        if (pending) return send(res, 409, { error: 'A command is already in flight' });
        if (!['snapshot', 'click', 'set', 'doubleClick'].includes(body.action)) return send(res, 400, { error: 'Action is not supported' });
        if (body.action !== 'snapshot') {
          if (!lastSnapshot || body.snapshotId !== lastSnapshot.snapshotId || body.fingerprint !== lastSnapshot.fingerprint || Date.now() - lastSnapshot.createdAt > 60000 || lastSnapshot.createdAt > Date.now() + 1000) return send(res, 409, { error: 'Snapshot is stale; inspect again' });
          const control = lastSnapshot.controls.find(c => c.id === body.controlId);
          if (!control || !control.actions?.includes(body.action)) return send(res, 400, { error: 'Control does not support this action' });
          if (typeof body.beforeValue !== 'string' || body.beforeValue !== control.value || !(body.afterValue === null || typeof body.afterValue === 'string') || (body.action === 'set' && typeof body.afterValue !== 'string') || (typeof body.afterValue === 'string' && body.afterValue.length > 240)) return send(res, 400, { error: 'Use the snapshot beforeValue and a string afterValue (null only for click/doubleClick)' });
        }
        // Copy only the protocol fields. No caller-supplied selectors or code reach the page.
        const command = Object.fromEntries(['action', 'snapshotId', 'fingerprint', 'controlId', 'beforeValue', 'afterValue'].filter(k => k in body).map(k => [k, body[k]]));
        command.id = randomBytes(16).toString('hex'); command.expiresAt = Date.now() + commandTimeoutMs;
        if (command.action !== 'snapshot') lastSnapshot = null;
        pending = { command, res, delivered: false, timer: null };
        pending.timer = setTimeout(() => { const delivered = pending?.delivered; if (session && delivered) session.requiresRearm = true; settle(504, { error: 'Command timed out', outcome: delivered ? 'unknown' : 'not_dispatched', doNotRetry: true, reconnectRequired: !!delivered }); }, commandTimeoutMs);
        deliver(); return;
      }
      send(res, 404, { error: 'Unknown endpoint' });
    } catch { send(res, 500, { error: 'Bridge request failed' }); }
  });
  server.on('close', () => { endPoll({ error: 'Server stopped' }); settle(503, { error: 'Server stopped', outcome: 'unknown', doNotRetry: true }); });
  return { server, token, close: () => { endPoll({ error: 'Server stopped' }); settle(503, { error: 'Server stopped', outcome: 'unknown', doNotRetry: true }); server.closeAllConnections(); return new Promise(resolveClose => server.close(resolveClose)); } };
}

async function main() {
  const bridge = createBridgeServer();
  await new Promise((ok, fail) => { bridge.server.once('error', fail); bridge.server.listen(DEFAULT_PORT, '127.0.0.1', ok); });
  await mkdir(dirname(runtimePath), { recursive: true, mode: 0o700 });
  await writeFile(runtimePath, JSON.stringify({ port: DEFAULT_PORT, token: bridge.token, pid: process.pid, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`BandLab bridge listening on 127.0.0.1:${DEFAULT_PORT}. Pairing file: ${runtimePath}`);
  console.log('Load the extension, open a BandLab Studio tab, choose the pairing file in its popup, then Connect this Studio tab.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await bridge.close(); await unlink(runtimePath).catch(() => {}); process.exit(0); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(err => { console.error(err.message); process.exitCode = 1; });
