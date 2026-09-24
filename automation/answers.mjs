// automation/answers.mjs — deterministic, auditable resolution of an
// application-form question to a saved answer.
//
// WHY THIS EXISTS
//
// worker.mjs previously matched saved answers to form labels with bidirectional
// SUBSTRING comparison on underscore-joined strings (savedAnswer /
// keyMatchesNormalized). Reproduced on the shipped example config:
//
//   "Do you manage a team?"  -> key "do_you_manage_a_team" contains "age"
//                               -> answered with the saved `age` value
//   "Package expectation"    -> contains "age" -> same
//   "Are you authorized to work in Singapore?"
//                            -> the documented key
//                               `require_sponsorship_in_singapore` does NOT
//                               match -> reported as an unanswerable field
//
// So the old matcher both supplied WRONG values and missed the ones it was
// configured for. In shadow mode that is noise; in canary/full it is a wrong
// answer on a submitted application, which cannot be recalled.
//
// THE RULES HERE
//
//   1. An exact match on the normalized question text, against answers learned
//      from previous applications (Block H in reports/).
//   2. An INTENT match: a curated pattern list per intent, where an intent maps
//      to one configured value. `application_answers` is keyed by intent, not by
//      form wording.
//   3. Identity fields (name, email, phone, links) from config/profile.yml.
//   4. Nothing else. There is NO fuzzy or substring fallback, by design — an
//      unmatched question is REPORTED, never guessed at. Silence loses one
//      field; a guess loses the application.
//
// Every resolution carries provenance: which rule fired and which config key
// supplied the value, so the Block H record can be audited after the fact.
//
// Two classes of question get special handling because a plain string answer is
// wrong for them:
//
//   Demographic self-identification. The configured value ("I prefer not to
//   disclose") is almost never the literal option text — real forms offer
//   "Decline to self identify", "I don't wish to answer", "Prefer not to say".
//   So for a field WITH options we select the option that matches a decline
//   pattern, and if no such option exists we report the field rather than
//   picking a demographic value. A guessed race or gender is never acceptable.
//
//   Consent and attestation. These are gated on
//   automation.preauthorize.consent_checkboxes / .attestations. Absent or false
//   means refuse, so a malformed config can never auto-attest.

/** The profile sentinel meaning "only the user can supply this". Never sent. */
export const UNCONFIRMED = 'CONFIRM_REQUIRED';

/** Normalize a question label for comparison: lowercase, punctuation to spaces. */
export function normalizeQuestion(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/'/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Matches an option offered as "I'd rather not say" in any of its usual forms. */
const DECLINE_OPTION = /prefer not|decline|do not wish|dont wish|not wish to|not disclose|choose not|rather not|no response|not specified|unspecified|i do not want/i;

/**
 * Intent table. Order matters: the first intent whose patterns match wins, so
 * more specific intents are listed before the ones they could be confused with.
 *
 * Every pattern is tested against the NORMALIZED question (see
 * normalizeQuestion), so patterns contain no punctuation.
 */
export const INTENTS = [
  {
    // Listed before sponsorship_required: "authorized to work ... without
    // sponsorship" mentions sponsorship but is asking about AUTHORIZATION, and
    // the two intents have opposite answers ("Yes" vs "No"). Requiring an
    // authorization verb here, and a require/need verb there, keeps them apart.
    key: 'work_authorization',
    patterns: [
      /\b(authorized|authorised|eligible|legally (?:able|permitted)|permitted|legal right|right to work)\b.*\bwork\b/,
      /\bwork\b.*\b(authorization|authorisation|eligibility)\b/,
      /\b(are|do) you (legally )?(authorized|authorised|eligible)\b/,
      /\bwork (permit|pass|authorization|authorisation)\b/,
    ],
  },
  {
    key: 'sponsorship_required',
    patterns: [
      /\b(require|requires|need|needs|request|seeking)\b.*\b(sponsorship|sponsor|visa)\b/,
      /\b(sponsorship|visa sponsorship)\b.*\b(required|needed)\b/,
      /\bnow or in the future\b.*\b(sponsorship|visa)\b/,
      /\bwill you (require|need)\b/,
    ],
  },
  {
    key: 'notice_period',
    patterns: [
      /\bnotice period\b/,
      /\bperiod of notice\b/,
      /\b(how (long|much)|length of)\b.*\bnotice\b/,
      /\bnotice\b.*\b(required|current employer)\b/,
    ],
  },
  {
    key: 'start_date',
    patterns: [
      /\bwhen (can|could|would) you (start|commence|join)\b/,
      /\b(earliest|possible|expected|available|availability)\b.*\bstart\b/,
      /\bstart date\b/,
      /\bdate available\b/,
      /\bavailable to (start|commence|join)\b/,
      /\bhow soon can you\b/,
    ],
  },
  {
    key: 'salary_expectation',
    patterns: [
      /\b(salary|compensation|remuneration|pay|package|ctc)\b.*\b(expectation|expectations|expected|requirement|requirements|range|desired)\b/,
      /\b(expected|desired|minimum|target)\b.*\b(salary|compensation|remuneration|pay|package|ctc)\b/,
      /\bhow much\b.*\b(salary|paid|earn)\b/,
      /\bwhat (are|is) your (salary|compensation|pay)\b/,
    ],
  },
  {
    key: 'willing_to_relocate',
    patterns: [
      /\b(willing|able|open|prepared)\b.*\brelocat/,
      /\brelocat\w*\b.*\b(willing|able|open|required|consider)/,
      /\bwould you relocate\b/,
      /\bopen to relocation\b/,
    ],
  },
  {
    key: 'criminal_record',
    patterns: [
      /\b(convicted|conviction|convictions)\b/,
      /\bcriminal (record|history|offence|offense|background)\b/,
      /\b(felony|misdemeanor|misdemeanour)\b/,
      /\bever been (arrested|charged)\b/,
    ],
  },
  {
    // Demographic self-identification. Option-aware; never guessed.
    key: 'demographic_self_id',
    optionPreferred: DECLINE_OPTION,
    requireOptionMatch: true,
    patterns: [
      /\b(gender|sex) (identity|at birth)?\b/,
      /^\s*(gender|sex)\s*$/,
      /\b(race|ethnicity|ethnic (group|origin)|racial)\b/,
      /\b(veteran|protected veteran|military service)\b/,
      /\b(disability|disabilities|disabled)\b/,
      /\bsexual orientation\b/,
      /\btransgender\b/,
      /\bpronouns\b/,
      /\bself identif/,
      /\bhispanic or latino\b/,
    ],
  },
  {
    // Gated on automation.preauthorize.consent_checkboxes / .attestations.
    key: 'consent',
    requiresPreauth: 'consent_checkboxes',
    patterns: [
      /\bi (have )?read\b/,
      /\bi (agree|consent|accept|acknowledge)\b/,
      /\b(privacy (notice|policy|statement)|terms (and conditions|of use|of service))\b/,
      /\b(data (processing|protection)|gdpr|pdpa)\b/,
      /\bconsent to\b/,
    ],
  },
  {
    key: 'attestation',
    requiresPreauth: 'attestations',
    configKey: 'consent',
    patterns: [
      /\bi certify\b/,
      /\bcertif(y|ication) that\b/,
      /\bi attest\b/,
      /\bdeclaration\b/,
      /\b(true and (complete|accurate)|accurate and complete)\b/,
      /\bto the best of my knowledge\b/,
    ],
  },
  {
    key: 'how_did_you_hear',
    patterns: [
      /\bhow did you (hear|find out|learn|come to know)\b/,
      /\bwhere did you (hear|find|see)\b/,
      /\b(referral|recruitment) source\b/,
      /\bhow did you find (this|us|the)\b/,
    ],
  },
];

/**
 * Identity fields read straight from config/profile.yml `candidate`. High
 * frequency on every form and fully deterministic, so they never need a model
 * call. Each entry names the profile key it reads.
 */
export const IDENTITY_FIELDS = [
  { key: 'full_name', profile: 'full_name', patterns: [/^(full |legal )?name$/, /\bfull name\b/, /\blegal name\b/] },
  { key: 'first_name', profile: 'full_name', derive: (v) => String(v).trim().split(/\s+/)[0], patterns: [/\bfirst name\b/, /\bgiven name\b/, /^forename$/] },
  { key: 'last_name', profile: 'full_name', derive: (v) => String(v).trim().split(/\s+/).slice(-1)[0], patterns: [/\blast name\b/, /\b(family|sur)name\b/] },
  { key: 'email', profile: 'email', patterns: [/\be ?mail\b/] },
  { key: 'phone', profile: 'phone', patterns: [/\b(phone|telephone|mobile|contact) (number|no)\b/, /^(phone|telephone|mobile)$/, /\bphone\b/] },
  { key: 'location', profile: 'location', patterns: [/^(location|city|current location)$/, /\bcurrent (location|city)\b/, /\bwhere are you (based|located)\b/] },
  { key: 'linkedin', profile: 'linkedin', patterns: [/\blinkedin\b/] },
  { key: 'github', profile: 'github', patterns: [/\bgithub\b/] },
  { key: 'portfolio', profile: 'portfolio_url', patterns: [/\b(portfolio|personal (website|site)|website)\b/] },
];

function usable(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  return text !== '' && text !== UNCONFIRMED;
}

/** The intent a question expresses, or null. Exported for tests and reporting. */
export function classifyQuestion(label) {
  const q = normalizeQuestion(label);
  if (!q) return null;
  for (const intent of INTENTS) {
    if (intent.patterns.some((re) => re.test(q))) return intent;
  }
  return null;
}

/** The identity field a question asks for, or null. */
export function classifyIdentity(label) {
  const q = normalizeQuestion(label);
  if (!q) return null;
  for (const field of IDENTITY_FIELDS) {
    if (field.patterns.some((re) => re.test(q))) return field;
  }
  return null;
}

/**
 * Pick the option that best expresses `value`, or the option matching
 * `preferred` when one is given. Returns the EXACT option text, since a form
 * select rejects anything else.
 */
function pickOption(options, value, preferred) {
  const list = Array.isArray(options) ? options.filter((o) => typeof o === 'string' && o.trim()) : [];
  if (!list.length) return null;
  if (preferred) {
    // Test the NORMALIZED option too, not just the raw text: real decline
    // options carry apostrophes and punctuation ("I don't wish to answer",
    // "Decline to self-identify") that a plain pattern misses. The value
    // returned is always the raw option, since a form select rejects anything
    // but its own exact text.
    const hit = list.find((o) => preferred.test(o) || preferred.test(normalizeQuestion(o)));
    if (hit) return hit;
  }
  if (!usable(value)) return null;
  const target = normalizeQuestion(value);
  const exact = list.find((o) => normalizeQuestion(o) === target);
  if (exact) return exact;
  // A yes/no answer against yes/no options.
  if (/^(yes|no)$/.test(target)) {
    const hit = list.find((o) => normalizeQuestion(o) === target || new RegExp(`^${target}\\b`).test(normalizeQuestion(o)));
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve one field.
 *
 * @param {{id: string, label?: string, type?: string, required?: boolean, options?: string[]}} field
 * @param {object} ctx
 * @param {Record<string, any>} [ctx.answers]     profile.application_answers, keyed by intent
 * @param {Record<string, any>} [ctx.candidate]   profile.candidate
 * @param {Record<string, string>} [ctx.byQuestion] learned answers, keyed by normalized question
 * @param {Record<string, boolean>} [ctx.preauthorize] automation.preauthorize
 * @returns {{resolved: true, value: string, rule: string, sourceKey: string, intent?: string}
 *          | {resolved: false, reason: string, intent?: string, needsPreauth?: string}}
 */
export function resolveField(field, ctx = {}) {
  const { answers = {}, candidate = {}, byQuestion = {}, preauthorize = {} } = ctx;
  const label = field?.label || '';
  const q = normalizeQuestion(label);
  if (!q) return { resolved: false, reason: 'field has no readable label' };

  // 1. An exact match on a question answered before (Block H history).
  if (usable(byQuestion[q])) {
    const value = String(byQuestion[q]);
    const option = field.options?.length ? pickOption(field.options, value) : null;
    if (field.options?.length && !option) {
      return { resolved: false, reason: `previous answer "${value}" is not one of this field's options` };
    }
    return { resolved: true, value: option || value, rule: 'prior-answer', sourceKey: `byQuestion:${q}` };
  }

  // 2. Intent match against the curated table.
  const intent = classifyQuestion(label);
  if (intent) {
    if (intent.requiresPreauth && preauthorize[intent.requiresPreauth] !== true) {
      return {
        resolved: false,
        intent: intent.key,
        needsPreauth: intent.requiresPreauth,
        reason: `${intent.key} needs automation.preauthorize.${intent.requiresPreauth} to be explicitly true`,
      };
    }
    const configKey = intent.configKey || intent.key;
    const configured = answers[configKey];

    if (field.options?.length) {
      const option = pickOption(field.options, configured, intent.optionPreferred);
      if (option) {
        return { resolved: true, value: option, rule: 'intent-option', sourceKey: `application_answers.${configKey}`, intent: intent.key };
      }
      // A demographic field with no decline option must NOT fall through to a
      // literal string: that would either fail validation or, worse, land on a
      // real demographic value.
      if (intent.requireOptionMatch) {
        return { resolved: false, intent: intent.key, reason: `no "prefer not to disclose" option offered for ${intent.key}` };
      }
    }

    if (intent.requireOptionMatch && !field.options?.length) {
      // Free-text demographic question: the configured decline string is safe.
      if (usable(configured)) {
        return { resolved: true, value: String(configured), rule: 'intent', sourceKey: `application_answers.${configKey}`, intent: intent.key };
      }
      return { resolved: false, intent: intent.key, reason: `application_answers.${configKey} is not set` };
    }

    if (field.type === 'checkbox') {
      // Consent/attestation checkboxes: an affirmative configured value ticks it.
      const affirmative = /^(yes|true|1|on|agree|accept|i agree|i accept)$/i.test(String(configured || '').trim());
      if (affirmative) {
        return { resolved: true, value: 'true', rule: 'intent-checkbox', sourceKey: `application_answers.${configKey}`, intent: intent.key };
      }
      return { resolved: false, intent: intent.key, reason: `application_answers.${configKey} is not an affirmative value` };
    }

    if (usable(configured)) {
      return { resolved: true, value: String(configured), rule: 'intent', sourceKey: `application_answers.${configKey}`, intent: intent.key };
    }
    return {
      resolved: false,
      intent: intent.key,
      reason: String(configured).trim() === UNCONFIRMED
        ? `application_answers.${configKey} is ${UNCONFIRMED} — only you can supply it`
        : `application_answers.${configKey} is not set`,
    };
  }

  // 3. Identity fields from the profile.
  const identity = classifyIdentity(label);
  if (identity) {
    const raw = candidate[identity.profile];
    if (usable(raw)) {
      const value = identity.derive ? identity.derive(raw) : String(raw);
      if (usable(value)) {
        return { resolved: true, value, rule: 'identity', sourceKey: `candidate.${identity.profile}` };
      }
    }
    return { resolved: false, reason: `candidate.${identity.profile} is not set in config/profile.yml` };
  }

  // 4. No fuzzy fallback. Deliberately.
  return { resolved: false, reason: 'no saved answer and no matching intent' };
}

/**
 * Resolve a whole form.
 *
 * @returns {{answers: Record<string,string>, provenance: Array, unresolved: Array}}
 */
export function resolveFields(fields = [], ctx = {}) {
  const answers = {};
  const provenance = [];
  const unresolved = [];
  for (const field of fields) {
    if (!field || typeof field !== 'object') continue;
    if (field.type === 'file') continue; // attachments are handled by the filler
    const outcome = resolveField(field, ctx);
    if (outcome.resolved) {
      answers[field.id] = outcome.value;
      provenance.push({
        field_id: field.id,
        label: field.label || '',
        value: outcome.value,
        rule: outcome.rule,
        source: outcome.sourceKey,
        intent: outcome.intent || null,
      });
    } else {
      unresolved.push({
        field_id: field.id,
        label: field.label || '',
        required: Boolean(field.required),
        reason: outcome.reason,
        intent: outcome.intent || null,
        needs_preauth: outcome.needsPreauth || null,
      });
    }
  }
  return { answers, provenance, unresolved };
}
