import fs from 'node:fs';

const SECRET_RE = /(sk-(?:or-)?[a-z0-9_-]{8,}|bot\d+:[a-z0-9_-]+|authorization:\s*bearer\s+\S+)/gi;

export function redact(value) {
  return String(value ?? '')
    .replace(SECRET_RE, '[REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email redacted]')
    .replace(/\b(?:\+?65[- ]?)?[689]\d{7}\b/g, '[phone redacted]')
    .slice(0, 3500);
}

export async function sendTelegram(text, opts = {}) {
  const readSecret = (name) => {
    if (process.env[name]) return process.env[name];
    const file = process.env[`${name}_FILE`];
    if (!file) return '';
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  };
  const token = opts.token || readSecret('TELEGRAM_BOT_TOKEN');
  const chatId = opts.chatId || readSecret('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return { sent: false, reason: 'not-configured' };
  const fetchFn = opts.fetchFn || fetch;
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: redact(text), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { sent: true };
      last = `HTTP ${response.status}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  return { sent: false, reason: redact(last || 'unknown') };
}

export async function verifyNotificationChannel(opts = {}) {
  const result = await sendTelegram('career-ops safety channel ready', opts);
  if (!result.sent) throw new Error(`Telegram safety channel unavailable: ${result.reason || 'unknown error'}`);
  return result;
}

export async function notifyBlock(item, reason, handoffUrl = '') {
  const link = handoffUrl ? `\nHandoff: ${handoffUrl}` : '';
  return sendTelegram(`Career Ops needs attention\n${item.company} — ${item.role}\n${reason}\n${item.url}${link}`);
}
