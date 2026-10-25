/**
 * Smoke test: load the compiled modules against a minimal `vscode` stub and
 * exercise the pure logic (SSE parsing, message conversion, 400-parameter
 * dropping, request classification). Run: node scripts/smoke.js
 */

const stubParts = [];
class LanguageModelTextPart {
  constructor(value) { this.value = value; }
}
class LanguageModelToolCallPart {
  constructor(id, name, input) { this.callId = id; this.name = name; this.input = input; }
}
class LanguageModelDataPart {
  constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; }
}
class LanguageModelToolResultPart {
  constructor(callId, content) { this.callId = callId; this.content = content; }
}
// Mutable settings behind the `vscode.workspace.getConfiguration` stub (the
// model-list mirror writes land here).
const settings = {};
// Application-scoped secret store behind `context.secrets` — the profile
// store's real source of truth (and what every VS Code profile shares).
const secrets = new Map();
const secretListeners = new Set();
const secretStorage = {
  get: async (key) => secrets.get(key),
  store: async (key, value) => {
    secrets.set(key, value);
  },
  delete: async (key) => {
    secrets.delete(key);
  },
  onDidChange: (listener) => {
    secretListeners.add(listener);
    return { dispose: () => secretListeners.delete(listener) };
  },
};
const extensionContext = { secrets: secretStorage };
const vscodeStub = {
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelDataPart,
  LanguageModelToolResultPart,
  LanguageModelChatToolMode: { Auto: 0, Required: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ThemeIcon: class {},
  LanguageModelError: class extends Error {
    static NoPermissions(m) { return new LanguageModelError(m); }
    static NotFound(m) { return new LanguageModelError(m); }
  },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
  window: {
    createOutputChannel: () => ({ appendLine() {} }),
    showInformationMessage: () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k in settings ? settings[k] : d),
      // Writes land back in `settings`, so the read-modify-write paths
      // (upsertProfile, limit overrides) can be verified end to end.
      update: async (k, v) => {
        settings[k] = v;
      },
      inspect: () => ({}),
    }),
  },
  l10n: {
    t: (msg, ...args) => msg.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')),
  },
  lm: {},
};
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return 'vscode-stub';
  }
  return originalResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

const assert = require('assert');
const { convertMessage, dropRejectedParams, estimatePromptTokens, buildRequestBody, readThinkingEffortChoice, readModelLimitOverrides, applyLimitOverrides, applyCompatibilityFallback, bodyDigest } = require('../out/message.js');
const {
  resolveThinkingEffort,
  detectModelPreset,
  resolveProfileEntry,
  CONTEXT_WINDOW_TIERS,
  contextTierOptions,
  defaultContextTier,
  realInputCeiling,
  summaryInputTokens,
  summaryWindowLabel,
  tokenWindowLabel,
} = require('../out/config.js');
const { streamSseToProgress } = require('../out/stream.js');
const { classifyRequestShape } = require('../out/requestKind.js');
const { usageDataPart } = require('../out/stream.js');
const { createPreflightToolCallId, filterPreflightControlFlow, inspectActivatePreflight } = require('../out/toolPreflight.js');

// --- convertMessage: tool calls + tool results split into role:tool entries ---
const toolCallMsg = {
  role: 2, // Assistant
  content: [
    new LanguageModelTextPart('checking'),
    new LanguageModelToolCallPart('call_1', 'get_weather', { city: 'sf' }),
  ],
};
const toolResultMsg = {
  role: 1, // User
  content: [new LanguageModelToolResultPart('call_1', [new LanguageModelTextPart('sunny')])],
};
let out = convertMessage(toolCallMsg).concat(convertMessage(toolResultMsg));
// The tool entry must follow the assistant turn DIRECTLY: an empty `user`
// turn wedged between assistant(tool_calls) and tool(result) is what strict
// gateways reject with a generic HTTP 400.
assert.strictEqual(out.length, 2, `shape: ${out.map((m) => m.role).join(',')}`);
assert.strictEqual(out[0].role, 'assistant');
assert.strictEqual(out[0].tool_calls[0].function.name, 'get_weather');
assert.strictEqual(out[0].tool_calls[0].function.arguments, '{"city":"sf"}');
assert.strictEqual(out[1].role, 'tool');
assert.strictEqual(out[1].tool_call_id, 'call_1');
assert.strictEqual(out[1].content, 'sunny');

// A user message that carries BOTH a tool result and text: the result first,
// the user's own words after it (never the other way round).
const mixed = convertMessage({
  role: 1,
  content: [new LanguageModelTextPart('and now?'), new LanguageModelToolResultPart('call_2', [new LanguageModelTextPart('42')])],
});
assert.deepStrictEqual(mixed.map((m) => m.role), ['tool', 'user']);
assert.strictEqual(mixed[1].content, 'and now?');

// A user message with nothing in it emits NOTHING (no empty content).
assert.deepStrictEqual(convertMessage({ role: 1, content: [] }), []);
// An assistant turn with neither text nor tool calls emits nothing either.
assert.deepStrictEqual(convertMessage({ role: 2, content: [] }), []);

// --- classifyRequestShape: title helper vs main agent ---
assert.strictEqual(classifyRequestShape({ firstText: 'You are an expert in crafting pithy titles for chats', latestUserText: 'hi', toolNames: [] }), 'chat-title');
assert.strictEqual(classifyRequestShape({ firstText: 'You are an expert AI programming assistant', latestUserText: 'fix this', toolNames: ['a', 'b'] }), 'main-agent');
assert.strictEqual(classifyRequestShape({ firstText: '', latestUserText: '[Terminal bash notification: exit code 0]', toolNames: [] }), 'terminal-steering');

// --- dropRejectedParams: strips named optional params + stray reasoning_content ---
const body = {
  stream_options: { include_usage: true },
  max_tokens: 2048,
  tool_choice: 'auto',
  messages: [{ role: 'user', content: 'x', reasoning_content: 'chain' }],
};
const dropped = dropRejectedParams(body, 'error: unknown field stream_options and reasoning_content is not allowed');
assert.ok(dropped.includes('stream_options'));
assert.ok(dropped.includes('reasoning_content'));
assert.ok(!('stream_options' in body));
assert.ok(!('reasoning_content' in body.messages[0]));
assert.ok('tool_choice' in body, 'tool_choice untouched (not named by gateway)');

// --- compatibility ladder: a GENERIC 400 still recovers (no field names) ---
const generic = '{"error":{"code":"400001","message":"The request is invalid: the request was rejected by an internal gateway component."}}';
const ladderBody = {
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }], reasoning_content: 'chain' },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'user', content: '' },
  ],
  stream: true,
  stream_options: { include_usage: true },
  tools: [{ type: 'function', function: { name: 'f' } }],
  tool_choice: 'auto',
  max_tokens: 32768,
};
const level1 = applyCompatibilityFallback(ladderBody, 1, generic);
assert.deepStrictEqual(level1, [], 'nothing named → level 1 cannot help');
const level2 = applyCompatibilityFallback(ladderBody, 2, generic);
assert.ok(level2.includes('reasoning_content'), `level 2 drops the thinking replay: ${level2}`);
assert.ok(!('reasoning_content' in ladderBody.messages[1]));
assert.ok(!('stream_options' in ladderBody));
const level3 = applyCompatibilityFallback(ladderBody, 3, generic);
assert.ok(level3.includes('max_tokens') && level3.includes('tool_choice'), `level 3: ${level3}`);
assert.ok(level3.includes('empty messages'), 'empty user turn removed');
assert.strictEqual(ladderBody.messages.length, 3);
const level4 = applyCompatibilityFallback(ladderBody, 4, generic);
assert.deepStrictEqual(level4, ['tools']);
assert.deepStrictEqual(applyCompatibilityFallback(ladderBody, 4, generic), [], 'ladder is exhausted');

// Digest is content-free and flags what a validator would complain about.
assert.strictEqual(
  bodyDigest({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: '' }, { role: 'assistant', content: null, tool_calls: [{}, {}], reasoning_content: 'r' }] }),
  '3[system,user(empty),assistant(empty,tools:2,think)]'
);

// --- SSE stream: text + tool-call fragments + terminal usage ---
function sseResponse(lines) {
  const chunks = lines.map((l) => Buffer.from(l, 'utf8'));
  let i = 0;
  return {
    body: {
      getReader() {
        return {
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
          cancel: async () => {},
          releaseLock() {},
        };
      },
    },
  };
}
const events = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"get_","arguments":"{\\"ci"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"\\":\\"sf\\"}"}}]}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
  'data: [DONE]\n\n',
];
const reported = [];
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
streamSseToProgress(sseResponse(events).body, { report: (p) => reported.push(p) }, token).then((result) => {
  const texts = reported.filter((p) => p instanceof LanguageModelTextPart).map((p) => p.value).join('');
  assert.strictEqual(texts, 'Hel');
  const calls = reported.filter((p) => p instanceof LanguageModelToolCallPart);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'get_weather');
  assert.deepStrictEqual(calls[0].input, { ci: 'sf' });
  assert.strictEqual(result.usage.prompt_tokens, 10);
  const usage = usageDataPart(result.usage);
  assert.strictEqual(usage.mimeType, 'usage');
  assert.ok(usage.data.byteLength > 0);

  // --- preflight: one activator picked, control flow stripped afterwards ---
  const round1 = createPreflightToolCallId(1, 'activate_tools');
  const messages = [
    { role: 1, content: [new LanguageModelTextPart('do the thing')] },
    { role: 2, content: [new LanguageModelToolCallPart(round1, 'activate_tools', {})] },
  ];
  const pre = inspectActivatePreflight(messages, [{ name: 'activate_tools' }, { name: 'read_file' }]);
  assert.strictEqual(pre.rounds, 1);
  assert.deepStrictEqual(pre.calledActivatorNames, ['activate_tools']);
  const filtered = filterPreflightControlFlow(messages);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(estimatePromptTokens(messages) > 0, true);
  // --- thinking effort: gear resolution + what lands on the wire ---
  const entry = { id: 'm1', name: 'm1', maxInputTokens: 128000, maxOutputTokens: 16384 };
  assert.strictEqual(resolveThinkingEffort('high'), 'high');
  assert.strictEqual(resolveThinkingEffort('HIGH'), 'high', 'case-insensitive');
  assert.strictEqual(resolveThinkingEffort('nonsense'), 'auto', 'unknown id → the safe default');
  assert.strictEqual(resolveThinkingEffort(undefined), 'auto', 'older host → the safe default');
  assert.strictEqual(readThinkingEffortChoice({ modelOptions: { reasoningEffort: 'low' } }), 'low');
  assert.strictEqual(readThinkingEffortChoice({ modelConfiguration: { reasoningEffort: 'medium' } }), 'medium');
  assert.strictEqual(readThinkingEffortChoice({}), undefined);

  const noopOptions = { toolMode: undefined, tools: undefined };
  const bodyAuto = buildRequestBody(entry, 'auto', [{ role: 1, content: [new LanguageModelTextPart('hi')] }], noopOptions, 'main-agent', []);
  assert.strictEqual(bodyAuto.model, 'm1');
  assert.ok(!('reasoning_effort' in bodyAuto), 'auto sends no reasoning parameter at all');
  assert.ok(!('max_tokens' in bodyAuto), 'the main agent never clamps output');
  const bodyHigh = buildRequestBody(entry, 'high', [{ role: 1, content: [new LanguageModelTextPart('hi')] }], noopOptions, 'main-agent', []);
  assert.strictEqual(bodyHigh.reasoning_effort, 'high', 'the gear rides out verbatim');
  const bodyOff = buildRequestBody(entry, 'none', [{ role: 1, content: [new LanguageModelTextPart('hi')] }], noopOptions, 'main-agent', []);
  assert.strictEqual(bodyOff.reasoning_effort, 'none');
  // Helper requests never carry it: a chat title must not pay for chain-of-thought.
  const bodyTitle = buildRequestBody(entry, 'high', [{ role: 1, content: [new LanguageModelTextPart('hi')] }], noopOptions, 'chat-title', []);
  assert.ok(!('reasoning_effort' in bodyTitle), 'helper requests drop the effort');
  assert.strictEqual(bodyTitle.max_tokens, 2048, 'helper requests keep their own output cap');
  // A rejected `reasoning_effort` is strippable by name and by ladder level.
  const dropped = dropRejectedParams({ reasoning_effort: 'high' }, 'invalid reasoning_effort value');
  assert.deepStrictEqual(dropped, ['reasoning_effort']);

  // --- official presets: detection, override chain, defaults ---
  // NOTE: the preset REGEXES match real mainstream model ids (that is their
  // purpose); the preset ids/labels stay neutral, and docs never name vendors.
  assert.strictEqual(detectModelPreset('gpt-4.1-mini').id, 'alpha-4.1');
  assert.strictEqual(detectModelPreset('gpt-4.1-mini').maxInputTokens, 1047576);
  assert.strictEqual(detectModelPreset('gpt-4.1-mini').maxOutputTokens, 32768);
  assert.strictEqual(detectModelPreset('gpt-5.1').maxInputTokens, 272000);
  assert.strictEqual(detectModelPreset('gpt-5.1').maxOutputTokens, 128000);
  assert.strictEqual(detectModelPreset('gpt-4o').maxInputTokens, 128000);
  const betaThinking = detectModelPreset('deepseek-reasoner');
  assert.strictEqual(betaThinking.id, 'beta-thinking');
  assert.strictEqual(betaThinking.reasoning, true, 'reasoner routes to the thinking preset');
  assert.strictEqual(detectModelPreset('DeepSeek-V4.1-Flash-1017').id, 'beta-v4');
  assert.strictEqual(detectModelPreset('DeepSeek-V4.1-Flash-1017').reasoning, undefined);
  assert.strictEqual(detectModelPreset('glm-5.3').id, 'gamma-5');
  assert.strictEqual(detectModelPreset('glm-4.6').maxInputTokens, 200000);
  assert.strictEqual(detectModelPreset('obscure-model'), undefined, 'unknown id → no preset');

  // Resolution chain: explicit profile field > detected preset > default.
  const bareProfile = (model, maxInputTokens = 0, maxOutputTokens = 0) => ({
    key: 'p',
    name: '',
    baseURL: 'https://x.example/v1',
    model,
    maxInputTokens,
    maxOutputTokens,
  });
  const unknown = resolveProfileEntry(bareProfile('obscure-model'));
  assert.strictEqual(unknown.maxInputTokens, 1048576, 'unknown id → 1M default');
  assert.strictEqual(unknown.maxOutputTokens, 131072, 'unknown id → 128K default output');
  assert.strictEqual(unknown.reasoning, false);
  const explicit = resolveProfileEntry(bareProfile('gamma-5', 64000));
  assert.strictEqual(explicit.maxInputTokens, 64000, 'explicit profile limit wins over the preset');
  assert.strictEqual(explicit.maxOutputTokens, 131072, 'untouched field falls back to the preset');

  // --- panel limit overrides: read, apply, persist semantics ---
  // Read: three request-scoped sources, first hit wins; strings coerced.
  assert.deepStrictEqual(
    readModelLimitOverrides({ modelOptions: { maxInputTokens: 524288 }, configuration: { maxOutputTokens: 999 } }),
    { maxInputTokens: 524288, maxOutputTokens: 999 }
  );
  assert.deepStrictEqual(
    readModelLimitOverrides({ modelConfiguration: { maxInputTokens: '131072' } }),
    { maxInputTokens: 131072 }
  );
  // Cleared box arrives as Number("") === 0 — a clear signal, not a value.
  assert.deepStrictEqual(
    readModelLimitOverrides({ modelOptions: { maxInputTokens: 0 } }),
    { maxInputTokens: 0 }
  );
  assert.deepStrictEqual(readModelLimitOverrides({}), {});
  assert.deepStrictEqual(readModelLimitOverrides({ modelOptions: { maxInputTokens: '' } }), {});

  // The context-window dropdown is the SAME override as maxInputTokens, and it
  // wins when a stale stored maxInputTokens rides along with it.
  assert.deepStrictEqual(
    readModelLimitOverrides({ modelOptions: { contextSize: 262144 } }),
    { maxInputTokens: 262144 },
    'contextSize becomes the input budget'
  );
  assert.deepStrictEqual(
    readModelLimitOverrides({ modelOptions: { contextSize: '524288', maxInputTokens: 999 } }),
    { maxInputTokens: 524288 },
    'dropdown beats the raw field'
  );

  // Window rungs: ONE fixed ladder for every model, ASCENDING 64K up to 1M
  // (this is the order the gear panel renders). It does not depend on the
  // ceiling and does not collapse after a pick.
  const LADDER = [65536, 131072, 262144, 524288, 1048576];
  assert.deepStrictEqual(
    [...CONTEXT_WINDOW_TIERS],
    LADDER,
    'the ladder is declared ASCENDING — every index-based read depends on it'
  );
  const rungs = contextTierOptions(1048576);
  assert.deepStrictEqual(
    rungs.map((tier) => tier.tokens),
    LADDER,
    'every model offers the same ladder'
  );
  assert.strictEqual(rungs[0].label, '64K', '64K is the floor');
  assert.strictEqual(rungs[rungs.length - 1].label, '1M', '1M reads as 1M, not 1024K');
  assert.deepStrictEqual(
    contextTierOptions(131072).map((tier) => tier.tokens),
    LADDER,
    'a picked rung is a ladder member already — no duplicate, no collapse'
  );
  assert.deepStrictEqual(
    contextTierOptions(524288).map((tier) => tier.tokens),
    LADDER,
    'picking 512K keeps 1M reachable'
  );
  assert.ok(
    contextTierOptions(700000).some((tier) => tier.tokens === 700000),
    'a hand-set ceiling stays selectable (schema default must be in its own enum)'
  );
  assert.deepStrictEqual(
    contextTierOptions(700000).map((tier) => tier.tokens),
    [65536, 131072, 262144, 524288, 700000, 1048576],
    'the hand-set value is slotted into the ladder by value, not appended'
  );

  // The starting rung: the largest one that does not exceed the real window.
  assert.strictEqual(defaultContextTier(1048576), 1048576, '1M model starts at 1M');
  assert.strictEqual(defaultContextTier(1047576), 1048576, 'round preset figures fit the rung');
  assert.strictEqual(defaultContextTier(272000), 262144, '272K starts at 256K');
  assert.strictEqual(defaultContextTier(200000), 131072, '200K starts at 128K');
  assert.strictEqual(defaultContextTier(128000), 131072, '128K starts at 128K, not 64K');
  assert.strictEqual(defaultContextTier(32000), 65536, 'below the floor → the smallest rung');

  // Resolution snaps the preset window onto the ladder (hand-set values do not).
  assert.strictEqual(
    resolveProfileEntry(bareProfile('glm-4.6')).maxInputTokens,
    131072,
    '200K preset snaps down to the 128K rung'
  );
  assert.strictEqual(
    resolveProfileEntry(bareProfile('gpt-5.1')).maxInputTokens,
    262144,
    '272K preset snaps down to the 256K rung'
  );
  assert.strictEqual(
    resolveProfileEntry(bareProfile('glm-5')).maxInputTokens,
    1048576,
    '1M preset starts at 1M'
  );

  // Summaries show the REAL ceiling, not the rung — until the user sets one.
  assert.strictEqual(realInputCeiling('glm-4.6'), 200000, 'real ceiling is pre-ladder');
  assert.strictEqual(realInputCeiling('obscure-model'), 1048576, 'unknown id → 1M');
  assert.strictEqual(
    summaryInputTokens({ model: 'glm-4.6', maxInputTokens: 0 }),
    200000,
    'a 200K model is summarized as 200K, not as its 128K starting rung'
  );
  assert.strictEqual(
    summaryInputTokens({ model: 'glm-4.6', maxInputTokens: 65536 }),
    65536,
    'a picked rung is what the summary shows'
  );
  // Two notations on purpose: preset ceilings are decimal (a 200K window),
  // rungs are binary (131072 IS 128K).
  assert.strictEqual(summaryWindowLabel(200000), '200K', 'decimal — not 195K');
  assert.strictEqual(summaryWindowLabel(1048576), '1M');
  assert.strictEqual(tokenWindowLabel(131072), '128K', 'rungs stay binary');
  assert.strictEqual(tokenWindowLabel(1048576), '1M', '1M rung, not 1024K');

  // Apply: >0 replaces the field for THIS request; 0 keeps the resolved value.
  const gamma = resolveProfileEntry(bareProfile('glm-5'));
  const raised = applyLimitOverrides(gamma, { maxInputTokens: 524288 });
  assert.strictEqual(raised.maxInputTokens, 524288);
  assert.strictEqual(raised.maxOutputTokens, 131072, 'untouched field kept');
  const cleared = applyLimitOverrides(gamma, { maxInputTokens: 0 });
  assert.strictEqual(cleared.maxInputTokens, 1048576, 'clear keeps the resolved value');

  // --- reasoning replay: marker round-trip → reasoning_content on next turn ---
  const { createReasoningMarker, readReasoningMarker } = require('../out/replay.js');
  const marker = createReasoningMarker('thought #1');
  assert.ok(marker, 'marker created');
  assert.strictEqual(marker.mimeType, 'stateful_marker');
  assert.strictEqual(readReasoningMarker([marker]), 'thought #1');
  assert.strictEqual(readReasoningMarker([new LanguageModelTextPart('x')]), undefined);

  // A FOREIGN marker (another provider's writer id) must never be replayed.
  const foreign = new LanguageModelDataPart(
    Buffer.from('someone-else\\json:eyJyZWFzb25pbmciOnt9fQ', 'utf8'),
    'stateful_marker'
  );
  assert.strictEqual(readReasoningMarker([foreign]), undefined, 'foreign marker ignored');

  // convertMessage prefers the marker over (possibly missing) thinking parts,
  // so a tool-call turn keeps its reasoning after a window reload.
  const replayTurn = convertMessage({
    role: 2,
    content: [new LanguageModelToolCallPart('call_9', 'read_file', { p: 'a' }), marker],
  });
  assert.strictEqual(replayTurn.length, 1);
  assert.strictEqual(replayTurn[0].reasoning_content, 'thought #1');
  assert.strictEqual(replayTurn[0].content, '', 'empty content is "", never null');

  // --- SSE tail: last event has NO trailing blank line ---
  const tailEvents = [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
  ];
  return streamSseToProgress(sseResponse(tailEvents).body, { report() {} }, token).then(async (tail) => {
    assert.strictEqual(tail.usage.prompt_tokens, 7, 'unterminated tail event is consumed');

    // --- profile store: the list lives in the USER-LEVEL credential store ---
    const cfg = require('../out/config.js');
    const store = require('../out/profileStore.js');

    // Before init the store is not the source yet: reads are empty, so no
    // caller needs a "not initialized yet" branch.
    store.resetProfileStoreForTests();
    assert.deepStrictEqual(store.readProfiles(), [], 'empty list lists nothing');
    assert.strictEqual(store.firstProfile(), undefined, 'no first profile');
    assert.strictEqual(store.isProfileStoreReady(), false, 'store not initialized yet');

    // First activation on a clean machine writes the empty marker: "store
    // initialized" must stay distinguishable from "not read yet".
    await store.initProfileStore(extensionContext);
    assert.strictEqual(store.isProfileStoreReady(), true, 'store initialized');
    assert.strictEqual(secrets.get(store.PROFILES_SECRET_KEY), '[]', 'empty list marker written');

    // An external payload (another window's save) is adopted on reload.
    secrets.set(store.PROFILES_SECRET_KEY, JSON.stringify([
      { key: 'p1', name: 'my-gateway', baseURL: 'https://tokenhub.example.com/v1', model: 'deepseek-v4-pro-0813', maxInputTokens: 0, maxOutputTokens: 0 },
      { key: 'p2', name: '', baseURL: 'https://b.example/v1', model: 'deepseek-v4-pro-0813', maxInputTokens: 32000, maxOutputTokens: 0 },
    ]));
    assert.strictEqual(await store.reloadProfiles(), true, 'external payload adopted');
    assert.deepStrictEqual(store.readProfiles().map((p) => p.key), ['p1', 'p2'], 'rows parsed from the store');

    // One profile → preset detection applies (1M/128K tier).
    const one = store.readProfiles().slice(0, 1);
    const entry = cfg.resolveProfileEntry(one[0]);
    assert.strictEqual(entry.id, 'deepseek-v4-pro-0813');
    assert.strictEqual(entry.maxInputTokens, 1048576);
    assert.strictEqual(entry.maxOutputTokens, 131072);

    // Two profiles may serve the SAME upstream model — the picker ids must
    // still differ, or VS Code's id-indexed table drops one of them.
    assert.notStrictEqual(
      cfg.encodePickerId('p1', 'deepseek-v4-pro-0813'),
      cfg.encodePickerId('p2', 'deepseek-v4-pro-0813'),
      'same model, distinct picker ids'
    );
    assert.deepStrictEqual(
      cfg.decodePickerId('p1::deepseek-v4-pro-0813'),
      { key: 'p1', model: 'deepseek-v4-pro-0813' },
      'picker id round-trips'
    );
    assert.strictEqual(cfg.decodePickerId('deepseek-v4-pro-0813'), undefined, 'bare id decodes to nothing');

    // Per-profile limits: explicit > preset > default.
    assert.strictEqual(cfg.resolveProfileEntry(store.readProfile('p2')).maxInputTokens, 32000, 'explicit profile limit wins');
    assert.strictEqual(cfg.resolveProfileEntry(store.readProfile('p1')).maxInputTokens, 1048576, 'preset applies (1M/128K tier)');
    assert.strictEqual(cfg.resolveProfileEntry(store.readProfile('p1')).id, 'deepseek-v4-pro-0813', 'entry id is the REAL model, never the alias');

    // Malformed rows are dropped; trailing slashes are stripped — one parser
    // serves every stored payload.
    secrets.set(store.PROFILES_SECRET_KEY, JSON.stringify([
      { key: 'p3', baseURL: 'https://c.example/v1//', model: 'gpt-4o' },
      { key: '', baseURL: 'https://bad.example/v1', model: 'gpt-4o' },
      { key: 'p4', baseURL: '', model: 'gpt-4o' },
      { key: 'p3', baseURL: 'https://dup.example/v1', model: 'gpt-4o' },
    ]));
    assert.strictEqual(await store.reloadProfiles(), true, 'external payload adopted');
    const parsed = store.readProfiles();
    assert.strictEqual(parsed.length, 1, 'rows without key/baseURL/model are dropped, duplicate keys collapse');
    assert.strictEqual(parsed[0].baseURL, 'https://c.example/v1', 'trailing slashes stripped');

    // A SECOND activation (another window) reads the same store and keeps it.
    await store.initProfileStore(extensionContext);
    assert.deepStrictEqual(store.readProfiles().map((p) => p.key), ['p3'], 're-init keeps the stored list');

    // upsertProfile replaces by key; removeProfile deletes the row — both land
    // in the credential store, never in settings.json.
    await store.writeProfiles([]);
    const p2 = { key: 'p2', name: 'B', baseURL: 'https://b.example/v1', model: 'glm-5', maxInputTokens: 0, maxOutputTokens: 0 };
    await store.upsertProfile(p2);
    assert.deepStrictEqual(store.readProfiles().map((p) => p.key), ['p2'], 'upsert stores the profile');
    await store.upsertProfile({ ...p2, model: 'glm-4.6' });
    assert.strictEqual(store.readProfiles().length, 1, 'upsert replaces by key');
    assert.strictEqual(store.readProfiles()[0].model, 'glm-4.6');
    assert.strictEqual(settings.profiles, undefined, 'writes never touch settings.json');
    assert.strictEqual(JSON.parse(secrets.get(store.PROFILES_SECRET_KEY))[0].model, 'glm-4.6', 'store payload updated');

    // Gear-panel limit overrides persist INTO the group (0 = restore auto).
    assert.strictEqual(await store.applyProfileLimitOverrides('p2', { maxInputTokens: 524288 }), true, 'override written');
    assert.strictEqual(store.readProfile('p2').maxInputTokens, 524288);
    assert.strictEqual(await store.applyProfileLimitOverrides('p2', { maxInputTokens: 524288 }), false, 'no-op override is not rewritten');
    assert.strictEqual(await store.applyProfileLimitOverrides('p2', { maxInputTokens: 0 }), true, 'cleared box restores auto');
    assert.strictEqual(store.readProfile('p2').maxInputTokens, 0);
    assert.strictEqual(await store.applyProfileLimitOverrides('nope', { maxInputTokens: 1 }), false, 'unknown group is a no-op');

    // Cross-window sync: another VS Code profile writes the store; this
    // window reloads, fires its listener once, and ignores its own writes.
    let notified = 0;
    const sub = store.onProfilesChanged(() => { notified += 1; });
    const foreignPayload = JSON.stringify([
      { key: 'p9', name: 'added elsewhere', baseURL: 'https://z.example/v1', model: 'glm-5' },
    ]);
    secrets.set(store.PROFILES_SECRET_KEY, foreignPayload);
    assert.strictEqual(await store.reloadProfiles(), true, 'foreign write adopted');
    assert.strictEqual(notified, 1, 'listener fired once');
    assert.deepStrictEqual(store.readProfiles().map((p) => p.key), ['p9'], 'foreign group visible');
    assert.strictEqual(await store.reloadProfiles(), false, 'identical payload is a no-op');
    assert.strictEqual(notified, 1, 'no extra notification');
    sub.dispose();

    // --- settings mirror: the read-only list the Settings UI can show ---
    const mirror = require('../out/modelListSetting.js');
    const rows = [
      { key: 'p1', name: 'my-gateway', baseURL: 'https://a.example/v1', model: 'deepseek-v4-pro-0813', maxInputTokens: 0, maxOutputTokens: 0 },
      { key: 'p2', name: '', baseURL: 'https://b.example/v1', model: 'gpt-4o', maxInputTokens: 0, maxOutputTokens: 0 },
    ];
    const lines = mirror.modelListLines(rows, new Set(['p1']));
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], 'my-gateway → deepseek-v4-pro-0813 · 1M/128K', `alias → id: ${lines[0]}`);
    // The mirror prints the REAL ceiling (128000 → 128K, decimal vendor
    // notation), not the rung the gear panel starts this model on — a rung is
    // a budget, and 200K models must not be summarized as 128K.
    assert.strictEqual(lines[1], 'gpt-4o · 128K/16K · ⚠ no API key', `no alias, no key: ${lines[1]}`);
    // Stored as ONE multiline string: an array would render as an editable
    // item list (per-row edit/remove + "Add Item") on a read-only mirror.
    const text = mirror.modelListText(rows, new Set(['p1']));
    assert.strictEqual(text, lines.join('\n'), 'one line per group');
    // Nothing credential-like and no endpoint ever reaches settings.json.
    for (const line of lines) {
      assert.ok(!line.includes('https://'), `mirror leaks an endpoint: ${line}`);
    }
    // Sync writes the text the Settings UI renders, and skips a no-op write.
    await store.writeProfiles(rows);
    secrets.set(cfg.apiKeySecretKey('p1'), 'sk-test');
    await mirror.syncModelListSetting(extensionContext);
    assert.strictEqual(settings.modelList, text, 'mirror written to the setting');
    // A manual edit is display noise, not input: the next sync repaints it.
    settings.modelList = 'hand-edited';
    await mirror.syncModelListSetting(extensionContext);
    assert.strictEqual(settings.modelList, text, 'hand edit is repainted, not adopted');
    // A value left behind by the array-shaped build is repainted too.
    settings.modelList = ['stale', 'array'];
    await mirror.syncModelListSetting(extensionContext);
    assert.strictEqual(settings.modelList, text, 'foreign shape is repainted');
    await store.writeProfiles([]);
    await store.removeProfile('p9');
    assert.deepStrictEqual(store.readProfiles(), [], 'removeProfile deletes the row');
    // --- learned capabilities: a refusal is remembered, not re-probed ---
    const cap = require('../out/modelCapability.js');
    secrets.delete(cap.CAPABILITY_SECRET_KEY);
    await cap.initCapabilityStore(extensionContext);

    const gw = 'https://tokenhub.example.com/v1';
    const model = 'deepseek-v4.1-flash-1017';
    assert.strictEqual(cap.endpointKey('https://TokenHub.Example.com/v1/'), 'tokenhub.example.com/v1', 'endpoint key normalises host case + trailing slash');
    assert.strictEqual(cap.effortVerdict(gw, model, 'medium'), 'unknown', 'nothing known yet');
    assert.strictEqual(cap.effortVerdict(gw, model, 'auto'), 'supported', 'auto puts nothing on the wire');

    // Only an ENUMERATED list is worth parsing; prose teaches nothing.
    const listDetail = 'Invalid reasoning_effort: must be one of low, high, max';
    assert.deepStrictEqual(cap.parseSupportedFromDetail(listDetail, 'medium'), ['low', 'high', 'max'], 'enumerated set parsed, refused value excluded');
    assert.strictEqual(cap.parseSupportedFromDetail('the request was rejected by an internal gateway component', 'medium'), undefined, 'generic body teaches nothing');
    assert.strictEqual(cap.parseSupportedFromDetail('reasoning_effort: bad', 'medium'), undefined, 'field named without a list → no guess');

    assert.strictEqual(await cap.recordEffortVerdict(gw, model, 'medium', 'rejected', listDetail), true, 'first refusal is a change');
    assert.strictEqual(cap.effortVerdict(gw, model, 'medium'), 'rejected');
    assert.strictEqual(cap.effortVerdict(gw, model, 'high'), 'supported', 'the list answers for values never tried');
    assert.strictEqual(cap.effortVerdict(gw, model, 'none'), 'rejected', 'a value missing from the list is refused');
    assert.strictEqual(cap.fallbackEffort(gw, model), 'high', 'fallback prefers high');
    assert.strictEqual(cap.effortVerdict(gw, 'another-model', 'medium'), 'unknown', 'learning is per model');

    assert.strictEqual(await cap.recordEffortVerdict(gw, model, 'medium', 'rejected', listDetail), false, 'the same verdict twice writes nothing');
    const payload = JSON.parse(secrets.get(cap.CAPABILITY_SECRET_KEY));
    assert.strictEqual(payload.version, 1, 'payload is versioned');
    assert.deepStrictEqual(
      payload.models[`tokenhub.example.com/v1|${model}`].supportedEfforts,
      ['low', 'high', 'max'],
      'accepted set stored under endpoint|model'
    );
    assert.ok(!JSON.stringify(payload).includes('sk-'), 'no key material in the learned store');

    // Positive evidence clears the refusal (a gateway that answered 200).
    await cap.recordEffortVerdict(gw, model, 'medium', 'supported');
    assert.notStrictEqual(cap.effortVerdict(gw, model, 'medium'), 'rejected', 'a 200 un-refuses the value');

    // Three refusals with no list = the FIELD is refused, not one value.
    const strict = 'https://b.example/v1';
    for (const value of ['none', 'medium', 'low']) {
      await cap.recordEffortVerdict(strict, 'glm-5.3', value, 'rejected', 'unsupported reasoning_effort');
    }
    assert.strictEqual(cap.effortVerdict(strict, 'glm-5.3', 'high'), 'rejected', 'no list + three refusals → field refusal');
    assert.strictEqual(cap.fallbackEffort(strict, 'glm-5.3'), undefined, 'nothing safe left → caller drops the parameter');

    // An activation in another window re-reads what this one learned.
    await cap.recordEffortVerdict('https://c.example/v1', 'm', 'medium', 'rejected', listDetail);
    await cap.initCapabilityStore(extensionContext);
    assert.strictEqual(cap.effortVerdict('https://c.example/v1', 'm', 'medium'), 'rejected', 'persisted payload re-read on activation');

    // Bounded growth: a script cycling model ids cannot inflate the secret.
    for (let i = 0; i < 70; i += 1) {
      await cap.recordEffortVerdict('https://cap.example/v1', `model-${i}`, 'medium', 'rejected', 'bad reasoning_effort value');
    }
    assert.strictEqual(cap.rememberedCount(), 64, 'record cap enforced');

    const cleared = await cap.clearCapabilities();
    assert.strictEqual(cleared, 64, 'clear reports what it forgot');
    assert.strictEqual(cap.rememberedCount(), 0);
    assert.strictEqual(secrets.has(cap.CAPABILITY_SECRET_KEY), false, 'the slot is deleted');
    assert.strictEqual(cap.effortVerdict(gw, model, 'medium'), 'unknown', 'nothing survives a clear');

    // --- keyless endpoints + base-URL normalisation -------------------------
    // A self-hosted inference server started without an auth flag has no
    // secret at all: "configured" must come from the explicit noAuth flag, not
    // from a non-empty key, or those endpoints can never be used.
    const onPrem = cfg.parseProfile({
      key: 'p-local',
      baseURL: 'http://localhost:11434/v1/',
      model: 'example-model',
      noAuth: true,
    });
    assert.strictEqual(onPrem.noAuth, true, 'noAuth survives validation');
    assert.strictEqual(onPrem.baseURL, 'http://localhost:11434/v1', 'http URL kept as-is');
    assert.strictEqual(cfg.profileHasCredentials(onPrem, ''), true, 'keyless endpoint counts as configured');
    assert.strictEqual(cfg.profileHasCredentials({ ...onPrem, noAuth: undefined }, ''), false, 'a keyed profile without a key is NOT configured');
    assert.strictEqual(cfg.profileHasCredentials(onPrem, 'sk-x'), true, 'a key can be added later without losing the flag');
    // Only the literal `true` enables it — a hand-edited payload must not.
    assert.strictEqual(cfg.parseProfile({ key: 'p', baseURL: 'https://x/v1', model: 'm', noAuth: 'true' }).noAuth, undefined, '"true" is not true');

    // Pasting the FULL endpoint (the shape every docs page shows) must not
    // become `.../chat/completions/chat/completions` — that is a 404, and the
    // recovery ladder only retries 400.
    assert.strictEqual(
      cfg.normalizeBaseURL('https://gw.example.com/v1/openai/chat/completions'),
      'https://gw.example.com/v1/openai',
      'full endpoint collapses to its base'
    );
    assert.strictEqual(
      cfg.normalizeBaseURL('  https://gw.example.com/v1/openai/chat/completions/  '),
      'https://gw.example.com/v1/openai',
      'slashes and whitespace tolerated'
    );
    assert.strictEqual(cfg.normalizeBaseURL('http://127.0.0.1:8000/v1//'), 'http://127.0.0.1:8000/v1', 'trailing slashes stripped');
    assert.strictEqual(cfg.normalizeBaseURL('https://gw.example.com/v1'), 'https://gw.example.com/v1', 'a base URL is left alone');
    assert.strictEqual(
      cfg.normalizeBaseURL('https://gw.example.com/openai/v1/chat/completions'),
      'https://gw.example.com/openai/v1',
      'non-/v1 prefixes are preserved'
    );

    console.log('SMOKE OK — all pure-logic assertions passed');
  });
}).catch((err) => { console.error(err); process.exit(1); });
