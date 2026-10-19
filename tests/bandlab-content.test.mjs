import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Run the actual content script and Chrome message listener. This deliberately
// small DOM implements only browser primitives that script uses, not its logic.
const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

function harness({ pathname = '/studio/test-project' } = {}) {
  let listener, clock = 10_000, hashBarrier = null;
  const nodes = [];
  const document = {
    title: 'Test Studio', activeElement: null, overlay: null,
    querySelectorAll: selectors => nodes.filter(el => el.matches(selectors)),
    getElementById: id => nodes.find(el => el.getAttribute('id') === id),
    elementFromPoint(x, y) {
      return this.overlay ?? nodes.findLast(el => {
        const r = el.getBoundingClientRect();
        return el.isConnected && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      }) ?? null;
    },
  };
  class Element {
    constructor(tag, options = {}) {
      this.tagName = tag.toUpperCase();
      this.attrs = { ...options.attrs };
      this.isConnected = true;
      this.disabled = false;
      this.readOnly = false;
      this.childElementCount = 0;
      this.parentElement = null;
      this.previousElementSibling = null;
      this.textContent = options.text ?? '';
      this.innerText = this.textContent;
      this.events = [];
      this.nativeWrites = this.shadowWrites = this.clicks = this.focuses = this.blurs = 0;
      this.rect = { x: 20, y: 20 + nodes.length * 50, width: 180, height: 30 };
      nodes.push(this);
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    matches(selectors) {
      return selectors.split(',').some(selector => {
        const match = /^([a-z]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i.exec(selector.trim());
        if (!match || (match[1] && match[1].toUpperCase() !== this.tagName)) return false;
        if (!match[2]) return true;
        const value = match[2] === 'type' ? this.type : this.getAttribute(match[2]);
        return match[3] === undefined ? value != null : value === match[3];
      });
    }
    closest(selectors) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selectors)) return node;
      return null;
    }
    contains(other) {
      for (let node = other; node; node = node.parentElement) if (node === this) return true;
      return false;
    }
    getBoundingClientRect() {
      const { x, y, width, height } = this.rect;
      return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
    }
    focus() { this.focuses++; document.activeElement = this; }
    blur() { this.blurs++; document.activeElement = null; }
    click() { this.clicks++; }
    dispatchEvent(event) { this.events.push(event); return true; }
  }
  class Input extends Element {
    constructor(options = {}) {
      super('input', options);
      this.type = options.type ?? 'number';
      this.min = options.min ?? '0'; this.max = options.max ?? '10'; this.step = options.step ?? '0.1';
      this._value = options.value ?? '3';
    }
    get value() { return this._value; }
    set value(next) { this.nativeWrites++; this._value = String(next); }
  }
  class Select extends Element {
    get value() { return this._value; }
    set value(next) { this.nativeWrites++; this._value = String(next); }
  }
  class BrowserEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  }
  class ClockDate extends Date { static now() { return clock; } }
  const context = vm.createContext({
    document, location: { pathname, href: `https://www.bandlab.com${pathname}` },
    innerHeight: 900, innerWidth: 1200,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    HTMLInputElement: Input, HTMLSelectElement: Select, Event: BrowserEvent, MouseEvent: BrowserEvent,
    TextEncoder, Uint8Array, Date: ClockDate,
    setTimeout: callback => queueMicrotask(callback),
    crypto: {
      randomUUID,
      subtle: { async digest(algorithm, data) {
        if (hashBarrier) {
          const barrier = hashBarrier;
          hashBarrier = null;
          barrier.started();
          await barrier.wait;
        }
        return webcrypto.subtle.digest(algorithm, data);
      } },
    },
    chrome: { runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } } } },
  });
  context.window = context;
  vm.runInContext(source, context, { filename: 'extension/content.js' });

  async function message(data) {
    const response = await new Promise(resolve => listener(data, { id: 'test-extension' }, resolve));
    // Allow the real listener's .finally() to release its busy flag.
    await new Promise(setImmediate);
    return response;
  }
  const command = data => message({ type: 'bridge.command', sessionId: 'test-session', command: { expiresAt: clock + 1000, ...data } });
  return {
    document,
    input: options => new Input(options),
    button: label => new Element('button', { text: label }),
    arm: () => message({ type: 'bridge.arm', sessionId: 'test-session' }),
    disarm: () => message({ type: 'bridge.disarm' }),
    command,
    async snapshot() {
      const result = await command({ action: 'snapshot' });
      assert.equal(result.ok, true, result.error);
      return result.snapshot;
    },
    action(snapshot, control, fields = {}) {
      return command({ action: 'set', snapshotId: snapshot.snapshotId, fingerprint: snapshot.fingerprint,
        controlId: control.id, beforeValue: control.value, afterValue: '6', ...fields });
    },
    advance: amount => { clock += amount; },
    pauseNextHash() {
      let started, release;
      const ready = new Promise(resolve => { started = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      hashBarrier = { started, wait };
      return { ready, release };
    },
  };
}

async function armedGain() {
  const h = harness();
  const gain = h.input({ attrs: { 'aria-label': 'Gain' } });
  assert.equal((await h.arm()).ok, true);
  const snapshot = await h.snapshot();
  return { h, gain, snapshot, control: snapshot.controls.find(row => row.label === 'Gain') };
}

test('actual listener requires arming a Studio tab; snapshot excludes passwords and publishing', async () => {
  const h = harness();
  h.input({ attrs: { 'aria-label': 'Gain' } });
  h.input({ type: 'password', attrs: { 'aria-label': 'Gain password' }, value: 'secret' });
  h.input({ attrs: { 'aria-label': 'Profile value' }, value: '2' });
  h.button('Publish');
  h.button('Play');
  assert.equal((await h.command({ action: 'snapshot' })).ok, false);
  assert.equal((await h.arm()).ok, true);
  const snapshot = await h.snapshot();
  assert.deepEqual(Array.from(snapshot.controls, row => row.label), ['Gain', 'Play']);
  assert.deepEqual(Array.from(snapshot.controls[0].actions), ['set']);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal((await harness({ pathname: '/feed' }).arm()).ok, false);
});

test('set uses native value setter, dispatches input/change, and reports observed readback', async () => {
  const { h, gain, snapshot, control } = await armedGain();
  Object.defineProperty(gain, 'value', { get() { return this._value; }, set(next) { this.shadowWrites++; this._value = next; } });
  const result = await h.action(snapshot, control);
  assert.equal(result.ok, true, result.error);
  assert.equal(gain.value, '6');
  assert.equal(gain.nativeWrites, 1);
  assert.equal(gain.shadowWrites, 0);
  assert.deepEqual(gain.events.map(event => [event.type, event.bubbles]), [['input', true], ['change', true]]);
  assert.equal(gain.focuses, 1);
  assert.equal(gain.blurs, 1);
  assert.equal(result.verification.actualAfterValue, '6');
  assert.equal(result.verification.verified, true);
  assert.match(result.verification.note, /audio result not verified/i);
  assert.notEqual(result.snapshot.snapshotId, snapshot.snapshotId);
});

test('expired command and aged snapshot reject before mutation', async () => {
  const { h, gain, snapshot, control } = await armedGain();
  let result = await h.action(snapshot, control, { expiresAt: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/i);
  h.advance(60001);
  result = await h.action(snapshot, control);
  assert.equal(result.ok, false);
  assert.match(result.error, /snapshot is stale/i);
  assert.equal(gain.nativeWrites, 0);
});

test('a reused snapshot cannot dispatch a second edit', async () => {
  const { h, gain, snapshot, control } = await armedGain();
  assert.equal((await h.action(snapshot, control)).ok, true);
  const replay = await h.action(snapshot, control);
  assert.equal(replay.ok, false);
  assert.match(replay.error, /snapshot is stale/i);
  assert.equal(gain.nativeWrites, 1);
});

test('incorrect beforeValue and actual value drift reject before mutation', async () => {
  const { h, gain, snapshot, control } = await armedGain();
  const incorrect = await h.action(snapshot, control, { beforeValue: '7' });
  assert.equal(incorrect.ok, false);
  assert.match(incorrect.error, /beforeValue changed/i);
  gain._value = '4'; // Simulate a user edit outside the bridge.
  const drift = await h.action(snapshot, control);
  assert.equal(drift.ok, false);
  assert.match(drift.error, /visible controls changed/i);
  assert.equal(gain.nativeWrites, 0);
});

test('numeric range violations reject before native setter or events', async () => {
  const { h, gain, snapshot, control } = await armedGain();
  for (const afterValue of ['-1', '11', 'NaN', '']) {
    const result = await h.action(snapshot, control, { afterValue });
    assert.equal(result.ok, false);
    assert.match(result.error, /outside the field range/i);
  }
  assert.equal(gain.nativeWrites, 0);
  assert.deepEqual(gain.events, []);
});

test('disarm during asynchronous fingerprint hash rejects before mutation', { timeout: 1500 }, async () => {
  const { h, gain, snapshot, control } = await armedGain();
  const barrier = h.pauseNextHash();
  const pending = h.action(snapshot, control);
  await barrier.ready;
  assert.equal((await h.disarm()).ok, true);
  barrier.release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled|rearmed/i);
  assert.equal(result.actionDispatched, false);
  assert.equal(gain.nativeWrites, 0);
  assert.deepEqual(gain.events, []);
});

test('overlay covering an observed control blocks click dispatch', async () => {
  const h = harness();
  const play = h.button('Play');
  await h.arm();
  const snapshot = await h.snapshot();
  h.document.overlay = {}; // Hit testing now returns an unrelated overlay.
  const result = await h.action(snapshot, snapshot.controls[0], { action: 'click', afterValue: null });
  assert.equal(result.ok, false);
  assert.match(result.error, /covered by another element/i);
  assert.equal(play.clicks, 0);
});
