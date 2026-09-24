#!/usr/bin/env node
// automation/local-preflight.mjs — is this machine ready to run unattended?
//
// Two tiers, deliberately. The previous version had one — `checks.every(ok)` —
// and counted OPENROUTER_API_KEY, a non-`:free` CAREER_OPS_MODEL,
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID among the things that had to pass. With
// the model backend moved to a local CLI and notification moved local-first,
// none of those four exist any more, so `ok: true` was unreachable and the gate
// documented in docs/LOCAL_AUTOMATION_WINDOWS.md could never be satisfied.
//
//   required  — the run cannot work without it. Any failure means ok: false.
//   advisory  — worth knowing, never a gate. A missing Telegram bot is the
//               canonical case: it is an extra delivery channel, not an
//               interlock, and it must not be able to stop an application.
//
// Exit code follows `ok`, so scripts can keep using it as a gate.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { automationPolicy, loadProfile } from './policy.mjs';
import { resolveCli } from '../lib/cli-resolve.mjs';
import { notifyPaths, telegramConfigured } from './notify.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const required = [];
const advisory = [];
function check(name, ok, detail) { required.push({ name, ok: Boolean(ok), detail }); }
function note(name, ok, detail) { advisory.push({ name, ok: Boolean(ok), detail }); }

let profile; let policy;
try {
  profile = loadProfile(root);
  policy = automationPolicy(profile);
  check('profile YAML', true, 'config/profile.yml');
} catch (error) {
  check('profile YAML', false, error.message);
  profile = {};
  policy = automationPolicy(profile);
}

// ── Platform and dependencies ───────────────────────────────────────────────
check('supported Node.js', Number(process.versions.node.split('.')[0]) >= 18, process.versions.node);
check('at least 4 GiB RAM', os.totalmem() >= 4 * 1024 ** 3, `${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`);
check('root dependencies installed', fs.existsSync(path.join(root, 'node_modules', 'playwright', 'package.json')), 'node_modules/playwright');
check('web dependencies installed', fs.existsSync(path.join(root, 'web', 'node_modules', 'next', 'package.json')), 'web/node_modules/next');
check('web production build', fs.existsSync(path.join(root, 'web', '.next', 'BUILD_ID')), 'run npm run automation:local:build when missing');
let chromiumPath = '';
try { chromiumPath = chromium.executablePath(); } catch { /* reported below */ }
check('Chromium installed', Boolean(chromiumPath) && fs.existsSync(chromiumPath), chromiumPath || 'run npx playwright install chromium');
for (const relative of ['data/browser-profile', 'data/browser-artifacts', 'data/automation-screenshots']) {
  check(`${relative} exists`, fs.existsSync(path.join(root, relative)), relative);
}

// Windows is the primary documented path, but nothing here requires it.
note('Windows host', process.platform === 'win32', `${process.platform}/${process.arch}`);

// ── Model backend: a local CLI, no API key ──────────────────────────────────
const cli = resolveCli(policy.modelCli);
check(`model CLI '${policy.modelCli}' resolves`, Boolean(cli),
  cli ? cli.binPath : `not found on PATH; set automation.model_cli or install it`);
if (cli && process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli.binPath)) {
  // Spawnable only via cmd.exe, which is safe here because the prompt travels on
  // stdin — but a CLI needing an argv prompt would be refused at call time.
  note('model CLI is a .cmd shim', true, `${cli.binPath} — invoked through cmd.exe with the prompt on stdin`);
}
check('daily model-call ceiling', policy.maxModelCallsPerDay > 0,
  policy.maxModelCallsPerDay > 0
    ? `${policy.maxModelCallsPerDay} calls/day (automation.max_model_calls_per_day)`
    : 'set automation.max_model_calls_per_day to a positive integer');

// ── Notification: local channel is the gate, Telegram is a bonus ────────────
const { digest } = notifyPaths(root);
let digestWritable = false;
try {
  fs.mkdirSync(path.dirname(digest), { recursive: true });
  fs.appendFileSync(digest, '');
  digestWritable = true;
} catch { /* reported */ }
check('local notification channel writable', digestWritable, path.relative(root, digest));
note('Telegram push configured', telegramConfigured(),
  telegramConfigured() ? 'bot token and chat id present' : 'optional — local digest is used either way');

// ── Local service URLs ──────────────────────────────────────────────────────
check('local apply URL', /^http:\/\/(127\.0\.0\.1|localhost):3000\/?$/i.test(String(policy.applyBaseUrl).replace(/\/$/, '') + '/'), policy.applyBaseUrl);
check('local handoff URL', /^http:\/\/(127\.0\.0\.1|localhost):3000\/apply/i.test(policy.handoffUrl),
  policy.handoffUrl || 'set automation.handoff_url to http://127.0.0.1:3000/apply');

// ── Unconfirmed personal facts ──────────────────────────────────────────────
// Advisory, not a gate: the worker withholds a CONFIRM_REQUIRED answer rather
// than sending it, so an unconfirmed fact costs a field, not correctness. But it
// is the most likely reason an application stops short, so it is reported.
const unconfirmed = Object.entries(profile.application_answers || {})
  .filter(([, value]) => String(value).trim() === 'CONFIRM_REQUIRED')
  .map(([key]) => key);
note('all saved answers confirmed', unconfirmed.length === 0,
  unconfirmed.length ? `CONFIRM_REQUIRED: ${unconfirmed.join(', ')}` : 'no placeholders left');

const ok = required.every((item) => item.ok);
console.log(JSON.stringify({
  ok,
  automationEnabled: policy.enabled,
  mode: policy.mode,
  modelCli: policy.modelCli,
  checks: required,
  advisory,
}, null, 2));
if (!ok) process.exitCode = 1;
