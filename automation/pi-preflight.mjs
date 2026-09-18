#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const allowNonArm = process.argv.includes('--allow-non-arm64');
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: Boolean(ok), detail }); }

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const webPackage = JSON.parse(fs.readFileSync(path.join(root, 'web', 'package.json'), 'utf8'));
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const architecture = process.arch;

check('64-bit ARM architecture', architecture === 'arm64' || allowNonArm, `${architecture}${allowNonArm && architecture !== 'arm64' ? ' (local override)' : ''}`);
check('at least 6 GiB RAM visible', os.totalmem() >= 6 * 1024 ** 3, `${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`);
check('root Playwright is 1.63.0', rootPackage.dependencies?.playwright === '1.63.0', rootPackage.dependencies?.playwright || 'missing');
check('web Playwright is 1.63.0', webPackage.dependencies?.['playwright-core'] === '1.63.0', webPackage.dependencies?.['playwright-core'] || 'missing');
check('matching Noble browser image', /mcr\.microsoft\.com\/playwright:v1\.63\.0-noble/.test(dockerfile), 'Dockerfile base');
check('apply browser read-only', /apply-browser:[\s\S]*?read_only:\s*true/.test(compose), 'docker-compose.yml');
check('apply browser has no model/Telegram secrets', !/apply-browser:[\s\S]*?(OPENROUTER|TELEGRAM)[\s\S]*?automation-worker:/.test(compose), 'credential isolation');
check('official seccomp profile present', fs.existsSync(path.join(root, 'automation', 'seccomp_profile.json')), 'automation/seccomp_profile.json');
for (const relative of ['data/browser-profile', 'data/browser-artifacts', 'data/automation-screenshots']) check(`${relative} exists`, fs.existsSync(path.join(root, relative)), relative);
for (const secret of ['openrouter_api_key', 'openrouter_model', 'telegram_bot_token', 'telegram_chat_id', 'novnc_password']) check(`secret ${secret}`, fs.existsSync(path.join(root, 'secrets', `${secret}.txt`)), `secrets/${secret}.txt`);

console.log(JSON.stringify({ ok: checks.every((x) => x.ok), architecture, checks }, null, 2));
if (checks.some((x) => !x.ok)) process.exitCode = 1;
