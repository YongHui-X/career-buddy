import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../path-resolver.mjs';

export const AUTOMATION_STATUSES = new Set([
  'discovered', 'evaluated', 'eligible', 'applying', 'submitted', 'blocked',
  'failed', 'submission_unknown', 'retry_wait', 'skipped', 'unsupported_source',
]);

const SENSITIVE_RE = /\b(?:salary|compensation|pay expectation|work auth|authori[sz]ed to work|visa|sponsor|citizen|immigration|relocat|disab|veteran|gender|sex|race|ethnic|religion|background check|criminal|conviction|date of birth|age|national id|passport|consent|agree|attest|privacy|terms)\b/i;
const CAPTCHA_RE = /captcha|not a robot|human verification|turnstile/i;

export function isSensitiveField(label = '') {
  return SENSITIVE_RE.test(String(label));
}

export function isChallenge(text = '') {
  return CAPTCHA_RE.test(String(text));
}

export function isDirectAtsUrl(value = '') {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|myworkdaysite\.com)$/.test(host);
  } catch {
    return false;
  }
}

export function assertSubmissionModel(model = process.env.CAREER_OPS_MODEL || '') {
  const value = String(model).trim();
  if (!value) throw new Error('CAREER_OPS_MODEL is required');
  if (/:free$/i.test(value)) throw new Error('submission runs require a paid pinned OpenRouter model; :free models are research-only');
  return value;
}

export function loadProfile(root = getCareerOpsRoot()) {
  const file = path.join(root, 'config', 'profile.yml');
  const raw = fs.readFileSync(file, 'utf8');
  return yaml.load(raw) || {};
}

export function automationPolicy(profile = {}) {
  const cfg = profile.automation || {};
  return {
    enabled: cfg.enabled === true,
    mode: ['auto', 'shadow', 'canary', 'full'].includes(cfg.mode) ? cfg.mode : 'shadow',
    minScore: Number.isFinite(Number(cfg.min_score)) ? Number(cfg.min_score) : 4,
    maxPerDay: Number.isInteger(Number(cfg.max_applications_per_day))
      ? Math.max(0, Number(cfg.max_applications_per_day)) : 5,
    maxEvaluationsPerRun: Number.isInteger(Number(cfg.max_evaluations_per_run))
      ? Math.max(1, Number(cfg.max_evaluations_per_run)) : 5,
    canaryMaxPerDay: Number.isInteger(Number(cfg.canary_max_per_day))
      ? Math.max(0, Number(cfg.canary_max_per_day)) : 1,
    sourceCooldownHours: Number.isFinite(Number(cfg.source_cooldown_hours)) ? Math.max(1, Number(cfg.source_cooldown_hours)) : 24,
    timezone: cfg.timezone || profile.location?.timezone || 'Asia/Singapore',
    applyBaseUrl: process.env.CAREER_OPS_APPLY_URL || cfg.apply_service_url || 'http://127.0.0.1:3000',
    handoffUrl: process.env.CAREER_OPS_HANDOFF_URL || cfg.handoff_url || '',
    browserHeadless: cfg.browser_headless !== false,
    failureNotifications: ['immediate', 'digest'].includes(cfg.failure_notifications) ? cfg.failure_notifications : 'immediate',
    directAtsScan: cfg.direct_ats_scan !== false,
    dailyModelBudgetUsd: Number.isFinite(Number(cfg.daily_model_budget_usd))
      ? Math.max(0, Number(cfg.daily_model_budget_usd)) : 0.25,
    savedAnswers: profile.application_answers || {},
  };
}

export function resolveEffectiveMode(configuredMode, events = [], timeZone = 'Asia/Singapore') {
  if (configuredMode !== 'auto') return configuredMode;
  const cleanShadowDates = new Set(events
    .filter((x) => x.status === 'shadow_pass' && x.clean === true)
    .map((x) => singaporeDate(new Date(x.at), timeZone)));
  if (cleanShadowDates.size < 3) return 'shadow';
  const canaryReceipts = events.filter((x) => x.status === 'submitted'
    && x.mode === 'canary' && x.direct_ats === true && x.receipt_verified === true).length;
  return canaryReceipts >= 5 ? 'full' : 'canary';
}

export function dailyLimit(policy) {
  if (policy.mode === 'shadow') return 0;
  return policy.mode === 'canary' ? Math.min(1, policy.canaryMaxPerDay) : policy.maxPerDay;
}

export function eligibilityDecision(evaluation, policy) {
  if (Number(evaluation.score) < policy.minScore) return { eligible: false, reason: `score ${Number(evaluation.score).toFixed(1)} below ${policy.minScore.toFixed(1)}` };
  if (evaluation.location_eligible !== true) return { eligible: false, reason: 'not Singapore-based or globally remote-eligible' };
  if (evaluation.seniority_eligible !== true) return { eligible: false, reason: 'seniority or required experience is outside the target range' };
  if (!['High Confidence', 'Proceed with Caution'].includes(evaluation.legitimacy)) return { eligible: false, reason: 'posting legitimacy is not credible enough for unattended application' };
  if (evaluation.post_age_days === null || evaluation.post_age_days === undefined) {
    if (Number(evaluation.score) < 4.5 || evaluation.legitimacy !== 'High Confidence') return { eligible: false, reason: 'unknown posting age requires score >=4.5 and High Confidence legitimacy' };
  } else if (Number(evaluation.post_age_days) > 7) return { eligible: false, reason: `posting is ${Number(evaluation.post_age_days)} days old` };
  if (Number.isFinite(Number(evaluation.salary_monthly_sgd)) && Number(evaluation.salary_monthly_sgd) < 4000) return { eligible: false, reason: `advertised salary is below SGD 4,000/month` };
  return { eligible: true, reason: 'policy gates passed' };
}

export function rolloutDecision(mode, events = [], timeZone = 'Asia/Singapore') {
  if (mode === 'shadow') return { allowed: true, reason: 'shadow mode is always safe' };
  const cleanShadowDates = new Set(events.filter((x) => x.status === 'shadow_pass' && x.clean === true).map((x) => singaporeDate(new Date(x.at), timeZone)));
  if (mode === 'canary' && cleanShadowDates.size < 3) return { allowed: false, reason: `canary requires 3 clean shadow dates; found ${cleanShadowDates.size}` };
  if (mode === 'full') {
    const canaryReceipts = events.filter((x) => x.status === 'submitted' && x.mode === 'canary' && x.direct_ats === true && x.receipt_verified === true).length;
    if (canaryReceipts < 5) return { allowed: false, reason: `full mode requires 5 verified direct-ATS canary receipts; found ${canaryReceipts}` };
  }
  return { allowed: true, reason: 'rollout evidence satisfied' };
}

export function retryDecision({ attempts = 0, submitInitiated = false, status = '' } = {}) {
  if (submitInitiated || status === 'submission_unknown') return { retry: false, status: 'submission_unknown' };
  return Number(attempts) <= 2
    ? { retry: true, status: 'retry_wait' }
    : { retry: false, status: 'failed' };
}

export function digestCounts(events = [], date = new Date(), timeZone = 'Asia/Singapore') {
  const target = singaporeDate(date, timeZone);
  const counts = {};
  for (const event of events) {
    if (!event?.at || singaporeDate(new Date(event.at), timeZone) !== target) continue;
    counts[event.status] = (counts[event.status] || 0) + 1;
  }
  return counts;
}

export function singaporeDate(date = new Date(), timeZone = 'Asia/Singapore') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
