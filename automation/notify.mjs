// automation/notify.mjs — channel-agnostic notification for the unattended
// worker.
//
// WHY: Telegram was a hard precondition for unattended submission. Three places
// turned a missing or failing bot into a stopped pipeline:
//
//   worker.mjs        verifyNotificationChannel() threw before canary/full
//   scheduler.mjs     threw when sendDigest() returned { sent: false }
//   local-preflight   counted the token and chat id in `checks.every(ok)`
//
// On a single-machine local setup that is the wrong trade: the notification is
// how you LEARN about a run, not a safety interlock on it, and a failed Telegram
// send should never be the reason an application did not go out. So the local
// channel is always available and cannot fail, and Telegram becomes an optional
// additional delivery.
//
// The local channel writes two files under the data root:
//
//   data/automation-digest.md    human-readable, newest run last, append-only
//   data/automation-notices.jsonl  machine-readable, for the dashboard
//
// redact() from telegram.mjs is applied on EVERY channel including the local
// files, because those files are the ones most likely to be pasted into a bug
// report or a chat.

import fs from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { redact, sendTelegram } from './telegram.mjs';

export { redact };

export function notifyPaths(root = getCareerOpsRoot()) {
  return {
    digest: process.env.CAREER_OPS_AUTOMATION_DIGEST || path.join(root, 'data', 'automation-digest.md'),
    notices: process.env.CAREER_OPS_AUTOMATION_NOTICES || path.join(root, 'data', 'automation-notices.jsonl'),
  };
}

/** True when both Telegram secrets are present (env or *_FILE). */
export function telegramConfigured() {
  const has = (name) => {
    if (process.env[name]) return true;
    const file = process.env[`${name}_FILE`];
    if (!file) return false;
    try { return fs.readFileSync(file, 'utf8').trim().length > 0; } catch { return false; }
  };
  return has('TELEGRAM_BOT_TOKEN') && has('TELEGRAM_CHAT_ID');
}

/**
 * Write to the local channel. Deliberately total: any failure here is swallowed
 * and reported in the return value rather than thrown, because this function is
 * on the path of every blocked application and must never be the thing that
 * stops one.
 *
 * @param {string} text
 * @param {object} [opts]
 * @returns {{ sent: boolean, reason?: string, files?: string[] }}
 */
export function writeLocalNotice(text, { root = getCareerOpsRoot(), kind = 'notice', at = new Date() } = {}) {
  const { digest, notices } = notifyPaths(root);
  const safe = redact(text);
  const written = [];
  try {
    fs.mkdirSync(path.dirname(digest), { recursive: true });
    fs.appendFileSync(digest, `\n## ${at.toISOString()} — ${kind}\n\n${safe}\n`, { encoding: 'utf8', mode: 0o600 });
    written.push(digest);
  } catch (error) {
    return { sent: false, reason: `local digest write failed: ${error.message}` };
  }
  try {
    fs.appendFileSync(notices, `${JSON.stringify({ at: at.toISOString(), kind, text: safe })}\n`, { encoding: 'utf8', mode: 0o600 });
    written.push(notices);
  } catch {
    // The markdown digest is the one that matters; the JSONL is for the
    // dashboard and its loss is not worth reporting as a failure.
  }
  return { sent: true, files: written };
}

/**
 * Deliver a notification on every configured channel.
 *
 * Succeeds when AT LEAST the local channel was written. A Telegram failure is
 * reported in `channels` but does not make the whole notification a failure —
 * that inversion is what previously let an unreachable bot stop a run.
 *
 * @param {string} text
 * @param {object} [opts]
 * @returns {Promise<{ sent: boolean, channels: Record<string, {sent: boolean, reason?: string}> }>}
 */
export async function notify(text, { root = getCareerOpsRoot(), kind = 'notice', telegram = true } = {}) {
  const channels = {};
  channels.local = writeLocalNotice(text, { root, kind });
  if (telegram && telegramConfigured()) {
    try {
      channels.telegram = await sendTelegram(text);
    } catch (error) {
      channels.telegram = { sent: false, reason: redact(error?.message || 'telegram threw') };
    }
  } else if (telegram) {
    channels.telegram = { sent: false, reason: 'not-configured' };
  }
  return { sent: channels.local.sent === true, channels };
}

/**
 * Confirm a notification channel exists before the worker is allowed to submit.
 *
 * Still a real check — it writes a probe and verifies the file landed — but it
 * can now be satisfied locally. It throws only when even the local channel is
 * unwritable, which means the data root is broken and the run has bigger
 * problems than notification.
 */
export async function verifyNotificationChannel({ root = getCareerOpsRoot() } = {}) {
  const result = writeLocalNotice('career-ops notification channel ready', { root, kind: 'channel-check' });
  if (!result.sent) {
    throw new Error(`no usable notification channel: ${result.reason || 'local digest could not be written'}`);
  }
  const channels = { local: result };
  if (telegramConfigured()) {
    channels.telegram = await sendTelegram('career-ops safety channel ready').catch((error) => ({ sent: false, reason: redact(error?.message || 'threw') }));
  }
  return { sent: true, channels };
}

/** Notify that one application needs a human. */
export async function notifyBlock(item, reason, handoffUrl = '', opts = {}) {
  const link = handoffUrl ? `\nHandoff: ${handoffUrl}` : '';
  return notify(`Career Ops needs attention\n${item.company} — ${item.role}\n${reason}\n${item.url}${link}`, { kind: 'blocked', ...opts });
}

/**
 * Format the daily digest the user actually asked for: what SUCCEEDED and what
 * FAILED, in that order, with counts as a footnote rather than a headline.
 *
 * @param {object} input
 * @param {string} input.date
 * @param {Array} input.submitted  queue items submitted today
 * @param {Array} input.outstanding queue items needing attention
 * @param {Record<string, number>} [input.counts]
 * @param {string} [input.handoffUrl]
 * @param {string} [input.mode]
 * @returns {string}
 */
export function formatDigest({ date, submitted = [], outstanding = [], counts = {}, handoffUrl = '', mode = '' }) {
  const lines = [`career-ops — ${date}${mode ? ` (${mode} mode)` : ''}`];

  lines.push('', `SUCCEEDED — ${submitted.length} application${submitted.length === 1 ? '' : 's'} submitted`);
  if (submitted.length === 0) {
    lines.push('  (none)');
  } else {
    for (const item of submitted) {
      lines.push(`  - ${redact(item.company || '?')} — ${redact(item.role || '?')}`);
      if (item.receipt?.url) lines.push(`    receipt: ${String(item.receipt.url).slice(0, 200)}`);
    }
  }

  lines.push('', `FAILED — ${outstanding.length} need${outstanding.length === 1 ? 's' : ''} attention`);
  if (outstanding.length === 0) {
    lines.push('  (none)');
  } else {
    const priority = { submission_unknown: 0, failed: 1, blocked: 2, unsupported_source: 3 };
    const sorted = [...outstanding].sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));
    for (const item of sorted.slice(0, 10)) {
      lines.push(`  - [${item.status}] ${redact(item.company || '?')} — ${redact(item.role || '?')}`);
      lines.push(`    ${redact(item.reason || 'needs attention').slice(0, 180)}`);
      if (item.url) lines.push(`    ${String(item.url).slice(0, 200)}`);
    }
    if (sorted.length > 10) lines.push(`  ...and ${sorted.length - 10} more`);
  }

  const countText = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');
  if (countText) lines.push('', `today: ${countText}`);
  if (handoffUrl) lines.push('', `Handoff: ${handoffUrl}`);
  return lines.join('\n');
}
