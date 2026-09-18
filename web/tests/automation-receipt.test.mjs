import test from 'node:test';
import assert from 'node:assert/strict';
import { attestationMatches, confirmationMatches, fileMetadataMatches } from '../src/lib/apply/receipt.mjs';

test('receipt detection requires explicit application confirmation', () => {
  assert.equal(confirmationMatches('Thank you for your application'), true);
  assert.equal(confirmationMatches('Thank you for applying. Your application has been received.'), true);
  assert.equal(confirmationMatches('Your application has not been received'), false);
  assert.equal(confirmationMatches('A verification code was sent. Enter it to submit your application.'), false);
  assert.equal(confirmationMatches('Your profile was saved'), false);
  assert.equal(confirmationMatches('An unexpected network error occurred'), false);
});

test('attestations are blocked and exact upload metadata is required', () => {
  assert.equal(attestationMatches('I certify that the information is true'), true);
  assert.equal(attestationMatches('Portfolio URL'), false);
  assert.equal(fileMetadataMatches({ name: 'cv.pdf', size: 123 }, { name: 'cv.pdf', size: 123 }), true);
  assert.equal(fileMetadataMatches({ name: 'cv.pdf', size: 122 }, { name: 'cv.pdf', size: 123 }), false);
});
