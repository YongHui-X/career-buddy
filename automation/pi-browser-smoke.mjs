#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const configuredProfile = process.env.CAREER_OPS_BROWSER_PROFILE_DIR;
const temporaryProfile = !configuredProfile;
const profile = configuredProfile || fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-pi-smoke-'));
const results = [];
let firstMarker;

async function launch(round) {
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.setContent(`<main><h1>career-ops ARM64 smoke</h1><p>${round}</p></main>`);
    const pdf = await page.pdf({ format: 'A4' });
    if (!pdf.subarray(0, 4).equals(Buffer.from('%PDF'))) throw new Error('PDF signature missing');
    if (round === 1) {
      firstMarker = `restored-${Date.now()}`;
      await context.addCookies([{ name: 'career-ops-smoke', value: firstMarker, domain: 'example.test', path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    } else {
      const marker = (await context.cookies('https://example.test')).find((cookie) => cookie.name === 'career-ops-smoke')?.value;
      if (marker !== firstMarker) throw new Error('persistent profile marker was not restored');
    }
    results.push({ round, chromium: true, pdfBytes: pdf.length, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  } finally { await context.close(); }
}

try {
  await launch(1);
  await launch(2);
  if (process.env.CAREER_OPS_NOVNC_URL) {
    const response = await fetch(process.env.CAREER_OPS_NOVNC_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`noVNC returned HTTP ${response.status}`);
    results.push({ noVnc: true, status: response.status });
  }
  console.log(JSON.stringify({ ok: true, profileRestored: true, results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, results }, null, 2));
  process.exitCode = 1;
} finally {
  if (temporaryProfile) fs.rmSync(profile, { recursive: true, force: true });
}
