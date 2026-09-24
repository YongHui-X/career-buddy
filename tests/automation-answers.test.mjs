import {
  UNCONFIRMED,
  classifyQuestion,
  normalizeQuestion,
  resolveField,
  resolveFields,
} from '../automation/answers.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nautomation/answers.mjs — deterministic application-answer resolution');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

// A realistic config, matching the shape written into config/profile.yml.
const ANSWERS = {
  work_authorization: 'Yes — Singapore citizen, authorised to work in Singapore without sponsorship',
  sponsorship_required: 'No',
  notice_period: UNCONFIRMED,
  salary_expectation: UNCONFIRMED,
  willing_to_relocate: UNCONFIRMED,
  start_date: UNCONFIRMED,
  demographic_self_id: 'I prefer not to disclose',
  criminal_record: 'No',
  consent: 'Yes',
  how_did_you_hear: 'Company careers page',
};
const CANDIDATE = {
  full_name: 'Tan Yong Hui',
  email: 'tanyonghui.johnny@gmail.com',
  phone: '+65 9733 2464',
  location: 'Singapore',
  linkedin: 'linkedin.com/in/tanyonghui',
  github: 'github.com/YongHui-X',
  portfolio_url: '',
};
const ctx = (over = {}) => ({ answers: ANSWERS, candidate: CANDIDATE, ...over });

const f = (label, extra = {}) => ({ id: extra.id || 'co1', label, ...extra });
const res = (label, extra = {}, over = {}) => resolveField(f(label, extra), ctx(over));

// ─────────────────────────────────────────────────────────────────────────────
// THE REPRODUCED BUG. The old matcher (worker.mjs savedAnswer /
// keyMatchesNormalized) did bidirectional substring comparison, so a short saved
// key such as `age` matched "do_you_manage_a_team" and "package_expectation",
// and the documented key `require_sponsorship_in_singapore` failed to match the
// real question. Both directions are asserted here.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- the reproduced substring bug --');

ok('an unrelated question is REPORTED, not answered ("Do you manage a team?")',
  res('Do you manage a team?').resolved === false);

ok('the unrelated question names no intent',
  res('Do you manage a team?').intent == null);

const authQ = res('Are you authorized to work in Singapore?');
ok('the previously-missed work-authorization question now resolves', authQ.resolved === true);
ok('it resolves via the work_authorization intent', authQ.intent === 'work_authorization');
ok('its provenance names the config key', authQ.sourceKey === 'application_answers.work_authorization');

// "Package expectation" DOES contain a real salary intent, so resolving it is
// correct — what was wrong before was resolving it to an `age` value.
const pkg = res('Package expectation');
ok('"Package expectation" maps to salary, not to an unrelated key',
  pkg.intent === 'salary_expectation');
ok('...and is withheld because the salary figure is unconfirmed', pkg.resolved === false);

// ─────────────────────────────────────────────────────────────────────────────
// WORK AUTHORIZATION vs SPONSORSHIP. These two have OPPOSITE answers ("Yes" and
// "No"), and real forms phrase them so that both keywords appear. Getting this
// backwards on a submitted application is unrecoverable.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- work authorization vs sponsorship (opposite answers) --');

for (const label of [
  'Are you legally authorized to work in Singapore?',
  'Are you legally authorised to work in Singapore without requiring sponsorship?',
  'Do you have the legal right to work in Singapore?',
  'Do you hold a valid work pass for Singapore?',
]) {
  const r = res(label);
  ok(`"${label.slice(0, 52)}..." -> work_authorization`, r.intent === 'work_authorization' && /^Yes/.test(r.value || ''));
}

for (const label of [
  'Will you now or in the future require sponsorship to work in Singapore?',
  'Do you require visa sponsorship?',
  'Do you need a work visa to be employed here?',
]) {
  const r = res(label);
  ok(`"${label.slice(0, 52)}..." -> sponsorship_required = No`, r.intent === 'sponsorship_required' && r.value === 'No');
}

// ─────────────────────────────────────────────────────────────────────────────
// THE UNCONFIRMED SENTINEL must never reach a form.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- the CONFIRM_REQUIRED sentinel is never sent --');

for (const [label, intent] of [
  ['What is your expected salary?', 'salary_expectation'],
  ['What is your notice period?', 'notice_period'],
  ['When can you start?', 'start_date'],
  ['Are you willing to relocate?', 'willing_to_relocate'],
]) {
  const r = res(label);
  ok(`"${label}" is withheld (${intent})`, r.resolved === false && r.intent === intent);
  ok(`"${label}" explains that only the user can supply it`, /CONFIRM_REQUIRED|only you/.test(r.reason || ''));
}

const all = resolveFields(
  [f('What is your expected salary?', { id: 'a' }), f('Are you authorized to work in Singapore?', { id: 'b' })],
  ctx(),
);
ok('no CONFIRM_REQUIRED value appears in a resolved answer map',
  !Object.values(all.answers).some((v) => String(v).includes(UNCONFIRMED)));

// ─────────────────────────────────────────────────────────────────────────────
// DEMOGRAPHIC SELF-ID. Option-aware, and never guessed.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- demographic self-identification --');

const gender = res('Gender', { type: 'select', options: ['Male', 'Female', 'Non-binary', 'Decline to self identify'] });
ok('a gender select picks the decline option', gender.resolved === true && gender.value === 'Decline to self identify');
ok('the decline option is returned as EXACT option text', gender.value === 'Decline to self identify');

for (const [opts, expected] of [
  [['Male', 'Female', 'I prefer not to say'], 'I prefer not to say'],
  [['Yes', 'No', "I don't wish to answer"], "I don't wish to answer"],
  [['White', 'Asian', 'Prefer not to disclose'], 'Prefer not to disclose'],
]) {
  const r = res('Race / Ethnicity', { type: 'select', options: opts });
  ok(`decline option recognised among ${JSON.stringify(opts.slice(-1))}`, r.value === expected);
}

const noDecline = res('Gender', { type: 'select', options: ['Male', 'Female'] });
ok('a demographic select with NO decline option is reported, never guessed', noDecline.resolved === false);
ok('...and says why', /prefer not to disclose/i.test(noDecline.reason || ''));
ok('...and never returns a real demographic value', noDecline.value === undefined);

const freeTextDemo = res('How do you self identify?');
ok('a free-text demographic question uses the configured decline string',
  freeTextDemo.resolved === true && freeTextDemo.value === 'I prefer not to disclose');

for (const label of ['Veteran status', 'Do you have a disability?', 'Sexual orientation', 'What are your pronouns?']) {
  const r = res(label, { type: 'select', options: ['A', 'B', 'Prefer not to say'] });
  ok(`"${label}" is treated as demographic`, r.intent === 'demographic_self_id' || r.value === 'Prefer not to say');
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSENT AND ATTESTATION are gated on explicit pre-authorization.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- consent / attestation pre-authorization --');

const consentLabels = [
  'I have read and agree to the Privacy Notice',
  'I consent to the processing of my personal data',
  'I accept the Terms and Conditions',
];
for (const label of consentLabels) {
  const off = res(label, { type: 'checkbox' });
  ok(`consent refused by default: "${label.slice(0, 40)}..."`, off.resolved === false);
  ok('...and names the flag that would allow it', off.needsPreauth === 'consent_checkboxes');

  const on = res(label, { type: 'checkbox' }, { preauthorize: { consent_checkboxes: true } });
  ok('...and is ticked once explicitly pre-authorized', on.resolved === true && on.value === 'true');
}

ok('an ABSENT preauthorize block refuses consent',
  res('I agree to the Terms', { type: 'checkbox' }, { preauthorize: undefined }).resolved === false);
ok('a FALSE flag refuses consent',
  res('I agree to the Terms', { type: 'checkbox' }, { preauthorize: { consent_checkboxes: false } }).resolved === false);
ok('a truthy-but-not-true flag refuses consent (no type coercion)',
  res('I agree to the Terms', { type: 'checkbox' }, { preauthorize: { consent_checkboxes: 'yes' } }).resolved === false);

const attest = res('I certify that the information provided is true and complete', { type: 'checkbox' });
ok('an attestation is gated separately from consent', attest.needsPreauth === 'attestations');
ok('consent pre-authorization alone does NOT enable attestations',
  res('I certify that the above is accurate', { type: 'checkbox' }, { preauthorize: { consent_checkboxes: true } }).resolved === false);
ok('an attestation is accepted only with its own flag',
  res('I certify that the above is accurate', { type: 'checkbox' }, { preauthorize: { attestations: true } }).resolved === true);

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY FIELDS from config/profile.yml.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- identity fields --');

ok('full name', res('Full name').value === 'Tan Yong Hui');
ok('first name is derived', res('First name').value === 'Tan');
ok('last name is derived', res('Last name').value === 'Hui');
ok('email', res('Email').value === CANDIDATE.email);
ok('e-mail with a hyphen', res('E-mail address').value === CANDIDATE.email);
ok('phone', res('Phone number').value === CANDIDATE.phone);
ok('mobile', res('Mobile').value === CANDIDATE.phone);
ok('location', res('Current location').value === 'Singapore');
ok('linkedin', res('LinkedIn Profile').value === CANDIDATE.linkedin);
ok('github', res('GitHub URL').value === CANDIDATE.github);

const emptyPortfolio = res('Portfolio website');
ok('an empty profile field is reported, not sent blank', emptyPortfolio.resolved === false);
ok('...and names the profile key to fill', /candidate\.portfolio_url/.test(emptyPortfolio.reason || ''));

// ─────────────────────────────────────────────────────────────────────────────
// NO FUZZY FALLBACK. This is the structural guarantee that the old bug cannot
// come back: a question with no intent and no identity match resolves to nothing,
// no matter how much it lexically overlaps a config key.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- no substring fallback, ever --');

for (const label of [
  'Do you manage a team?',
  'Describe your most impactful project',
  'Why do you want to work here?',
  'How many years of Python experience do you have?',
  'What is your favourite programming language?',
  'Manager name',
  'Startup experience?',
  'Tell us about a time you disagreed with a colleague',
]) {
  ok(`unmatched question reported: "${label.slice(0, 46)}"`, res(label).resolved === false);
}

// Config keys used as questions must not self-match by substring.
for (const key of Object.keys(ANSWERS)) {
  const asQuestion = key.replace(/_/g, ' ');
  const r = res(`Random unrelated prompt about ${asQuestion.slice(0, 4)}`);
  ok(`a 4-char fragment of "${key}" does not resolve anything`, r.resolved === false || r.intent != null);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIOR ANSWERS (Block H history) take precedence, and respect options.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- learned prior answers --');

const prior = { [normalizeQuestion('Why do you want to work here?')]: 'Because of the retrieval work.' };
const priorHit = res('Why do you want to work here?', {}, { byQuestion: prior });
ok('a prior answer resolves a question no intent covers', priorHit.resolved === true);
ok('a prior answer is labelled as such', priorHit.rule === 'prior-answer');
ok('normalization makes matching punctuation-insensitive',
  resolveField(f('why do you want to work here'), ctx({ byQuestion: prior })).resolved === true);

const priorBadOption = resolveField(
  f('Preferred office', { type: 'select', options: ['Singapore', 'Tokyo'] }),
  ctx({ byQuestion: { [normalizeQuestion('Preferred office')]: 'Berlin' } }),
);
ok('a prior answer that is not an offered option is refused', priorBadOption.resolved === false);

// ─────────────────────────────────────────────────────────────────────────────
// resolveFields aggregation.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  -- whole-form resolution --');

const form = [
  f('First name', { id: 'f1' }),
  f('Email', { id: 'f2' }),
  f('Are you authorized to work in Singapore?', { id: 'f3' }),
  f('What is your expected salary?', { id: 'f4', required: true }),
  f('Resume', { id: 'f5', type: 'file' }),
  f('Why us?', { id: 'f6', required: true }),
];
const out = resolveFields(form, ctx());
ok('resolves the deterministic fields', out.answers.f1 === 'Tan' && out.answers.f2 === CANDIDATE.email && Boolean(out.answers.f3));
ok('file fields are left to the attachment path', !('f5' in out.answers));
ok('reports the unresolved ones', out.unresolved.length === 2);
ok('marks which unresolved fields are required', out.unresolved.every((u) => u.required === true));
ok('every resolved answer carries provenance', out.provenance.length === Object.keys(out.answers).length);
ok('provenance names a rule and a source', out.provenance.every((p) => p.rule && p.source));

// An empty / malformed form must not throw.
ok('an empty field list is handled', resolveFields([], ctx()).provenance.length === 0);
ok('null entries are skipped', resolveFields([null, undefined, f('Email')], ctx()).provenance.length === 1);
ok('a field with no label is reported', resolveField({ id: 'x' }, ctx()).resolved === false);

// classifyQuestion is exported for the digest/report path.
ok('classifyQuestion is usable standalone', classifyQuestion('What is your notice period?')?.key === 'notice_period');
ok('classifyQuestion returns null for an unknown question', classifyQuestion('Favourite colour?') === null);
ok('classifyQuestion tolerates empty input', classifyQuestion('') === null);
