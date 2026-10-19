# Official integration surfaces

Reviewed against official RX 12 and BandLab documentation on October 19, 2026. These are documented product capabilities, not a claim that every action has been tested by this bridge. The installed RX version and current browser UI remain the authority for available controls.

## iZotope RX

- **Module presets:** RX supports importing presets, reloading the preset directory, and assigning a preset shortcut. The documented Windows user folder is `C:\Users\<user>\Documents\iZotope\RX Audio Editor\User Presets\`; prior RX Pro installations can use a different location. Use the module's **Explore Preset** action to confirm the actual folder. [Common Module Controls](https://docs.izotope.com/rx12/en/common-module-controls.html)
- **Module Chain:** save and recall ordered processing chains, enable or disable modules, and edit individual module settings. Wow & Flutter is excluded from chains. [Module Chain](https://docs.izotope.com/rx12/en/module-chain.html)
- **Batch Processor:** apply a chain to multiple files. Batch presets can store both chain and output settings; output supports a separate destination, naming changes, and file-format selection. Wow & Flutter is excluded. [Batch Processor](https://docs.izotope.com/rx12/en/batch-processor.html)
- **Keyboard bindings:** custom bindings can be exported and imported. Windows defaults include `Ctrl+B` for Batch Processor, `C` for Module Chain, `Shift+Space` for preview, and `Ctrl+E` for export. Opening and processing a module are different commands: for example, `Shift+4` opens Voice De-noise and `Ctrl+4` processes it. The manual's command-name strings identify keyboard bindings; they are not documented as an external invocation API. [Keyboard Shortcuts](https://docs.izotope.com/rx12/en/keyboard-shortcuts.html)
- **RX Connect:** a plugin workflow for transferring clips between supported desktop DAW/NLE hosts and RX. It is not documented as a BandLab browser integration. [RX Connect](https://docs.izotope.com/rx12/en/rx-connect.html)
- **Review evidence:** RX documents preserve editing history, and the current undo history can be exported as XML. [Working with Files](https://docs.izotope.com/rx12/en/working-with-files.html)

## BandLab Web Studio

- **Keyboard controls:** documented shortcuts include save revision (`Ctrl+S` on Windows), automation (`A`), mute (`Shift+M`), solo (`Shift+S`), duplicate track (`Shift+D`), play/stop (`Space`), and beginning of project (`Enter`). Confirm focus and selection before sending a shortcut. [Studio Keyboard Shortcuts](https://help.bandlab.com/hc/en-us/articles/360021363353-Studio-Keyboard-Shortcuts)
- **FX presets:** custom effects chains can be saved and recalled from **My Presets**. Current documented limits are 10 effects, or 20 with Membership; some effects require Membership. [Creating Custom FX Presets](https://help.bandlab.com/hc/en-us/articles/900000100726-Creating-Custom-FX-Presets)
- **MIDI mapping:** Web Studio's **View > MIDI Mappings** highlights mappable controls. Mappings persist in browser cookies. A software-generated MIDI connection is a possible future adapter, but needs its own end-to-end validation. [Mapping your MIDI device](https://help.bandlab.com/hc/en-us/articles/900000187966-Mapping-your-MIDI-device)
- **Automation:** volume, pan, and exposed FX parameters support automation points; mapped MIDI controls can record automation. [Using Automation](https://help.bandlab.com/hc/en-us/articles/360021039314-Using-Automation)
- **Audio exchange:** tracks can be exported as audio, and project stems can be downloaded in WAV or M4A. Audio files can then be imported into Studio. [Downloading Mixdowns and Tracks](https://help.bandlab.com/hc/en-us/articles/115002959774-Downloading-Mixdowns-and-Tracks), [Importing Audio and MIDI Files](https://help.bandlab.com/hc/en-us/articles/900003008403-Importing-Audio-and-MIDI-Files)

## Recommended bridge workflow

Use native RX presets, Module Chains, and Batch Processor presets for repeated cleanup tasks. Inspect settings, preview the treatment, and verify the result before treating a job as complete. Keep the GUI-dependent adapter explicit about which operations were observed and which were merely requested.

Use BandLab's saved FX chains and visible browser controls for editing. Keep MIDI mapping as an optional adapter until a mapped parameter has been changed and read back successfully in the user's actual session.

For a BandLab-to-RX round trip:

1. Save the current BandLab revision and export the required track or WAV stem.
2. Retain that export unchanged as the source. Process a working copy in RX.
3. Export the processed result to a separate output folder with a distinct filename. Avoid overwriting the source.
4. Verify duration, sample rate, channel count, and alignment before importing the result into a new BandLab track.
5. Compare playback with the original, retain the original track, and save a new revision after accepting the edit.

The official materials reviewed did not expose a general RX scripting/headless-processing API or a public BandLab project-editing API. This is a bounded research finding, not proof that no other integration exists. Private website endpoints and third-party wrappers are not established by these sources as supported interfaces.
