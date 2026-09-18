#!/usr/bin/env node
import { chromium } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';

const { server, baseUrl } = await startFixtureServer();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];
  for (const scenario of ['greenhouse', 'lever', 'ashby', 'workable', 'captcha', 'mfa', 'login', 'attestation', 'unknown-required', 'failed-upload', 'validation', 'ambiguous']) {
    await page.goto(`${baseUrl}/${scenario}`);
    results.push({ scenario, controls: await page.locator('input, textarea, select').count(), marker: await page.locator('body').innerText() });
  }
  await page.goto(`${baseUrl}/workday`);
  await page.getByRole('button', { name: 'Next' }).click();
  if (!(await page.getByText('Motivation').isVisible())) throw new Error('Workday multi-step fixture did not advance');
  const redirected = await page.goto(`${baseUrl}/redirect`);
  if (!redirected?.url().endsWith('/greenhouse')) throw new Error('external ATS redirect fixture failed');
  console.log(JSON.stringify({ ok: true, scenarios: results.map((x) => x.scenario), workdayMultiStep: true, redirect: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
