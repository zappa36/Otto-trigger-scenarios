/*
 * The ElevenLabs API, the little of it the loop uses: agent tests
 * (create / list / update / run / poll), conversations with their
 * analysis, the agent's config, and branches. One fetch wrapper
 * underneath, shared with the Supabase and OpenAI calls, so every
 * command gets the same three things for free:
 *
 *   - --dry-run: the request is printed (method, path, body) and never
 *     sent. Headers are never printed — the API key travels only in
 *     the xi-api-key header, and the printer redacts the secrets it
 *     was handed in case one ever lands in a body by mistake;
 *   - one retry after a pause on 429 (the test runner and the
 *     conversations list both rate-limit when hammered) and, only where
 *     a re-send cannot do anything twice, on 5xx — see send();
 *   - errors that say what failed: status, method, path and the first
 *     300 characters of what came back, which is where ElevenLabs puts
 *     the validation message.
 *
 * Every path and field here was checked against the API reference
 * (append .md to a docs URL for the markdown) — the reference URL sits
 * next to each function. The old simulate-conversation endpoint is
 * deprecated and deliberately absent.
 */

export const DEFAULT_BASE = 'https://api.elevenlabs.io';

export class ApiError extends Error {
  constructor(status, method, path, text) {
    super(`${status} from ${method} ${path}: ${String(text || '').slice(0, 300)}`);
    this.status = status;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const withQuery = (path, query) => {
  const q = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!q.length) return path;
  return path + '?' + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
};

/* The methods a re-send cannot do twice: a repeated GET reads, a
 * repeated PUT or PATCH writes the same thing again. */
const IDEMPOTENT = new Set(['GET', 'PUT', 'PATCH', 'DELETE']);

/* The fetch wrapper. `secrets` are the strings that must never reach
 * stdout; `log` is where a dry run prints. `retryDelayMs` is only
 * shortened by the tests. `retry` says whether a 5xx may be re-sent;
 * by default only an idempotent method is. `quiet` keeps a dry run's
 * BODIES off stdout — the prompt travels in one of them (the proposer's
 * input, a branch's conversation_config), and a public job log must
 * never carry it; the method and path still print, so a dry run still
 * shows what would be sent. */
export function makeHttp({ dryRun = false, log = console.log, fetchImpl = globalThis.fetch, secrets = [], retryDelayMs = 1500, quiet = false } = {}) {
  const redact = s => secrets.filter(Boolean).reduce((acc, k) => acc.split(k).join('[redacted]'), String(s));
  let sent = 0;

  async function send({ method = 'GET', base, path, query, headers = {}, body, label = '', retry = IDEMPOTENT.has(method) }) {
    const url = String(base).replace(/\/+$/, '') + withQuery(path, query);
    if (dryRun) {
      log(`  (dry run) ${method} ${redact(url)}${label ? '   ' + label : ''}`);
      if (body !== undefined) log(quiet ? '      (body not shown — --quiet)' : redact(JSON.stringify(body, null, 2)).replace(/^/gm, '      '));
      return null;
    }
    for (let attempt = 0; ; attempt++) {
      const r = await fetchImpl(url, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      sent++;
      const text = await r.text();
      if (r.ok) {
        if (!text.trim()) return {};
        try { return JSON.parse(text); } catch { return { raw: text }; }
      }
      /* A 429 was refused outright, so any request can go again. A 5xx
       * is different: a 502 or 504 from a gateway can arrive AFTER the
       * backend accepted the request, and a second run-tests then
       * starts (and bills) a second suite nobody polls, a second create
       * leaves a duplicate test, a second branch clashes on its name, a
       * second merge finds its source already archived. So a 5xx is only
       * retried where a re-send changes nothing. */
      if (attempt === 0 && (r.status === 429 || (r.status >= 500 && retry))) {
        await sleep(retryDelayMs);
        continue;
      }
      throw new ApiError(r.status, method, redact(withQuery(path, query)), redact(text));
    }
  }

  return { send, dryRun, get sent() { return sent; } };
}

/* The ElevenLabs client proper. Every method returns the parsed JSON,
 * or null on a dry run — callers treat null as "nothing came back". */
export function elevenLabs({ apiKey, base = DEFAULT_BASE, http }) {
  const headers = { 'xi-api-key': apiKey };
  const call = (method, path, opts = {}) => http.send({ method, base, path, headers, ...opts });

  /* Cursor pagination as every ElevenLabs list endpoint does it:
   * { <items>: [], has_more, next_cursor }. */
  async function* paginate(path, query, itemsKey, { pageSize = 100 } = {}) {
    let cursor = null;
    for (;;) {
      const page = await call('GET', path, { query: { ...query, page_size: pageSize, cursor } });
      if (!page) return;
      for (const item of page[itemsKey] || []) yield item;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  return {
    /* https://elevenlabs.io/docs/api-reference/tests/create — body is
     * the test itself (type llm | tool | simulation); reply { id } */
    createTest: body => call('POST', '/v1/convai/agent-testing/create', { body, label: body && body.name }),
    /* https://elevenlabs.io/docs/api-reference/tests/update — PUT, same body */
    updateTest: (id, body) => call('PUT', `/v1/convai/agent-testing/${encodeURIComponent(id)}`, { body, label: body && body.name }),
    /* https://elevenlabs.io/docs/api-reference/tests/list — ?search= filters by name */
    listTests: (query = {}) => paginate('/v1/convai/agent-testing', query, 'tests'),
    /* https://elevenlabs.io/docs/api-reference/tools/list — the workspace's
     * tools, each { id, tool_config: { name, type: client|webhook|system|mcp } };
     * an agent names its own by id in conversation_config.agent.prompt.tool_ids */
    listTools: (query = {}) => paginate('/v1/convai/tools', query, 'tools'),
    /* https://elevenlabs.io/docs/api-reference/tests/run-tests — body
     * { tests: [{test_id}], branch_id?, repeat_count?, agent_config_override? } */
    runTests: (agentId, body) => call('POST', `/v1/convai/agents/${encodeURIComponent(agentId)}/run-tests`, { body }),
    /* https://elevenlabs.io/docs/api-reference/tests/test-invocations/get */
    getInvocation: id => call('GET', `/v1/convai/test-invocations/${encodeURIComponent(id)}`),
    /* https://elevenlabs.io/docs/api-reference/agents/get — ?branch_id / ?version_id read another */
    getAgent: (agentId, query = {}) => call('GET', `/v1/convai/agents/${encodeURIComponent(agentId)}`, { query }),
    /* https://elevenlabs.io/docs/api-reference/agents/update — PATCH,
     * partial body; version_description names the version it cuts */
    patchAgent: (agentId, body, query = {}) => call('PATCH', `/v1/convai/agents/${encodeURIComponent(agentId)}`, { body, query }),
    /* https://elevenlabs.io/docs/api-reference/agents/branches/create —
     * { parent_version_id, name, description, conversation_config?, platform_settings? }
     * -> { created_branch_id, created_version_id } */
    createBranch: (agentId, body) => call('POST', `/v1/convai/agents/${encodeURIComponent(agentId)}/branches`, { body }),
    /* https://elevenlabs.io/docs/api-reference/agents/branches/list -> { results: [] } */
    listBranches: (agentId, query = {}) => call('GET', `/v1/convai/agents/${encodeURIComponent(agentId)}/branches`, { query }),
    /* https://elevenlabs.io/docs/eleven-agents/api-reference/agents/branches/get
     * -> { id, name, agent_id, description, created_at, last_committed_at,
     * is_archived, … }. `description` is the branch's own note — what the
     * proposal said it changed. It lives here, in ElevenLabs, and not in
     * the public repo, which is why promote reads it back instead of
     * carrying a proposal file around. */
    getBranch: (agentId, branchId) => call('GET', `/v1/convai/agents/${encodeURIComponent(agentId)}/branches/${encodeURIComponent(branchId)}`),
    /* https://elevenlabs.io/docs/api-reference/agents/branches/merge —
     * the target branch goes in the QUERY, the body holds
     * { archive_source_branch, force } */
    mergeBranch: (agentId, sourceBranchId, targetBranchId, body = {}) =>
      call('POST', `/v1/convai/agents/${encodeURIComponent(agentId)}/branches/${encodeURIComponent(sourceBranchId)}/merge`,
        { query: { target_branch_id: targetBranchId }, body: { archive_source_branch: true, force: false, ...body } }),
    /* https://elevenlabs.io/docs/api-reference/conversations/list —
     * ?agent_id=&call_start_after_unix= ; items under `conversations` */
    listConversations: (query = {}) => paginate('/v1/convai/conversations', query, 'conversations'),
    /* https://elevenlabs.io/docs/api-reference/conversations/get —
     * transcript[], metadata, analysis, conversation_initiation_client_data */
    getConversation: id => call('GET', `/v1/convai/conversations/${encodeURIComponent(id)}`),
  };
}

/* The proposer. The repo's existing provider (scenario-ai drafts and
 * revises scenarios through the same endpoint), same request shape:
 * chat completions, JSON mode. The base URL is a knob only so the
 * tests can point it at a mock.
 * https://platform.openai.com/docs/api-reference/chat/create */
export function openai({ apiKey, base = 'https://api.openai.com/v1', http }) {
  return {
    async json({ model, system, user, maxTokens = 3000 }) {
      const res = await http.send({
        method: 'POST', base, path: '/chat/completions',
        headers: { Authorization: `Bearer ${apiKey}` },
        /* a completion leaves nothing behind, so a 5xx is retried the
         * way a GET is */
        retry: true,
        body: {
          model,
          response_format: { type: 'json_object' },
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        },
      });
      if (!res) return null;
      const choice = (res.choices && res.choices[0]) || {};
      const content = choice.message && choice.message.content;
      /* a reply cut by the token limit is not "not JSON" — it is JSON
       * with no end, and the caller has to ask for more room */
      if (choice.finish_reason === 'length') throw new Error(`the model's reply was cut by the token limit (max_tokens ${maxTokens}) before the JSON closed — the reply has to hold the whole prompt, so the prompt is too long for this budget`);
      try { return JSON.parse(content); } catch { throw new Error(`the model returned something other than JSON: ${String(content).slice(0, 200)}`); }
    },
  };
}
