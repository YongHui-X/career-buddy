# Native Windows unattended automation

This is the primary PC workflow. Docker, WSL, OpenMediaVault, noVNC and
Tailscale are not required. The dashboard and application API bind only to
`127.0.0.1:3000`, and Chromium uses `data/browser-profile` so authenticated
sessions survive restarts.

## 1. Configure the model backend

**No API key is required.** Evaluation and CV tailoring run through a local agent
CLI, set in `config/profile.yml`:

```yaml
automation:
  model_cli: claude            # claude | codex | gemini | opencode | copilot | qwen | antigravity
  max_model_calls_per_day: 60  # hard ceiling; the run stops rather than exceed it
```

The CLI must resolve to a directly-spawnable executable —
`npm run automation:local:preflight` reports the resolved path. It is invoked
read-only: tool access is restricted to Read/Glob/Grep, no MCP servers are
loaded, and the prompt travels on **stdin** rather than the command line, because
Windows caps a command line at 32,767 characters and an evaluation prompt exceeds
that.

`automation.max_model_calls_per_day` replaces the old
`automation.daily_model_budget_usd`: a local CLI exposes no spend figure, so the
ceiling is a call count counted from `data/automation-events.jsonl`. It fails
closed — an unreadable ledger or an unset ceiling refuses to run rather than
assuming zero.

### Optional: Telegram push

Notifications are written locally to `data/automation-digest.md` and shown on the
dashboard whether or not Telegram is configured, and a Telegram failure never
stops a run. To also get the daily succeeded/failed digest on your phone, create
an untracked `.env` in the repository root:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_private_chat_id
```

Do not put these values in `config/profile.yml`.

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

### Unattended submission needs two explicit opt-ins

A real application form almost always carries a consent checkbox ("I agree to the
Privacy Notice") or a required attestation ("I certify the above is true"). Both
are refused by default at every layer, so an otherwise-complete application stops
there. Accepting them without a human present means pre-authorizing them once:

```yaml
automation:
  preauthorize:
    consent_checkboxes: true   # privacy notices, terms, data processing
    attestations: true         # "I certify the information provided is accurate"
```

Each flag must be literally `true` — absent, `false`, or a quoted `"true"` all
mean refuse. Every consent accepted this way is recorded verbatim in that
application's `output/applications/{NNN}/manifest.json`.

CAPTCHA, bot challenges, login walls and MFA remain unconditional refusals no
matter what these flags say. So does a blacklisted company, a duplicate
application, and a page whose visible company or role does not match the
evaluated posting.

### Seeing why applications did not go out

```powershell
npm run automation:report
```

Reads `data/automation-events.jsonl` and ranks the blockers worst-first, with a
per-ATS-vendor breakdown and the rollout ladder's progress. This is the fastest
way to find the one missing `application_answers` key that is costing you
applications.

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
