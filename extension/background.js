const BASE = 'http://127.0.0.1:17845';
const studioURL = value => { try { const u = new URL(value); return u.protocol === 'https:' && ['www.bandlab.com', 'bandlab.com'].includes(u.hostname) && /^\/(studio|mix-editor)(\/|$)/.test(u.pathname); } catch { return false; } };
let looping = false, generation = 0;
// Session storage is not exposed to content scripts and clears on browser restart.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const readState = async () => (await chrome.storage.session.get('bridge')).bridge;
async function request(state, path, body, timeout = 18000) {
  const response = await fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout), credentials: 'omit', cache: 'no-store' });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `Bridge returned ${response.status}`); return result;
}
async function disable(reason = '') {
  generation++;
  const state = await readState();
  await chrome.storage.session.remove('bridge');
  await chrome.storage.session.set({ lastError: reason });
  await chrome.alarms.clear('bridge-wake');
  if (state) { await chrome.tabs.sendMessage(state.tabId, { type: 'bridge.disarm' }).catch(() => {}); await request(state, '/v1/disarm', { sessionId: state.sessionId }, 1500).catch(() => {}); }
}
async function runLoop() {
  if (looping) return;
  looping = true; const ownGeneration = generation;
  try {
    while (ownGeneration === generation) {
      const state = await readState(); if (!state) break;
      const tab = await chrome.tabs.get(state.tabId);
      if (!studioURL(tab.url) || tab.url !== state.url) throw new Error('Studio navigated; reconnect the tab.');
      const result = await request(state, '/v1/poll', { sessionId: state.sessionId });
      if (ownGeneration !== generation) break;
      if (!result.command) continue;
      const command = result.command;
      let outcome;
      if (Date.now() >= command.expiresAt) outcome = { ok: false, error: 'Command expired before dispatch', actionDispatched: false };
      else {
        try { outcome = await chrome.tabs.sendMessage(state.tabId, { type: 'bridge.command', sessionId: state.sessionId, command }); }
        catch (err) { outcome = { ok: false, error: err.message, outcome: 'unknown', doNotRetry: true }; }
      }
      // Never replay a command after delivery, even if posting its result fails.
      await request(state, '/v1/result', { sessionId: state.sessionId, commandId: command.id, result: outcome || { ok: false, error: 'No response', outcome: 'unknown', doNotRetry: true } }, 4000);
    }
  } catch (err) { if (ownGeneration === generation) await disable(err.message); }
  finally { looping = false; if (ownGeneration !== generation && await readState()) runLoop(); }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // A page or content script cannot pair, read the secret, or arm itself.
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return;
  (async () => {
    if (message.type === 'bridge.status') { const state = await readState(); return { active: !!state, title: state?.title, error: (await chrome.storage.session.get('lastError')).lastError }; }
    if (message.type === 'bridge.disconnect') { await disable(); return { active: false }; }
    if (message.type !== 'bridge.connect') throw new Error('Unknown popup action');
    if (!/^[a-f0-9]{64}$/.test(message.token)) throw new Error('Select a valid pairing JSON file or paste its token.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !studioURL(tab.url)) throw new Error('Open a BandLab Studio tab first.');
    await disable();
    const state = { token: message.token, tabId: tab.id, url: tab.url, title: tab.title };
    const arm = await request(state, '/v1/arm', { tabId: tab.id, url: tab.url, title: tab.title }, 4000); state.sessionId = arm.sessionId;
    try {
      const ready = await chrome.tabs.sendMessage(tab.id, { type: 'bridge.arm', sessionId: state.sessionId });
      if (!ready?.ok) throw new Error('Content script not ready');
    } catch {
      await request(state, '/v1/disarm', { sessionId: state.sessionId }, 2000).catch(() => {});
      throw new Error('Refresh the Studio tab once, then reconnect.');
    }
    await chrome.storage.session.set({ bridge: state, lastError: '' });
    await chrome.alarms.create('bridge-wake', { periodInMinutes: 0.5 });
    runLoop(); return { active: true };
  })().then(reply, err => reply({ error: err.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => { if ((await readState())?.tabId === tabId) await disable('Connected tab closed.'); });
chrome.tabs.onUpdated.addListener(async (tabId, change) => { const state = await readState(); if (state?.tabId === tabId && (change.status === 'loading' || (change.url && change.url !== state.url))) await disable('Studio navigated or reloaded; reconnect the tab.'); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-wake') runLoop(); });
runLoop();
