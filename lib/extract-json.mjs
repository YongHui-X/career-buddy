// lib/extract-json.mjs — pull a JSON object out of an LLM's text answer.
//
// Extracted from web/src/app/api/apply/prefill/route.ts so the unattended
// automation worker and the web prefill route share one parser instead of
// keeping two that drift. The behaviour that matters is TRUNCATION SALVAGE: a
// planner CLI killed mid-output leaves an unbalanced object, and the fields that
// DID finish are still worth having. automation/openrouter.mjs's older
// extractJson threw on that case and lost the whole response.
//
// Returns { obj, truncated }:
//   obj       — the parsed object, or null if nothing could be recovered
//   truncated — true when the object was salvaged from an incomplete answer, so
//               callers can warn instead of trusting it as complete
//
// Divergence from the original prefill implementation, on purpose: that version
// computed the closing-brace padding ONCE from the whole fragment and reused it
// for every shortened candidate, so the padding was wrong as soon as it walked
// back past a nested object — `{"x":{"y":1},"z":{"w":` recovered nothing even
// though `x` had finished. It also only ever padded `}`, so a truncated ARRAY
// was unrecoverable. Both matter here: the worker's evaluation response nests
// objects inside an `evidence` array. The padding is now recomputed per
// candidate from a string-aware bracket stack.
//
// Pure and dependency-free; safe to import from anywhere.

/**
 * The suffix that would close every still-open bracket in `s`, or null when `s`
 * ends inside a string literal (where no suffix can safely close it).
 * @param {string} s
 * @returns {string | null}
 */
function closingSuffix(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inStr) return null;
  return stack.reverse().map((b) => (b === '{' ? '}' : ']')).join('');
}

/**
 * @param {string} text Raw model/CLI stdout, possibly fenced or with trailing prose.
 * @returns {{ obj: Record<string, unknown> | null, truncated: boolean }}
 */
export function extractJsonObject(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start === -1) return { obj: null, truncated: false };

  // Fast path: find the matching close brace, tracking string/escape state so a
  // brace inside a quoted value never ends the object early.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end !== -1) {
    try {
      return { obj: JSON.parse(s.slice(start, end + 1)), truncated: false };
    } catch {
      /* balanced but malformed — fall through to salvage */
    }
  }

  // Salvage: walk back from successive commas, closing whatever is still open at
  // that point, and keep the largest prefix that parses.
  const frag = s.slice(start);
  for (let tryEnd = frag.length; tryEnd > 1;) {
    const cand = frag.slice(0, tryEnd).replace(/,\s*$/, '');
    const closer = closingSuffix(cand);
    if (closer !== null) {
      try {
        const obj = JSON.parse(cand + closer);
        // A bare `{}` recovered from a fragment carries no information; keep
        // walking rather than reporting an empty success.
        if (obj && typeof obj === 'object' && Object.keys(obj).length > 0) {
          return { obj, truncated: true };
        }
      } catch {
        /* not a valid prefix — keep walking back */
      }
    }
    const prevComma = frag.lastIndexOf(',', tryEnd - 1);
    if (prevComma <= 0) break;
    tryEnd = prevComma;
  }
  return { obj: null, truncated: true };
}
