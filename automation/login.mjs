#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { automationPolicy, loadProfile } from './policy.mjs';

const root = getCareerOpsRoot();
const policy = automationPolicy(loadProfile(root));
const sourceArg = String(process.argv.find((x) => x.startsWith('--source=')) || '').slice('--source='.length).trim().toLowerCase();
const portals = yaml.load(fs.readFileSync(path.join(root, 'portals.yml'), 'utf8')) || {};
// An explicitly named source may be disabled for unattended discovery precisely
// because it needs this deliberate visible-login flow.
const sources = (portals.browser_sources || []).filter((x) => /^https:\/\//i.test(x?.url || '')
  && (x?.enabled !== false || (sourceArg && String(x.name || '').toLowerCase().includes(sourceArg))));
const selected = (sourceArg ? sources.find((x) => String(x.name || '').toLowerCase().includes(sourceArg)) : sources[0]) || sources[0];
if (!selected) throw new Error('no matching browser_sources entry exists in portals.yml');

const health = await fetch(`${policy.applyBaseUrl}/api/automation/health`, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
if (!health?.ok) throw new Error('career-ops service is not running; start the CareerOpsLocalAutomation task first');
const response = await fetch(`${policy.applyBaseUrl}/api/automation/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: selected.url }), signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`interactive login failed: ${(await response.text()).slice(0, 200)}`);
console.log(`Opened the persistent browser for ${selected.name || selected.url}. Sign in, then close the browser window.`);
