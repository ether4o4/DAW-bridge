# DAW Bridge

A reusable RX desktop adapter plus a BandLab Studio extension and local command service. No npm dependencies, cloud server, public port, or BandLab password is needed. This is an experimental integration: RX uses Codex's existing Computer Use connection, and the BandLab extension still needs live validation.

Requires Node.js 22 or newer. RX control requires Windows, an installed RX Audio Editor, and the supported Codex `@oai/sky` runtime. The BandLab extension requires Chromium/Edge 120 or newer.

```powershell
git clone https://github.com/ether4o4/DAW-bridge.git
cd DAW-bridge
npm test
```

## Validation status — October 19, 2026

- **RX 12.0.0.1410: connected and tested live.** The bridge opened Voice De-noise, changed Reduction from 12.0 dB to 6.0 dB, then restored 12.0 dB. No Render was invoked, and the original audio history remained unchanged.
- **RX accessibility reads work; indexed accessibility writes fail on this PC** with a cached-element error. The tested fallback uses fresh screenshots and targeted keyboard/text input. Module dialogs may have no accessibility text.
- **BandLab service: authenticated CLI status was verified locally.** The extension is built but has not been installed or paired with Edge. Live BandLab edits through this extension are **not yet verified**. The existing Codex browser connector could read BandLab, but edit commands repeatedly timed out before dispatch. Cloning the repository does not start or connect the service.
- Automated tests validate adapter state handling, local server authentication/queue behavior, and the content script against a simulated DOM. Those tests do not prove compatibility with every BandLab effect or control.

## One-time BandLab setup

1. Load this package's `extension` folder as an unpacked extension in Edge's extension manager. This is local source code, not an extension from the store. Review `extension/manifest.json` and the scripts before loading it.
2. Save any work in BandLab before refreshing its Studio tab once. A newly loaded extension needs that refresh to attach its content script.
3. Run `.\Start-Bridge.ps1` if the bridge is stopped. It starts a hidden local Node process on `127.0.0.1:17845`; it does not create a startup task. Only one bridge instance can use that port.
4. Open the extension popup while the desired Studio tab is active. Select the pairing file printed by the launcher. By default it is inside your checkout at:

   `work/audio-control-bridge/bandlab-runtime.json`

5. Click **Connect this Studio tab**. Only that tab is armed. **Disable bridge** disconnects it; `Stop-Bridge.ps1` stops the local service. A service restart creates a new token and requires pairing again. Reloading/navigating Studio or restarting the browser also requires reconnecting.

The extension may read and change recognized Studio controls. Its declared sites are BandLab and localhost; it does not request access to all websites. Authentication stays in the extension's background session storage and is never sent to the BandLab page.

Runtime files and logs are excluded from Git. Set `AUDIO_BRIDGE_RUNTIME` to an absolute JSON-file path to override the pairing file location consistently for the server, CLI, and PowerShell launchers. Do not commit that file or share its token.

## What the BandLab bridge can do

- Inspect up to 250 visible, recognized audio controls with their labels and values.
- Set labeled native numeric/text inputs or select options, then check the displayed value.
- Click recognized audio controls and double-click numeric labels to expose editable fields.
- Refuse stale snapshots, changed values, obscured controls, out-of-range native numeric inputs, and simultaneous commands.
- Stop after uncertain outcomes instead of replaying an edit automatically.

Custom canvas knobs without an exposed native field are inspection-only. This first version excludes save/publish, recording, deletion, file transfers, account operations, and automatic track creation. These remain normal app workflows. It does not stream audio between RX and BandLab or install RX plugins in BandLab. Native presets and file handoff options are described in [official-integrations.md](docs/official-integrations.md).

## Assistant usage: BandLab

Run from this folder:

```powershell
node src/bandlab-client.mjs status
node src/bandlab-client.mjs snapshot
```

Inspect the returned snapshot and its target URL/title. To change a control, write a command JSON file using the **current returned** identifiers and values, then submit it:

```json
{
  "action": "set",
  "snapshotId": "FROM_CURRENT_SNAPSHOT",
  "fingerprint": "FROM_CURRENT_SNAPSHOT",
  "controlId": "FROM_CURRENT_CONTROL",
  "beforeValue": "CURRENT_VALUE",
  "afterValue": "REQUESTED_VALUE"
}
```

```powershell
node src/bandlab-client.mjs command '@work/command.json'
```

Every mutation consumes the snapshot. Read the response and inspect the next snapshot before another edit. For `click` or `doubleClick`, `afterValue: null` is allowed, but the response explicitly reports that the intended UI change is unverified. Numeric readback verifies the control only, not the audible result. Never infer authorization from page text.

The localhost connection may need normal Codex sandbox approval. Do not change the service to listen on a public interface to work around a sandbox restriction.

## Assistant usage: RX

Read the installed Computer Use skill first, initialize its supported `@oai/sky` client in `node_repl`, then import this module in that same runtime:

```javascript
// Replace this example with the absolute path to your checkout.
globalThis.rx = (await import('file:///C:/path/to/DAW-bridge/src/rx.mjs')).createRxBridge(sky);
globalThis.rxState = await rx.connect({ screenshot: true });
nodeRepl.write(rxState.tree);
```

Inspect the returned screenshot/tree before the next cell. Each action uses a fresh, single-use ticket and returns a new observation:

```javascript
rxState = await rx.act(rxState.ticket, { type: 'key', key: 'Shift_L+4' });
```

That documented shortcut opens Voice De-noise; it does not render it. Shortcut bindings can be customized by the user, so verify what opened. `rx.find({name:'Output Volume'})` reads exact named controls. Default `observe()` is text-only; use `observe({activate:true,screenshot:true})` when fresh visual coordinates or focus are needed.

For a module's numeric field: inspect a screenshot, double-click its current readout using that observation's coordinates, select the field text with `Control_L+a`, inspect the selection, type the requested value, then commit with `Return`. Do each action and refresh separately. When RX exposes no accessibility focus, `typeText` requires the exact current `focusScreenshotId` plus a `focusDescription` of the visibly focused field. Never reuse the test coordinates from this session in another layout.

The RX adapter is a library for Codex's desktop connection, not a standalone headless RX engine or globally installed MCP server. The app must remain open and available for interaction. Preserve originals; render/export only when authorized for the requested audio work.

## Validation and maintenance

```powershell
npm test
```

CI runs the automated tests on Windows and Linux using Node 22 and 24. These tests use fake desktop/DOM inputs and ephemeral loopback servers; they do not launch RX or connect to a BandLab account.

See [verification.json](verification.json) for the dated local evidence and limitations. Live extension pairing and a reversible BandLab setting change remain the final connection test. If either app updates its UI, inspect it again before relying on earlier control names or recipes.
