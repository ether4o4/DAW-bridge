import { randomUUID } from 'node:crypto';

const VERIFIED_RX12_PATH = 'C:\\Program Files\\iZotope\\RX 12 Audio Editor\\win64\\iZotope RX 12 Audio Editor.exe';
const RX_NAME = /^(?:iZotope\s+)?RX\s+\d+(?:\.\d+)?\s+(?:(?:Advanced|Standard|Elements)\s+)?Audio Editor(?:\s+(?:Advanced|Standard|Elements))?$/i;

function problem(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isRx(app) {
  const executable = String(app.id ?? '').split(/[\\/]/).at(-1).replace(/\.exe$/i, '');
  return RX_NAME.test(String(app.displayName ?? '').trim()) || RX_NAME.test(executable);
}

function observedElements(tree) {
  const elements = [];
  for (const line of tree.split(/\r?\n/)) {
    const match = /^\s*(?:\[(\d+)\]|\((\d+)\)|(\d+)[.:]|(\d+)(?=\s))\s+(.*)$/.exec(line);
    if (!match) continue;
    const index = Number(match[1] ?? match[2] ?? match[3] ?? match[4]);
    // RX's observed format: 7732 edit (settable, string) Selection start time Value: ...
    const details = /^(.+?)\s+\([^)]*\)\s*(.*)$/.exec(match[5])
      ?? /^(check box|radio button|menu item|list item|tab item|combo box|scroll bar|title bar|tree item|progress bar|split button|edit|button|text|window|pane|group|slider|menu|list|tab|tree|document)\s+(.*)$/i.exec(match[5]);
    const valueAt = details?.[2].indexOf(' Value: ') ?? -1;
    const name = details ? (valueAt < 0 ? details[2] : details[2].slice(0, valueAt)) : null;
    elements.push(Object.freeze({ index, role: details?.[1] ?? null, name, value: valueAt < 0 ? null : details[2].slice(valueAt + 8), line }));
  }
  return elements;
}

/**
 * Inject the supported @oai/sky client from node_repl. Observe in one cell,
 * inspect its tree/screenshot, then call act in the next cell. No action batches.
 * The caller must ensure the intended edit is authorized and inspect its result;
 * a refreshed observation is not proof that a setting or audio edit succeeded.
 * Do not mix direct sky inputs or another automation client with outstanding tickets.
 */
export function createRxBridge(sky, { now = Date.now, maxAgeMs = 60_000 } = {}) {
  if (!sky || typeof sky.list_apps !== 'function' || typeof sky.get_window_state !== 'function') {
    throw new TypeError('Pass the supported @oai/sky client.');
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60_000) {
    throw new TypeError('maxAgeMs must be greater than zero and at most 60000.');
  }
  let target = null;
  let latest = null;
  let busy = false;

  async function exclusive(operation) {
    if (busy) throw problem('RX_BUSY', 'Another RX operation is in progress; wait, then observe again.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }

  function captureSettings({ screenshot = false, activate = false } = {}) {
    if (typeof screenshot !== 'boolean' || typeof activate !== 'boolean') {
      throw new TypeError('screenshot and activate must be boolean.');
    }
    return { screenshot, activate };
  }

  async function capture(options = {}) {
    latest = null;
    if (!target) throw problem('RX_NOT_CONNECTED', 'Connect to exactly one RX Audio Editor window first.');
    const { screenshot, activate } = captureSettings(options);
    if (activate) await sky.activate_window({ window: target });
    const issuedAt = now();
    const state = await sky.get_window_state({ window: target, include_screenshot: screenshot, include_text: true });
    if (!state?.window || state.window.id !== target.id || state.window.app !== target.app) {
      target = null;
      throw problem('RX_WINDOW_CHANGED', 'Capture returned a different window; reconnect before acting.');
    }
    target = state.window;
    const tree = String(state.accessibility?.tree ?? '');
    const focusedElement = state.accessibility?.focused_element ?? null;
    const image = screenshot ? state.screenshots?.[0] : undefined;
    const coordinateBounds = image && Number.isFinite(image.width) && image.width > 0
      && Number.isFinite(image.height) && image.height > 0
      ? Object.freeze({ width: image.width, height: image.height }) : null;
    const captureOptions = Object.freeze({ screenshot });
    const snapshot = Object.freeze({
      ticket: randomUUID(),
      window: Object.freeze({ id: target.id, app: target.app, title: target.title }),
      tree,
      focusedElement,
      screenshotId: image?.id ?? null,
      coordinateBounds,
      captureOptions,
    });
    const elements = observedElements(tree);
    latest = { snapshot, issuedAt, window: target, elements, captureOptions, indexes: new Set(elements.map(element => element.index)) };
    return snapshot;
  }

  function indexFor(action, observation) {
    if (!Number.isSafeInteger(action.elementIndex) || !observation.indexes.has(action.elementIndex)) {
      throw problem('RX_UNOBSERVED_ELEMENT', 'elementIndex must occur in the latest captured accessibility tree.');
    }
    return action.elementIndex;
  }

  function coordinates(action, observation, points) {
    const { screenshotId, coordinateBounds } = observation.snapshot;
    if (!screenshotId || action.screenshotId !== screenshotId || !coordinateBounds) {
      throw problem('RX_SCREENSHOT_REQUIRED', 'Coordinates require the latest screenshotId and captured image dimensions.');
    }
    for (const [x, y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0
        || x >= coordinateBounds.width || y >= coordinateBounds.height) {
        throw problem('RX_COORDINATES_OUT_OF_BOUNDS', 'Coordinates must be inside the latest screenshot bounds.');
      }
    }
    return screenshotId;
  }

  function text(value, name) {
    if (typeof value !== 'string' || value.length > 16_384 || /[\x00-\x1f\x7f]/.test(value)) {
      throw problem('RX_INVALID_TEXT', `${name} must be literal single-line text of at most 16384 characters.`);
    }
    return value;
  }

  function command(action, observation) {
    if (!action || typeof action !== 'object' || Array.isArray(action) || 'window' in action || 'app' in action) {
      throw problem('RX_INVALID_ACTION', 'Provide one action; its target is always the observed RX window.');
    }
    const window = observation.window;
    switch (action.type) {
      case 'click': {
        const input = { window };
        if ('elementIndex' in action) {
          if ('x' in action || 'y' in action || 'screenshotId' in action) {
            throw problem('RX_INVALID_ACTION', 'Choose an elementIndex or screenshot coordinates, not both.');
          }
          input.element_index = indexFor(action, observation);
        } else {
          input.screenshotId = coordinates(action, observation, [[action.x, action.y]]);
          input.x = action.x;
          input.y = action.y;
        }
        if (action.button !== undefined) {
          if (!['left', 'right', 'middle'].includes(action.button)) throw problem('RX_INVALID_ACTION', 'Invalid mouse button.');
          input.mouse_button = action.button;
        }
        if (action.clickCount !== undefined) {
          if (![1, 2].includes(action.clickCount)) throw problem('RX_INVALID_ACTION', 'clickCount must be 1 or 2.');
          input.click_count = action.clickCount;
        }
        return ['click', input];
      }
      case 'setValue':
        return ['set_value', { window, element_index: indexFor(action, observation), value: text(action.value, 'value') }];
      case 'typeText': {
        const focus = observation.snapshot.focusedElement;
        const hasAccessibilityFocus = typeof focus === 'string' && !!focus.trim();
        if (hasAccessibilityFocus ? action.focusedElement !== focus
          : !observation.snapshot.screenshotId || action.focusScreenshotId !== observation.snapshot.screenshotId
            || typeof action.focusDescription !== 'string' || !action.focusDescription.trim()
            || action.focusDescription.length > 300 || /[\x00-\x1f\x7f]/.test(action.focusDescription)) {
          throw problem('RX_FOCUS_REQUIRED', 'Inspect focus in the preceding observation. Pass exact focusedElement, or, when accessibility focus is unavailable, the latest focusScreenshotId and a description of the visibly focused field.');
        }
        // RX module dialogs may have no accessibility tree. Visual fallback is an
        // explicit caller attestation after inspecting the prior screenshot in a
        // separate cell; this adapter cannot infer focus from image pixels.
        return ['type_text', { window, text: text(action.text, 'text') }];
      }
      case 'key': {
        const key = text(action.key, 'key');
        const parts = key.split('+').map(part => part.trim());
        if (!parts.length || parts.length > 5 || parts.some(part => !/^[A-Za-z0-9_]+$/.test(part))) {
          throw problem('RX_INVALID_KEY', 'Use one keysym-style key or chord, such as Control_L+z.');
        }
        const normalized = parts.map(part => part.toLowerCase().replace(/_[lr]$/, ''));
        if (normalized.some(part => /^(?:meta|windows|win|cmd|command|super|os|hyper)$/.test(part))) {
          throw problem('RX_FORBIDDEN_KEY', 'Windows/Meta shortcuts are not permitted.');
        }
        const modifiers = new Set(['control', 'ctrl', 'alt', 'shift']);
        if (normalized.filter(part => !modifiers.has(part)).length > 1) {
          throw problem('RX_INVALID_KEY', 'Only one non-modifier key is permitted per action.');
        }
        const ctrl = normalized.includes('control') || normalized.includes('ctrl');
        if ((normalized.includes('alt') && normalized.some(part => ['tab', 'escape'].includes(part)))
          || (ctrl && normalized.includes('alt') && normalized.includes('delete'))
          || (ctrl && normalized.includes('shift') && normalized.includes('escape'))) {
          throw problem('RX_FORBIDDEN_KEY', 'System and window-switching shortcuts are not permitted.');
        }
        return ['press_key', { window, key }];
      }
      case 'scroll': {
        const screenshotId = coordinates(action, observation, [[action.x, action.y]]);
        if (![action.scrollX, action.scrollY].every(Number.isFinite)
          || Math.abs(action.scrollX) > 10_000 || Math.abs(action.scrollY) > 10_000) {
          throw problem('RX_INVALID_ACTION', 'Provide finite scrollX and scrollY deltas between -10000 and 10000.');
        }
        return ['scroll', { window, screenshotId, x: action.x, y: action.y, scrollX: action.scrollX, scrollY: action.scrollY }];
      }
      case 'drag': {
        const screenshotId = coordinates(action, observation, [[action.fromX, action.fromY], [action.toX, action.toY]]);
        return ['drag', { window, screenshotId, from_x: action.fromX, from_y: action.fromY, to_x: action.toX, to_y: action.toY }];
      }
      default: throw problem('RX_INVALID_ACTION', 'Supported actions: click, setValue, key, typeText, scroll, drag.');
    }
  }

  return Object.freeze({
    async connect({ launch = false, windowTitle, windowId, screenshot = false, activate = false } = {}) {
      return exclusive(async () => {
        latest = null;
        target = null;
        if (typeof launch !== 'boolean' || (windowTitle !== undefined && typeof windowTitle !== 'string')
          || (windowId !== undefined && !Number.isSafeInteger(windowId))) {
          throw new TypeError('launch must be boolean; windowTitle must be exact; windowId must be an observed integer id.');
        }
        captureSettings({ screenshot, activate });
        let apps = (await sky.list_apps()).filter(isRx);
        let windows = apps.flatMap(app => app.windows ?? []);
        if (!windows.length && launch) {
          if (apps.length > 1) throw problem('RX_AMBIGUOUS_APP', 'Multiple RX Audio Editor installations found; open the intended one first.');
          await sky.launch_app({ app: apps[0]?.id ?? VERIFIED_RX12_PATH });
          apps = (await sky.list_apps()).filter(isRx);
          windows = apps.flatMap(app => app.windows ?? []);
        }
        const allWindows = windows;
        if (windowTitle !== undefined) windows = windows.filter(window => window.title === windowTitle);
        if (windowId !== undefined) windows = windows.filter(window => window.id === windowId);
        if (windows.length !== 1) {
          const error = problem('RX_WINDOW_SELECTION', `Expected exactly one RX Audio Editor window; found ${windows.length}. Open RX or provide its exact windowTitle.`);
          error.candidates = allWindows.map(({ id, app, title }) => ({ id, app, title }));
          throw error;
        }
        target = windows[0];
        return capture({ screenshot, activate });
      });
    },
    async observe(options = {}) { return exclusive(() => capture(options)); },
    find({ name, role } = {}) {
      if (busy) throw problem('RX_BUSY', 'Wait for the current operation before reading its elements.');
      if (!latest || now() - latest.issuedAt > maxAgeMs || now() < latest.issuedAt) {
        throw problem('RX_STALE_TICKET', 'Observe and inspect before resolving an element.');
      }
      if (typeof name !== 'string' || (role !== undefined && typeof role !== 'string')) {
        throw new TypeError('find requires an exact name string and optional exact role string.');
      }
      return latest.elements.filter(element => element.name === name && (role === undefined || element.role === role));
    },
    async act(ticket, action, refreshOptions = {}) {
      return exclusive(async () => {
        const observation = latest;
        latest = null; // Every attempt consumes state, including validation and input errors.
        if (!observation || ticket !== observation.snapshot.ticket) {
          throw problem('RX_INVALID_TICKET', 'Ticket is missing, superseded, or consumed; observe and inspect again.');
        }
        const age = now() - observation.issuedAt;
        if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
          throw problem('RX_STALE_TICKET', 'Observation expired; observe and inspect again.');
        }
        if (!refreshOptions || typeof refreshOptions !== 'object' || Array.isArray(refreshOptions)
          || Object.keys(refreshOptions).some(key => key !== 'screenshot')) {
          throw new TypeError('Action refresh options support only screenshot; activate in a separate observe call.');
        }
        const refresh = captureSettings({ ...observation.captureOptions, ...refreshOptions });
        const [method, input] = command(action, observation);
        try {
          await sky[method](input);
          return await capture(refresh);
        } catch (cause) {
          latest = null;
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw problem('RX_OUTCOME_UNKNOWN', `Input or refresh outcome is unknown: ${detail}. Observe and inspect before retrying.`, cause);
        }
      });
    },
  });
}
