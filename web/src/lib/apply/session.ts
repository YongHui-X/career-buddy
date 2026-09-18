import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Locator, type Response } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractForm, type ApplyField, type ExtractedForm } from "./extract";
import { parseGreenhouse, fetchGreenhouseSchema } from "./greenhouse";
import { statusBlock, dismissConsent, tryApplyTrigger, dropNewTabs, classifyEmpty, captchaWarning, multiStepInfo, verifyFill, verifyFillDetailed, type ApplyIssue, type FieldVerification } from "./diagnose";
import { agentInterpretForm } from "./agent-interpret";
import { careerOpsRoot } from "../career-ops";
import { adapterFor, detectVendor } from "./adapters";
import { finalSubmissionControls } from "./submit-control";
import { attestationMatches, confirmationMatches, fileMetadataMatches } from "./receipt.mjs";

/** The frame with the most interactive controls — where the agentic interpreter
 *  should look when deterministic extraction found nothing usable. */
async function richestControlFrame(page: Page): Promise<Frame> {
  let best = page.mainFrame();
  let bestN = -1;
  for (const fr of page.frames()) {
    const n = await fr.evaluate(() => document.querySelectorAll('input, textarea, select, [role="combobox"], [contenteditable="true"]').length).catch(() => 0);
    if (n > bestN) {
      bestN = n;
      best = fr;
    }
  }
  return best;
}

/** Escape a value for use inside a double-quoted CSS attribute selector.
 *  Backslash FIRST, then quote — escaping only the quote would let a trailing
 *  backslash neutralize the closing quote (CodeQL js/incomplete-sanitization). */
function cssAttr(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Navigate resiliently: a transient nav error / slow ATS shouldn't fail the
 *  whole apply. Up to 3 attempts with backoff; returns the navigation Response
 *  (status/headers feed the cheap status-block check). */
async function gotoResilient(page: Page, url: string): Promise<Response | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
      return resp;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(800 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("could not open the page");
}

/** Distinguish a real APPLICATION form from a careers-listing / job-search form
 *  (a closed Greenhouse posting redirects to the board, whose keyword/department
 *  filters would otherwise look like a fillable form). */
function looksLikeApplicationForm(form: ExtractedForm): boolean {
  const fs = form.fields;
  if (fs.length === 0) return false;
  const lab = (f: ApplyField) => (f.label || "").toLowerCase();
  const hasFile = fs.some((f) => f.type === "file");
  const hasEmail = fs.some((f) => f.type === "email" || /e-?mail/.test(lab(f)));
  const hasAppish = fs.some((f) => /first name|last name|full name|resume|résumé|\bcv\b|cover letter|phone|linkedin|github|why |portfolio|sponsorship|relocat/.test(lab(f)));
  if (hasFile || hasEmail || hasAppish) return true; // clearly an application
  // Job-description pages can expose long lists of optional skill/favourite
  // checkboxes. MyCareersFuture does this for every skill tag, which previously
  // made the posting itself look like an application form and prevented us from
  // clicking the real Apply button. A checkbox-only surface with no required or
  // applicant-identity fields is navigation/filter UI, not an application.
  if (fs.every((f) => f.type === "checkbox") && fs.every((f) => !f.required)) return false;
  const allSearch = fs.every(
    (f) => /search|buscar|filtr|keyword|palabra|department|departa|office|oficina|location|ubicaci|remote|category|categor/.test(lab(f)) || /filter|search|keyword/.test((f.nativeId || "").toLowerCase()),
  );
  if (allSearch) return false; // a job-board search/filter form
  if (fs.length <= 3 && fs.every((f) => !f.required)) return false; // too sparse + all optional = not an app form
  return true;
}

/** ATS forms are often embedded in an <iframe> on a company career site
 *  (greenhouse/lever/smartrecruiters embeds), sometimes cross-origin — the main
 *  frame then has 0 fields. Extract from EVERY frame and keep the richest one. */
async function pickFormFrame(page: Page): Promise<{ frame: Frame; form: ExtractedForm }> {
  let best: { frame: Frame; form: ExtractedForm } = {
    frame: page.mainFrame(),
    form: { title: "", url: page.url(), fields: [] },
  };
  for (const fr of page.frames()) {
    try {
      const form = await extractForm(fr);
      if (form.fields.length > best.form.fields.length) best = { frame: fr, form };
    } catch {
      /* detached / cross-origin restriction → skip */
    }
  }
  // Prefer the main frame's title (the posting title) when an iframe won the form.
  if (best.frame !== page.mainFrame() && !best.form.title) best.form.title = await page.title().catch(() => best.form.title);
  return best;
}

/** Enrich generically-extracted fields with an ATS's published schema (clean
 *  labels, correct types, real options) — Greenhouse renders react-select
 *  widgets whose options aren't in the DOM. Matched by native id/name, then label. */
async function enrichFromAts(url: string, fields: ApplyField[]): Promise<void> {
  const gh = parseGreenhouse(url);
  if (!gh) return;
  const schema = await fetchGreenhouseSchema(gh.token, gh.jobId);
  if (!schema) return;
  for (const f of fields) {
    const hit =
      (f.nativeName && schema.get(f.nativeName)) ||
      (f.nativeId && schema.get(f.nativeId)) ||
      (f.label && schema.get(`label:${f.label.toLowerCase()}`));
    if (!hit) continue;
    if (hit.label) f.label = hit.label;
    if (hit.type) f.type = hit.type as ApplyField["type"];
    if (hit.options.length) f.options = hit.options;
    if (hit.required) f.required = true;
    if (hit.type === "select") f.combobox = true;
  }
}

// A persistent apply SESSION keeps one real-form page open (headed-but-off-screen)
// so we can: extract → (user verifies pre-filled answers) → FILL the real form →
// bringToFront() for the human to submit it themselves. Headed (channel:chrome) =
// the user's own Chrome on their residential IP (best ATS success); never submits.
type Session = { id: string; url: string; title: string; fields: ApplyField[]; context: BrowserContext; page: Page; frame: Frame; createdAt: number; formShot?: string; persistent?: boolean; cvMetadata?: { name: string; size: number }; visitedSteps?: Set<string> };

declare global {
  // eslint-disable-next-line no-var
  var __coApplySessions: Map<string, Session> | undefined;
  // eslint-disable-next-line no-var
  var __coHeadedBrowser: Browser | undefined;
  var __coPersistentContext: BrowserContext | undefined;
  var __coPersistentHeadless: boolean | undefined;
  // eslint-disable-next-line no-var
  var __coIdleTimer: ReturnType<typeof setTimeout> | undefined;
}
const SESSIONS: Map<string, Session> = (globalThis.__coApplySessions ??= new Map());

async function persistentContext(headlessOverride?: boolean): Promise<BrowserContext> {
  const profileDir = process.env.CAREER_OPS_BROWSER_PROFILE_DIR?.trim();
  if (!profileDir) throw new Error("CAREER_OPS_BROWSER_PROFILE_DIR is required for authenticated discovery");
  const headless = headlessOverride ?? process.env.CAREER_OPS_BROWSER_HEADLESS === "true";
  let context = globalThis.__coPersistentContext;
  if (context && globalThis.__coPersistentHeadless !== headless) {
    await context.close().catch(() => {});
    globalThis.__coPersistentContext = undefined;
    context = undefined;
  }
  if (!context) {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-dev-shm-usage"],
    });
    globalThis.__coPersistentContext = context;
    globalThis.__coPersistentHeadless = headless;
  }
  return context;
}

export async function openAuthenticatedLogin(url: string): Promise<void> {
  if (!/^https:\/\//i.test(url)) throw new Error("login URL must use HTTPS");
  const context = await persistentContext(false);
  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url() === "about:blank") || await context.newPage();
  await gotoResilient(page, url);
  await page.bringToFront().catch(() => {});
}

async function headedBrowser(): Promise<Browser> {
  const b = globalThis.__coHeadedBrowser;
  if (b && b.isConnected()) return b;
  let nb: Browser;
  try {
    nb = await chromium.launch({
      channel: "chrome",
      headless: false,
      args: ["--window-position=-3200,-3200", "--window-size=1280,940"], // off-screen during fill; moved on-screen at handoff
    });
  } catch {
    // No system Google Chrome → fall back to Playwright's bundled Chromium if
    // present; otherwise a clear, actionable error.
    try {
      nb = await chromium.launch({ headless: false, args: ["--window-position=-3200,-3200", "--window-size=1280,940"] });
    } catch {
      throw new Error("The apply feature needs Google Chrome. Install Chrome (or run: npx playwright install chromium) and try again.");
    }
  }
  globalThis.__coHeadedBrowser = nb;
  return nb;
}

/** Close the headed Chrome once no sessions have been active for a while, so we
 *  don't leak a browser process. Re-armed on every prune/close; cancelled on open. */
function scheduleIdleClose() {
  if (globalThis.__coIdleTimer) clearTimeout(globalThis.__coIdleTimer);
  globalThis.__coIdleTimer = setTimeout(() => {
    if (SESSIONS.size === 0) {
      const b = globalThis.__coHeadedBrowser;
      globalThis.__coHeadedBrowser = undefined;
      void b?.close().catch(() => {});
      const c = globalThis.__coPersistentContext;
      globalThis.__coPersistentContext = undefined;
      void c?.close().catch(() => {});
    }
  }, 5 * 60_000);
}

function prune() {
  const now = Date.now();
  for (const [id, s] of SESSIONS) if (now - s.createdAt > 15 * 60_000) void closeSession(id);
}

/** Bounded scroll pass to trigger lazy/virtualized forms that only render their
 *  fields once scrolled into view, then return to the top. */
async function nudgeScroll(page: Page): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * 1200).catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

export async function openSession(url: string, cliId?: string, forceAgent?: boolean, noApplyBtn?: boolean): Promise<{ id: string; title: string; fields: ApplyField[]; shots: string[]; issues: ApplyIssue[]; needsDrive?: boolean; vendor: string }> {
  prune();
  if (globalThis.__coIdleTimer) clearTimeout(globalThis.__coIdleTimer); // someone's active
  const profileDir = process.env.CAREER_OPS_BROWSER_PROFILE_DIR?.trim();
  let persistent = false;
  let context: BrowserContext;
  if (profileDir) {
    context = await persistentContext();
    persistent = true;
  } else {
    const browser = await headedBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  }
  context.setDefaultTimeout(8000); // no single action hangs the whole open/fill
  const page = await context.newPage();
  const abort = async (msg: string): Promise<never> => {
    if (persistent) await page.close().catch(() => {});
    else await context.close().catch(() => {});
    if (SESSIONS.size === 0) scheduleIdleClose();
    throw new Error(msg);
  };
  // Capture the real form as we read it → a "behind the scenes" progress strip
  // that proves we genuinely opened + parsed THEIR form (not magic). The last
  // shot doubles as a subtle blurred backdrop behind the clean proxy.
  const shots: string[] = [];
  const snap = async () => {
    try {
      const b = await page.screenshot({ type: "jpeg", quality: 42 });
      shots.push(`data:image/jpeg;base64,${b.toString("base64")}`);
    } catch {
      /* ignore */
    }
  };
  // 1) Navigate (resilient) → cheapest hard-block check on the Response status.
  const resp = await gotoResilient(page, url);
  await snap(); // first paint
  const sBlock = statusBlock(resp?.status(), resp ? resp.headers() : {});
  if (sBlock) return abort(sBlock.message);

  // 2) Clear any cookie/consent overlay that hides the form (never a hard block).
  const consentIssues = await dismissConsent(page);

  // 3) Wait for real form controls to render (SPA hydrate) in ANY frame (embedded
  //    forms), then settle. More reliable than a fixed sleep.
  const formSel = 'form input, form textarea, input[type=file], [role=combobox], [class*="application-form" i], #application_form';
  await Promise.race(page.frames().map((f) => f.waitForSelector(formSel, { timeout: 12_000 }).catch(() => null))).catch(() => {});
  await page.waitForTimeout(1200);
  await dropNewTabs(page); // make any "Apply" link/popup navigate in OUR tab
  await snap(); // settled

  // 4) Extract from the richest frame; if nothing yet, try (a) a scroll pass to
  //    trigger lazy/virtualized fields, then (b) clicking an "Apply" button (SPA;
  //    never a submit) — re-settling and re-extracting after each.
  let { frame, form } = await pickFormFrame(page);
  // "no usable form yet" = 0 fields OR only non-application fields (e.g. a search
  // box on a job-description page) — both should trigger the recovery, not just 0.
  if (!looksLikeApplicationForm(form)) {
    await nudgeScroll(page);
    await page.waitForTimeout(400);
    ({ frame, form } = await pickFormFrame(page));
  }
  if (!noApplyBtn && !looksLikeApplicationForm(form) && (await tryApplyTrigger(page))) {
    await Promise.race(page.frames().map((f) => f.waitForSelector(formSel, { timeout: 6_000 }).catch(() => null))).catch(() => {});
    await page.waitForTimeout(800);
    await dropNewTabs(page);
    ({ frame, form } = await pickFormFrame(page));
    await snap();
  }
  await enrichFromAts(url, form.fields); // clean labels + real options for known ATS (Greenhouse)
  await snap();

  let aiInterpreted = false;
  // Opt-in: ALWAYS interpret with AI (max robustness, ignores the deterministic
  // result) — for users who'd rather pay tokens than risk a heuristic miss.
  if (forceAgent && cliId) {
    const aiFrame = await richestControlFrame(page);
    const aiFields = await agentInterpretForm(aiFrame, cliId, form.title || (await page.title().catch(() => ""))).catch(() => [] as ApplyField[]);
    if (aiFields.length) {
      frame = aiFrame;
      form = { ...form, fields: aiFields };
      aiInterpreted = true;
      await snap();
    }
  }

  // 5) Deterministic extraction found no usable APPLICATION form. Classify WHY
  //    first — then run the AGENTIC FALLBACK only for the genuinely AMBIGUOUS
  //    "no-form" case (controls are present but our heuristics produced nothing).
  //    A challenge/login/listing/expired/Workday page has no form to interpret,
  //    so we abort directly with the right message (no wasted AI run).
  if (!aiInterpreted && !looksLikeApplicationForm(form)) {
    const why = await classifyEmpty(page, url);
    // Driveable (controls present, not a hard block) + we have an agent → KEEP the
    // session open and hand off to the STREAMED drive route, so the user watches
    // the agent reach the form live (/api/apply/drive). Otherwise abort.
    if (cliId && why.code === "no-form") {
      const id = `apply-${crypto.randomUUID()}`;
      const title = form.title || (await page.title().catch(() => "")) || "Application";
      SESSIONS.set(id, { id, url, title, fields: [], context, page, frame, createdAt: Date.now(), formShot: shots[shots.length - 1], persistent });
      return { id, title, fields: [], shots, issues: [], needsDrive: true, vendor: detectVendor(page.url() || url) };
    }
    return abort(why.message);
  }

  // 6) Soft issues the user should know about — surfaced, never silent.
  const [cap, multi] = await Promise.all([captchaWarning(page), multiStepInfo(page)]);
  const unlabeled = form.fields.filter((f) => !(f.label || "").trim()).length;
  const issues: ApplyIssue[] = [...consentIssues];
  if (cap) issues.push(cap);
  if (multi) issues.push(multi);
  if (aiInterpreted) issues.push({ level: "info", code: "ai-interpreted", message: "This form had an uncommon layout, so AI read its fields live — give them an extra check before submitting." });
  if (unlabeled > 0) issues.push({ level: "warn", code: "unlabeled-fields", message: `${unlabeled} field${unlabeled > 1 ? "s" : ""} couldn't be labelled cleanly — double-check ${unlabeled > 1 ? "them" : "it"} before submitting.` });

  const id = `apply-${crypto.randomUUID()}`;
  SESSIONS.set(id, { id, url, title: form.title, fields: form.fields, context, page, frame, createdAt: Date.now(), formShot: shots[shots.length - 1], persistent });
  return { id, title: form.title, fields: form.fields, shots, issues, vendor: detectVendor(page.url() || url) };
}

export type DiscoveredBrowserJob = { url: string; title: string; company: string; location: string; source: string };

/** Best-effort, sequential discovery for user-authorized logged-in job boards.
 * It never solves challenges or follows instructions from page text; it only
 * reads job-card links and surrounding labels. */
export async function discoverAuthenticatedSources(sources: Array<{ name?: string; url: string }>): Promise<{ jobs: DiscoveredBrowserJob[]; failures: Array<{ source: string; reason: string }> }> {
  const context = await persistentContext();
  const jobs: DiscoveredBrowserJob[] = [];
  const failures: Array<{ source: string; reason: string }> = [];
  for (const source of sources.slice(0, 10)) {
    const page = await context.newPage();
    try {
      await gotoResilient(page, source.url);
      await page.waitForTimeout(1800);
      const why = await classifyEmpty(page, source.url).catch(() => null);
      if (why && ["bot-challenge", "login-wall", "auth-required"].includes(why.code)) {
        failures.push({ source: source.name || source.url, reason: why.message });
        continue;
      }
      const rows = await page.evaluate((sourceName) => {
        const clean = (v: string | null | undefined) => (v || "").replace(/\s+/g, " ").trim();
        const selectors = 'a[href*="/jobs/view/"],a[href*="/viewjob"],a[href*="/job-listing/"],a[href*="/job/"],a[href*="/jobs/"]';
        const out: Array<{ url: string; title: string; company: string; location: string; source: string }> = [];
        for (const a of Array.from(document.querySelectorAll(selectors)).slice(0, 100)) {
          const href = (a as HTMLAnchorElement).href;
          const title = clean(a.getAttribute("aria-label") || a.textContent);
          if (!href || title.length < 3 || /sign in|log in|view all|saved jobs/i.test(title)) continue;
          const card = a.closest('li,article,[class*="job-card" i],[data-job-id]');
          const text = clean(card?.textContent);
          const parts = text.split(/\n| · | \| /).map(clean).filter(Boolean);
          out.push({ url: href, title, company: parts[1] || "Unknown", location: parts[2] || "", source: sourceName });
        }
        return out;
      }, source.name || new URL(source.url).hostname);
      jobs.push(...rows);
    } catch (error) {
      failures.push({ source: source.name || source.url, reason: error instanceof Error ? error.message.slice(0, 160) : "discovery failed" });
    } finally {
      await page.close().catch(() => {});
    }
  }
  const seen = new Set<string>();
  return { jobs: jobs.filter((j) => { const key = j.url.split("#")[0]; if (seen.has(key)) return false; seen.add(key); return true; }), failures };
}

export function getSession(id: string): Session | undefined {
  return SESSIONS.get(id);
}

/** Open a bare headed page on a URL (for the agentic drive loop / validation),
 *  without the full extract pipeline. Caller must close the context. */
export async function newDrivePage(url: string): Promise<{ page: Page; context: BrowserContext }> {
  if (globalThis.__coIdleTimer) clearTimeout(globalThis.__coIdleTimer);
  const browser = await headedBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  await gotoResilient(page, url);
  await dismissConsent(page).catch(() => {});
  await page.waitForTimeout(1000);
  return { page, context };
}

/** Extract+enrich the current page (used after the drive loop reaches a form). */
export async function extractCurrent(page: Page, url: string): Promise<{ frame: Frame; form: ExtractedForm }> {
  const r = await pickFormFrame(page);
  await enrichFromAts(url, r.form.fields);
  return r;
}

export function isApplicationFormFn(form: ExtractedForm): boolean {
  return looksLikeApplicationForm(form);
}

/** After the streamed drive loop reaches a form, extract+enrich it (Tier-3
 *  interpret as a last resort), UPDATE the open session, and return the fields +
 *  issues. Returns null if no real application form materialised. */
export async function finalizeDrivenSession(id: string, cliId?: string): Promise<{ title: string; fields: ApplyField[]; issues: ApplyIssue[] } | null> {
  const s = SESSIONS.get(id);
  if (!s) return null;
  let { frame, form } = await pickFormFrame(s.page);
  await enrichFromAts(s.url, form.fields);
  let aiInterpreted = false;
  if (!looksLikeApplicationForm(form) && cliId) {
    const aiFrame = await richestControlFrame(s.page);
    const aiFields = await agentInterpretForm(aiFrame, cliId, form.title || s.title).catch(() => [] as ApplyField[]);
    if (aiFields.length && looksLikeApplicationForm({ title: form.title, url: form.url, fields: aiFields })) {
      frame = aiFrame;
      form = { ...form, fields: aiFields };
      aiInterpreted = true;
    }
  }
  if (!looksLikeApplicationForm(form)) return null;
  s.frame = frame;
  s.fields = form.fields;
  if (form.title) s.title = form.title;
  const issues: ApplyIssue[] = [{ level: "info", code: "ai-navigated", message: "AI navigated to reach this application form on your machine — review the fields before submitting." }];
  if (aiInterpreted) issues.push({ level: "info", code: "ai-interpreted", message: "AI also read the fields live (uncommon layout) — give them an extra check." });
  const cap = await captchaWarning(s.page);
  if (cap) issues.push(cap);
  return { title: s.title, fields: s.fields, issues };
}

export async function closeSession(id: string): Promise<void> {
  const s = SESSIONS.get(id);
  SESSIONS.delete(id);
  if (s?.persistent) await s.page.close().catch(() => {});
  else await s?.context.close().catch(() => {});
  if (SESSIONS.size === 0) scheduleIdleClose();
}

export type FillStep = { fieldId: string; label: string; ok: boolean; thumb?: string };

/** True for a file field that wants the candidate's résumé/CV (vs. cover letter,
 *  portfolio, or a generic attachment we leave for the user). */
function isResumeField(f: ApplyField): boolean {
  return f.type === "file" && /resume|résumé|\bcv\b|curriculum|lebenslauf|currículum/i.test(f.label || "");
}

function normalizedIdentity(value: string | undefined): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Resolve a control after an ATS SPA has replaced its DOM. Re-extraction tags
 * the new controls, then identity evidence must resolve to exactly one match. */
async function liveField(s: Session, meta: ApplyField): Promise<{ field: ApplyField; locator: Locator }> {
  // Positional coN handles can be recycled after an upload removes its input.
  // Native identity takes precedence; never trust a surviving positional tag.
  if (meta.nativeId) {
    const native = s.frame.locator(`[id="${cssAttr(meta.nativeId)}"]`);
    if (await native.count() === 1) {
      const id = await native.getAttribute("data-co-field");
      if (id) return { field: { ...meta, id }, locator: native };
    }
  }

  const refreshed = await extractForm(s.frame);
  const sameType = refreshed.fields.filter((candidate) => candidate.type === meta.type && !!candidate.combobox === !!meta.combobox);
  const selectors: Array<(candidate: ApplyField) => boolean> = [
    (candidate) => !!meta.stableKey && candidate.stableKey === meta.stableKey,
    (candidate) => !!meta.nativeName && candidate.nativeName === meta.nativeName,
    (candidate) => !!meta.nativeId && candidate.nativeId === meta.nativeId,
    (candidate) => normalizedIdentity(candidate.label) === normalizedIdentity(meta.label) && normalizedIdentity(candidate.section) === normalizedIdentity(meta.section),
  ];
  for (const matches of selectors.map((select) => sameType.filter(select))) {
    if (matches.length !== 1) continue;
    const field = matches[0];
    const locator = s.frame.locator(`[data-co-field="${cssAttr(field.id)}"]`);
    const count = await locator.count().catch(() => 0);
    if (count === 1 || (field.type === "radio" && count > 0)) return { field, locator };
  }
  throw new Error(`Could not uniquely re-identify field: ${meta.label || meta.id}`);
}

/** Read-only diagnostics for a live application. No scripts supplied by callers. */
export async function inspectSession(id: string) {
  const s = SESSIONS.get(id);
  if (!s) throw new Error("apply session not found or expired");
  return {
    title: await s.page.title(), url: s.page.url(),
    visibleText: await s.frame.locator('body').innerText().then(text => text.slice(-6500)),
    buttons: await s.frame.evaluate(() => Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(el => (el as HTMLElement).offsetParent !== null).map(el => ({ text: el.textContent?.trim(), type: el.getAttribute('type'), markup: el.outerHTML.slice(0, 1200) }))),
    attachments: await s.frame.evaluate(() => Array.from(document.querySelectorAll('.file-upload__filename p')).filter(el => (el as HTMLElement).offsetParent !== null).map(el => el.textContent?.trim())),
    controls: await s.frame.evaluate(() => Array.from(document.querySelectorAll('input, select, textarea, [role="combobox"]')).filter(el => !['password', 'hidden'].includes(el.getAttribute('type') || '')).map((el) => ({
      tag: el.tagName, id: el.id, type: el.getAttribute("type"),
      label: el.getAttribute("aria-label"), fieldId: el.getAttribute("data-co-field"),
    }))),
  };
}

export async function verifySession(id: string, fields: ApplyField[], answers: Record<string, string>) {
  const s = SESSIONS.get(id);
  if (!s) throw new Error("apply session not found or expired");
  const remapped = await remapForVerification(s, fields, answers);
  return verifyFillDetailed(s.frame, remapped.fields, remapped.answers);
}

async function remapForVerification(s: Session, fields: ApplyField[], answers: Record<string, string>): Promise<{ fields: ApplyField[]; answers: Record<string, string> }> {
  const liveFields: ApplyField[] = [];
  const liveAnswers: Record<string, string> = {};
  for (const meta of fields) {
    try {
      const live = await liveField(s, meta);
      liveFields.push(live.field);
      if (answers[meta.id] !== undefined) liveAnswers[live.field.id] = answers[meta.id];
    } catch {
      // Retain the missing original so verification reports it as unverified.
      // Missing controls must not inherit another field's recycled coN tag.
      const missingId = `missing-${meta.id}`;
      liveFields.push({ ...meta, id: missingId });
      if (answers[meta.id] !== undefined) liveAnswers[missingId] = answers[meta.id];
    }
  }
  return { fields: liveFields.map(f => ({ ...f, uploadedFileName: isResumeField(f) ? s.cvMetadata?.name : undefined })), answers: liveAnswers };
}

/** Fill the real form with verified answers, screenshotting after each field.
 *  Attaches the tailored CV PDF to résumé/CV file fields (cvPath). NEVER clicks a
 *  submit/apply control — only fills/selects/checks/attaches. */
export async function fillSession(
  id: string,
  answers: Record<string, string>,
  fieldsMeta: ApplyField[],
  cvPath?: string,
): Promise<{ steps: FillStep[]; navigated: boolean; issues: ApplyIssue[]; verification: FieldVerification[] }> {
  const s = SESSIONS.get(id);
  if (!s) throw new Error("apply session not found (it may have expired)");
  const byId = new Map(fieldsMeta.map((f) => [f.id, f]));
  const steps: FillStep[] = [];
  // Belt-and-suspenders: if filling ever navigates the page (i.e. something got
  // submitted), the URL path changes. We never submit by construction, but we
  // report it so the caller can flag it instead of silently "succeeding".
  const startPath = (() => {
    try {
      return new URL(s.frame.url()).pathname;
    } catch {
      return s.frame.url();
    }
  })();

  const shoot = async () => {
    try {
      const buf = await s.page.screenshot({ type: "jpeg", quality: 38 });
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch {
      return undefined;
    }
  };

  // 1) Attach the tailored CV to every résumé/CV file field (even with no text
  //    answer). The real <input type=file> was tagged data-co-field at extract
  //    time; setInputFiles works even when the ATS visually hides it behind a
  //    dropzone. Other file fields (cover letter, portfolio) are left to the user.
  if (cvPath) {
    const expectedCv = { name: path.basename(cvPath), size: fs.statSync(cvPath).size };
    for (const meta of fieldsMeta) {
      if (!isResumeField(meta)) continue;
      let ok = false;
      try {
        const { locator } = await liveField(s, meta);
        const input = locator.first();
        const originalInput = await input.elementHandle();
        await input.setInputFiles(cvPath);
        const actual = await originalInput?.evaluate((el) => {
          const file = (el as HTMLInputElement).files?.[0];
          return file ? { name: file.name, size: file.size } : null;
        });
        ok = fileMetadataMatches(actual, expectedCv);
        await originalInput?.dispose();
      } catch { ok = false; }
      steps.push({ fieldId: meta.id, label: `${meta.label || "Resume"} (CV attached)`, ok, thumb: await shoot() });
    }
    const resumeSteps = steps.filter((step) => /\(CV attached\)$/.test(step.label));
    if (resumeSteps.length > 0 && resumeSteps.every((step) => step.ok)) s.cvMetadata = expectedCv;
  }

  for (const [fid, raw] of Object.entries(answers)) {
    const meta = byId.get(fid);
    const value = (raw ?? "").toString();
    if (!meta || value === "") continue;
    if (meta.type === "file") continue; // handled above (CV) — never auto-fill other uploads
    // Defense-in-depth: NEVER auto-tick a legal consent/agreement checkbox — the
    // human must affirmatively accept. (The planner already flags these
    // needs_confirmation; this guarantees it even if it slips.)
    if (meta.type === "checkbox" && /\b(i (have )?read|i agree|i consent|i accept|consent to|privacy notice|terms|gdpr|data protection)\b/i.test(meta.label || "")) {
      steps.push({ fieldId: fid, label: `${meta.label} — you confirm`, ok: false, thumb: undefined });
      continue;
    }
    let ok = false;
    let gaveUp = false;
    try {
      const live = await liveField(s, meta);
      const loc = live.locator.first();
      if (meta.combobox) {
        // react-select: open, type to filter, CLICK the matching option. We never
        // press Enter — in a form, Enter can submit. Clicking an option can't.
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click();
        await s.page.waitForTimeout(150);
        await loc.pressSequentially(value, { delay: 15 }).catch(async () => {
          await s.page.keyboard.type(value);
        });
        await s.page.waitForTimeout(300);
        const esc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const menu = '.select__menu .select__option, .select__menu-list [role="option"], [class*="menu" i] [role="option"], [role="listbox"] [role="option"]';
        const exact = s.frame.locator(menu).filter({ visible: true }).filter({ hasText: new RegExp(`^\\s*${esc}(?:\\s*\\(?\\+\\d{1,4}\\)?)?\\s*$`, "i") });
        if (await exact.count() === 1) await exact.first().click();
        else {
          await s.page.keyboard.press("Escape").catch(() => {});
          gaveUp = true;
        }
      } else if (meta.type === "select") {
        await loc.selectOption({ label: value }).catch(async () => {
          await loc.selectOption(value);
        });
      } else if (meta.type === "checkbox") {
        const want = ["true", "1", "yes", "on", "checked"].includes(value.toLowerCase());
        let done = false;
        try {
          await loc.setChecked(want, { timeout: 3000 });
          done = true;
        } catch {
          // custom-styled checkbox with a hidden real <input> → click its label
          // (native toggle + React onChange) or force as a last resort.
          if ((await loc.isChecked().catch(() => false)) === want) {
            done = true;
          } else {
            const cid = await loc.getAttribute("id").catch(() => null);
            const lab = cid ? s.frame.locator(`label[for="${cssAttr(cid)}"]`).first() : null;
            if (lab && (await lab.count())) {
              await lab.click().catch(() => {});
              done = true;
            } else {
              try {
                await loc.check({ force: true });
                done = true;
              } catch {
                /* leave for the user */
              }
            }
          }
        }
        gaveUp = !done;
      } else if (meta.type === "radio") {
        const r = s.frame.locator(`[data-co-field="${cssAttr(live.field.id)}"][data-co-option="${cssAttr(value)}"]`).first();
        await r.check({ timeout: 3000 }).catch(async () => {
          await r.check({ force: true }).catch(async () => {
            const rid = await r.getAttribute("id").catch(() => null);
            if (rid) await s.frame.locator(`label[for="${cssAttr(rid)}"]`).first().click().catch(() => { gaveUp = true; });
            else gaveUp = true;
          });
        });
      } else {
        const capability = adapterFor(s.page.url() || s.url);
        if (capability.textEntry === "type") {
          await loc.focus();
          await loc.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
          await loc.pressSequentially(value, { delay: 12 });
        } else {
          await loc.fill(value);
        }
      }
      ok = !gaveUp;
    } catch {
      ok = false;
    }
    steps.push({ fieldId: fid, label: meta.label, ok, thumb: await shoot() });
  }
  const endPath = (() => {
    try {
      return new URL(s.frame.url()).pathname;
    } catch {
      return s.frame.url();
    }
  })();
  // Read the real form back: did every answer actually land? any validation
  // error? — so we warn the user about silent divergence before the handoff.
  const verification = await remapForVerification(s, fieldsMeta, answers);
  const verified = await verifyFillDetailed(s.frame, verification.fields, verification.answers).catch(() => ({
    outcomes: verification.fields.map((field) => ({ fieldId: field.id, label: field.label, status: "unverified" as const, intended: verification.answers[field.id] })),
    issues: [{ level: "warn" as const, code: "verification-failed", message: "Could not verify the filled form." }],
  }));
  return { steps, navigated: endPath !== startPath, issues: verified.issues, verification: verified.outcomes };
}

export type ApplyStepState = "form" | "review" | "complete" | "blocked";

async function stepFingerprint(frame: Frame, fields: ApplyField[]): Promise<string> {
  const progress = await frame.evaluate(() => {
    const node = document.querySelector('[aria-current="step"], [class*="progress" i], [class*="step" i][aria-current], [data-automation-id*="progress" i]');
    return (node?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }).catch(() => "");
  const raw = [frame.url(), progress, ...fields.map((field) => field.stableKey || `${field.type}:${normalizedIdentity(field.label)}`)].join("\n");
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

async function hasVisibleSubmit(frame: Frame): Promise<boolean> {
  const submit = frame.locator('button[type="submit"], input[type="submit"], button').filter({ hasText: /^\s*(submit(?: application)?|send application|complete application|finish application|apply)\s*$/i }).first();
  return !!(await submit.count().catch(() => 0)) && await submit.isVisible().catch(() => false);
}

export async function advanceSession(id: string): Promise<{ advanced: boolean; fields: ApplyField[]; issues: ApplyIssue[]; state: ApplyStepState; stepId: string; vendor: string }> {
  const s = SESSIONS.get(id);
  if (!s) throw new Error("apply session not found");
  const capability = adapterFor(s.page.url() || s.url);
  const before = await stepFingerprint(s.frame, s.fields);
  s.visitedSteps ??= new Set<string>();
  s.visitedSteps.add(before);
  if (!capability.multiStep) return { advanced: false, fields: s.fields, issues: [], state: "review", stepId: before, vendor: capability.vendor };
  const cap = await captchaWarning(s.page).catch(() => null);
  if (cap) return { advanced: false, fields: s.fields, issues: [cap], state: "blocked", stepId: before, vendor: capability.vendor };
  const next = s.frame.locator('button').filter({ hasText: /^\s*(next|continue|save and continue)\s*$/i })
    .or(s.frame.locator('input[type="button"][value="next" i], input[type="button"][value="continue" i], input[type="button"][value="save and continue" i]')).first();
  if (!(await next.count().catch(() => 0)) || !(await next.isVisible().catch(() => false))) {
    const state: ApplyStepState = await hasVisibleSubmit(s.frame) ? "review" : "complete";
    return { advanced: false, fields: s.fields, issues: [], state, stepId: before, vendor: capability.vendor };
  }
  await next.click({ timeout: 8000 });
  await s.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await s.page.waitForTimeout(1000);
  const why = await classifyEmpty(s.page, s.page.url()).catch(() => null);
  if (why && ["bot-challenge", "login-wall", "auth-required"].includes(why.code)) return { advanced: false, fields: [], issues: [why], state: "blocked", stepId: before, vendor: adapterFor(s.page.url() || s.url).vendor };
  const current = await pickFormFrame(s.page);
  await enrichFromAts(s.page.url() || s.url, current.form.fields);
  const after = await stepFingerprint(current.frame, current.form.fields);
  s.frame = current.frame;
  s.fields = current.form.fields;
  const issues: ApplyIssue[] = [];
  const currentCap = await captchaWarning(s.page).catch(() => null);
  if (currentCap) issues.push(currentCap);
  const vendor = adapterFor(s.page.url() || s.url).vendor;
  if (after === before) {
    issues.push({ level: "warn", code: "step-unchanged", message: "The application did not move to a new step after Continue. Review the visible validation messages." });
    return { advanced: false, fields: s.fields, issues, state: "blocked", stepId: after, vendor };
  }
  if (s.visitedSteps.has(after)) {
    issues.push({ level: "warn", code: "step-loop", message: "The application returned to a step already seen. Automatic navigation stopped to avoid a loop." });
    return { advanced: false, fields: s.fields, issues, state: "blocked", stepId: after, vendor };
  }
  s.visitedSteps.add(after);
  if (s.fields.length === 0) {
    const state: ApplyStepState = await hasVisibleSubmit(s.frame) ? "review" : "complete";
    return { advanced: true, fields: [], issues, state, stepId: after, vendor };
  }
  return { advanced: true, fields: s.fields, issues, state: "form", stepId: after, vendor };
}

/** Hand the real (now pre-filled) form to a human for manual intervention. The
 *  window was kept OFF-SCREEN during fill, so bringToFront alone wouldn't make it
 *  visible — we reposition it on-screen via CDP first. We never submit. */
export async function handoffSession(id: string): Promise<void> {
  const s = SESSIONS.get(id);
  if (!s) throw new Error("apply session not found");
  try {
    const cdp = await s.context.newCDPSession(s.page);
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: 80, top: 60, width: 1280, height: 920, windowState: "normal" },
    });
    await cdp.detach().catch(() => {});
  } catch {
    /* CDP unavailable → bringToFront still raises it */
  }
  await s.page.bringToFront().catch(() => {});
}

export type SubmitResult = {
  status: "submitted" | "blocked" | "failed" | "submission_unknown";
  reason?: string;
  receipt?: { url: string; title: string; confirmation: string };
  screenshot?: string;
};

export async function captureSession(id: string, category = "blocked"): Promise<string | undefined> {
  const s = SESSIONS.get(id);
  if (!s) return undefined;
  try {
    const dir = path.join(careerOpsRoot(), "data", "automation-screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const safeCategory = category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "blocked";
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 12)}-${safeCategory}.png`;
    const absolute = path.join(dir, filename);
    const sensitiveControls = s.page.locator('input, textarea, select, [contenteditable="true"]');
    const knownValues = await sensitiveControls.evaluateAll((nodes) => [...new Set(nodes.map((node) => {
      const el = node as HTMLInputElement;
      return String(el.value || el.textContent || "").trim();
    }).filter((value) => value.length >= 3))]).catch(() => [] as string[]);
    const piiText = knownValues.slice(0, 30).map((value) => s.page.getByText(value, { exact: false }));
    await s.page.screenshot({ path: absolute, fullPage: false, mask: [sensitiveControls, ...piiText], animations: "disabled" });
    fs.chmodSync(absolute, 0o600);
    return path.relative(careerOpsRoot(), absolute).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
}

function identityMatches(haystack: string, expected: string): boolean {
  const clean = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const h = clean(haystack);
  const e = clean(expected);
  // An absent or placeholder expectation cannot be verified against the page.
  // Fail CLOSED: this runs immediately before an irreversible submit, and returning
  // true here silently disabled the gate whenever the caller fell back to a
  // placeholder company/role (the worker defaulted to the literal 'Unknown').
  if (!e || e === "unknown") return false;
  if (h.includes(e)) return true;
  const tokens = e.split(" ").filter((t) => t.length >= 4 && !["engineer", "developer", "analyst", "manager", "senior", "junior"].includes(t));
  return tokens.length > 0 && tokens.every((t) => h.includes(t));
}

/** Submit a fully verified session for the unattended worker. This is deliberately
 * separate from fillSession: a caller cannot accidentally submit by asking to
 * fill. It fails closed on challenges, attestations, identity mismatches, empty
 * required fields, and any visible validation issue. */
export async function submitSession(
  id: string,
  answers: Record<string, string>,
  fields: ApplyField[],
  expectedCompany: string,
  expectedRole: string,
): Promise<SubmitResult> {
  const s = SESSIONS.get(id);
  if (!s) return { status: "failed", reason: "apply session not found or expired" };
  const stop = async (status: SubmitResult["status"], reason: string, receipt?: SubmitResult["receipt"]): Promise<SubmitResult> => ({
    status, reason, receipt, screenshot: await captureSession(id, status),
  });

  const cap = await captchaWarning(s.page).catch(() => null);
  if (cap) return stop("blocked", cap.message);
  const adapter = adapterFor(s.page.url() || s.url);
  if (!adapter.submission) return stop("blocked", `${adapter.vendor} is discovery-only; automatic submission requires an employer-hosted supported ATS`);
  if (!s.cvMetadata) return stop("blocked", "No browser-verified tailored CV upload is present in this application session");
  const attestation = fields.find((f) => f.required && attestationMatches(f.label || ""));
  if (attestation) return stop("blocked", `Required attestation needs human confirmation: ${attestation.label}`);

  const pageIdentity = await s.page.evaluate(() => `${document.title}\n${(document.body?.innerText || "").slice(0, 6000)}`).catch(() => s.title);
  if (!identityMatches(pageIdentity, expectedCompany) || !identityMatches(pageIdentity, expectedRole)) {
    const unverifiable = !expectedCompany?.trim() || !expectedRole?.trim()
      || /^unknown$/i.test(expectedCompany.trim()) || /^unknown$/i.test(expectedRole.trim());
    return stop("blocked", unverifiable
      ? "Expected company or role is missing or a placeholder, so page identity cannot be verified before submitting"
      : "Visible company or role does not match the evaluated application");
  }

  const remapped = await remapForVerification(s, fields, answers);
  const verification = await verifyFill(s.frame, remapped.fields, remapped.answers).catch(() => [{ level: "warn", code: "verification-failed", message: "Could not verify the filled form" } as ApplyIssue]);
  const blocking = verification.filter((x) => x.level !== "info");
  if (blocking.length) return stop("blocked", blocking.map((x) => x.message).join("; "));

  // A job header's "Apply" button often only scrolls to the form. Never count
  // that navigation control as a submission attempt.
  const submit = finalSubmissionControls(s.frame);
  if (await submit.count().catch(() => 0) !== 1 || !(await submit.isEnabled().catch(() => false))) {
    return stop("blocked", "No unambiguous visible Submit control was found");
  }

  try {
    await submit.click({ timeout: 8000 });
  } catch (error) {
    return stop("submission_unknown", `Submit initiation became ambiguous: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`);
  }
  await s.page.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => {});
  await s.page.waitForTimeout(2500);
  const challenge = await s.page.locator('body').innerText().catch(() => "");
  if (/verification code was sent|enter the .{0,25}code to confirm|check your email.{0,80}code/i.test(challenge)) {
    return stop("blocked", "Email verification required: enter the code sent by the employer to complete this application. No submission receipt yet.");
  }
  const receipt = await s.page.evaluate(() => ({
    url: location.href,
    title: document.title,
    confirmation: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1200),
  })).catch(() => ({ url: s.page.url(), title: "", confirmation: "" }));

  if (confirmationMatches(receipt.confirmation) || confirmationMatches(receipt.title)) {
    await closeSession(id);
    return { status: "submitted", receipt };
  }
  return stop("submission_unknown", "Submit was clicked but no reliable confirmation receipt was detected; automatic retry is disabled", receipt);
}
