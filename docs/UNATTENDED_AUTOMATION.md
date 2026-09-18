# Unattended automation on OpenMediaVault

The unattended worker scans configured Singapore and remote sources, evaluates
new postings with one pinned OpenRouter model, generates a tailored CV, and uses
the existing browser application service. It starts in `shadow` mode and cannot
submit until `config/profile.yml` is deliberately changed to `canary` or `full`.

## Requirements

- 64-bit OpenMediaVault/Debian (`uname -m` should print `aarch64`)
- Docker Engine with the Compose plugin
- At least 8 GB RAM and 10 GB free disk space for browser/PDF images
- A paid OpenRouter model ID, Telegram bot token, and Telegram chat ID
- Tailscale installed on the NAS host

The worker never bypasses CAPTCHA or MFA. Unknown sensitive questions,
attestations, login expiry, validation failures, and uncertain submission
receipts are quarantined and sent to Telegram.

## Secrets

Create these five untracked files on the NAS. Each contains only the value named
by the filename and one trailing newline is fine:

```text
secrets/openrouter_api_key.txt
secrets/openrouter_model.txt
secrets/telegram_bot_token.txt
secrets/telegram_chat_id.txt
secrets/novnc_password.txt
```

`openrouter_model.txt` must contain one pinned model ID. Submission is disabled
when it is missing; the worker never rotates models while filling applications.

Set the private handoff URL before starting:

```sh
export CAREER_OPS_HANDOFF_URL=https://your-nas-name.your-tailnet.ts.net:8443
```

Set `PUID` and `PGID` to the owner of the checkout (commonly `1000`) and prepare
the protected persistent profile before the first start:

```sh
mkdir -p data/browser-profile data/browser-artifacts data/automation-screenshots
chmod 700 data/browser-profile data/browser-artifacts data/automation-screenshots
export PUID=1000 PGID=1000
```

The browser and automation services run as that non-root identity. The browser
uses Playwright's extended seccomp profile, a read-only root filesystem,
`no-new-privileges`, narrow mounts, fixed CPU/memory limits, and a 1 GB
shared-memory allocation for Chromium. It receives neither model nor Telegram
credentials.

Expose the loopback-only dashboard and noVNC service through Tailscale, not the
public internet:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve --bg --https=8443 http://127.0.0.1:6080
```

Use the `:8443` noVNC address to perform one-time job-board logins. The Chromium
profile is persisted in the protected `data/browser-profile` bind mount.

## Start and verify

```sh
docker compose build
docker compose up -d dashboard apply-browser automation-worker
docker compose logs -f automation-worker
```

Run the ARM64 and browser checks before the first shadow deployment:

```sh
npm run automation:preflight
docker compose exec apply-browser node automation/pi-browser-smoke.mjs
docker compose restart apply-browser
docker compose exec apply-browser node automation/pi-browser-smoke.mjs
docker stats --no-stream career-ops-apply-browser career-ops-automation
```

For the noVNC reachability check, pass its loopback URL to the smoke script:

```sh
docker compose exec -e CAREER_OPS_NOVNC_URL=http://127.0.0.1:6080 apply-browser node automation/pi-browser-smoke.mjs
```

Record both smoke outputs and the `docker stats` snapshot. Do not deploy shadow
mode until Chromium launch, PDF creation, persisted-profile restoration,
noVNC reachability, restart recovery, and memory pressure all pass.

Only after those checks, set `automation.enabled: true` in
`config/profile.yml`. The shipped/current migration state stays disabled, so
the 52 existing `discovered` queue entries are preserved without being
evaluated merely by installing or starting the stack.

The default schedule is 07:30 and 20:00 in `Asia/Singapore`. Run a manual shadow
cycle with:

```sh
docker compose exec automation-worker node automation/worker.mjs
```

Inspect `data/automation-queue.json`, `data/automation-events.jsonl`, generated
reports, and Telegram messages before enabling submission.

## Rollout

Set `automation.mode: auto` for the guarded unattended rollout. Its effective
mode remains shadow until three distinct clean Singapore dates, changes to
canary (one verified direct-ATS submission per day), and changes to full only
after five verified canary receipts. Full remains capped by
`max_applications_per_day` (five by default).

`shadow`, `canary`, and `full` remain available as explicit emergency/manual
overrides. Their existing evidence gates remain enforced.

If Submit was clicked but no strong confirmation page appeared, the item becomes
`submission_unknown`. It is never retried automatically, preventing duplicate
applications.

With `failure_notifications: digest`, blocked, failed, unknown-submission, and
aggregator-only items are held for the single 20:00 Telegram digest instead of
generating immediate failure messages.

Set `automation.daily_model_budget_usd` to cap unattended model use. Before
each evaluation and tailoring request, the worker reads the key's live
OpenRouter `usage_daily` value and reserves $0.02 of headroom. If the usage
endpoint is unavailable or the next call could cross the ceiling, the run stops
fail-closed before issuing another model request. OpenRouter defines the daily
usage window in UTC.
