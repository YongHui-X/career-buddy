#!/usr/bin/env node
// automation-report.mjs — why did unattended applications not go out?
//
// `data/automation-events.jsonl` has recorded an `error_category` on every
// blocked and failed application since the subsystem was written, and nothing
// read it: only automation/state.mjs and automation/prune-nontarget.mjs opened
// the file at all. So the one question that decides where to spend effort — which
// blocker is actually costing applications — had no answer, and the daily digest
// showed individual failures without ever aggregating them.
//
// Read-only. Never writes, never touches the tracker or the queue.
//
// Usage:
//   node automation-report.mjs                 # JSON
//   node automation-report.mjs --summary        # human-readable tables
//   node automation-report.mjs --days 14        # window (default 30)
//   node automation-report.mjs --since 2026-09-01

import fs from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';

/** Categories the worker records, with what each one actually means. */
export const CATEGORY_MEANING = {
  'unknown-sensitive-field': 'A question had no saved answer. Add it to application_answers in config/profile.yml.',
  'cv-attachment': 'The tailored CV could not be attached or verified in the browser.',
  'challenge-or-login': 'CAPTCHA, bot challenge, login wall, or MFA. Never worked around by design.',
  'fill-validation': 'The form reported a validation error, or navigated while being filled.',
  'multi-step-blocker': 'A multi-step form refused to advance.',
  'multi-step-unknown': 'The form advanced to a step whose fields could not be read.',
  'multi-step-limit': 'The form exceeded the ten-step safety limit.',
  'policy-gate': 'Blacklisted company, or a duplicate application already exists.',
  'prefill-policy-gate': 'A duplicate or blacklist match appeared between opening and filling.',
  'final-policy-gate': 'A duplicate or blacklist match appeared immediately before submit.',
  'pre-submit-transport': 'The local apply service became unreachable before submit.',
  'answer-drafting': 'The model could not draft a grounded answer for a required free-text field.',
  'model-budget': 'The daily model-call ceiling stopped the run.',
  'tracker-sync': 'The application was submitted but the tracker update failed.',
  'source-login': 'An authenticated job board needs a fresh sign-in.',
  'authenticated-source-scan': 'The logged-in board sweep failed.',
  'standard-scan': 'scan.mjs failed.',
  'direct-ats-scan': 'scan-ats-full.mjs failed.',
  'scheduler-run': 'The scheduled run threw before finishing.',
};

export function eventsPath(root = getCareerOpsRoot()) {
  return process.env.CAREER_OPS_AUTOMATION_EVENTS || path.join(root, 'data', 'automation-events.jsonl');
}

export function readEventLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { events: [], missing: true, torn: 0 };
  }
  const events = [];
  let torn = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { torn += 1; }
  }
  return { events, missing: false, torn };
}

/**
 * Fold the ledger into an actionable report.
 * @param {object[]} events
 * @param {{ since?: string }} [opts]
 */
export function buildReport(events, { since = null } = {}) {
  const inWindow = since
    ? events.filter((e) => typeof e?.at === 'string' && e.at.slice(0, 10) >= since)
    : events.slice();

  const byStatus = {};
  const byCategory = {};
  const byVendorCategory = {};
  const modelCalls = {};
  const runs = [];
  const shadowPasses = [];
  const submitted = [];

  for (const event of inWindow) {
    const status = event?.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;

    if (status === 'model_call') {
      const day = String(event.at || '').slice(0, 10);
      modelCalls[day] = (modelCalls[day] || 0) + 1;
      continue;
    }
    if (status === 'run_complete') {
      runs.push({ at: event.at, ok: event.ok === true, effective_mode: event.effective_mode, counts: event.counts || {} });
      continue;
    }
    if (status === 'shadow_pass') {
      shadowPasses.push({ at: event.at, clean: event.clean === true, simulations: event.simulations || 0 });
      continue;
    }
    if (status === 'submitted') {
      submitted.push({ at: event.at, vendor: event.vendor || null, mode: event.mode || null });
      continue;
    }

    const category = event?.error_category || (['blocked', 'failed', 'submission_unknown'].includes(status) ? 'uncategorized' : null);
    if (!category) continue;
    byCategory[category] = (byCategory[category] || 0) + 1;
    const vendor = event.vendor || 'unknown';
    byVendorCategory[vendor] ??= {};
    byVendorCategory[vendor][category] = (byVendorCategory[vendor][category] || 0) + 1;
  }

  const ranked = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({
      category,
      count,
      meaning: CATEGORY_MEANING[category] || 'No description recorded for this category.',
    }));

  // The rollout ladder's own evidence, so "why is it still in shadow?" is
  // answerable without re-deriving policy.mjs by hand.
  const cleanShadowDates = [...new Set(shadowPasses.filter((x) => x.clean).map((x) => String(x.at).slice(0, 10)))];
  const canaryReceipts = inWindow.filter((e) => e.status === 'submitted' && e.mode === 'canary'
    && e.direct_ats === true && e.receipt_verified === true).length;

  return {
    window: { since: since || 'all time', events: inWindow.length },
    statuses: byStatus,
    blockers: ranked,
    by_vendor: byVendorCategory,
    model_calls_per_day: modelCalls,
    runs: runs.slice(-10),
    submitted_count: submitted.length,
    rollout: {
      clean_shadow_dates: cleanShadowDates.length,
      clean_shadow_dates_needed: 3,
      verified_canary_receipts: canaryReceipts,
      verified_canary_receipts_needed: 5,
    },
  };
}

function pad(value, width) { return String(value).padEnd(width); }

export function formatSummary(report, { missing = false, torn = 0 } = {}) {
  const out = [];
  if (missing) {
    out.push('No automation event ledger yet (data/automation-events.jsonl).');
    out.push('Nothing has run, so there is nothing to report.');
    return out.join('\n');
  }
  out.push(`career-ops automation report — window: ${report.window.since} (${report.window.events} events)`);
  if (torn) out.push(`note: ${torn} unparseable ledger line${torn === 1 ? '' : 's'} skipped`);

  out.push('', 'STATUS COUNTS');
  const statuses = Object.entries(report.statuses).sort((a, b) => b[1] - a[1]);
  if (!statuses.length) out.push('  (none)');
  for (const [status, count] of statuses) out.push(`  ${pad(status, 24)} ${count}`);

  out.push('', 'WHY APPLICATIONS DID NOT GO OUT  (most costly first)');
  if (!report.blockers.length) {
    out.push('  (nothing blocked)');
  } else {
    for (const b of report.blockers) {
      out.push(`  ${pad(b.category, 26)} ${pad(b.count, 5)} ${b.meaning}`);
    }
  }

  const vendors = Object.entries(report.by_vendor);
  if (vendors.length) {
    out.push('', 'BY ATS VENDOR');
    for (const [vendor, cats] of vendors) {
      const detail = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(', ');
      out.push(`  ${pad(vendor, 16)} ${detail}`);
    }
  }

  const days = Object.entries(report.model_calls_per_day).sort();
  if (days.length) {
    out.push('', 'MODEL CALLS PER DAY');
    for (const [day, count] of days.slice(-14)) out.push(`  ${day}  ${count}`);
  }

  out.push('', 'ROLLOUT LADDER');
  out.push(`  clean shadow dates       ${report.rollout.clean_shadow_dates} / ${report.rollout.clean_shadow_dates_needed} needed for canary`);
  out.push(`  verified canary receipts ${report.rollout.verified_canary_receipts} / ${report.rollout.verified_canary_receipts_needed} needed for full`);
  out.push(`  applications submitted   ${report.submitted_count}`);

  if (report.runs.length) {
    out.push('', 'RECENT RUNS');
    for (const run of report.runs) {
      out.push(`  ${String(run.at).slice(0, 19)}  ${run.ok ? 'ok   ' : 'ISSUE'}  ${pad(run.effective_mode || '?', 8)} ${JSON.stringify(run.counts)}`);
    }
  }
  return out.join('\n');
}

function resolveSince(argv) {
  // flagValue, not indexOf: `--days=14` is invisible to indexOf, and a lookup
  // written that way silently reports the DEFAULT window instead (#2401).
  const explicit = flagValue(argv, '--since');
  if (explicit) return String(explicit).slice(0, 10);
  const raw = flagValue(argv, '--days');
  const days = Number(raw === undefined ? 30 : raw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days must be a positive number (got ${JSON.stringify(raw)})`);
  }
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

const USAGE = `Usage: node automation-report.mjs [--summary] [--days N | --since YYYY-MM-DD]

Reads data/automation-events.jsonl and reports WHY unattended applications did
not go out, worst blocker first. Read-only.

  --summary   human-readable tables instead of JSON
  --days N    window in days (default 30)
  --since D   window start as YYYY-MM-DD (overrides --days)`;

async function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, ['--summary', '--days', '--since', '--help', '-h'], USAGE, { valueFlags: ['--days', '--since'] });
  const root = getCareerOpsRoot();
  const { events, missing, torn } = readEventLines(eventsPath(root));
  const report = buildReport(events, { since: resolveSince(argv) });
  if (hasFlag(argv, '--summary')) console.log(formatSummary(report, { missing, torn }));
  else console.log(JSON.stringify({ ...report, ledger_missing: missing, torn_lines: torn }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => { console.error(`automation-report: ${error.message}`); process.exitCode = 1; });
}
