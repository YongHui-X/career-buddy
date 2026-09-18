#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const once = process.argv.includes('--once');
const noScan = process.argv.includes('--no-scan');
const interactiveLogin = process.argv.includes('--login');
const sourceArg = process.argv.find((x) => x.startsWith('--source='))?.slice('--source='.length).trim().toLowerCase();
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
for (const relative of ['data/browser-profile', 'data/browser-artifacts', 'data/automation-screenshots', 'data/automation-logs']) fs.mkdirSync(path.join(root, relative), { recursive: true });
if (!fs.existsSync(path.join(root, 'web', '.next', 'BUILD_ID'))) throw new Error('Web build missing. Run: npm run automation:local:build');
const lockFile = path.join(root, 'data', 'automation-local-supervisor.lock');
if (fs.existsSync(lockFile)) {
  const raw = fs.readFileSync(lockFile, 'utf8').trim();
  let previous = Number(raw);
  let startedAt = null;
  try { const parsed = JSON.parse(raw); previous = Number(parsed.pid); startedAt = Date.parse(parsed.started_at); } catch { /* legacy PID-only lock */ }
  if (Number.isInteger(previous) && previous > 0) {
    let pidAlive = false;
    try { process.kill(previous, 0); pidAlive = true; } catch { /* stale PID */ }
    let serviceAlive = false;
    if (pidAlive) {
      try {
        const response = await fetch('http://127.0.0.1:3000/api/automation/health', { signal: AbortSignal.timeout(1500) });
        const payload = await response.json();
        serviceAlive = response.ok && payload.service === 'career-ops-apply';
      } catch { /* stale lock or process still starting */ }
    }
    const recentlyStarted = Number.isFinite(startedAt) && Date.now() - startedAt < 120_000;
    if (pidAlive && (serviceAlive || recentlyStarted)) throw new Error(`local automation is already running as PID ${previous}`);
  }
  fs.unlinkSync(lockFile);
}
const lockHandle = fs.openSync(lockFile, 'wx', 0o600);
fs.writeFileSync(lockHandle, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

const env = {
  ...process.env,
  NODE_ENV: 'production',
  CAREER_OPS_APPLY_URL: 'http://127.0.0.1:3000',
  CAREER_OPS_BROWSER_PROFILE_DIR: path.join(root, 'data', 'browser-profile'),
  CAREER_OPS_BROWSER_HEADLESS: interactiveLogin ? 'false' : 'true',
};
const children = new Set();
const childPids = new Set();
function child(command, args) {
  const proc = spawn(command, args, { cwd: root, env, stdio: 'inherit', shell: false, windowsHide: process.platform === 'win32' });
  children.add(proc); if (proc.pid) childPids.add(proc.pid);
  proc.once('exit', () => children.delete(proc)); return proc;
}
async function waitForWeb() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:3000/api/automation/health', { signal: AbortSignal.timeout(1000) });
      const payload = await response.json();
      if (response.ok && payload.service === 'career-ops-apply' && payload.browserApiDisabled === false) return;
    }
    catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('local web/apply service did not become ready within 60 seconds');
}
async function shutdown(code = 0) {
  if (process.platform === 'win32') {
    await Promise.all([...childPids].map((pid) => new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', resolve); killer.once('error', resolve);
    })));
  } else {
    for (const proc of children) proc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  try { fs.closeSync(lockHandle); } catch { /* already closed */ }
  try { fs.unlinkSync(lockFile); } catch { /* already removed */ }
  process.exit(code);
}
process.once('SIGINT', () => void shutdown(130));
process.once('SIGTERM', () => void shutdown(143));

if (!fs.existsSync(npmCli)) throw new Error(`npm CLI was not found beside Node: ${npmCli}`);
const web = child(process.execPath, [npmCli, '--prefix', 'web', 'run', 'start', '--', '--hostname', '127.0.0.1', '--port', '3000']);
web.once('exit', (code) => { if (!once) void shutdown(code || 1); });
try {
  await waitForWeb();
  console.log('career-ops local apply service ready at http://127.0.0.1:3000/apply');
  if (interactiveLogin) {
    const portals = yaml.load(fs.readFileSync(path.join(root, 'portals.yml'), 'utf8')) || {};
    const sources = (portals.browser_sources || []).filter((x) => /^https:\/\//i.test(x?.url || '')
      && (x?.enabled !== false || (sourceArg && String(x.name || '').toLowerCase().includes(sourceArg))));
    const selected = (sourceArg ? sources.find((x) => String(x.name || '').toLowerCase().includes(sourceArg)) : sources[0]) || sources[0];
    if (!selected) throw new Error('no matching browser_sources entry exists in portals.yml');
    const response = await fetch('http://127.0.0.1:3000/api/automation/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: selected.url }),
    });
    if (!response.ok) throw new Error(`interactive browser login failed: ${(await response.text()).slice(0, 200)}`);
    console.log(`Interactive login opened for ${selected.name || selected.url}. Sign in, then press Ctrl+C here.`);
  } else {
  const workerArgs = [once ? 'automation/worker.mjs' : 'automation/scheduler.mjs'];
  if (once && noScan) workerArgs.push('run', '--no-scan');
  const worker = child(process.execPath, workerArgs);
  worker.once('exit', (code, signal) => {
    if (!once) console.error(`automation scheduler exited unexpectedly (code=${code ?? 'null'}, signal=${signal || 'none'})`);
    void shutdown(once ? (code || 0) : (code || 1));
  });
  }
} catch (error) {
  console.error(`local supervisor: ${error.message}`);
  await shutdown(1);
}
