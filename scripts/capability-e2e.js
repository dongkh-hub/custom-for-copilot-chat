/**
 * End-to-end check of the learned-capability layer (run `npm run e2e`).
 *
 * A real HTTP server plays the gateway: it 400s `reasoning_effort: medium`
 * (once with a field-naming body, once with a generic one). The COMPILED
 * provider is loaded against a minimal `vscode` stub, so this exercises the
 * actual request path — the probe, the attribution, the learned substitution
 * on the next message, and the gear-panel note.
 *
 * Needs `out/` to be current: `npm run e2e` compiles first.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const assert = require('assert');

// The provider narrates every stage through console.log. Keep `npm run verify`
// readable; CAP_E2E_VERBOSE=1 shows the same lines for debugging.
const realLog = console.log;
if (!process.env.CAP_E2E_VERBOSE) {
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[CustomModel]')) {
      return;
    }
    realLog(...args);
  };
}

const ROOT = path.join(__dirname, '..');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? 'vscode-stub' : origResolve.call(this, request, ...rest);
};

class LanguageModelTextPart {
  constructor(value) { this.value = value; }
}
class LanguageModelDataPart {
  constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; }
}
class LanguageModelToolCallPart {
  constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; }
}
class LanguageModelToolResultPart {
  constructor(callId, content) { this.callId = callId; this.content = content; }
}
const settings = {};
const secrets = new Map();
const secretStorage = {
  get: async (k) => secrets.get(k),
  store: async (k, v) => { secrets.set(k, v); },
  delete: async (k) => { secrets.delete(k); },
  onDidChange: () => ({ dispose() {} }),
};
let captured;
const vscodeStub = {
  version: '1.999.0-e2e',
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelChatToolMode: { Auto: 0, Required: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ThemeIcon: class {},
  LanguageModelError: class extends Error {
    static NoPermissions(m) { return new Error(m); }
    static NotFound(m) { return new Error(m); }
  },
  EventEmitter: class {
    constructor() {
      this.listeners = new Set();
      this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
    }
    fire() { for (const fn of this.listeners) fn(); }
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, append() {} }),
    showInformationMessage: () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k in settings ? settings[k] : d),
      update: async (k, v) => { settings[k] = v; },
      inspect: () => ({}),
    }),
  },
  l10n: { t: (m, ...a) => m.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)] ?? '')) },
  lm: { registerLanguageModelChatProvider: (_vendor, provider) => { captured = provider; return { dispose() {} }; } },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

const seen = [];
// Authorization header per request — a keyless gateway must receive NONE.
const authSeen = [];
let genericBody = false;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push(body.reasoning_effort);
    authSeen.push(req.headers.authorization ?? null);
    const refuses = genericBody
      ? body.reasoning_effort !== undefined
      : body.reasoning_effort === 'medium';
    if (refuses) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: genericBody
            ? 'the request was rejected by an internal gateway component, please check the request body'
            : 'Invalid reasoning_effort: must be one of low, high, max',
        },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"id":"x","choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.write('data: {"id":"x","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-e2e-'));

  const store = require(`${ROOT}/out/profileStore.js`);
  const cap = require(`${ROOT}/out/modelCapability.js`);
  const cfg = require(`${ROOT}/out/config.js`);
  const providerMod = require(`${ROOT}/out/provider.js`);

  const context = { secrets: secretStorage, globalStorageUri: { fsPath: tmp }, subscriptions: [] };
  await store.initProfileStore(context);
  await cap.initCapabilityStore(context);
  const baseURL = `http://127.0.0.1:${port}/v1`;
  await store.writeProfiles([
    { key: 'p1', name: '本地测试', baseURL, model: 'm1', maxInputTokens: 0, maxOutputTokens: 0 },
  ]);
  secrets.set(cfg.apiKeySecretKey('p1'), 'sk-test');
  providerMod.registerModelProvider(context);

  const messages = [{ role: 1, content: [new LanguageModelTextPart('hi')] }];
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const ask = async (effort) => {
    const parts = [];
    await captured.provideLanguageModelChatResponse(
      { id: 'p1::m1' },
      messages,
      { modelOptions: { reasoningEffort: effort }, tools: [] },
      { report: (part) => parts.push(part) },
      token
    );
    return parts;
  };

  // 1) First attempt with `medium`: 400 → probe without it → learned.
  await ask('medium');
  assert.deepStrictEqual(seen, ['medium', undefined], `expected medium then a probe without it, got ${JSON.stringify(seen)}`);
  assert.strictEqual(cap.effortVerdict(baseURL, 'm1', 'medium'), 'rejected', 'refusal remembered');
  assert.deepStrictEqual(cap.parseSupportedFromDetail(
    'Invalid reasoning_effort: must be one of low, high, max', 'medium'
  ), ['low', 'high', 'max'], 'enumerated set learned from the same error');
  console.log('PASS 1 — first failure probed, remembered:', cap.describeVerdict(baseURL, 'm1'));

  // 2) Second attempt: the learned value is replaced BEFORE the request.
  seen.length = 0;
  await ask('medium');
  assert.deepStrictEqual(seen, ['high'], `second attempt must send the fallback, got ${JSON.stringify(seen)}`);
  console.log('PASS 2 — second attempt never re-probed, sent:', seen[0]);

  // 3) The gear panel annotates the refused position instead of hiding it.
  const infos = await captured.provideLanguageModelChatInformation({}, token);
  const schema = infos[0].configurationSchema.properties.reasoningEffort;
  const mediumIndex = schema.enum.indexOf('medium');
  assert.ok(mediumIndex >= 0, 'refused value stays in the enum');
  assert.ok(/refused/i.test(schema.enumDescriptions[mediumIndex]), `description: ${schema.enumDescriptions[mediumIndex]}`);
  assert.ok(/"high"/.test(schema.enumDescriptions[mediumIndex]), 'description names the substitute');
  console.log('PASS 3 — panel note:', schema.enumDescriptions[mediumIndex]);

  // 4) A value the enumeration rejected is also skipped without a round-trip.
  seen.length = 0;
  await ask('none');
  assert.deepStrictEqual(seen, ['high'], `none was never tried, got ${JSON.stringify(seen)}`);
  console.log('PASS 4 — enumerated-but-missing value skipped, sent:', seen[0]);

  // 5) A GENERIC error body (no field named) is still attributable: the probe
  //    differs by one parameter, so the conclusion holds without the body's
  //    cooperation — it just cannot enumerate the accepted set.
  await store.writeProfiles([
    { key: 'p1', name: '本地测试', baseURL, model: 'm1', maxInputTokens: 0, maxOutputTokens: 0 },
    { key: 'p2', name: '通用错误', baseURL, model: 'm2', maxInputTokens: 0, maxOutputTokens: 0 },
  ]);
  secrets.set(cfg.apiKeySecretKey('p2'), 'sk-test');
  genericBody = true;
  seen.length = 0;
  await captured.provideLanguageModelChatResponse(
    { id: 'p2::m2' },
    messages,
    { modelOptions: { reasoningEffort: 'low' }, tools: [] },
    { report: () => undefined },
    token
  );
  assert.deepStrictEqual(seen, ['low', undefined], `generic body: probe still fires, got ${JSON.stringify(seen)}`);
  assert.strictEqual(cap.effortVerdict(baseURL, 'm2', 'low'), 'rejected', 'learned from a generic body');
  assert.strictEqual(
    cap.describeVerdict(baseURL, 'm2'),
    `127.0.0.1:${port}/v1: m2 → rejected=low`,
    'no accepted set is invented'
  );
  console.log('PASS 5 — generic body, no invented accepted set:', cap.describeVerdict(baseURL, 'm2'));


  // 6) A KEYLESS endpoint: no secret stored, `noAuth` set, and the request must
  //    carry no Authorization header at all — a bare `Bearer ` is rejected by
  //    proxies that treat the header's presence as a credential.
  await store.writeProfiles([
    { key: 'p3', name: '本地无鉴权', baseURL, model: 'm3', noAuth: true, maxInputTokens: 0, maxOutputTokens: 0 },
  ]);
  authSeen.length = 0;
  await captured.provideLanguageModelChatResponse(
    { id: 'p3::m3' },
    messages,
    { modelOptions: { reasoningEffort: 'auto' }, tools: [] },
    { report: () => undefined },
    token
  );
  assert.deepStrictEqual(authSeen, [null], `keyless request must send no Authorization header, got ${JSON.stringify(authSeen)}`);
  const keyless = (await captured.provideLanguageModelChatInformation({}, token))[0];
  assert.strictEqual(keyless.statusIcon, undefined, 'keyless endpoint is configured, not flagged');
  console.log('PASS 6 — keyless endpoint served with no Authorization header');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('E2E OK');
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
