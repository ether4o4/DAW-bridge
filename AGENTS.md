# DAW Bridge development

Read README.md and verification.json before describing integration status. Automated tests do not prove live RX or BandLab compatibility.

- Keep runtime tokens, logs, command JSON, and private audio under ignored work/. Never print pairing-file contents or authorization headers.
- Use the supported Codex Computer Use skill and @oai/sky for RX. Do not build a second native automation helper. Preserve the observe/inspect/action/refresh loop.
- BandLab mutations require an explicitly paired Studio tab and fresh snapshot IDs, fingerprints, and before values. Do not automatically retry unknown outcomes.
- Run npm test for changes to protocol, control handling, or runtime paths. The tests need localhost networking but do not need RX or a BandLab account.
- Keep Windows launchers, Node server, and CLI aligned on runtime-file location and overrides.
- Preserve originals in live audio work. Test with reversible settings restored afterward or an explicitly designated test project.
