(() => {
  'use strict';
  const studio = () => /^\/(studio|mix-editor)(\/|$)/.test(location.pathname);
  const forbidden = /password|account|profile|user.?name|email|project|library|notification|sign.?in|log.?in|log.?out|publish|delete|remove|upload|download|export|import|invite|share|record|purchase|upgrade|billing|subscribe|subscription|payment|collaborat|save|add track|new track|open file/i;
  const audioParameter = /gain|volume|pan|balance|frequency|freq|threshold|ratio|attack|release|knee|make.?up|reverb|delay|mix|wet|dry|feedback|cutoff|resonance|bandwidth|pitch|tune|tuning|key|scale|tempo|bpm|decay|damping|width|depth|rate|amount|drive|saturat|filter|equalizer|compressor|limit|search.*(?:effect|preset)/i;
  const safeButton = /^(?:play|pause|stop|rewind|loop|metronome|effects?|fx|edit fx|add effect|presets?|bypass|enable|disable|on|off|eq|equalizer|compressor|reverb|delay|close effects?|close fx|close)(?:\s|$)/i;
  const numeric = /^[-+]?\d+(?:[.,]\d+)?\s*(?:%|dB|Hz|kHz|ms|s|:1)?$/i;
  let sessionId = null, current = null, busy = false;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  function visible(el) {
    if (!el?.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  }
  function unobstructed(el) {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
    const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
    const hit = document.elementFromPoint(x, y);
    return hit === el || !!(hit && el.contains(hit));
  }
  function label(el) {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const explicit = el.getAttribute('aria-label') || labelled || el.labels?.[0]?.textContent || el.getAttribute('title') || el.getAttribute('placeholder');
    if (explicit) return clean(explicit);
    if (el.matches('button,[role="button"]')) return clean(el.innerText || el.textContent);
    return clean(el.previousElementSibling?.textContent || el.parentElement?.textContent || el.tagName);
  }
  function value(el) {
    if (el.matches('input,textarea,select')) return String(el.value);
    return el.getAttribute('aria-valuenow') ?? el.getAttribute('aria-pressed') ?? el.getAttribute('aria-checked') ?? el.getAttribute('aria-expanded') ?? (numeric.test(clean(el.textContent)) ? clean(el.textContent) : '');
  }
  function describe(el, id, kind, actions) {
    const r = el.getBoundingClientRect();
    return { id, label: label(el), kind, value: value(el), actions, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', visible: visible(el), rect: [r.x, r.y, r.width, r.height].map(n => Math.round(n)), ...(el.matches('input[type="number"],input[type="range"]') ? { min: el.min, max: el.max, step: el.step } : {}), ...(el.tagName === 'SELECT' ? { options: Array.from(el.options, o => ({ value: o.value, label: clean(o.textContent) })).slice(0, 80) } : {}) };
  }
  async function hash(rows) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)))), n => n.toString(16).padStart(2, '0')).join(''); }
  function candidates() {
    const rows = [];
    const add = (el, kind, actions) => { if (rows.length < 250) rows.push({ el, id: crypto.randomUUID(), kind, actions }); };
    for (const el of document.querySelectorAll('button,[role="button"],input,textarea,select,[role="slider"]')) {
      if (!visible(el) || el.closest('a,[role="link"]') || forbidden.test(label(el)) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.matches('input')) {
        if (['password', 'file', 'hidden', 'submit', 'reset', 'button', 'image', 'checkbox', 'radio', 'email', 'tel', 'url'].includes(el.type) || el.readOnly) continue;
        if (audioParameter.test(label(el)) && ['number', 'range', 'text', 'search'].includes(el.type)) add(el, 'field', ['set']);
      } else if (el.matches('select') && audioParameter.test(label(el))) add(el, 'select', ['set']);
      else if (el.matches('[role="slider"]') && audioParameter.test(label(el))) add(el, 'slider', []);
      else if (el.matches('button,[role="button"]') && safeButton.test(label(el))) add(el, 'button', ['click']);
    }
    // Numeric labels often become an editable field after a double click. No value is changed here.
    let examined = 0;
    for (const el of document.querySelectorAll('span,div')) {
      if (++examined > 6000 || rows.length >= 250) break;
      if (el.childElementCount || !numeric.test(clean(el.textContent)) || !visible(el) || el.closest('button,a,input,[role="button"],[role="link"]')) continue;
      if (audioParameter.test(label(el)) && !forbidden.test(label(el))) add(el, 'numeric-display', ['doubleClick']);
    }
    return rows;
  }
  async function snapshot() {
    if (!studio() || !sessionId) throw new Error('Studio tab is not armed');
    const rows = candidates(), controls = rows.map(r => describe(r.el, r.id, r.kind, r.actions));
    const result = { snapshotId: crypto.randomUUID(), fingerprint: await hash(controls), createdAt: Date.now(), url: location.href, title: document.title, controls, truncated: controls.length >= 250 };
    current = { result, rows }; return result;
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 160));
  async function command(c) {
    if (!studio() || !sessionId) throw new Error('Studio tab is not armed');
    const commandSession = sessionId;
    if (!Number.isFinite(c.expiresAt) || c.expiresAt <= Date.now()) throw new Error('Command expired');
    if (c.action === 'snapshot') return { ok: true, snapshot: await snapshot() };
    if (!['click', 'set', 'doubleClick'].includes(c.action)) throw new Error('Unsupported action');
    if (!current || c.snapshotId !== current.result.snapshotId || c.fingerprint !== current.result.fingerprint || Date.now() - current.result.createdAt > 60000) throw new Error('Snapshot is stale; inspect again');
    const prior = current;
    const row = prior.rows.find(r => r.id === c.controlId);
    if (!row || !row.actions.includes(c.action)) throw new Error('Control does not support this action');
    const now = prior.rows.map(r => describe(r.el, r.id, r.kind, r.actions));
    const nowFingerprint = await hash(now);
    if (sessionId !== commandSession || current !== prior) throw new Error('Tab was disabled or rearmed before mutation');
    if (nowFingerprint !== prior.result.fingerprint) throw new Error('Visible controls changed; inspect again');
    const el = row.el;
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' || forbidden.test(label(el)) || value(el) !== c.beforeValue) throw new Error('Control or beforeValue changed; inspect again');
    if (!(c.afterValue === null || typeof c.afterValue === 'string') || (typeof c.afterValue === 'string' && c.afterValue.length > 240)) throw new Error('Invalid afterValue');
    if (c.action === 'set') {
      if (typeof c.afterValue !== 'string' || el.readOnly) throw new Error('A writable field and string afterValue are required');
      if (el.matches('input[type="number"],input[type="range"]')) {
        const n = Number(c.afterValue);
        if (!c.afterValue.trim() || !Number.isFinite(n) || (el.min !== '' && n < Number(el.min)) || (el.max !== '' && n > Number(el.max))) throw new Error('Value is outside the field range');
      }
      if (el.tagName === 'SELECT' && !Array.from(el.options).some(o => o.value === c.afterValue && !o.disabled)) throw new Error('Value is not an enabled option');
      if (!el.matches('input,select')) throw new Error('Only native input/select values can be changed');
    }
    if (!sessionId || sessionId !== commandSession || !studio()) throw new Error('Tab was disabled or rearmed before mutation');
    if (!unobstructed(el)) throw new Error('Control is covered by another element; inspect the Studio before continuing');
    if (Date.now() >= c.expiresAt) throw new Error('Command expired before mutation');
    // Invalidate the previous snapshot before mutation, including exceptional outcomes.
    current = null;
    let dispatched = false;
    try {
      if (c.action === 'set') {
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        el.focus({ preventScroll: true }); setter.call(el, c.afterValue); dispatched = true;
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur();
      } else if (c.action === 'click') { dispatched = true; el.click(); }
      else { dispatched = true; el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 })); }
      await settle();
      const afterValue = el.isConnected ? value(el) : null;
      const verified = c.afterValue !== null && afterValue === c.afterValue;
      return { ok: c.afterValue === null || verified, actionDispatched: dispatched, verification: { beforeValue: c.beforeValue, expectedAfterValue: c.afterValue, actualAfterValue: afterValue, verified, note: c.afterValue === null ? 'Dispatch only. Inspect the new snapshot to verify the intended UI change.' : verified ? 'Same control reports expected value; audio result not verified.' : 'Expected value was not observed. Do not retry automatically.' }, snapshot: await snapshot() };
    } catch (err) { return { ok: false, error: err.message, actionDispatched: dispatched, outcome: dispatched ? 'unknown' : 'not_dispatched', doNotRetry: true }; }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'bridge.arm') { if (!studio()) { reply({ ok: false }); return; } sessionId = message.sessionId; current = null; reply({ ok: true }); return; }
    if (message.type === 'bridge.disarm') { sessionId = null; current = null; reply({ ok: true }); return; }
    if (message.type !== 'bridge.command') return;
    if (!sessionId || message.sessionId !== sessionId || busy) { reply({ ok: false, error: 'Unarmed or busy tab', actionDispatched: false }); return; }
    busy = true;
    command(message.command).then(reply, err => reply({ ok: false, error: err.message, actionDispatched: false })).finally(() => { busy = false; });
    return true;
  });
})();
