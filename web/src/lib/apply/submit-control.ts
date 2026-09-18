import type { Frame } from "playwright-core";

export function finalSubmissionControls(frame: Frame) {
  const finalLabel = /^\s*(submit(?: application)?|send application|complete application|finish application)\s*$/i;
  return frame.locator('button').filter({ hasText: finalLabel })
    .or(frame.locator('button[type="submit"]').filter({ hasText: /^\s*apply\s*$/i }))
    .or(frame.locator('input[type="submit"][value*="submit" i], input[type="submit"][value*="apply" i]'))
    .filter({ visible: true });
}
