#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { buildTitleFilter } from '../title-keywords.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const PROTECTED_QUEUE_STATUSES = new Set(['applying', 'submitted', 'submission_unknown']);

export function pruneQueueState(state, titleMatches) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const kept = items.filter((item) => PROTECTED_QUEUE_STATUSES.has(item.status) || titleMatches(item.role));
  return { state: { ...state, items: kept }, removed: items.length - kept.length };
}

export function prunePipelineText(text, titleMatches) {
  let removed = 0;
  const lines = String(text || '').split(/\r?\n/).filter((line) => {
    if (!/^- \[[ x]\]\s+https?:\/\//i.test(line)) return true;
    const role = (line.split(' | ')[2] || '').trim();
    if (!role || titleMatches(role)) return true;
    removed++;
    return false;
  });
  return { text: `${lines.join('\n').replace(/\n+$/, '')}\n`, removed };
}

function atomicWrite(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

export function pruneNonTargets(root = getCareerOpsRoot(), { confirm = false } = {}) {
  const portals = yaml.load(fs.readFileSync(path.join(root, 'portals.yml'), 'utf8')) || {};
  const titleMatches = buildTitleFilter(portals.title_filter);
  const queueFile = path.join(root, 'data', 'automation-queue.json');
  const pipelineFile = path.join(root, 'data', 'pipeline.md');
  const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  const pipeline = fs.readFileSync(pipelineFile, 'utf8');
  const queueResult = pruneQueueState(queue, titleMatches);
  const pipelineResult = prunePipelineText(pipeline, titleMatches);
  if (confirm) {
    atomicWrite(queueFile, `${JSON.stringify(queueResult.state, null, 2)}\n`);
    atomicWrite(pipelineFile, pipelineResult.text);
  }
  return { confirmed: confirm, queue_removed: queueResult.removed, pipeline_removed: pipelineResult.removed };
}

if (isMainModule(import.meta.url)) {
  const confirm = process.argv.includes('--confirm');
  const result = pruneNonTargets(getCareerOpsRoot(), { confirm });
  console.log(JSON.stringify(result, null, 2));
  if (!confirm && (result.queue_removed || result.pipeline_removed)) {
    console.error('Dry run only. Re-run with --confirm to remove non-target operational entries.');
  }
}
