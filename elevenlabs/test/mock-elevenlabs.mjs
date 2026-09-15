/*
 * An in-process stand-in for the three services the loop talks to —
 * the ElevenLabs API (tests, invocations, conversations, the agent,
 * branches), Supabase's REST (messages, scenarios, agent_runs) and the
 * proposer's chat-completions endpoint — on one port, fed from
 * test/fixture/.
 * It records every request it gets, which is how the tests check what
 * the loop sends (and that --dry-run sends nothing at all).
 *
 * Shapes follow the API reference the loop was written against; the
 * point is the loop's side of the wire, not a faithful ElevenLabs.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const load = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
};

export async function startMock(fixtureDir) {
  const fixture = {
    agent: load(fixtureDir, 'agent.json'),
    invocation: load(fixtureDir, 'invocation.json'),
    conversations: load(fixtureDir, 'conversations.json'),
    messages: load(fixtureDir, 'messages.json'),
    scenarios: load(fixtureDir, 'scenarios.json'),
  };
  const state = {};
  const mock = { requests: [], state, fixture };

  mock.reset = () => {
    mock.requests.length = 0;
    state.agent = JSON.parse(JSON.stringify(fixture.agent));
    /* one test already in the workspace, so push-tests has something
     * to find by name without a lock */
    state.tests = [{ id: 'test_pre8', name: 'Otto · #8 Blocked route · terse', type: 'simulation', body: null }];
    state.created = 0;
    state.invocation = null;
    state.polls = 0;
    state.branches = [];
    state.merges = [];
    state.messages = JSON.parse(JSON.stringify(fixture.messages));
    /* the agent_runs table, empty; false = a project whose schema.sql
     * predates it, which PostgREST reports as a 404 (PGRST205) */
    state.agentRuns = [];
    state.agentRunsTable = true;
    /* the workspace's tools: one client tool an agent may carry (the
     * suite mocks it), one system tool (never mocked); the fixture agent
     * carries neither until a test gives it tool_ids */
    state.tools = [
      { id: 'tool_report', tool_config: { name: 'report_incident', type: 'client' } },
      { id: 'tool_end', tool_config: { name: 'end_call', type: 'system' } },
    ];
    state.failNext = null;
    /* an invocation that never finishes, for the poll timeout */
    state.neverComplete = false;
    /* the proposer's finish_reason — 'length' is a reply the token
     * limit cut */
    state.openaiFinish = 'stop';
    /* the proposer's default answer: the agent's prompt plus one line */
    state.openaiReply = () => ({
      prompt: state.agent.conversation_config.agent.prompt.prompt + '\nAsk where they parked before anything else.',
      note: 'Ask where they parked first — two field debriefs never got the spot',
      rationale: 'conv_aaa was graded bad on follow-up; the failing test rationale says the agent asked generic questions.',
    });
  };
  mock.reset();

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const routes = [
    /* ---------- ElevenLabs ---------- */
    ['POST', /^\/v1\/convai\/agent-testing\/create$/, (m, q, body) => {
      const id = `test_${String(++state.created).padStart(3, '0')}`;
      state.tests.push({ id, name: body.name, type: body.type || 'llm', body });
      return [200, { id }];
    }],
    ['GET', /^\/v1\/convai\/agent-testing$/, (m, q) => {
      const s = String(q.search || '').toLowerCase();
      const tests = state.tests.filter(t => !s || t.name.toLowerCase().includes(s))
        .map(t => ({ id: t.id, name: t.name, type: t.type, entity_type: 'test', created_at_unix_secs: 1, last_updated_at_unix_secs: 1 }));
      return [200, { tests, has_more: false, next_cursor: null }];
    }],
    ['PUT', /^\/v1\/convai\/agent-testing\/([^/]+)$/, (m, q, body) => {
      const t = state.tests.find(x => x.id === m[1]);
      if (!t) return [404, { detail: { status: 'test_not_found', message: `No test ${m[1]}` } }];
      t.body = body; t.name = body.name;
      return [200, { id: t.id, ...body }];
    }],
    ['POST', /^\/v1\/convai\/agents\/([^/]+)\/run-tests$/, (m, q, body) => {
      state.invocation = { agent_id: m[1], tests: body.tests, branch_id: body.branch_id || null, repeat_count: body.repeat_count || 1 };
      state.polls = 0;
      return [200, { id: 'inv_1', test_runs: pendingRuns() }];
    }],
    ['GET', /^\/v1\/convai\/test-invocations\/([^/]+)$/, () => {
      state.polls++;
      /* the first poll is still pending, the second is the fixture —
       * with the branch the run asked for stamped on every run */
      if (state.neverComplete || state.polls < 2) return [200, { id: 'inv_1', test_runs: pendingRuns() }];
      const inv = JSON.parse(JSON.stringify(fixture.invocation));
      const b = state.invocation && state.invocation.branch_id;
      if (b) inv.test_runs.forEach(r => { r.branch_id = b; r.version_id = 'agtvrsn_b1'; });
      return [200, inv];
    }],
    ['GET', /^\/v1\/convai\/conversations$/, (m, q) => {
      const items = fixture.conversations.map(c => c.list).filter(c => !q.agent_id || c.agent_id === q.agent_id);
      /* two pages, so the cursor path is exercised */
      if (!q.cursor) return [200, { conversations: items.slice(0, 2), has_more: items.length > 2, next_cursor: items.length > 2 ? 'page2' : null }];
      return [200, { conversations: items.slice(2), has_more: false, next_cursor: null }];
    }],
    ['GET', /^\/v1\/convai\/conversations\/([^/]+)$/, m => {
      const c = fixture.conversations.find(x => x.list.conversation_id === m[1]);
      return c ? [200, c.detail] : [404, { detail: 'not found' }];
    }],
    ['GET', /^\/v1\/convai\/tools$/, () => [200, { tools: state.tools, has_more: false, next_cursor: null }]],
    ['GET', /^\/v1\/convai\/agents\/([^/]+)$/, () => [200, state.agent]],
    ['PATCH', /^\/v1\/convai\/agents\/([^/]+)$/, (m, q, body) => {
      /* the reference does not say whether platform_settings merges
       * into what the agent has or replaces it; replacing is the case
       * that would hurt, so it is the one the mock models — a configure
       * that sent its three keys alone would lose the agent's auth here */
      if (body.platform_settings) state.agent.platform_settings = body.platform_settings;
      if (body.conversation_config) state.agent.conversation_config = deepMerge(state.agent.conversation_config, body.conversation_config);
      return [200, state.agent];
    }],
    ['POST', /^\/v1\/convai\/agents\/([^/]+)\/branches$/, (m, q, body) => {
      if (!body.parent_version_id || !body.name || body.description == null) return [422, { detail: [{ loc: ['body'], msg: 'parent_version_id, name and description are required', type: 'value_error' }] }];
      state.branches.push(body);
      return [200, { created_branch_id: 'branch_loop1', created_version_id: 'agtvrsn_b1' }];
    }],
    ['POST', /^\/v1\/convai\/agents\/([^/]+)\/branches\/([^/]+)\/merge$/, (m, q, body) => {
      if (!q.target_branch_id) return [422, { detail: [{ loc: ['query', 'target_branch_id'], msg: 'field required', type: 'value_error.missing' }] }];
      state.merges.push({ source: m[2], target: q.target_branch_id, body });
      return [200, {}];
    }],
    /* ---------- Supabase REST ---------- */
    ['GET', /^\/rest\/v1\/messages$/, (m, q) => {
      let rows = state.messages;
      if (q.conversation_id === 'not.is.null') rows = rows.filter(r => r.conversation_id != null);
      return [200, rows];
    }],
    ['PATCH', /^\/rest\/v1\/messages$/, (m, q, body) => {
      const id = String(q.id || '').replace(/^eq\./, '');
      const row = state.messages.find(r => r.id === id);
      if (!row) return [200, []];
      Object.assign(row, body);
      return [200, [row]];
    }],
    ['GET', /^\/rest\/v1\/scenarios$/, () => [200, fixture.scenarios]],
    ['GET', /^\/rest\/v1\/agent_runs$/, () => (state.agentRunsTable ? [200, state.agentRuns] : noTable())],
    /* an insert the way PostgREST answers one: 201, the stored rows
     * (id and created_at filled in) only when the Prefer header asked
     * for the representation — a loop that forgot it would get nothing
     * back and not know its row's id */
    ['POST', /^\/rest\/v1\/agent_runs$/, (m, q, body, headers) => {
      if (!state.agentRunsTable) return noTable();
      const rows = (Array.isArray(body) ? body : [body]).map(r => ({
        id: `00000000-0000-4000-8000-${String(state.agentRuns.length + 1).padStart(12, '0')}`,
        ...r, created_at: new Date().toISOString(),
      }));
      state.agentRuns.push(...rows);
      return [201, /return=representation/.test(String(headers.prefer || '')) ? rows : []];
    }],
    /* ---------- the proposer ---------- */
    ['POST', /^\/v1\/chat\/completions$/, (m, q, body) => {
      const reply = typeof state.openaiReply === 'function' ? state.openaiReply(body) : state.openaiReply;
      return [200, { id: 'chatcmpl_1', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(reply) }, finish_reason: state.openaiFinish }] }];
    }],
  ];

  const noTable = () => [404, { code: 'PGRST205', details: null, hint: "Perhaps you meant the table 'public.runs'", message: "Could not find the table 'public.agent_runs' in the schema cache" }];

  function pendingRuns() {
    const runs = [];
    const inv = state.invocation;
    (inv ? inv.tests : []).forEach(t => {
      for (let i = 0; i < inv.repeat_count; i++) runs.push({ test_run_id: `run_${t.test_id}_${i}`, test_invocation_id: 'inv_1', agent_id: inv.agent_id, status: 'pending', test_id: t.test_id });
    });
    return runs;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const q = Object.fromEntries(url.searchParams.entries());
      let body = null;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) { try { body = JSON.parse(text); } catch { body = text; } }
      mock.requests.push({
        method: req.method, path: url.pathname, query: q, body,
        auth: { xi: !!req.headers['xi-api-key'], apikey: !!req.headers.apikey, bearer: /^Bearer /.test(String(req.headers.authorization || '')) },
        prefer: req.headers.prefer || null,
      });
      if (state.failNext) { const s = state.failNext; state.failNext = null; return json(res, s, { detail: `forced ${s}` }); }
      /* what a real request needs: the key header for ElevenLabs, the
       * apikey for Supabase, a bearer for the proposer */
      if (url.pathname.startsWith('/v1/convai/') && !req.headers['xi-api-key']) return json(res, 401, { detail: { status: 'invalid_api_key', message: 'missing xi-api-key' } });
      if (url.pathname.startsWith('/rest/v1/') && !req.headers.apikey) return json(res, 401, { message: 'No API key found in request' });
      if (url.pathname === '/v1/chat/completions' && !/^Bearer /.test(String(req.headers.authorization || ''))) return json(res, 401, { error: { message: 'missing bearer' } });
      for (const [method, re, handler] of routes) {
        const m = method === req.method && re.exec(url.pathname);
        if (m) { const [status, out] = handler(m, q, body, req.headers); return json(res, status, out); }
      }
      json(res, 404, { detail: `no mock route for ${req.method} ${url.pathname}` });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  mock.url = `http://127.0.0.1:${server.address().port}`;
  mock.close = () => new Promise(r => server.close(r));
  return mock;
}
