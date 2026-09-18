import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { AUTOMATION_STATUSES } from './policy.mjs';

export function statePaths(root = getCareerOpsRoot()) {
  return {
    queue: process.env.CAREER_OPS_AUTOMATION_QUEUE || path.join(root, 'data', 'automation-queue.json'),
    events: process.env.CAREER_OPS_AUTOMATION_EVENTS || path.join(root, 'data', 'automation-events.jsonl'),
  };
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

export function readQueue(root = getCareerOpsRoot()) {
  const { queue } = statePaths(root);
  try {
    const parsed = JSON.parse(fs.readFileSync(queue, 'utf8'));
    if (!Array.isArray(parsed.items)) return { schema_version: 1, items: [] };
    parsed.items = parsed.items.map((item) => ({ ...item, normalized_url: item.normalized_url || normalizedUrl(item.url) }));
    return parsed;
  } catch {
    return { schema_version: 1, items: [] };
  }
}

function normalizedUrl(value) {
  try {
    const u = new URL(value);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|source$|ref$|trk$)/i.test(k)) u.searchParams.delete(k);
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}

function normalizedIdentity(company, role) {
  const clean = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const c = clean(company); const r = clean(role);
  return c && c !== 'unknown' && r && r !== 'unknown' ? `${c}|${r}` : '';
}

function isDirectAtsUrl(value = '') {
  try {
    const host = new URL(value).hostname.toLowerCase();
    // iCIMS is discovered by the broad ATS pass but has no guarded form
    // adapter yet, so it remains a manual/digest item instead of entering the
    // automated application queue.
    return /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|myworkdaysite\.com)$/.test(host);
  } catch { return false; }
}

export function parsePendingPipeline(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const hit = line.match(/^- \[ \] (.+)$/);
    if (!hit) continue;
    const parts = hit[1].split(' | ').map((x) => x.trim());
    if (!/^https?:\/\//i.test(parts[0] || '')) continue;
    const posted = parts.slice(4).join(' | ').match(/posted:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || null;
    out.push({ url: parts[0], company: parts[1] || 'Unknown', role: parts[2] || 'Unknown', location: parts[3] || '', posted_at: posted });
  }
  return out;
}

export async function mutateQueue(fn, root = getCareerOpsRoot()) {
  const { queue } = statePaths(root);
  return withPipelineLock(queue, async () => {
    const state = readQueue(root);
    const result = await fn(state);
    atomicWrite(queue, `${JSON.stringify(state, null, 2)}\n`);
    return result;
  });
}

export async function enqueue(items, root = getCareerOpsRoot()) {
  return mutateQueue((state) => {
    const known = new Set(state.items.map((x) => normalizedUrl(x.url)));
    const identities = new Map(state.items.map((x) => [normalizedIdentity(x.company, x.role), x]).filter(([key]) => key));
    for (const tracker of [path.join(root, 'data', 'applications.md'), path.join(root, 'applications.md')]) {
      if (!fs.existsSync(tracker)) continue;
      for (const line of fs.readFileSync(tracker, 'utf8').split(/\r?\n/)) {
        const cells = line.split('|').slice(1, -1).map((x) => x.trim());
        if (/^\d+$/.test(cells[0] || '')) identities.set(normalizedIdentity(cells[2], cells[3]), { tracker: true });
      }
      break;
    }
    const added = [];
    for (const raw of items) {
      const key = normalizedUrl(raw.url);
      const identity = normalizedIdentity(raw.company, raw.role);
      if (!key || known.has(key)) continue;
      const identityMatch = identity ? identities.get(identity) : null;
      if (identityMatch) {
        if (!identityMatch.tracker && ['discovered', 'retry_wait', 'failed', 'unsupported_source'].includes(identityMatch.status)
          && isDirectAtsUrl(raw.apply_url || raw.url)
          && !isDirectAtsUrl(identityMatch.apply_url || identityMatch.url)) {
          identityMatch.apply_url = raw.apply_url || raw.url;
          identityMatch.ats_resolution = { vendor: new URL(identityMatch.apply_url).hostname, source: 'exact-company-role-match', resolved_at: new Date().toISOString() };
          identityMatch.status = 'discovered';
          identityMatch.reason = null;
          identityMatch.next_retry_at = null;
          identityMatch.updated_at = new Date().toISOString();
        }
        continue;
      }
      const now = new Date().toISOString();
      const item = {
        id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
        url: raw.url, normalized_url: key, company: raw.company || 'Unknown', role: raw.role || 'Unknown',
        location: raw.location || '', posted_at: raw.posted_at || null, source: raw.source || null, status: 'discovered', attempts: 0,
        created_at: now, updated_at: now,
      };
      state.items.push(item);
      known.add(key);
      if (identity) identities.set(identity, item);
      added.push(item);
    }
    return added;
  }, root);
}

export async function reconcileQueue(pipeline = [], { maxAgeDays = 7, titleMatches = null, locationMatches = null } = {}, root = getCareerOpsRoot()) {
  const pipelineByUrl = new Map(pipeline.map((x) => [normalizedUrl(x.url), x]));
  return mutateQueue((state) => {
    const now = Date.now();
    const changed = [];
    for (const item of state.items) {
      const source = pipelineByUrl.get(item.normalized_url || normalizedUrl(item.url));
      if (!item.posted_at && source?.posted_at) item.posted_at = source.posted_at;
      const ageBase = item.posted_at || item.created_at;
      const ageDays = ageBase ? Math.floor((now - Date.parse(ageBase)) / 86_400_000) : null;
      const direct = isDirectAtsUrl(item.apply_url || item.url);
      const active = ['discovered', 'retry_wait', 'unsupported_source', 'eligible'].includes(item.status);
      if (active && typeof titleMatches === 'function' && !titleMatches(item.role)) {
        Object.assign(item, { status: 'skipped', reason: 'outside current target titles', next_retry_at: null, updated_at: new Date().toISOString() });
        changed.push(item.id);
      } else if (active && typeof locationMatches === 'function' && !locationMatches(item.location, item.url, item.role)) {
        Object.assign(item, { status: 'skipped', reason: 'outside current target locations', next_retry_at: null, updated_at: new Date().toISOString() });
        changed.push(item.id);
      } else if (['discovered', 'retry_wait', 'unsupported_source'].includes(item.status) && ageDays !== null && ageDays > maxAgeDays) {
        Object.assign(item, { status: 'skipped', reason: `posting is ${ageDays} days old`, next_retry_at: null, updated_at: new Date().toISOString() });
        changed.push(item.id);
      } else if (['discovered', 'retry_wait'].includes(item.status) && !direct) {
        Object.assign(item, { status: 'unsupported_source', reason: 'aggregator-only posting; no exact employer-hosted ATS match', next_retry_at: null, updated_at: new Date().toISOString() });
        changed.push(item.id);
      } else if (item.status === 'failed' && direct && !item.recovered_at
        && (typeof titleMatches !== 'function' || titleMatches(item.role))
        && (typeof locationMatches !== 'function' || locationMatches(item.location, item.url, item.role))
        && /OpenRouter|timeout|extract/i.test(String(item.reason || '')) && (ageDays === null || ageDays <= maxAgeDays)) {
        Object.assign(item, { status: 'discovered', reason: null, next_retry_at: null, evaluation_attempts: 0, recovered_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        changed.push(item.id);
      }
    }
    return changed;
  }, root);
}

export async function transition(id, status, patch = {}, root = getCareerOpsRoot()) {
  if (!AUTOMATION_STATUSES.has(status)) throw new Error(`invalid automation status: ${status}`);
  const item = await mutateQueue((state) => {
    const found = state.items.find((x) => x.id === id);
    if (!found) throw new Error(`automation item not found: ${id}`);
    Object.assign(found, patch, { status, updated_at: new Date().toISOString() });
    return { ...found };
  }, root);
  appendEvent({ item_id: id, status, normalized_url: item.normalized_url, vendor: item.vendor || null, attempt: item.attempts || 0, artifact_bundle: item.artifacts?.bundle || null, ...patch }, root);
  return item;
}

export function appendEvent(event, root = getCareerOpsRoot()) {
  const { events } = statePaths(root);
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.appendFileSync(events, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function readEvents(root = getCareerOpsRoot()) {
  const { events } = statePaths(root);
  try { return fs.readFileSync(events, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

function plain(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

export function submissionPolicyGate(item, root = getCareerOpsRoot()) {
  const company = plain(item.company); const role = plain(item.role);
  const blacklist = path.join(root, 'data', 'blacklist.md');
  if (company && fs.existsSync(blacklist)) {
    const text = plain(fs.readFileSync(blacklist, 'utf8'));
    if (text.includes(company)) return { allowed: false, reason: `company is listed in data/blacklist.md` };
  }
  const queueDuplicate = readQueue(root).items.find((x) => x.id !== item.id && x.status === 'submitted' && plain(x.company) === company && plain(x.role) === role);
  if (queueDuplicate) return { allowed: false, reason: 'same company/role already has a verified submission receipt' };
  for (const tracker of [path.join(root, 'data', 'applications.md'), path.join(root, 'applications.md')]) {
    if (!fs.existsSync(tracker)) continue;
    for (const line of fs.readFileSync(tracker, 'utf8').split(/\r?\n/)) {
      const cells = line.split('|').slice(1, -1).map((x) => x.trim());
      if (!/^\d+$/.test(cells[0] || '') || Number(cells[0]) === Number(item.report_num)) continue;
      if (plain(cells[2]) === company && plain(cells[3]) === role && /applied|interview|offer|hired/i.test(cells.join(' '))) return { allowed: false, reason: 'duplicate application channel found in tracker' };
    }
    break;
  }
  return { allowed: true, reason: 'blacklist and duplicate gates passed' };
}

export function pipelineItems(root = getCareerOpsRoot()) {
  const file = path.join(root, 'data', 'pipeline.md');
  return parsePendingPipeline(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
}
