// Regression tests. Loads the existing TypeScript unchanged; all external
// services and credentials are fake. Does not start the app or modify its data.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = process.env.TIDY_TEST_ROOT || path.resolve(__dirname, '..');
const projectRequire = createRequire(path.join(root, 'package.json'));
const ts = projectRequire('typescript');
const { test } = require('node:test');
function loader(mocks = {}, env = {}) {
  const cache = new Map();
  const context = vm.createContext({
    console,
    Request,
    Response,
    Headers,
    URL,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    AbortSignal,
    AbortController,
    structuredClone,
    setTimeout,
    clearTimeout,
    Buffer,
    crypto: require('node:crypto').webcrypto,
    process: { env: { NEXT_PUBLIC_WORKOS_REDIRECT_URI: 'http://localhost:3000/callback', ...env } },
    fetch: async () => {
      throw new Error('Unexpected network request');
    },
  });
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} };
    cache.set(absolute, mod);
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    function req(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      // Next resolves `server-only` itself; outside Next it is a no-op marker.
      if (name === 'server-only') return {};
      if (name.startsWith('@/') || name.startsWith('.')) {
        let target = name.startsWith('@/')
          ? path.join(root, name.slice(2))
          : path.resolve(path.dirname(absolute), name);
        if (!/\.tsx?$/.test(target)) target += '.ts';
        return load(target);
      }
      return projectRequire(name);
    }
    vm.runInContext(`(function(require,module,exports){${source}\n})`, context, { filename: absolute })(
      req,
      mod,
      mod.exports,
    );
    return mod.exports;
  }
  return { load, context };
}
const credential = {
  accessToken: 'FAKE_AGENT_TOKEN',
  sessionId: 'fake_session',
  agentInstanceId: 'fake_agent',
  permissions: ['customers:read', 'customers:archive'],
};
const rows = [
  { id: 'customer_0001', status: 'active' },
  { id: 'customer_0002', status: 'active' },
];
const ok = data => ({ ok: true, status: 200, data, raw: JSON.stringify(data) });
const denied = {
  ok: false,
  status: 403,
  data: { missingPermission: 'customers:delete', grantedPermissions: credential.permissions },
  raw: '{"missingPermission":"customers:delete"}',
};
const call = (name, args) => ({ functionCalls: [{ name, args }] });
function gemini(responses, http) {
  const events = [],
    requests = [],
    apiCalls = [];
  const l = loader({
    '@google/genai': {
      GoogleGenAI: class {
        models = {
          generateContent: async request => {
            requests.push(JSON.parse(JSON.stringify(request)));
            const response = responses.shift();
            if (response instanceof Error) throw response;
            if (!response) throw new Error('No more fake responses');
            return response;
          },
        };
      },
    },
    '@/lib/agent-events': { revokedReply: () => 'Revoked; stopped.' },
    '@/lib/agent-http': {
      agentCall: async (...args) => {
        apiCalls.push(args);
        return http(...args);
      },
    },
  });
  return {
    ...l,
    events,
    requests,
    apiCalls,
    run: signal =>
      l
        .load('lib/gemini-agent.ts')
        .runGeminiAgent(
          'http://localhost:3000',
          credential,
          'Clean up stale customers',
          event => events.push(event),
          'FAKE_MODEL_KEY',
          signal,
        ),
  };
}

const finalReply = { candidates: [{ content: { parts: [{ text: 'Finished.' }] } }] };
(async () => {
  await test('403 stops the same batch before an alternative mutation', async () => {
    const g = gemini(
      [
        {
          functionCalls: [
            { name: 'delete_customer', args: { customer_id: 'customer_0001' } },
            { name: 'archive_customers', args: { inactive_days: 730 } },
          ],
        },
      ],
      async () => denied,
    );
    await g.run();
    assert.equal(g.apiCalls.length, 1);
    assert.equal(g.events.at(-1).outcome, 'denied');
  });
  for (const value of [undefined, null, false, true, '', ' ', '730', -1, 1.5, 36501]) {
    await test('Reject invalid inactive_days: ' + String(value), async () => {
      const g = gemini([call('archive_customers', { inactive_days: value })], async () => {
        throw new Error('Must not call API');
      });
      await g.run();
      assert.equal(g.apiCalls.length, 0);
      assert.equal(g.events.find(e => e.type === 'tool_result').status, 400);
      assert.equal(g.events.at(-1).outcome, 'error');
    });
  }
  await test('Valid archive changes exactly 402 stale rows in the real store', async () => {
    let store;
    const g = gemini(
      [call('archive_customers', { inactive_days: 730 }), finalReply],
      async (_o, _t, route, data) =>
        route.includes('/archive')
          ? ok(
              store.changeCustomers(data.ids, 'archive', {
                kind: 'agent',
                label: 'Tidy',
                onBehalfOf: 'Test',
                agentId: 'agent_1',
                userId: 'user_1',
                sessionId: 'session_1',
              }),
            )
          : ok(
              store.listCustomers(
                Number(new URL('http://localhost:3000' + route).searchParams.get('inactiveDays')),
              ),
            ),
    );
    store = g.load('lib/store.ts');
    store.resetCustomers();
    await g.run();
    assert.equal(store.listCustomers().archived, 402);
    assert.equal(g.events.at(-1).outcome, 'archived');
    const log = store.activityLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].actor.agentId, 'agent_1');
    assert.equal(log[0].actor.userId, 'user_1');
    assert(log[0].at);
  });
  await test('401 stops queued tools and model turns', async () => {
    const g = gemini(
      [
        {
          functionCalls: [
            { name: 'list_customers', args: { inactive_days: 730 } },
            { name: 'archive_customers', args: { inactive_days: 730 } },
          ],
        },
      ],
      async () => ({ ok: false, status: 401, data: {}, raw: '{}' }),
    );
    await g.run();
    assert.equal(g.apiCalls.length, 1);
    assert.equal(g.requests.length, 1);
    assert.equal(g.events.at(-1).outcome, 'revoked');
  });
  await test('503 is an error and stops execution', async () => {
    const g = gemini([call('list_customers', { inactive_days: 730 })], async () => ({
      ok: false,
      status: 503,
      data: {},
      raw: '{}',
    }));
    await g.run();
    assert.equal(g.events.at(-1).outcome, 'error');
    assert.equal(g.requests.length, 1);
  });
  await test('Eight-tool cap', async () => {
    const g = gemini(
      Array.from({ length: 9 }, () => call('list_customers', { inactive_days: 730 })),
      async () => ok({ customers: rows }),
    );
    await g.run();
    assert.equal(g.apiCalls.length, 8);
    assert.equal(g.events.at(-1).outcome, 'limit');
  });
  await test('Credentials stay out of model context', async () => {
    const g = gemini([call('delete_customer', { customer_id: 'customer_0001' })], async () => denied);
    await g.run();
    const sent = JSON.stringify(g.requests);
    assert(!sent.includes('FAKE_AGENT_TOKEN'));
    assert(!sent.includes('FAKE_MODEL_KEY'));
  });
  await test('Abort prevents queued mutations', async () => {
    const aborter = new AbortController();
    const g = gemini(
      [
        {
          functionCalls: [
            { name: 'list_customers', args: { inactive_days: 730 } },
            { name: 'archive_customers', args: { inactive_days: 730 } },
          ],
        },
      ],
      async () => {
        aborter.abort();
        return ok({ customers: rows });
      },
    );
    await assert.rejects(g.run(aborter.signal));
    assert.equal(g.apiCalls.length, 1);
  });
  await test('Fallback is described without revealing keys', async () => {
    const l = loader();
    const mode = l.load('lib/agent-mode.ts').agentMode();
    assert.equal(mode.mode, 'scripted');
    assert.match(mode.label, /no LLM/);
    assert.match(mode.note, /isn.t connected/);
    const configured = loader({}, { GEMINI_API_KEY: 'fake_secret' }).load('lib/agent-mode.ts').agentMode();
    assert.equal(configured.mode, 'gemini');
    assert(!JSON.stringify(configured).includes('fake_secret'));
  });
  await test('Token expiry retains backing-session management handle', async () => {
    const l = loader();
    const s = l.load('lib/demo-sessions.ts');
    const h = s.saveSession('test', 'Test', { ...credential, expiresIn: -1 }, Date.now() + 60000);
    s.prune();
    assert(s.sessions.has(h));
  });
  await test('Per-owner lock rejects a concurrent mint and then releases', async () => {
    const l = loader();
    const { withMintLock } = l.load('lib/demo-sessions.ts');
    let release;
    const first = withMintLock(
      'test',
      () =>
        new Promise(r => {
          release = r;
        }),
    );
    await assert.rejects(
      withMintLock('test', async () => {}),
      /already being started/,
    );
    release();
    await first;
    await withMintLock('test', async () => {});
  });
  await test('Busy agent can be revoked; runner is aborted without unlocking it early', async () => {
    const controller = new AbortController();
    const session = {
      busy: true,
      revoking: false,
      revoked: false,
      parent: credential,
      observations: [],
      controller,
    };
    let revoked = false;
    const l = loader({
      'next/headers': { headers: async () => new Headers() },
      '@workos-inc/authkit-nextjs': {
        withAuth: async () => ({ user: { id: 'test' }, accessToken: 'fake_human' }),
      },
      '@/lib/require-permission': { requirePermission: async () => ({ kind: 'human' }) },
      '@/lib/agent-auth': {
        revoke: async () => {
          revoked = true;
        },
        verifyAgentJwt: async () => ({}),
        getSession: async () => ({ status: 'revoked', revokedAt: 'now' }),
      },
      '@/lib/demo-sessions': { ownedSession: () => session },
      '@/lib/agent-http': { agentCall: async () => ({ ok: false, status: 401, raw: '{}', data: {} }) },
    });
    const result = await l.load('app/actions/demo.ts').revokeTidy('fake');
    assert(!result.error);
    assert(revoked);
    assert(controller.signal.aborted);
    assert(session.busy);
    assert(!session.revoking);
    assert(session.revoked);
  });
  await test('Reset is blocked while any agent runs', async () => {
    const l = loader();
    const s = l.load('lib/demo-sessions.ts');
    const h = s.saveSession('test', 'Test', { ...credential, expiresIn: 600 });
    s.sessions.get(h).busy = true;
    assert.throws(() => s.assertNoRunningAgent(), /before resetting/);
    s.sessions.get(h).busy = false;
    s.assertNoRunningAgent();
  });
  await test('Truncated stream is rejected; complete event without newline is accepted', async () => {
    const { readAgentEvents } = loader().load('lib/agent-stream.ts');
    const stream = text =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
    await assert.rejects(
      readAgentEvents(stream('{"type":"assistant","text":"hello"}\n'), () => {}),
      /interrupted/,
    );
    let completed = false;
    await readAgentEvents(stream('{"type":"done","outcome":"nothing"}'), () => {
      completed = true;
    });
    assert(completed);
  });
  await test('Bearer credentials never fall back to human cookies', async () => {
    let reads = 0;
    const l = loader({
      '@workos-inc/authkit-nextjs': {
        withAuth: async () => {
          reads++;
          return {};
        },
      },
      '@/lib/agent-auth': {},
    });
    await assert.rejects(
      l
        .load('lib/require-permission.ts')
        .requirePermission(
          'customers:read',
          new Request('http://localhost:3000/api/customers', { headers: { authorization: 'Basic invalid' } }),
        ),
      e => e.status === 401,
    );
    assert.equal(reads, 0);
  });
  await test('Unknown customer in batch prevents all changes', async () => {
    const s = loader().load('lib/store.ts');
    s.resetCustomers();
    assert.equal(
      s.changeCustomers(['customer_0001', 'customer_9999'], 'delete', { kind: 'human', label: 'Test' }),
      null,
    );
    assert.equal(s.listCustomers().total, 1206);
  });
  await test('Re-archiving keeps the original attribution and logs nothing', async () => {
    const s = loader().load('lib/store.ts');
    s.resetCustomers();
    s.changeCustomers(['customer_0001'], 'archive', { kind: 'agent', label: 'Tidy', onBehalfOf: 'First' });
    const again = s.changeCustomers(['customer_0001'], 'archive', {
      kind: 'agent',
      label: 'Tidy',
      onBehalfOf: 'Second',
    });
    assert.equal(again.count, 0);
    assert.equal(s.activityLog().length, 1);
    assert.equal(
      s.listCustomers().customers.find(row => row.id === 'customer_0001').changedBy,
      'Tidy (agent) for First',
    );
  });
  await test('Error bodies keep only well-typed fields', async () => {
    const { errorBody, errorMessage } = loader().load('lib/api-body.ts');
    // Compared as JSON: the module runs in its own vm context, so its objects have a different prototype.
    assert.equal(
      JSON.stringify(
        errorBody({
          error: 'Denied',
          missingPermission: 7,
          grantedPermissions: ['customers:read', 1],
          extra: true,
        }),
      ),
      JSON.stringify({ error: 'Denied', grantedPermissions: ['customers:read'] }),
    );
    assert.equal(JSON.stringify(errorBody('<html>')), '{}');
    assert.equal(errorMessage(null, 'HTTP 502'), 'HTTP 502');
  });
})();
