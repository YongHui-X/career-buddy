import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('scheduled Windows launcher hides child processes and Chromium', () => {
  const source = fs.readFileSync(new URL('../automation/local-supervisor.mjs', import.meta.url), 'utf8');
  assert.match(source, /windowsHide:\s*process\.platform === 'win32'/);
  assert.match(source, /CAREER_OPS_BROWSER_HEADLESS:\s*interactiveLogin \? 'false' : 'true'/);
});

test('interactive login is explicit and the scheduled task is hidden', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installer = fs.readFileSync(new URL('../automation/install-windows-task.ps1', import.meta.url), 'utf8');
  assert.equal(packageJson.scripts['automation:login'], 'node automation/login.mjs');
  assert.match(installer, /-WindowStyle Hidden/);
  assert.match(installer, /New-ScheduledTaskSettingsSet[^\r\n]+-Hidden/);
  assert.match(installer, /-AllowStartIfOnBatteries/);
  assert.match(installer, /-DontStopIfGoingOnBatteries/);
  assert.match(installer, /Get-ScheduledTask -TaskName \$taskName/);
});
