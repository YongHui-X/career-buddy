function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('OpenRouter returned no JSON object');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error('OpenRouter returned truncated JSON');
}

export async function assertOpenRouterDailyBudget(limitUsd, { reserveUsd = 0.02, fetchFn = fetch } = {}) {
  const limit = Number(limitUsd);
  if (!Number.isFinite(limit) || limit <= 0) return { enforced: false, usageDaily: null, remaining: null };
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is required for the daily model budget check');
  const response = await fetchFn('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter daily model budget check failed (HTTP ${response.status})`);
  const payload = await response.json();
  const usageDaily = Number((payload.data || payload).usage_daily);
  if (!Number.isFinite(usageDaily)) throw new Error('OpenRouter daily model budget check returned no usage_daily value');
  if (usageDaily + reserveUsd > limit) {
    throw new Error(`OpenRouter daily model budget reached ($${usageDaily.toFixed(3)} used; $${limit.toFixed(2)} limit)`);
  }
  return { enforced: true, usageDaily, remaining: Math.max(0, limit - usageDaily) };
}

export async function callOpenRouterJson({ system, prompt, validate, schema, schemaName = 'career_ops_response', fetchFn = fetch }) {
  const key = process.env.OPENROUTER_API_KEY;
  const model = process.env.CAREER_OPS_MODEL;
  if (!key) throw new Error('OPENROUTER_API_KEY is required');
  if (!model) throw new Error('CAREER_OPS_MODEL must pin a model for unattended automation');
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`, 'content-type': 'application/json',
          'http-referer': 'https://github.com/career-ops-hq/career-ops', 'x-title': 'career-ops automation',
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: Number(process.env.CAREER_OPS_MAX_COMPLETION_TOKENS || 16_000),
          provider: { require_parameters: true },
          plugins: [{ id: 'response-healing' }],
          response_format: schema
            ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
            : { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(Number(process.env.CAREER_OPS_MODEL_TIMEOUT_MS || 180_000)),
      });
      if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
      const payload = await response.json();
      const finishReason = payload.choices?.[0]?.finish_reason;
      if (finishReason === 'length') throw new Error('OpenRouter response was truncated by the completion-token limit');
      if (finishReason && !['stop', 'tool_calls'].includes(finishReason)) throw new Error(`OpenRouter stopped with finish_reason=${finishReason}`);
      const value = extractJson(payload.choices?.[0]?.message?.content);
      if (validate && !validate(value)) throw new Error('OpenRouter response failed schema validation');
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < 2) continue;
    }
  }
  throw lastError;
}
