import test from 'node:test';
import assert from 'node:assert/strict';
import { createRxBridge } from '../src/rx.mjs';

const rxWindow = { id: 42, app: 'rx-app', title: 'RX 12 Audio Editor - test.wav' };
function fixture(overrides = {}) {
  let time = 1000;
  let count = 0;
  const calls = [];
  const sky = {
    async list_apps() { return [{ id: 'rx-app', displayName: 'RX 12 Audio Editor', windows: [rxWindow] }]; },
    async launch_app(input) { calls.push(['launch_app', input]); },
    async activate_window(input) { calls.push(['activate_window', input]); },
    async get_window_state(input) {
      calls.push(['get_window_state', input]);
      return { window: rxWindow, accessibility: { tree: '[1] Window\n  [12] Edit value: 3\n  14: Button Preview', focused_element: '[12] Edit value: 3' }, screenshots: input.include_screenshot ? [{ id: `shot-${++count}`, width: 800, height: 600, url: 'data:secret' }] : [] };
    },
    ...Object.fromEntries(['click', 'set_value', 'press_key', 'type_text', 'scroll', 'drag'].map(name => [name, async input => { calls.push([name, input]); }])),
    ...overrides,
  };
  return { bridge: createRxBridge(sky, { now: () => time }), sky, calls, advance: ms => { time += ms; } };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('one observed action targets the returned RX window and immediately refreshes', async () => {
  const { bridge, calls } = fixture();
  const first = await bridge.connect();
  const next = await bridge.act(first.ticket, { type: 'setValue', elementIndex: 12, value: '6.0' });
  assert.equal(calls[1][0], 'set_value');
  assert.equal(calls[1][1].window, rxWindow);
  assert.equal(calls[2][0], 'get_window_state');
  assert.notEqual(next.ticket, first.ticket);
  assert.equal(next.screenshotId, null);
  assert.equal(calls[0][1].include_screenshot, false);
  assert.equal(calls[2][1].include_screenshot, false);
  assert.deepEqual(next.captureOptions, { screenshot: false });
  assert.equal(JSON.stringify(next).includes('data:secret'), false);
  assert.equal('verified' in next, false);
});

test('stale and replayed tickets cannot issue input', async () => {
  const f = fixture();
  const stale = await f.bridge.connect();
  f.advance(60001);
  await rejectsCode(f.bridge.act(stale.ticket, { type: 'key', key: 'space' }), 'RX_STALE_TICKET');
  const fresh = await f.bridge.observe();
  await f.bridge.act(fresh.ticket, { type: 'key', key: 'space' });
  await rejectsCode(f.bridge.act(fresh.ticket, { type: 'key', key: 'space' }), 'RX_INVALID_TICKET');
  assert.equal(f.calls.filter(([name]) => name === 'press_key').length, 1);
});

test('re-observation supersedes earlier ticket, and invalid attempts consume latest state', async () => {
  const { bridge } = fixture();
  const old = await bridge.connect();
  const fresh = await bridge.observe();
  await rejectsCode(bridge.act(old.ticket, { type: 'key', key: 'space' }), 'RX_INVALID_TICKET');
  await rejectsCode(bridge.act(fresh.ticket, { type: 'key', key: 'space' }), 'RX_INVALID_TICKET');
});

test('ambiguous windows stop without input; exact title selects one', async () => {
  const f = fixture({ async list_apps() { return [{ id: 'rx-app', displayName: 'RX 12 Audio Editor', windows: [rxWindow, { ...rxWindow, id: 43, title: 'Other RX' }] }]; } });
  await rejectsCode(f.bridge.connect(), 'RX_WINDOW_SELECTION');
  assert.deepEqual(f.calls, []);
  assert.equal((await f.bridge.connect({ windowTitle: rxWindow.title })).window.id, 42);
});

test('RX plugins, Product Portal, and similarly named unrelated apps do not qualify', async () => {
  const { bridge } = fixture({ async list_apps() { return ['RX 12 De-noise', 'iZotope Product Portal', 'Some RX 12 Audio Editor helper'].map(displayName => ({ id: displayName, displayName, windows: [rxWindow] })); } });
  await rejectsCode(bridge.connect(), 'RX_WINDOW_SELECTION');
});

test('launch is explicit, uses only observed app id or fixed verified fallback, and relists', async () => {
  let lists = 0;
  const f = fixture({ async list_apps() { return ++lists === 1 ? [] : [{ id: 'rx-app', displayName: 'RX 12 Audio Editor', windows: [rxWindow] }]; } });
  await f.bridge.connect({ launch: true });
  assert.equal(lists, 2);
  assert.equal(f.calls[0][0], 'launch_app');
  assert.equal(f.calls[0][1].app, 'C:\\Program Files\\iZotope\\RX 12 Audio Editor\\win64\\iZotope RX 12 Audio Editor.exe');
});

test('input failure invalidates the ticket and reports unknown outcome', async () => {
  const { bridge, calls } = fixture({ async click() { throw new Error('input timeout'); } });
  const first = await bridge.connect();
  await assert.rejects(bridge.act(first.ticket, { type: 'click', elementIndex: 12 }), error => error.code === 'RX_OUTCOME_UNKNOWN' && error.message.includes('input timeout') && error.cause.message === 'input timeout');
  await rejectsCode(bridge.act(first.ticket, { type: 'click', elementIndex: 12 }), 'RX_INVALID_TICKET');
  assert.equal(calls.length, 1);
  assert.ok((await bridge.observe()).ticket);
});

test('refresh failure also invalidates all action state', async () => {
  const f = fixture();
  const first = await f.bridge.connect();
  f.sky.get_window_state = async () => { throw new Error('capture timeout'); };
  await rejectsCode(f.bridge.act(first.ticket, { type: 'key', key: 'space' }), 'RX_OUTCOME_UNKNOWN');
  await rejectsCode(f.bridge.act(first.ticket, { type: 'key', key: 'space' }), 'RX_INVALID_TICKET');
});

test('coordinates require exact latest screenshot and stay inside its bounds', async () => {
  const f = fixture();
  const initial = await f.bridge.connect({ screenshot: true });
  await rejectsCode(f.bridge.act(initial.ticket, { type: 'click', x: 30, y: 40, screenshotId: 'guessed' }), 'RX_SCREENSHOT_REQUIRED');
  const outside = await f.bridge.observe({ screenshot: true });
  await rejectsCode(f.bridge.act(outside.ticket, { type: 'click', x: 800, y: 40, screenshotId: outside.screenshotId }), 'RX_COORDINATES_OUT_OF_BOUNDS');
  const good = await f.bridge.observe({ screenshot: true });
  await f.bridge.act(good.ticket, { type: 'click', x: 799, y: 599, screenshotId: good.screenshotId });
  assert.equal(f.calls.filter(([name]) => name === 'click').length, 1);
  assert.equal(f.calls.find(([name]) => name === 'click')[1].screenshotId, good.screenshotId);
});

test('missing image dimensions fail closed for coordinates', async () => {
  const { bridge } = fixture({ async get_window_state() { return { window: rxWindow, accessibility: null, screenshots: [{ id: 'image' }] }; } });
  const state = await bridge.connect({ screenshot: true });
  await rejectsCode(bridge.act(state.ticket, { type: 'drag', screenshotId: 'image', fromX: 0, fromY: 0, toX: 1, toY: 1 }), 'RX_SCREENSHOT_REQUIRED');
});

test('indexes must come from the captured tree, and typing requires exact observed focus', async () => {
  const { bridge } = fixture();
  let state = await bridge.connect();
  await rejectsCode(bridge.act(state.ticket, { type: 'click', elementIndex: 999 }), 'RX_UNOBSERVED_ELEMENT');
  state = await bridge.observe();
  await rejectsCode(bridge.act(state.ticket, { type: 'typeText', text: '5' }), 'RX_FOCUS_REQUIRED');
  state = await bridge.observe();
  assert.ok((await bridge.act(state.ticket, { type: 'typeText', text: '5', focusedElement: state.focusedElement })).ticket);
});

test('Windows key aliases, system shortcuts, and multiple-key actions are rejected', async () => {
  const { bridge, calls } = fixture();
  await bridge.connect();
  for (const key of ['Meta+r', 'Win_L+r', 'Super_L+r', 'WINDOWS+r', 'OS+r', 'Alt+Tab', 'Ctrl+Shift+Escape']) {
    const state = await bridge.observe();
    await rejectsCode(bridge.act(state.ticket, { type: 'key', key }), 'RX_FORBIDDEN_KEY');
  }
  const state = await bridge.observe();
  await rejectsCode(bridge.act(state.ticket, { type: 'key', key: 'a+b' }), 'RX_INVALID_KEY');
  assert.equal(calls.filter(([name]) => name === 'press_key').length, 0);
});

test('a captured window change breaks the connection instead of retargeting input', async () => {
  const { bridge } = fixture({ async get_window_state() { return { window: { ...rxWindow, app: 'other-app' }, screenshots: [] }; } });
  await rejectsCode(bridge.connect(), 'RX_WINDOW_CHANGED');
  await rejectsCode(bridge.observe(), 'RX_NOT_CONNECTED');
});

test('concurrent actions cannot reuse the same snapshot', async () => {
  let finish;
  const { bridge } = fixture({ click() { return new Promise(resolve => { finish = resolve; }); } });
  const state = await bridge.connect();
  const running = bridge.act(state.ticket, { type: 'click', elementIndex: 12 });
  await rejectsCode(bridge.act(state.ticket, { type: 'click', elementIndex: 12 }), 'RX_BUSY');
  finish();
  await running;
});

test('live RX integer-space tree format supports exact name and role lookup', async () => {
  const { bridge, calls } = fixture({ async get_window_state() {
    return { window: rxWindow, accessibility: { tree: '\t7732 edit (settable, string) Selection start time Value: 00:00:00.000\n\t7626 check box (settable, string) Gain Value: False\n\t7627 button Gain', focused_element: '7732 edit Selection start time' }, screenshots: [] };
  } });
  const state = await bridge.connect();
  assert.equal(bridge.find({ name: 'Gain' }).length, 2);
  const matches = bridge.find({ role: 'edit', name: 'Selection start time' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].index, 7732);
  assert.equal(matches[0].value, '00:00:00.000');
  assert.equal(bridge.find({ name: 'Selection' }).length, 0);
  await bridge.act(state.ticket, { type: 'setValue', elementIndex: matches[0].index, value: '00:00:01.000' });
  assert.equal(calls[0][1].element_index, 7732);
});

test('explicit returned window id disambiguates module and editor windows', async () => {
  const f = fixture({ async list_apps() { return [{ id: 'rx-app', displayName: 'iZotope RX 12 Advanced Audio Editor', windows: [rxWindow, { ...rxWindow, id: 43, title: 'Gain' }] }]; } });
  assert.equal((await f.bridge.connect({ windowId: 42 })).window.id, 42);
  await assert.rejects(f.bridge.connect({ windowId: 99 }), error => error.code === 'RX_WINDOW_SELECTION' && error.candidates.length === 2);
});

test('coordinate action preserves screenshot capture; explicit refresh can switch to text-only', async () => {
  const { bridge, calls } = fixture();
  const first = await bridge.connect({ screenshot: true });
  const second = await bridge.act(first.ticket, { type: 'click', screenshotId: first.screenshotId, x: 40, y: 40 });
  assert.equal(second.screenshotId, 'shot-2');
  assert.deepEqual(second.captureOptions, { screenshot: true });
  const third = await bridge.act(second.ticket, { type: 'key', key: 'Escape' }, { screenshot: false });
  assert.equal(third.screenshotId, null);
  assert.equal(calls.at(-1)[1].include_screenshot, false);
});

test('observe defaults to text-only even after a screenshot observation', async () => {
  const { bridge } = fixture();
  await bridge.connect({ screenshot: true });
  const state = await bridge.observe();
  assert.equal(state.screenshotId, null);
  await rejectsCode(bridge.act(state.ticket, { type: 'click', screenshotId: 'shot-1', x: 20, y: 20 }), 'RX_SCREENSHOT_REQUIRED');
});

test('activation is explicit and immediately followed by capture, never repeated by action refresh', async () => {
  const { bridge, calls } = fixture();
  await bridge.connect();
  const state = await bridge.observe({ activate: true, screenshot: true });
  assert.equal(calls[1][0], 'activate_window');
  assert.equal(calls[1][1].window, rxWindow);
  assert.equal(calls[2][0], 'get_window_state');
  await bridge.act(state.ticket, { type: 'key', key: 'Escape' });
  assert.equal(calls.filter(([name]) => name === 'activate_window').length, 1);
});

test('activation failure invalidates old tickets and does not retry', async () => {
  let activations = 0;
  const { bridge } = fixture({ async activate_window() { activations++; throw new Error('activation blocked'); } });
  const state = await bridge.connect();
  await assert.rejects(bridge.observe({ activate: true }), /activation blocked/);
  await rejectsCode(bridge.act(state.ticket, { type: 'key', key: 'Escape' }), 'RX_INVALID_TICKET');
  assert.equal(activations, 1);
});

test('RX modules without accessibility focus allow explicit visually observed focus evidence', async () => {
  const f = fixture({ async get_window_state(input) {
    return { window: rxWindow, accessibility: null, screenshots: input.include_screenshot ? [{ id: 'module-shot', width: 500, height: 400 }] : [] };
  } });
  const state = await f.bridge.connect({ screenshot: true });
  await f.bridge.act(state.ticket, { type: 'typeText', text: '6.0', focusScreenshotId: state.screenshotId, focusDescription: 'Voice De-noise Reduction numeric readout, existing 12.0 visibly selected.' });
  assert.equal(f.calls[0][0], 'type_text');
  assert.equal(f.calls[0][1].text, '6.0');
});

test('visual focus requires latest screenshot and nonempty description', async () => {
  const { bridge } = fixture({ async get_window_state(input) {
    return { window: rxWindow, accessibility: null, screenshots: input.include_screenshot ? [{ id: 'module-shot', width: 500, height: 400 }] : [] };
  } });
  let state = await bridge.connect();
  await rejectsCode(bridge.act(state.ticket, { type: 'typeText', text: '6', focusScreenshotId: 'module-shot', focusDescription: 'Selected numeric field' }), 'RX_FOCUS_REQUIRED');
  for (const evidence of [
    { focusScreenshotId: 'old-shot', focusDescription: 'Selected numeric field' },
    { focusScreenshotId: 'module-shot', focusDescription: ' ' },
    { focusScreenshotId: 'module-shot' },
  ]) {
    state = await bridge.observe({ screenshot: true });
    await rejectsCode(bridge.act(state.ticket, { type: 'typeText', text: '6', ...evidence }), 'RX_FOCUS_REQUIRED');
  }
});

test('visual attestation cannot override available accessibility focus', async () => {
  const { bridge } = fixture();
  const state = await bridge.connect({ screenshot: true });
  await rejectsCode(bridge.act(state.ticket, { type: 'typeText', text: '6', focusedElement: 'Another field', focusScreenshotId: state.screenshotId, focusDescription: 'Selected numeric field' }), 'RX_FOCUS_REQUIRED');
});
