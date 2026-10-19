const status = document.getElementById('status');
const token = document.getElementById('token');
document.getElementById('config').addEventListener('change', async event => {
  try { const config = JSON.parse(await event.target.files[0].text()); if (config.port !== 17845 || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid pairing file'); token.value = config.token; status.textContent = 'Pairing file loaded. Connect your Studio tab.'; } catch (err) { status.textContent = err.message; }
});
document.getElementById('connect').addEventListener('click', async () => {
  try { const result = await chrome.runtime.sendMessage({ type: 'bridge.connect', token: token.value.trim() }); status.textContent = result.error || 'Connected. Keep the local bridge running.'; if (!result.error) token.value = ''; } catch (err) { status.textContent = err.message; }
});
document.getElementById('disconnect').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'bridge.disconnect' }); token.value = ''; status.textContent = 'Disabled.'; });
chrome.runtime.sendMessage({ type: 'bridge.status' }).then(result => { status.textContent = result.active ? 'This bridge is armed for: ' + result.title : (result.error || 'Not connected.'); });
