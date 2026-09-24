import { automationPolicy } from '../automation/policy.mjs';
import { resolveField } from '../automation/answers.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, pass, fail } from './helpers.mjs';

console.log('\nautomation pre-authorization — consent and attestation must fail closed');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

// ─────────────────────────────────────────────────────────────────────────────
// policy.mjs normalization. Only a literal `true` grants permission. Everything
// else — absent, false, a truthy string, a number — must refuse, because this
// flag is what lets a machine accept a legal statement in the user's name.
// ─────────────────────────────────────────────────────────────────────────────
const pol = (preauthorize) => automationPolicy({ automation: { preauthorize } });

ok('an absent preauthorize block refuses both',
  pol(undefined).preauthorize.consent_checkboxes === false && pol(undefined).preauthorize.attestations === false);
ok('an empty preauthorize block refuses both',
  pol({}).preauthorize.consent_checkboxes === false && pol({}).preauthorize.attestations === false);
ok('explicit false refuses', pol({ consent_checkboxes: false }).preauthorize.consent_checkboxes === false);
ok('literal true grants', pol({ consent_checkboxes: true }).preauthorize.consent_checkboxes === true);

for (const truthy of ['true', 'yes', 1, 'on', [], {}]) {
  ok(`a truthy non-boolean (${JSON.stringify(truthy)}) does NOT grant consent`,
    pol({ consent_checkboxes: truthy }).preauthorize.consent_checkboxes === false);
  ok(`a truthy non-boolean (${JSON.stringify(truthy)}) does NOT grant attestations`,
    pol({ attestations: truthy }).preauthorize.attestations === false);
}

ok('the two flags are independent: consent on, attestations off',
  pol({ consent_checkboxes: true }).preauthorize.attestations === false);
ok('the two flags are independent: attestations on, consent off',
  pol({ attestations: true }).preauthorize.consent_checkboxes === false);

// ─────────────────────────────────────────────────────────────────────────────
// The resolver honours the same contract, so a field cannot be answered past a
// refused flag even if the config carries a value for it.
// ─────────────────────────────────────────────────────────────────────────────
const ctx = (preauthorize) => ({ answers: { consent: 'Yes' }, candidate: {}, preauthorize });
const consentField = { id: 'c1', label: 'I have read and agree to the Privacy Notice', type: 'checkbox' };
const attestField = { id: 'a1', label: 'I certify that the information provided is true and complete', type: 'checkbox' };

ok('consent refused with no flags', resolveField(consentField, ctx(undefined)).resolved === false);
ok('consent refused with the WRONG flag on', resolveField(consentField, ctx({ attestations: true })).resolved === false);
ok('consent accepted with its own flag', resolveField(consentField, ctx({ consent_checkboxes: true })).resolved === true);

ok('attestation refused with no flags', resolveField(attestField, ctx(undefined)).resolved === false);
ok('attestation refused with only consent on', resolveField(attestField, ctx({ consent_checkboxes: true })).resolved === false);
ok('attestation accepted with its own flag', resolveField(attestField, ctx({ attestations: true })).resolved === true);

ok('a refusal names the flag that would allow it',
  resolveField(consentField, ctx(undefined)).needsPreauth === 'consent_checkboxes');
ok('an attestation refusal names its own flag',
  resolveField(attestField, ctx(undefined)).needsPreauth === 'attestations');

// Even fully pre-authorized, a consent value that is not affirmative must not
// tick the box — the flag grants permission, it does not invent an answer.
ok('a non-affirmative consent value is still refused',
  resolveField(consentField, { answers: { consent: 'No' }, candidate: {}, preauthorize: { consent_checkboxes: true } }).resolved === false);
ok('a missing consent value is still refused',
  resolveField(consentField, { answers: {}, candidate: {}, preauthorize: { consent_checkboxes: true } }).resolved === false);

// ─────────────────────────────────────────────────────────────────────────────
// The browser layer's own default. session.ts is TypeScript and not importable
// here, so the invariant is asserted against its source: the guard must compare
// against a literal `true`, and the interactive routes must pass the flag
// through rather than synthesising one.
// ─────────────────────────────────────────────────────────────────────────────
const sessionSrc = readFileSync(join(ROOT, 'web/src/lib/apply/session.ts'), 'utf8');
ok('session.ts gates on a strict === true comparison',
  /return p\?\.\[key\] === true;/.test(sessionSrc));
ok('session.ts refuses consent when not pre-authorized',
  /if \(!preauthorized\(preauth, "consentCheckboxes"\)\)/.test(sessionSrc));
ok('session.ts refuses required attestations when not pre-authorized',
  /if \(attestations\.length && !preauthorized\(preauth, "attestations"\)\)/.test(sessionSrc));
ok('session.ts records which consents were accepted',
  /consentAccepted/.test(sessionSrc) && /attestationsAccepted/.test(sessionSrc));

// CAPTCHA, login and MFA must remain unconditional refusals: a pre-authorization
// flag grants permission to accept the user's own legal statements, never to work
// around a site saying no.
ok('captcha remains an unconditional block before submit',
  /const cap = await captchaWarning\(s\.page\)[\s\S]{0,200}?if \(cap\) return stop\("blocked", cap\.message\);/.test(sessionSrc));
ok('no preauthorize flag appears near the captcha guard',
  !/captchaWarning[\s\S]{0,300}?preauthorized/.test(sessionSrc));

const fillRoute = readFileSync(join(ROOT, 'web/src/app/api/apply/fill/route.ts'), 'utf8');
const submitRoute = readFileSync(join(ROOT, 'web/src/app/api/apply/submit/route.ts'), 'utf8');
ok('the fill route forwards the caller\'s flag verbatim', /fillSession\([^)]*body\.preauthorize\)/.test(fillRoute));
ok('the submit route forwards the caller\'s flag verbatim', /submitSession\([^)]*body\.preauthorize\)/.test(submitRoute));
ok('neither route defaults the flag to true',
  !/preauthorize\s*[:=]\s*\{[^}]*true/.test(fillRoute) && !/preauthorize\s*[:=]\s*\{[^}]*true/.test(submitRoute));

// ─────────────────────────────────────────────────────────────────────────────
// The shipped user config must not silently carry pre-authorization on.
// ─────────────────────────────────────────────────────────────────────────────
const workerSrc = readFileSync(join(ROOT, 'automation/worker.mjs'), 'utf8');
ok('the worker sends the flag derived from policy, not a constant',
  /consentCheckboxes: policy\.preauthorize\?\.consent_checkboxes === true/.test(workerSrc));
ok('the worker records the consents accepted per application',
  /consent_accepted: consentAccepted/.test(workerSrc));
ok('the worker records which flags were in force',
  /preauthorized: policy\.preauthorize/.test(workerSrc));
