#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assertSubmissionModel, automationPolicy, loadProfile } from './policy.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: Boolean(ok), detail }); }
function isConfigured(value) {
  const normalized = String(value || '').trim();
  return Boolean(normalized) && !/^(?:\.{3}|change[-_ ]?me|your[-_ ].*|.*placeholder.*)$/i.test(normalized);
}

let profile; let policy;
try { profile = loadProfile(root); policy = automationPolicy(profile); check('profile YAML', true, 'config/profile.yml'); }
catch (error) { check('profile YAML', false, error.message); profile = {}; policy = automationPolicy(profile); }

check('supported Node.js', Number(process.versions.node.split('.')[0]) >= 18, process.versions.node);
check('Windows host', process.platform === 'win32', `${process.platform}/${process.arch}`);
check('at least 4 GiB RAM', os.totalmem() >= 4 * 1024 ** 3, `${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`);
check('root dependencies installed', fs.existsSync(path.join(root, 'node_modules', 'playwright', 'package.json')), 'node_modules/playwright');
check('web dependencies installed', fs.existsSync(path.join(root, 'web', 'node_modules', 'next', 'package.json')), 'web/node_modules/next');
check('web production build', fs.existsSync(path.join(root, 'web', '.next', 'BUILD_ID')), 'run npm run automation:local:build when missing');
check('Chromium installed', fs.existsSync(chromium.executablePath()), chromium.executablePath());
for (const relative of ['data/browser-profile', 'data/browser-artifacts', 'data/automation-screenshots']) check(`${relative} exists`, fs.existsSync(path.join(root, relative)), relative);
const openRouterConfigured = isConfigured(process.env.OPENROUTER_API_KEY);
check('OpenRouter API key', openRouterConfigured, openRouterConfigured ? 'configured' : 'missing or placeholder in .env');
let paidModel = false;
try { assertSubmissionModel(process.env.CAREER_OPS_MODEL); paidModel = true; } catch { /* reported below */ }
check('paid pinned OpenRouter model', paidModel, process.env.CAREER_OPS_MODEL ? 'must not end in :free' : 'CAREER_OPS_MODEL missing from .env');
check('daily OpenRouter budget', policy.dailyModelBudgetUsd > 0, policy.dailyModelBudgetUsd > 0
  ? `$${policy.dailyModelBudgetUsd.toFixed(2)} USD/day with $0.02 call reserve`
  : 'set automation.daily_model_budget_usd to a positive amount');
const telegramTokenConfigured = isConfigured(process.env.TELEGRAM_BOT_TOKEN);
const telegramChatConfigured = isConfigured(process.env.TELEGRAM_CHAT_ID);
check('Telegram bot token', telegramTokenConfigured, telegramTokenConfigured ? 'configured' : 'missing or placeholder in .env');
check('Telegram chat ID', telegramChatConfigured, telegramChatConfigured ? 'configured' : 'missing or placeholder in .env');
check('local apply URL', /^http:\/\/(127\.0\.0\.1|localhost):3000\/?/i.test(policy.applyBaseUrl), policy.applyBaseUrl);
check('local handoff URL', /^http:\/\/(127\.0\.0\.1|localhost):3000\/apply/i.test(policy.handoffUrl), policy.handoffUrl || 'set automation.handoff_url to http://127.0.0.1:3000/apply');

const required = checks.every((item) => item.ok);
console.log(JSON.stringify({ ok: required, automationEnabled: policy.enabled, mode: policy.mode, checks }, null, 2));
if (!required) process.exitCode = 1;
