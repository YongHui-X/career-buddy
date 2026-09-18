#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { loadProfile, rolloutDecision } from './policy.mjs';
import { readEvents } from './state.mjs';

const requested = String(process.argv[2] || '').toLowerCase();
if (!['auto', 'shadow', 'canary', 'full'].includes(requested)) {
  console.error('Usage: npm run automation:mode -- auto|shadow|canary|full');
  process.exit(2);
}
const root = getCareerOpsRoot();
const profile = loadProfile(root);
const decision = requested === 'auto'
  ? { allowed: true, reason: 'automatic rollout derives its effective mode from verified evidence' }
  : rolloutDecision(requested, readEvents(root), profile.automation?.timezone || profile.location?.timezone || 'Asia/Singapore');
if (!decision.allowed) {
  console.error(`Refusing ${requested}: ${decision.reason}`);
  process.exit(1);
}
const file = path.join(root, 'config', 'profile.yml');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
let inAutomation = false; let changed = false;
for (let i = 0; i < lines.length; i++) {
  if (/^automation:\s*$/.test(lines[i])) { inAutomation = true; continue; }
  if (inAutomation && /^\S/.test(lines[i])) break;
  if (inAutomation && /^\s+mode:\s*/.test(lines[i])) {
    const indent = lines[i].match(/^\s*/)?.[0] || '  ';
    lines[i] = `${indent}mode: "${requested}" # auto | shadow | canary | full`;
    changed = true;
    break;
  }
}
if (!changed) throw new Error('config/profile.yml has no automation.mode entry');
const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
fs.writeFileSync(temp, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
fs.renameSync(temp, file);
console.log(`automation rollout mode set explicitly to ${requested}`);
