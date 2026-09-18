import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSubmissionModel, automationPolicy, dailyLimit, digestCounts, eligibilityDecision, isDirectAtsUrl, isSensitiveField, resolveEffectiveMode, retryDecision, rolloutDecision, singaporeDate } from '../automation/policy.mjs';
import { enqueue, parsePendingPipeline, readQueue, reconcileQueue, submissionPolicyGate } from '../automation/state.mjs';
import { redact, sendTelegram, verifyNotificationChannel } from '../automation/telegram.mjs';
import { assertOpenRouterDailyBudget, callOpenRouterJson } from '../automation/openrouter.mjs';
import { fixtureHtml } from '../automation/fixture-server.mjs';
import { buildRunSummary, directCheckpointItems, directScanArgs } from '../automation/worker.mjs';
import { prunePipelineText, pruneQueueState } from '../automation/prune-nontarget.mjs';

test('policy defaults fail closed in shadow mode', () => {
  const p = automationPolicy({ location: { timezone: 'Asia/Singapore' } });
  assert.equal(p.enabled, false);
  assert.equal(p.mode, 'shadow');
  assert.equal(p.minScore, 4);
  assert.equal(p.maxEvaluationsPerRun, 5);
  assert.equal(dailyLimit(p), 0);
});

test('evaluation batches are bounded to a positive integer', () => {
  assert.equal(automationPolicy({ automation: { max_evaluations_per_run: 2 } }).maxEvaluationsPerRun, 2);
  assert.equal(automationPolicy({ automation: { max_evaluations_per_run: 0 } }).maxEvaluationsPerRun, 1);
  assert.equal(automationPolicy({ automation: { max_evaluations_per_run: 'invalid' } }).maxEvaluationsPerRun, 5);
});

test('evaluated jobs are tracked before eligibility can skip them', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'automation', 'worker.mjs'), 'utf8');
  const evaluated = source.indexOf("transition(live.id, 'evaluated'");
  const tracked = source.indexOf('await ensureTrackerRow(item, null)', evaluated);
  const gated = source.indexOf('eligibilityDecision(result, policy)', evaluated);
  assert.ok(evaluated >= 0 && tracked > evaluated && gated > tracked);
});

test('canary and full daily limits are distinct', () => {
  assert.equal(dailyLimit(automationPolicy({ automation: { mode: 'canary', canary_max_per_day: 4 } })), 1);
  assert.equal(dailyLimit(automationPolicy({ automation: { mode: 'full', max_applications_per_day: 5 } })), 5);
});

test('eligibility gates enforce location, age, salary, seniority, and score', () => {
  const policy = automationPolicy({ automation: { min_score: 4 } });
  const good = { score: 4.2, location_eligible: true, seniority_eligible: true, post_age_days: 3, salary_monthly_sgd: 4500, legitimacy: 'High Confidence' };
  assert.equal(eligibilityDecision(good, policy).eligible, true);
  assert.match(eligibilityDecision({ ...good, post_age_days: 8 }, policy).reason, /8 days/);
  assert.match(eligibilityDecision({ ...good, salary_monthly_sgd: 3999 }, policy).reason, /below SGD/);
  assert.equal(eligibilityDecision({ ...good, location_eligible: false }, policy).eligible, false);
  assert.equal(eligibilityDecision({ ...good, seniority_eligible: false }, policy).eligible, false);
  assert.equal(eligibilityDecision({ ...good, post_age_days: null, score: 4.5, legitimacy: 'High Confidence' }, policy).eligible, true);
  assert.equal(eligibilityDecision({ ...good, post_age_days: null, score: 4.4, legitimacy: 'High Confidence' }, policy).eligible, false);
  assert.equal(eligibilityDecision({ ...good, legitimacy: 'Suspicious' }, policy).eligible, false);
});

test('submission model rejects free routing', () => {
  assert.equal(assertSubmissionModel('anthropic/claude-sonnet'), 'anthropic/claude-sonnet');
  assert.throws(() => assertSubmissionModel('vendor/model:free'), /paid pinned/);
});

test('rollout requires three shadow dates and five canary receipts', () => {
  const shadow = ['2026-01-01', '2026-01-02', '2026-01-03'].map((d) => ({ at: `${d}T01:00:00Z`, status: 'shadow_pass', clean: true }));
  assert.equal(rolloutDecision('canary', shadow, 'UTC').allowed, true);
  assert.equal(rolloutDecision('canary', shadow.slice(0, 2), 'UTC').allowed, false);
  const receipts = Array.from({ length: 5 }, (_, i) => ({ at: `2026-01-${10 + i}T01:00:00Z`, status: 'submitted', mode: 'canary', direct_ats: true, receipt_verified: true }));
  assert.equal(rolloutDecision('full', [...shadow, ...receipts], 'UTC').allowed, true);
});

test('auto mode advances only from clean shadow dates and verified canary receipts', () => {
  const shadow = ['2026-01-01', '2026-01-02', '2026-01-03'].map((d) => ({ at: `${d}T01:00:00Z`, status: 'shadow_pass', clean: true }));
  assert.equal(resolveEffectiveMode('auto', shadow.slice(0, 2), 'UTC'), 'shadow');
  assert.equal(resolveEffectiveMode('auto', shadow, 'UTC'), 'canary');
  const receipts = Array.from({ length: 5 }, (_, i) => ({ at: `2026-01-${10 + i}T01:00:00Z`, status: 'submitted', mode: 'canary', direct_ats: true, receipt_verified: true }));
  assert.equal(resolveEffectiveMode('auto', [...shadow, ...receipts], 'UTC'), 'full');
  assert.equal(resolveEffectiveMode('shadow', [...shadow, ...receipts], 'UTC'), 'shadow');
});

test('final submission gate enforces blacklist and duplicate tracker channels', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-policy-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'automation-queue.json'), '{"schema_version":1,"items":[]}');
  fs.writeFileSync(path.join(root, 'data', 'blacklist.md'), '| Acme | reason |\n');
  assert.equal(submissionPolicyGate({ id: '1', company: 'Acme', role: 'Engineer', report_num: 1 }, root).allowed, false);
  fs.writeFileSync(path.join(root, 'data', 'blacklist.md'), '');
  fs.writeFileSync(path.join(root, 'data', 'applications.md'), '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n| 2 | 2026-01-01 | Acme | Engineer | 4/5 | Applied | x | x | x |\n');
  assert.equal(submissionPolicyGate({ id: '1', company: 'Acme', role: 'Engineer', report_num: 1 }, root).allowed, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sensitive questions are recognized and ordinary motivation is not', () => {
  assert.equal(isSensitiveField('Will you require visa sponsorship?'), true);
  assert.equal(isSensitiveField('I agree to the privacy notice'), true);
  assert.equal(isSensitiveField('Why do you want to join us?'), false);
});

test('canary submission is limited to direct ATS hosts', () => {
  assert.equal(isDirectAtsUrl('https://jobs.ashbyhq.com/acme/abc'), true);
  assert.equal(isDirectAtsUrl('https://sg.jobstreet.com/job/123'), false);
});

test('pending pipeline parser keeps canonical fields', () => {
  const rows = parsePendingPipeline('- [ ] https://jobs.example/1 | Acme | AI Engineer | Singapore\n- [x] https://jobs.example/2');
  assert.deepEqual(rows, [{ url: 'https://jobs.example/1', company: 'Acme', role: 'AI Engineer', location: 'Singapore', posted_at: null }]);
});

test('exact direct-ATS identity upgrades an aggregator queue item without duplication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-direct-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'automation-queue.json'), JSON.stringify({ schema_version: 1, items: [{ id: 'a', url: 'https://aggregator.test/job/1', normalized_url: 'https://aggregator.test/job/1', company: 'Acme Pte Ltd', role: 'AI Engineer', status: 'unsupported_source' }] }));
  const added = await enqueue([{ url: 'https://jobs.lever.co/acme/123', company: 'Acme Pte Ltd', role: 'AI Engineer' }], root);
  const item = readQueue(root).items[0];
  assert.equal(added.length, 0);
  assert.equal(item.apply_url, 'https://jobs.lever.co/acme/123');
  assert.equal(item.status, 'discovered');
  fs.rmSync(root, { recursive: true, force: true });
});

test('queue reconciliation preserves history while classifying stale and aggregator-only jobs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-reconcile-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'automation-queue.json'), JSON.stringify({ schema_version: 1, items: [
    { id: 'stale', url: 'https://jobs.lever.co/acme/old', company: 'Acme', role: 'Old Role', status: 'discovered', posted_at: '2020-01-01' },
    { id: 'agg', url: 'https://aggregator.test/job/2', company: 'Beta', role: 'Engineer', status: 'discovered', created_at: new Date().toISOString() },
    { id: 'done', url: 'https://jobs.lever.co/acme/done', company: 'Acme', role: 'Done', status: 'submitted', posted_at: '2020-01-01' },
  ] }));
  await reconcileQueue([], { maxAgeDays: 7 }, root);
  const byId = Object.fromEntries(readQueue(root).items.map((x) => [x.id, x]));
  assert.equal(byId.stale.status, 'skipped');
  assert.equal(byId.agg.status, 'unsupported_source');
  assert.equal(byId.done.status, 'submitted');
  fs.rmSync(root, { recursive: true, force: true });
});

test('queue reconciliation skips old targets without changing completed history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-retarget-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'automation-queue.json'), JSON.stringify({ schema_version: 1, items: [
    { id: 'dev', url: 'https://jobs.lever.co/acme/dev', company: 'Acme', role: 'Software Engineer', status: 'discovered', created_at: new Date().toISOString() },
    { id: 'network', url: 'https://jobs.lever.co/acme/net', company: 'Acme', role: 'Network Engineer', status: 'discovered', created_at: new Date().toISOString() },
    { id: 'submitted', url: 'https://jobs.lever.co/acme/done', company: 'Acme', role: 'Software Engineer', status: 'submitted', created_at: new Date().toISOString() },
    { id: 'failed-dev', url: 'https://jobs.lever.co/acme/failed', company: 'Acme', role: 'Backend Engineer', status: 'failed', reason: 'OpenRouter timeout', created_at: new Date().toISOString() },
  ] }));
  await reconcileQueue([], { maxAgeDays: 7, titleMatches: (title) => /network/i.test(title) }, root);
  const byId = Object.fromEntries(readQueue(root).items.map((item) => [item.id, item]));
  assert.equal(byId.dev.status, 'skipped');
  assert.equal(byId.dev.reason, 'outside current target titles');
  assert.equal(byId.network.status, 'discovered');
  assert.equal(byId.submitted.status, 'submitted');
  assert.equal(byId['failed-dev'].status, 'failed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('queue reconciliation skips locations outside the active market before evaluation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-relocate-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'automation-queue.json'), JSON.stringify({ schema_version: 1, items: [
    { id: 'sg', url: 'https://jobs.lever.co/acme/sg', company: 'Acme', role: 'Network Engineer', location: 'Singapore', status: 'discovered', created_at: new Date().toISOString() },
    { id: 'us', url: 'https://jobs.lever.co/acme/us', company: 'Acme', role: 'Network Engineer', location: 'Remote - USA', status: 'retry_wait', reason: 'timeout', created_at: new Date().toISOString() },
  ] }));
  await reconcileQueue([], { maxAgeDays: 7, locationMatches: (location) => /singapore/i.test(location) }, root);
  const byId = Object.fromEntries(readQueue(root).items.map((item) => [item.id, item]));
  assert.equal(byId.sg.status, 'discovered');
  assert.equal(byId.us.status, 'skipped');
  assert.equal(byId.us.reason, 'outside current target locations');
  fs.rmSync(root, { recursive: true, force: true });
});

test('automation profile accepts auto mode and digest-only failure delivery', () => {
  const policy = automationPolicy({ automation: { enabled: true, mode: 'auto', browser_headless: true, failure_notifications: 'digest', direct_ats_scan: true } });
  assert.equal(policy.mode, 'auto');
  assert.equal(policy.browserHeadless, true);
  assert.equal(policy.failureNotifications, 'digest');
  assert.equal(policy.directAtsScan, true);
});

test('direct ATS scan is bounded and samples every supported source', () => {
  const args = directScanArgs();
  assert.deepEqual(args.slice(0, 5), ['scan-ats-full.mjs', '--since', '7', '--ats', 'greenhouse,lever,ashby,workday,icims']);
  assert.equal(args.includes('--resume'), false);
  assert.equal(args.includes('--shuffle'), true);
  assert.equal(args[args.indexOf('--limit') + 1], '250');
});

test('partial direct-ATS checkpoints yield usable queue records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-direct-checkpoint-'));
  fs.mkdirSync(path.join(root, 'data', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'cache', 'ats-full-checkpoint.json'), JSON.stringify({ offers: [
    { url: 'https://jobs.lever.co/acme/123', company: 'Acme', title: 'Engineer', location: 'Singapore', postedAt: Date.UTC(2026, 8, 12), source: 'lever-full' },
  ] }));
  assert.deepEqual(directCheckpointItems(root), [{ url: 'https://jobs.lever.co/acme/123', company: 'Acme', role: 'Engineer', location: 'Singapore', posted_at: '2026-09-12', source: 'lever-full' }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('run summary cannot report success when a required stage failed', () => {
  const good = buildRunSummary([{ status: 'evaluated' }, { status: 'skipped' }], { configuredMode: 'auto', effectiveMode: 'shadow', startedAt: 'start', finishedAt: 'end' });
  const bad = buildRunSummary([{ status: 'evaluated' }, { status: 'failed' }], { configuredMode: 'auto', effectiveMode: 'shadow', startedAt: 'start', finishedAt: 'end' });
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false);
  assert.equal(bad.counts.failed, 1);
});

test('Telegram redaction removes contact details and API keys', () => {
  const value = redact('john@example.com +65 91234567 sk-or-v1-supersecretvalue');
  assert.doesNotMatch(value, /john@example|91234567|supersecretvalue/);
});

test('Telegram notifier uses an injected transport', async () => {
  let payload;
  const result = await sendTelegram('hello', { token: 'test', chatId: '42', fetchFn: async (_url, init) => { payload = JSON.parse(init.body); return { ok: true }; } });
  assert.equal(result.sent, true);
  assert.equal(payload.chat_id, '42');
});

test('notification readiness fails closed when Telegram delivery fails', async () => {
  await assert.rejects(
    verifyNotificationChannel({ token: 'test', chatId: '42', fetchFn: async () => ({ ok: false, status: 401 }) }),
    /safety channel unavailable/,
  );
});

test('OpenRouter structured output is schema checked', async () => {
  const beforeKey = process.env.OPENROUTER_API_KEY; const beforeModel = process.env.CAREER_OPS_MODEL;
  process.env.OPENROUTER_API_KEY = 'test'; process.env.CAREER_OPS_MODEL = 'vendor/model';
  try {
    const value = await callOpenRouterJson({ system: 's', prompt: 'p', validate: (x) => x.ok === true, fetchFn: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }) }) });
    assert.deepEqual(value, { ok: true });
  } finally {
    if (beforeKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = beforeKey;
    if (beforeModel === undefined) delete process.env.CAREER_OPS_MODEL; else process.env.CAREER_OPS_MODEL = beforeModel;
  }
});

test('malformed or ungrounded model output fails before application work', async () => {
  const beforeKey = process.env.OPENROUTER_API_KEY; const beforeModel = process.env.CAREER_OPS_MODEL;
  process.env.OPENROUTER_API_KEY = 'test'; process.env.CAREER_OPS_MODEL = 'vendor/model';
  try {
    await assert.rejects(callOpenRouterJson({ system: 's', prompt: 'p', validate: () => true, fetchFn: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{bad json' } }] }) }) }), /truncated JSON|Unexpected token/);
    await assert.rejects(callOpenRouterJson({ system: 's', prompt: 'p', validate: (x) => Array.isArray(x.evidence) && x.evidence.length > 0, fetchFn: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"score":4.8,"evidence":[]}' } }] }) }) }), /schema validation/);
    await assert.rejects(callOpenRouterJson({ system: 's', prompt: 'p', validate: () => true, fetchFn: async () => ({ ok: false, status: 503, text: async () => 'unavailable' }) }), /HTTP 503/);
  } finally {
    if (beforeKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = beforeKey;
    if (beforeModel === undefined) delete process.env.CAREER_OPS_MODEL; else process.env.CAREER_OPS_MODEL = beforeModel;
  }
});

test('OpenRouter requests parameter-compatible structured output and rejects length truncation', async () => {
  const beforeKey = process.env.OPENROUTER_API_KEY; const beforeModel = process.env.CAREER_OPS_MODEL;
  process.env.OPENROUTER_API_KEY = 'test'; process.env.CAREER_OPS_MODEL = 'vendor/model';
  let requestBody;
  try {
    await assert.rejects(callOpenRouterJson({ system: 's', prompt: 'p', validate: () => true, schema: { type: 'object' }, fetchFn: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"ok":true}' } }] }) };
    } }), /truncated/);
    assert.equal(requestBody.provider.require_parameters, true);
    assert.deepEqual(requestBody.plugins, [{ id: 'response-healing' }]);
    assert.equal(requestBody.max_tokens, 16000);
  } finally {
    if (beforeKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = beforeKey;
    if (beforeModel === undefined) delete process.env.CAREER_OPS_MODEL; else process.env.CAREER_OPS_MODEL = beforeModel;
  }
});

test('daily OpenRouter budget reserves headroom and fails closed', async () => {
  const beforeKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test';
  try {
    const allowed = await assertOpenRouterDailyBudget(0.25, { fetchFn: async () => ({ ok: true, json: async () => ({ data: { usage_daily: 0.11 } }) }) });
    assert.equal(allowed.enforced, true);
    assert.equal(allowed.remaining, 0.14);
    await assert.rejects(
      assertOpenRouterDailyBudget(0.25, { fetchFn: async () => ({ ok: true, json: async () => ({ data: { usage_daily: 0.24 } }) }) }),
      /daily model budget reached/,
    );
    await assert.rejects(
      assertOpenRouterDailyBudget(0.25, { fetchFn: async () => ({ ok: false, status: 503 }) }),
      /budget check failed/,
    );
  } finally {
    if (beforeKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = beforeKey;
  }
});

test('Singapore date uses the requested timezone', () => {
  assert.equal(singaporeDate(new Date('2026-01-01T16:30:00Z'), 'Asia/Singapore'), '2026-01-02');
});

test('only pre-submit failures receive at most two retries', () => {
  assert.deepEqual(retryDecision({ attempts: 1 }), { retry: true, status: 'retry_wait' });
  assert.deepEqual(retryDecision({ attempts: 2 }), { retry: true, status: 'retry_wait' });
  assert.deepEqual(retryDecision({ attempts: 3 }), { retry: false, status: 'failed' });
  assert.deepEqual(retryDecision({ attempts: 1, submitInitiated: true }), { retry: false, status: 'submission_unknown' });
});

test('daily digest counts are derived from event records in Singapore time', () => {
  const events = [
    { at: '2026-01-01T16:30:00Z', status: 'discovered' },
    { at: '2026-01-02T02:00:00Z', status: 'submitted' },
    { at: '2026-01-02T16:30:00Z', status: 'failed' },
  ];
  assert.deepEqual(digestCounts(events, new Date('2026-01-02T05:00:00Z'), 'Asia/Singapore'), { discovered: 1, submitted: 1 });
});

test('fixture catalogue covers supported ATS and every stop condition', () => {
  for (const scenario of ['greenhouse', 'lever', 'ashby', 'workable', 'workday', 'captcha', 'mfa', 'login', 'attestation', 'unknown-required', 'failed-upload', 'validation', 'ambiguous']) {
    assert.match(fixtureHtml(`/${scenario}`), /<|Verification code|Sign in/);
  }
});

test('queue migration preserves existing discovered jobs without evaluating them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-queue-'));
  fs.mkdirSync(path.join(root, 'data'));
  const items = Array.from({ length: 52 }, (_, i) => ({ id: String(i), url: `https://example.test/job/${i}`, company: `Company ${i}`, role: 'Engineer', status: 'discovered', attempts: 0 }));
  fs.writeFileSync(path.join(root, 'data', 'automation-queue.json'), JSON.stringify({ schema_version: 1, items }));
  const added = await enqueue([{ url: 'https://example.test/job/1', company: 'Company 1', role: 'Engineer' }], root);
  assert.equal(added.length, 0);
  assert.equal(readQueue(root).items.length, 52);
  assert.equal(readQueue(root).items.every((item) => item.status === 'discovered'), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('retarget pruning removes obsolete operational jobs but preserves ambiguous submissions', () => {
  const match = (title) => /network/i.test(title);
  const queue = pruneQueueState({ schema_version: 1, items: [
    { id: 'old', role: 'Software Engineer', status: 'skipped' },
    { id: 'new', role: 'Network Engineer', status: 'discovered' },
    { id: 'unknown', role: 'Software Engineer', status: 'submission_unknown' },
  ] }, match);
  assert.equal(queue.removed, 1);
  assert.deepEqual(queue.state.items.map((item) => item.id), ['new', 'unknown']);
  const pipeline = prunePipelineText('# Pipeline\n- [ ] https://example/1 | Acme | Software Engineer | Singapore\n- [ ] https://example/2 | Acme | Network Engineer | Singapore\n', match);
  assert.equal(pipeline.removed, 1);
  assert.match(pipeline.text, /Network Engineer/);
  assert.doesNotMatch(pipeline.text, /Software Engineer/);
});
