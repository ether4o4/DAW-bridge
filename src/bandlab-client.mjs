import { readFile } from 'node:fs/promises';
import { runtimePath, DEFAULT_PORT } from './bandlab-server.mjs';

async function main() {
  const [verb = 'status', argument] = process.argv.slice(2);
  if (!['status', 'snapshot', 'list', 'command'].includes(verb)) throw new Error('Usage: node src/bandlab-client.mjs status|snapshot|list|command <JSON or @file>');
  const config = JSON.parse(await readFile(runtimePath, 'utf8'));
  if (config.port !== DEFAULT_PORT || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid bridge runtime file');
  let body;
  if (verb === 'snapshot' || verb === 'list') body = { action: 'snapshot' };
  if (verb === 'command') { if (!argument) throw new Error('command requires JSON or @file'); body = JSON.parse(argument.startsWith('@') ? await readFile(argument.slice(1), 'utf8') : argument); }
  const response = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/v1/${verb === 'status' ? 'status' : 'command'}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(16000) });
  const result = await response.json();
  // list retains snapshot credentials because they are mandatory for every mutation.
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || result.ok === false) process.exitCode = 1;
}
main().catch(err => { console.error(`BandLab bridge: ${err.message}`); process.exitCode = 1; });
