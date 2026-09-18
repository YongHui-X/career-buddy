const ATTESTATION_RE = /\b(i (?:have )?read|i agree|i consent|i accept|certif(?:y|ication)|attest|declaration|signature|privacy notice|terms(?: of use| and conditions)?|background check)\b/i;
const CONFIRMATION_RE = /\b(thank you for (?:your )?application|application (?:has been )?submitted|(?:your )?application has been received|we (?:have )?received your application|application complete|successfully applied|submission confirmed)\b/i;

export function attestationMatches(value = "") { return ATTESTATION_RE.test(String(value)); }
export function confirmationMatches(value = "") { return CONFIRMATION_RE.test(String(value)); }
export function fileMetadataMatches(actual, expected) {
  return Boolean(actual && expected && actual.name === expected.name && Number(actual.size) === Number(expected.size));
}
