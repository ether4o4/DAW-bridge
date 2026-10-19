import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runFile = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverFile = join(repository, 'src', 'bandlab-server.mjs');

async function fixture(t) {
  const fixtures = join(repository, 'work');
  await mkdir(fixtures, { recursive: true });
  const directory = await mkdtemp(join(fixtures, 'runtime-path-'));
  t.after(async () => {
    const within = relative(fixtures, directory);
    assert.ok(within && within !== '..' && !within.startsWith(`..${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function readRuntimePath(file, cwd, override) {
  const env = { ...process.env };
  delete env.AUDIO_BRIDGE_RUNTIME;
  if (override !== undefined) env.AUDIO_BRIDGE_RUNTIME = override;
  const source = `import { runtimePath } from ${JSON.stringify(pathToFileURL(file).href)}; process.stdout.write(runtimePath);`;
  return runFile(process.execPath, ['--input-type=module', '--eval', source], { cwd, env });
}

test('default runtime follows a relocated checkout instead of its working directory', async t => {
  const directory = await fixture(t);
  const checkout = join(directory, 'a relocated checkout');
  const relocatedSource = join(checkout, 'src', 'bandlab-server.mjs');
  await mkdir(dirname(relocatedSource), { recursive: true });
  await copyFile(serverFile, relocatedSource);
  const { stdout } = await readRuntimePath(relocatedSource, directory);
  assert.equal(stdout, join(checkout, 'work', 'audio-control-bridge', 'bandlab-runtime.json'));
});

test('absolute runtime override is honored without reading or creating a pairing file', async t => {
  const directory = await fixture(t);
  const pairingFile = join(directory, 'private state', 'pairing.json');
  const { stdout } = await readRuntimePath(serverFile, directory, pairingFile);
  assert.equal(stdout, pairingFile);
});

test('relative runtime override fails with an actionable error before starting a server', async t => {
  const directory = await fixture(t);
  await assert.rejects(readRuntimePath(serverFile, directory, 'private/pairing.json'), error => {
    assert.match(error.stderr, /AUDIO_BRIDGE_RUNTIME must be an absolute path/);
    return true;
  });
});

test('Windows drive-relative and root-relative runtime overrides are rejected', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  for (const override of ['C:pairing.json', '\\pairing.json', '/pairing.json']) {
    await assert.rejects(readRuntimePath(serverFile, directory, override), error => {
      assert.match(error.stderr, /AUDIO_BRIDGE_RUNTIME must be an absolute path/);
      return true;
    });
  }
});

test('Windows launchers reject relative overrides before operating on a service', { skip: process.platform !== 'win32' }, async () => {
  for (const script of ['Start-Bridge.ps1', 'Stop-Bridge.ps1']) {
    await assert.rejects(runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repository, script)], {
      cwd: repository,
      env: { ...process.env, AUDIO_BRIDGE_RUNTIME: 'private/pairing.json' },
    }), error => {
      assert.match(error.stderr, /AUDIO_BRIDGE_RUNTIME must be an absolute path/);
      return true;
    });
  }
});
