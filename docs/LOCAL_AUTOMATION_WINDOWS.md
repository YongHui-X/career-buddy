# Native Windows unattended automation

This is the primary PC workflow. Docker, WSL, OpenMediaVault, noVNC and
Tailscale are not required. The dashboard and application API bind only to
`127.0.0.1:3000`, and Chromium uses `data/browser-profile` so authenticated
sessions survive restarts.

## 1. Configure credentials

Create an untracked `.env` in the repository root:

```dotenv
OPENROUTER_API_KEY=your_key
CAREER_OPS_MODEL=provider/paid-model-id
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_private_chat_id
```

`CAREER_OPS_MODEL` must be pinned and must not end in `:free`. Do not put these
values in `config/profile.yml`.

The profile's `automation.daily_model_budget_usd` is a local hard stop for the
worker. It checks OpenRouter's live daily usage before every evaluation and CV
tailoring request; the recommended conservative default is `$0.25`.

## 2. Build and check

```powershell
npm install
npm --prefix web install
npx playwright install chromium
npm run automation:local:build
npm run automation:local:preflight
npm run automation:fixture-smoke
npm run automation:smoke
```

The preflight must report `ok: true`. Keep `automation.enabled: false` until it
does. The existing 52 queue entries remain `discovered` while disabled.

## 3. Start locally

For the dashboard and daily scheduler:

```powershell
npm run automation:local
```

Scheduled and normal local runs are fully hidden. To deliberately open the
persistent Chromium profile for a source login, run:

```powershell
npm run automation:login
# optionally select a configured source by name
npm run automation:login -- --source=linkedin
```

Sign in, then press Ctrl+C in that PowerShell window. Scheduled runs reuse the
profile headlessly. CAPTCHA, MFA and expired sessions stop safely and appear in
the daily Telegram digest.

For exactly one cycle:

```powershell
npm run automation:local:once
```

After credentials and preflight pass, explicitly set `automation.enabled: true`
and `automation.mode: auto` in `config/profile.yml`. Automatic rollout remains
in shadow for three clean Singapore dates, permits one canary submission per
day, and reaches full only after five verified canary receipts. Manual guarded
overrides remain available:

```powershell
npm run automation:mode -- canary
npm run automation:mode -- full
```

## 4. Start automatically when you sign in

Run this once from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File automation/install-windows-task.ps1
Start-ScheduledTask -TaskName CareerOpsLocalAutomation
```

The task starts PowerShell, Node, and Chromium with hidden/headless settings. It
never opens the dashboard or a browser at sign-in. Use `npm run automation:login`
when a visible authenticated session is deliberately required. The internal
scheduler scans at 07:30 and sends one digest at 20:00 Asia/Singapore. Logs are
written to `data/automation-logs`.

To remove it:

```powershell
powershell -ExecutionPolicy Bypass -File automation/uninstall-windows-task.ps1
```
