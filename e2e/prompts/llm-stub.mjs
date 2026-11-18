// Test shim only: answers calls to the AI providers with a fixed reply that echoes the prompt, so runs can be tested without a real key.
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? input);
  if (/generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com/.test(url)) {
    const body = (() => { try { return JSON.parse(init?.body ?? '{}'); } catch { return {}; } })();
    const msgs = body.messages ?? [];
    const last = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
    const key = (/key=([^&]+)/.exec(url) || [])[1] || '';
    if (decodeURIComponent(key) === 'bad-key') return new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 401 });
    const model = body.model ?? 'stub';
    const text = `Echo: ${String(last).slice(0, 200)}\n\nHere is the plan:\n1. Draft the research plan\n2. Interview three customers\n3. Write the findings summary\n\n- Share it with the team`;
    return new Response(JSON.stringify({ id: 'stub', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return real(input, init);
};
