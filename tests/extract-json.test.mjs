import { extractJsonObject } from '../lib/extract-json.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nlib/extract-json.mjs — LLM JSON extraction with truncation salvage');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function keysOf(input) {
  const { obj } = extractJsonObject(input);
  return obj ? Object.keys(obj).length : null;
}

// ── The ordinary cases ──────────────────────────────────────────────────────
ok('parses a plain object', keysOf('{"a":1}') === 1);
ok('strips a json code fence', keysOf('```json\n{"a":1}\n```') === 1);
ok('strips a bare code fence', keysOf('```\n{"a":1}\n```') === 1);
ok('ignores prose before and after', keysOf('Here you go: {"a":1} hope that helps') === 1);
ok('parses nested objects', keysOf('{"a":{"b":{"c":1}},"d":2}') === 2);

// ── String-state tracking. A brace or quote inside a VALUE must not end the
//    object early — an application answer can easily contain either. ─────────
ok('a closing brace inside a string does not end the object', keysOf('{"a":"} not the end","b":2}') === 2);
ok('an escaped quote inside a string is respected', keysOf('{"a":"say \\"hi\\"","b":2}') === 2);
ok('a trailing backslash in a string does not swallow the closing quote', keysOf('{"a":"path\\\\","b":2}') === 2);
ok('braces in a multi-sentence answer survive', keysOf('{"why":"I use {} in code daily.","ok":true}') === 2);

// ── Truncation salvage: the reason this module exists. A planner CLI killed
//    mid-output must still yield the fields that finished. ──────────────────
const cut = extractJsonObject('{"a":1,"b":2,"c":');
ok('salvages completed keys from a truncated object', cut.obj && Object.keys(cut.obj).length === 2);
ok('salvage is reported as truncated', cut.truncated === true);
ok('a complete object is not reported as truncated', extractJsonObject('{"a":1}').truncated === false);

const cutNested = extractJsonObject('{"x":{"y":1},"z":{"w":');
ok('salvages a completed sibling when a nested object is cut', cutNested.obj && Object.keys(cutNested.obj).length === 1);

const cutMidString = extractJsonObject('{"a":1,"b":"half a sen');
ok('salvages around a value cut mid-string', cutMidString.obj && Object.keys(cutMidString.obj).length === 1);

// ── Failure is explicit, never a throw. The worker treats null as "retry",
//    so this must not become an exception that aborts a whole run. ──────────
ok('no JSON at all returns null', extractJsonObject('sorry, I cannot help with that').obj === null);
ok('no JSON at all is not flagged truncated', extractJsonObject('sorry, I cannot help with that').truncated === false);
ok('empty input returns null', extractJsonObject('').obj === null);
ok('null input returns null rather than throwing', extractJsonObject(null).obj === null);
ok('undefined input returns null rather than throwing', extractJsonObject(undefined).obj === null);
ok('an unsalvageable fragment returns null', extractJsonObject('{').obj === null);

// ── Parity with the web prefill route it was extracted from: an answers map
//    keyed by field id is the real-world shape. ─────────────────────────────
const answers = extractJsonObject(`Thinking done.
\`\`\`json
{
  "co1": {"value": "Tan Yong Hui", "needs_confirmation": false},
  "co2": {"value": "", "needs_confirmation": true},
  "co3": {"value": "I built a RAG system with 86% Recall@5.", "needs_confirmation": false}
}
\`\`\``);
ok('parses a realistic prefill answers map', answers.obj && Object.keys(answers.obj).length === 3);
ok('preserves nested answer fields', answers.obj?.co3?.value?.includes('86% Recall@5'));
ok('preserves a needs_confirmation flag', answers.obj?.co2?.needs_confirmation === true);

// ── Truncated ARRAYS. The worker's evaluation response nests objects inside an
//    `evidence` array, so array salvage is not hypothetical here. The prefill
//    route's original implementation only ever padded `}` and recovered nothing
//    from these. ─────────────────────────────────────────────────────────────
const cutArray = extractJsonObject('{"score":4.5,"evidence":[{"source":"jd","finding":"x"},{"source":');
ok('salvages scalar siblings when an array is cut', cutArray.obj?.score === 4.5);
ok('array salvage is reported as truncated', cutArray.truncated === true);

const cutArrayTail = extractJsonObject('{"a":1,"tags":["one","two"');
ok('closes a truncated array of strings', Array.isArray(cutArrayTail.obj?.tags) || cutArrayTail.obj?.a === 1);

const deepCut = extractJsonObject('{"a":{"b":[{"c":1}]},"d":[{"e":');
ok('salvages through nested object-in-array truncation', deepCut.obj && Object.keys(deepCut.obj).includes('a'));

// A recovered empty object carries no information and must not read as success.
ok('an empty recovered object is not reported as a win', extractJsonObject('{"a":').obj === null);
