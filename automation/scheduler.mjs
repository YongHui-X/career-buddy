#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { automationPolicy, loadProfile, singaporeDate } from './policy.mjs';
import { runWorker, sendDigest } from './worker.mjs';
import { appendEvent } from './state.mjs';
import { redact, sendTelegram } from './telegram.mjs';

const ROOT = getCareerOpsRoot();
const RUN_LOCK = path.join(ROOT, 'data', 'automation-run');
const STAMP = path.join(ROOT, 'data', 'automation-schedule-state.json');
function secret(name) { if (process.env[name]) return process.env[name]; const file = process.env[`${name}_FILE`]; if (!file) return ''; try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
for (const name of ['OPENROUTER_API_KEY', 'CAREER_OPS_MODEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) { const value = secret(name); if (value) process.env[name] = value; }
function readStamp() { try { return JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { return {}; } }
function writeStamp(value) { fs.mkdirSync(path.dirname(STAMP), { recursive: true }); fs.writeFileSync(STAMP, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); }
function localTime(timeZone) { return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }

export async function tick() {
  const profile = loadProfile(ROOT); const policy = automationPolicy(profile);
  if (!policy.enabled) return;
  const cfg = profile.automation || {}; const today = singaporeDate(new Date(), policy.timezone); const now = localTime(policy.timezone); const stamp = readStamp();
  if (now >= (cfg.scan_time || '07:30') && stamp.run_date !== today) {
    stamp.run_date = today;
    stamp.run_ok = null;
    stamp.run_started_at = new Date().toISOString();
    delete stamp.run_error;
    delete stamp.run_summary;
    writeStamp(stamp);
    try {
      const summary = await withPipelineLock(RUN_LOCK, () => runWorker());
      stamp.run_summary = summary;
      stamp.run_ok = summary.ok === true;
      if (!stamp.run_ok) stamp.run_error = 'one or more required automation stages failed; see run_summary and daily digest';
      else delete stamp.run_error;
    } catch (error) {
      stamp.run_ok = false; stamp.run_error = redact(error.message);
      appendEvent({ status: 'failed', error_category: 'scheduler-run', reason: stamp.run_error }, ROOT);
      if (policy.failureNotifications === 'immediate') await sendTelegram(`career-ops scheduled run failed\n${stamp.run_error}${policy.handoffUrl ? `\nHandoff: ${policy.handoffUrl}` : ''}`);
    }
    writeStamp(stamp);
  }
  if (now >= (cfg.digest_time || '20:00') && stamp.digest_date !== today) {
    const result = await sendDigest();
    if (!result.sent) throw new Error(`daily digest notification failed: ${result.reason || 'unknown error'}`);
    stamp.digest_date = today; writeStamp(stamp);
  }
}

console.log('career-ops automation scheduler started');
await tick().catch((e) => console.error(`scheduler: ${e.message}`));
setInterval(() => void tick().catch((e) => console.error(`scheduler: ${e.message}`)), 60_000);
