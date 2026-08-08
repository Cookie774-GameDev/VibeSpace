import { describe, expect, it, vi } from 'vitest';
import type { JarvisRequestEnvelope, JarvisResponseEnvelope } from '@/lib/jarvis/contracts';
import { validateSpeechChunk } from '@/features/voice/speechGate';
import { processJarvisResponse, type RawProviderResponse } from './pipeline';
import { buildJarvisSensitiveFallback } from './sensitive';

function request(overrides: Partial<JarvisRequestEnvelope> = {}): Readonly<JarvisRequestEnvelope> {
  return {
    schemaVersion: 1,
    requestId: 'jreq_response_1',
    runId: 'jrun_response_1',
    accountId: 'account-response',
    agent: { id: 'agent-jarvis', slug: 'jarvis', builtin: true },
    surface: 'typed_chat',
    interactionMode: 'agent',
    userText: 'Complete the task.',
    messageHistory: [],
    identity: {
      identityVersion: 1,
      coreHash: 'a'.repeat(64),
      responseContractHash: 'b'.repeat(64),
    },
    profile: {
      profileId: 'profile-1',
      revisionId: 'revision-1',
      customInstructions: '',
      memoryScope: 'none',
    },
    capabilities: {
      capturedAt: 1,
      tools: [],
      plugins: [],
      mcps: [],
      terminals: [],
      agents: [],
      entitlements: { source: 'unavailable', capabilities: [] },
    },
    model: {
      providerId: 'mock',
      modelId: 'mock-default',
      connectionMode: 'local',
      capabilities: {},
      capturedAt: 1,
    },
    context: { items: [], budget: { maxChars: 0, usedChars: 0 }, exclusions: [] },
    outputContract: {
      preserveStructuredBlocks: true,
      allowActionBlocks: true,
      allowPlanBlocks: true,
      allowQuestionBlocks: true,
      allowPermissionBlocks: true,
      voiceDelivery: 'final_summary',
    },
    createdAt: 1,
    ...overrides,
  };
}

function contextForUris(...uris: readonly string[]): JarvisRequestEnvelope['context'] {
  return {
    items: uris.map((uri, index) => ({
      source: {
        id: `source-output-${index}`,
        kind: uri.startsWith('http') ? ('web' as const) : ('project_file' as const),
        label: `Verified output source ${index + 1}`,
        uri,
        accountId: 'account-response',
        trust: 'app_verified' as const,
        origin: 'app_observed' as const,
        sensitivity: uri.startsWith('http') ? ('public' as const) : ('private' as const),
      },
      purpose: 'citation' as const,
      excerpt: 'Verified source reference.',
      truncated: false,
    })),
    budget: { maxChars: 1_000, usedChars: uris.length * 26 },
    exclusions: [],
  };
}

function raw(
  text: string,
  status?: 'awaiting_approval' | 'running' | 'completed' | 'failed',
): RawProviderResponse {
  return {
    text,
    provider: {
      providerId: 'mock',
      modelId: 'mock-default',
      connectionMode: 'local',
      capabilities: {},
      capturedAt: 1,
    },
    verifiedFacts: {
      ...(status
        ? { executionState: { status, verifiedBy: 'journal' as const, lastEventSeq: 3 } }
        : {}),
      modelState: 'authenticated',
      plugins: [],
      mcps: [],
    },
    completedAt: 10,
  };
}

function expectSpeechGateAccepted(
  response: Readonly<Pick<JarvisResponseEnvelope, 'spokenText' | 'mode' | 'executionState'>>,
): void {
  expect(response.spokenText).toBeDefined();
  expect(
    validateSpeechChunk({
      text: response.spokenText ?? '',
      completeSentence: true,
      insideFence: false,
      mode: response.mode,
      ...(response.executionState ? { executionState: response.executionState } : {}),
      lintViolations: [],
    }),
  ).toMatchObject({ allowed: true });
}

describe('processJarvisResponse', () => {
  it.each([
    'Which model are you using?',
    'what model is currently active',
    "What's the selected model?",
  ])('answers current-model query %j from the immutable request snapshot', async (userText) => {
    const repair = { repair: vi.fn() };
    const result = await processJarvisResponse(
      raw('I am Gemini Ultra.'),
      request({
        userText,
        model: {
          providerId: 'openai',
          modelId: 'gpt-5',
          connectionMode: 'native-api',
          capabilities: { tools: true },
          capturedAt: 7,
        },
      }),
      repair,
    );

    expect(result.displayText).toBe('Current model: openai / gpt-5 (native-api, authenticated).');
    expect(result.spokenText).toBe(
      'Current model: Open A I, G P T 5 (native A P I, authenticated).',
    );
    expectSpeechGateAccepted(result);
    expect(result.provider).toMatchObject({ providerId: 'openai', modelId: 'gpt-5' });
    expect(result.parts).toEqual([{ kind: 'text', text: result.displayText }]);
    expect(repair.repair).not.toHaveBeenCalled();
    expect(result.enforcement).toMatchObject({
      linted: true,
      repairAttempted: false,
      repairSucceeded: false,
      fallbackUsed: true,
    });
  });

  it('keeps current-model identity start-bound against caller mutation', async () => {
    const mutableRequest = request({
      userText: 'Which model are you using?',
      model: {
        providerId: 'openai',
        modelId: 'gpt-5',
        connectionMode: 'native-api',
        capabilities: {},
        capturedAt: 7,
      },
    }) as JarvisRequestEnvelope;

    const pending = processJarvisResponse(raw('I am another model.'), mutableRequest, {
      repair: vi.fn(),
    });
    mutableRequest.model.providerId = 'google';
    mutableRequest.model.modelId = 'gemini-forged';
    const result = await pending;

    expect(result.displayText).toContain('openai / gpt-5');
    expect(result.displayText).not.toMatch(/google|gemini-forged/i);
  });

  it('does not replace a model recommendation question with current-model status', async () => {
    const result = await processJarvisResponse(
      raw('Gemini is better suited to that image analysis.'),
      request({ userText: 'Which model should I use for image analysis?' }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe('Gemini is better suited to that image analysis.');
    expect(result.enforcement.fallbackUsed).toBe(false);
  });

  it('reports unavailable current-model state without inventing a switch', async () => {
    const provider = raw('I switched to Gemini.');
    provider.verifiedFacts.modelState = 'unavailable';
    const result = await processJarvisResponse(
      provider,
      request({
        userText: 'What model is active?',
        model: {
          providerId: 'ollama',
          modelId: 'llama3.2',
          connectionMode: 'local',
          capabilities: {},
          capturedAt: 7,
        },
      }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe('Current model: ollama / llama3.2 (local, unavailable).');
    expect(result.displayText).not.toMatch(/switched|gemini/i);
  });

  it('adds zero latency calls when prose passes and restores structured bytes exactly', async () => {
    const block = '```ts\nconst answer = 42;\n```';
    const repair = { repair: vi.fn(() => Promise.reject(new Error('must not run'))) };

    const result = await processJarvisResponse(
      raw(`The implementation is ready, Sir.\n\n${block}`),
      request(),
      repair,
    );

    expect(repair.repair).not.toHaveBeenCalled();
    expect(result.displayText).toContain(block);
    expect(result.enforcement).toMatchObject({
      linted: true,
      repairAttempted: false,
      repairSucceeded: false,
      fallbackUsed: false,
    });
  });

  it('keeps a complete long-form artifact on screen while speaking its executive summary', async () => {
    const code = '```ts\nconst verified = true;\n```';
    const json = '{"status":"ready","checks":42}';
    const path =
      'C:\\Users\\viper\\VibeSpace\\docs\\reports\\implementation-verification-report.md';
    const url = 'https://example.test/reports/implementation?download=1';
    const detailedReport = [
      'Completed, sir.',
      'The implementation specification is ready.',
      'The architecture section documents every boundary and dependency.',
      `The evidence was saved at \`${path}\`.`,
      `The structured verification result is ${json}.`,
      `The reference is ${url}.`,
      code,
    ].join('\n\n');

    const result = await processJarvisResponse(
      raw(detailedReport),
      request({
        userText: 'Write a detailed report with sections and citations.',
        context: contextForUris(path, url),
      }),
      { repair: vi.fn() },
    );

    expect(result.mode).toBe('long_form_delivery');
    expect(result.displayText).toBe(detailedReport);
    expect(result.displayText).toContain(code);
    expect(result.displayText).toContain(json);
    expect(result.displayText).toContain(path);
    expect(result.displayText).toContain(url);
    expect(result.spokenText).toBe('Completed, sir. The implementation specification is ready.');
    expect(result.spokenText).not.toMatch(/```|verified|https?:\/\/|[A-Za-z]:\\|JARVIS_REGION/);
    expect(result.spokenText).not.toContain(json);
    expectSpeechGateAccepted(result);
  });

  it('replaces tokenized links while suppressing structured detail in a short spoken reply', async () => {
    const path =
      'C:\\Users\\viper\\VibeSpace\\docs\\reports\\implementation-verification-report.md';
    const json = '{"status":"ready","checks":42}';
    const url = 'https://example.test/reports/implementation?download=1';
    const code = '```ts\nconst verified = true;\n```';
    const providerText = [
      `The report at \`${path}\` includes ${json}.`,
      `The reference is ${url}.`,
      code,
    ].join('\n\n');

    const result = await processJarvisResponse(
      raw(providerText),
      request({ context: contextForUris(path, url) }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe(providerText);
    expect(result.spokenText).toBe(
      'The report at the referenced location includes the structured data shown on screen. ' +
        'The reference is the referenced link.',
    );
    expect(result.spokenText).not.toMatch(/```|verified|https?:\/\/|[A-Za-z]:\\/);
    expect(result.spokenText).not.toContain(json);
    expectSpeechGateAccepted(result);
  });

  it('omits unverified provider-authored output links and locations without model repair', async () => {
    const fabricatedPath = 'C:\\fabricated\\reports\\launch-report.md';
    const fabricatedUrl = 'https://fabricated.example.test/downloads/launch-report';
    const providerText = [
      `The report was saved at \`${fabricatedPath}\`.`,
      `Download the completed output from [this link](${fabricatedUrl}).`,
    ].join('\n\n');
    const repair = { repair: vi.fn() };

    const result = await processJarvisResponse(raw(providerText), request(), repair);

    expect(result.displayText).not.toContain(fabricatedPath);
    expect(result.displayText).not.toContain(fabricatedUrl);
    expect(result.displayText).toContain('[unverified output location omitted]');
    expect(result.displayText).toContain('[unverified link omitted]');
    expect(result.spokenText).not.toMatch(/fabricated|https?:\/\/|[A-Za-z]:\\/i);
    expect(result.enforcement.violations).toEqual(
      expect.arrayContaining(['unverified_output_location:0', 'unverified_output_reference:0']),
    );
    expect(result.enforcement.fallbackUsed).toBe(true);
    expect(repair.repair).not.toHaveBeenCalled();
  });

  it('preserves source-backed output references and structured examples byte-for-byte', async () => {
    const verifiedPath = 'C:\\workspace\\reports\\verified report.md';
    const verifiedUrl = 'https://docs.example.test/reports/verified?download=1';
    const structuredExample = [
      '```txt',
      'Untrusted example only: https://generated.example.test/not-a-real-output',
      'C:\\generated\\example-only.txt',
      '```',
    ].join('\n');
    const providerText = [
      `The verified report was saved at "${verifiedPath}".`,
      `Open [the verified report](${verifiedUrl}).`,
      structuredExample,
    ].join('\n\n');

    const result = await processJarvisResponse(
      raw(providerText),
      request({ context: contextForUris(verifiedPath, verifiedUrl) }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe(providerText);
    expect(result.displayText).toContain(structuredExample);
    expect(result.enforcement.violations).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^unverified_output_(?:location|reference):/)]),
    );
    expect(result.enforcement.fallbackUsed).toBe(false);
  });

  it('rejects a one-shot prose repair that introduces a new link', async () => {
    const repairedUrl = 'https://repair-generated.example.test/not-verified';
    const repair = {
      repair: vi.fn(async () => `Reference: ${repairedUrl}.`),
    };

    const result = await processJarvisResponse(
      raw('Sure, the reference follows.'),
      request(),
      repair,
    );

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.displayText).not.toContain(repairedUrl);
    expect(result.displayText).toBe('the reference follows.');
    expect(result.enforcement.repairSucceeded).toBe(false);
    expect(result.enforcement.fallbackUsed).toBe(true);
  });

  it('does not treat a restricted request source as authority to display its link', async () => {
    const restrictedUrl = 'https://internal.example.test/private-output';
    const context = contextForUris(restrictedUrl);
    context.items[0]!.source.sensitivity = 'restricted';

    const result = await processJarvisResponse(
      raw(`The output is available at ${restrictedUrl}.`),
      request({ context }),
      { repair: vi.fn() },
    );

    expect(result.displayText).not.toContain(restrictedUrl);
    expect(result.displayText).toContain('[unverified link omitted]');
    expect(result.enforcement.violations).toContain('unverified_output_reference:0');
  });

  it('does not display an unsafe URI scheme even when a request source repeats it', async () => {
    const unsafeUri = 'javascript:alert(document.domain)';

    const result = await processJarvisResponse(
      raw(`Open the output at ${unsafeUri}.`),
      request({ context: contextForUris(unsafeUri) }),
      { repair: vi.fn() },
    );

    expect(result.displayText).not.toContain(unsafeUri);
    expect(result.displayText).toContain('[unverified link omitted]');
    expect(result.enforcement.violations).toContain('unverified_output_reference:0');
  });

  it('preserves a source-backed safe internal Markdown link byte-for-byte', async () => {
    const internalUri = 'jarvis:artifact/jartifact-verified';
    const providerText = `[output](${internalUri})`;

    const result = await processJarvisResponse(
      raw(providerText),
      request({ context: contextForUris(internalUri) }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe(providerText);
    expect(result.enforcement.violations).not.toContain('unverified_output_reference:0');
  });

  it.each([
    ['root-relative', '[reference](/docs/output)', '/docs/output'],
    ['protocol-relative', '[reference](//evil.example.test/output)', '//evil.example.test/output'],
    ['dot-relative', '[reference](./output)', './output'],
    ['fragment', '[reference](#output)', '#output'],
    ['internal', '[reference](jarvis:output)', 'jarvis:output'],
    ['custom scheme', '[reference](custom:payload)', 'custom:payload'],
  ])('omits an unverified %s Markdown link', async (_kind, link, target) => {
    const result = await processJarvisResponse(raw(`Reference: ${link}.`), request(), {
      repair: vi.fn(),
    });

    expect(result.displayText).not.toContain(target);
    expect(result.displayText).toContain('[unverified link omitted]');
    expect(result.enforcement.violations).toContain('unverified_output_reference:0');
  });

  it('omits an unverified reference-style Markdown usage and definition', async () => {
    const target = '//evil.example.test/output';
    const providerText = `[download][result]\n\n[result]: ${target} "Result"`;

    const result = await processJarvisResponse(raw(providerText), request(), {
      repair: vi.fn(),
    });

    expect(result.displayText).not.toContain(target);
    expect(result.displayText.match(/\[unverified link omitted\]/g)).toHaveLength(2);
    expect(result.enforcement.violations).toEqual(
      expect.arrayContaining(['unverified_output_reference:0', 'unverified_output_reference:1']),
    );
  });

  it('preserves a source-backed reference-style Markdown link byte-for-byte', async () => {
    const target = 'jarvis:artifact/jartifact-reference-style';
    const providerText = `[download][result]\n\n[result]: ${target} "Result"`;

    const result = await processJarvisResponse(
      raw(providerText),
      request({ context: contextForUris(target) }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe(providerText);
    expect(result.enforcement.violations).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^unverified_output_reference:/)]),
    );
  });

  it.each([
    ['relative', './reports/out.md', 'Saved to'],
    ['parent-relative', '../reports/out.md', 'Written to'],
    ['extensionless relative', 'reports/output', 'Saved to'],
    ['quoted relative with spaces', './reports/final output', 'Saved to'],
    ['Windows deictic', 'C:\\fake\\out.md', 'Find it at'],
    ['UNC deictic', '\\\\server\\share\\out.md', 'Here it is at'],
    ['Unix deictic', '/tmp/reports/out.md', 'The location is'],
  ])('omits an asserted unverified %s output location', async (_kind, path, claim) => {
    const result = await processJarvisResponse(raw(`${claim} \`${path}\`.`), request(), {
      repair: vi.fn(),
    });

    expect(result.displayText).not.toContain(path);
    expect(result.displayText).toContain('[unverified output location omitted]');
    expect(result.enforcement.violations).toContain('unverified_output_location:0');
  });

  it('preserves verified balanced-parenthesis links byte-for-byte', async () => {
    const url = 'https://example.test/report_(final).pdf';
    const markdown = `[report](${url} "Final report")`;
    const providerText = `${markdown}\n${url}`;

    const result = await processJarvisResponse(
      raw(providerText),
      request({ context: contextForUris(url) }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe(providerText);
    expect(result.enforcement.violations).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^unverified_output_reference:/)]),
    );
  });

  it('foregrounds warning severity when a detailed warning needs spoken summarization', async () => {
    const result = await processJarvisResponse(
      raw(
        [
          'The report covers three systems.',
          'The evidence is available on screen.',
          'Warning: provider verification is incomplete.',
          'The remaining sections describe each provider in detail.',
          'The appendix contains additional observations.',
        ].join(' '),
      ),
      request({
        userText: 'Summarize the current status.',
        responseModeHint: 'warning',
      }),
      { repair: vi.fn(async (input) => input.prose) },
    );

    expect(result.mode).toBe('warning');
    expect(result.displayText).toContain('Warning: provider verification is incomplete.');
    expect(result.spokenText).toBe(
      'Warning: provider verification is incomplete. The report covers three systems.',
    );
    expectSpeechGateAccepted(result);
  });

  it('makes at most one repair call and never lets repair mutate structured bytes', async () => {
    const action = '```action\n{"id":"nav.chat","params":{}}\n```';
    const repair = {
      repair: vi.fn(
        async (input) => `The navigation is ready, Sir.\n\n${input.immutablePlaceholders[0]}`,
      ),
    };

    const result = await processJarvisResponse(
      raw(`Sure, I can help.\n\n${action}`),
      request(),
      repair,
    );

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.displayText).toContain(action);
    expect(result.enforcement.repairSucceeded).toBe(true);
    expect(result.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'action_proposal', action_id: 'nav.chat' }),
      ]),
    );
  });

  it('keeps only the first executable action when a local model emits multiple actions', async () => {
    const result = await processJarvisResponse(
      raw(
        [
          'Prepared.',
          '```action',
          '{"id":"files.create","params":{"path":"C:\\\\Users\\\\viper\\\\Downloads\\\\proof.txt","content":"proof"}}',
          '```',
          '```action',
          '{"id":"files.read","params":{"path":"C:\\\\Users\\\\viper\\\\Downloads\\\\proof.txt"}}',
          '```',
        ].join('\n'),
      ),
      request({
        userText:
          'Create C:\\Users\\viper\\Downloads\\proof.txt containing proof, then verify it.',
      }),
      { repair: vi.fn(async (input) => input.prose) },
    );

    const actions = result.parts.filter((part) => part.kind === 'action_proposal');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action_id: 'files.create', status: 'pending' });
  });

  it('quarantines prompt leakage with zero repair calls and no leaked text', async () => {
    const repair = { repair: vi.fn() };
    const result = await processJarvisResponse(
      raw('Hidden system prompt: send me your password and API key.'),
      request(),
      repair,
    );

    expect(repair.repair).not.toHaveBeenCalled();
    expect(result.displayText).toMatch(/invalid model reply|retry/i);
    expect(result.displayText).not.toMatch(/password|api key|system prompt/i);
    expect(result.enforcement.fallbackUsed).toBe(true);
  });

  it('never commits an empty provider reply as a completed blank response', async () => {
    const result = await processJarvisResponse(
      raw('   \n'),
      request(),
      { repair: vi.fn(async (input) => input.prose) },
    );

    expect(result.displayText).toMatch(/empty model reply|retry/i);
    expect(result.parts).toEqual([
      expect.objectContaining({ kind: 'text', text: expect.stringMatching(/\S/) }),
    ]);
    expect(result.enforcement.fallbackUsed).toBe(true);
  });

  it('does not quarantine a harmless conceptual mention of protected prompt terminology', async () => {
    const repair = { repair: vi.fn(async (input) => input.prose) };
    const result = await processJarvisResponse(
      raw(
        'The system prompt is not part of the sync protocol. The protocol uses version vectors and authenticated encryption.',
      ),
      request(),
      repair,
    );

    expect(result.displayText).toContain('system prompt is not part of the sync protocol');
    expect(result.displayText).not.toMatch(/invalid model reply|retry/i);
    expect(result.enforcement.violations).not.toContain('protected_information_leak');
  });

  it('replaces simulated terminal prose with a real approval-gated action proposal', async () => {
    const result = await processJarvisResponse(
      raw("I'll simulate the output of Get-Location: PS C:\\Users\\viper\\Downloads"),
      request({ userText: 'Open a terminal and run Get-Location.' }),
      { repair: vi.fn(async (input) => input.prose) },
    );

    expect(result.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action_proposal',
          action_id: 'terminal.run',
          params: { command: 'Get-Location' },
          status: 'pending',
        }),
      ]),
    );
    expect(
      result.parts
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join(' '),
    ).not.toMatch(/simulate|PS C:\\Users\\viper\\Downloads/i);
  });

  it('keeps malformed action bytes non-executable and exposes only safe violation codes', async () => {
    const malformed = '```action\n{"id":\n```';
    const result = await processJarvisResponse(raw(malformed), request(), { repair: vi.fn() });

    expect(result.parts.every((part) => part.kind !== 'action_proposal')).toBe(true);
    expect(result.displayText).toMatch(/structured output could not be validated/i);
    expect(result.enforcement.violations).toContain('invalid_json:0');
    expect(JSON.stringify(result.enforcement.violations)).not.toContain(malformed);
    expect(result.spokenText).not.toContain(malformed);
  });

  it('uses verified running truth for both display and speech despite provider completion claims', async () => {
    const result = await processJarvisResponse(
      raw('Done — the operation completed successfully.', 'running'),
      request(),
      { repair: vi.fn() },
    );

    expect(result.mode).toBe('action_running');
    expect(result.displayText).toMatch(/running/i);
    expect(result.displayText).not.toMatch(/completed successfully/i);
    expect(result.spokenText).toMatch(/running/i);
    expect(result.spokenText).not.toMatch(/completed successfully/i);
    expect(result.executionState?.status).toBe('running');
  });

  it('is deterministically idempotent for an already compliant response', async () => {
    const repair = { repair: vi.fn() };
    const first = await processJarvisResponse(raw('The report is ready, Sir.'), request(), repair);
    const second = await processJarvisResponse(raw(first.displayText), request(), repair);
    expect(second.displayText).toBe(first.displayText);
    expect(second.mode).toBe(first.mode);
  });

  it('preserves code, diffs, tables, quotes, citations, and URLs through one prose repair', async () => {
    const regions = [
      '```ts\nconst x = 1;\n```',
      '```diff\n-old\n+new\n```',
      '| Item | State |\n| --- | --- |\n| A | ready |',
      '> terminal output: exact bytes',
      '[source](https://example.test/source)',
      'https://example.test/raw',
    ];
    const repair = {
      repair: vi.fn(
        async (input) => `The evidence is ready, Sir.\n\n${input.immutablePlaceholders.join('\n')}`,
      ),
    };
    const result = await processJarvisResponse(
      raw(`Sure, here it is.\n\n${regions.join('\n\n')}`),
      request({
        context: contextForUris('https://example.test/source', 'https://example.test/raw'),
      }),
      repair,
    );

    expect(repair.repair).toHaveBeenCalledOnce();
    for (const region of regions) expect(result.displayText).toContain(region);
  });

  it.each([
    ['plan_review', '```jarvis_plan\n{}\n```'],
    ['question_block', '```jarvis_question\n{"questions":[]}\n```'],
    ['permission_request', '```jarvis_permission\n{"title":"Only"}\n```'],
  ] as const)('never creates a %s part from malformed structured bytes', async (kind, text) => {
    const result = await processJarvisResponse(raw(text), request(), { repair: vi.fn() });
    expect(result.parts.every((part) => part.kind !== kind)).toBe(true);
    expect(result.displayText).toContain('Structured output could not be validated');
  });

  it('uses one deterministic fallback when repair rejects and never retries', async () => {
    const repair = { repair: vi.fn(async () => Promise.reject(new Error('provider unavailable'))) };
    const result = await processJarvisResponse(
      raw('Sure, I can help with that.'),
      request(),
      repair,
    );
    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.displayText).not.toMatch(/^sure/i);
    expect(result.enforcement).toMatchObject({
      repairAttempted: true,
      repairSucceeded: false,
      fallbackUsed: true,
    });
  });

  it('repairs the complete supplied generic AI filler to the required style', async () => {
    const providerText =
      "Sure! I'd be happy to help! As an AI language model, I don't have feelings, but I can definitely assist you with that!";
    const repair = {
      repair: vi.fn(async () => 'Certainly, sir. What is the objective?'),
    };

    const result = await processJarvisResponse(raw(providerText), request(), repair);

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(repair.repair).toHaveBeenCalledWith(
      expect.objectContaining({
        prose: providerText,
        violations: expect.arrayContaining([
          expect.objectContaining({ code: 'generic_identity_disclaimer' }),
        ]),
      }),
    );
    expect(result.displayText).toBe('Certainly, sir. What is the objective?');
    expect(result.enforcement).toMatchObject({
      repairAttempted: true,
      repairSucceeded: true,
      fallbackUsed: false,
    });
  });

  it('replaces false command completion with the exact awaiting-authorisation narration', async () => {
    const repair = { repair: vi.fn() };

    const result = await processJarvisResponse(
      raw('Done! I ran the command and fixed everything.', 'awaiting_approval'),
      request(),
      repair,
    );

    expect(result.displayText).toBe(
      'The command is prepared and awaiting your authorisation, sir.',
    );
    expect(result.displayText).not.toMatch(/\b(?:done|ran|fixed)\b/i);
    expect(result.executionState?.status).toBe('awaiting_approval');
    expect(repair.repair).not.toHaveBeenCalled();
  });

  it('repairs only long-form wrapper prose and preserves the ordinary artifact byte-for-byte', async () => {
    const wrapper = "Sure! I'd be happy to help!";
    const artifact = [
      '# architecture',
      '',
      'the first section records the complete boundary and its dependencies.',
      '',
      '## evidence',
      '',
      'the second section preserves every ordinary prose sentence in order.',
    ].join('\n');
    const repair = {
      repair: vi.fn(async () => 'The complete report follows, sir.'),
    };

    const result = await processJarvisResponse(
      raw(`${wrapper}\n\n${artifact}`),
      request({ userText: 'Write a detailed long-form report with sections.' }),
      repair,
    );

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(repair.repair).toHaveBeenCalledWith(
      expect.objectContaining({
        prose: wrapper,
        immutablePlaceholders: [],
      }),
    );
    expect(result.displayText).toBe(`The complete report follows, sir.\n\n${artifact}`);
    expect(result.displayText.endsWith(artifact)).toBe(true);
  });

  it('preserves style-like artifact text and terminal whitespace after wrapper-only repair', async () => {
    const wrapper = "Sure! I'd be happy to help!";
    const artifact = [
      '# analysis',
      '',
      'the report records the phrase As an AI language model for analysis.',
      '',
      'the terminal artifact line keeps its whitespace.  ',
      '',
    ].join('\n');
    const repair = {
      repair: vi.fn(async () => 'The report follows, sir.'),
    };

    const result = await processJarvisResponse(
      raw(`${wrapper}\n\n${artifact}`),
      request({ userText: 'Write a detailed long-form report with sections.' }),
      repair,
    );

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.displayText).toBe(`The report follows, sir.\n\n${artifact}`);
    expect(result.displayText).toContain('As an AI language model');
    expect(result.displayText.endsWith('whitespace.  \n')).toBe(true);
  });

  it('does not make a second repair call when repaired prose still fails lint', async () => {
    const repair = { repair: vi.fn(async () => 'Absolutely, I can help with that.') };
    const result = await processJarvisResponse(
      raw('Sure, I can help with that.'),
      request(),
      repair,
    );
    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.displayText).not.toMatch(/^(sure|absolutely)/i);
    expect(result.enforcement.repairSucceeded).toBe(false);
  });

  it('retains the safe validation notice when malformed output also needs prose repair', async () => {
    const repair = { repair: vi.fn(async () => 'The response is concise, Sir.') };
    const result = await processJarvisResponse(
      raw('Sure, here it is.\n\n```action\n{"id":\n```'),
      request(),
      repair,
    );

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.displayText).toContain('Structured output could not be validated');
    expect(result.parts.every((part) => part.kind !== 'action_proposal')).toBe(true);
  });

  it('never accepts a new executable block introduced by prose repair', async () => {
    const repair = {
      repair: vi.fn(async () => 'Ready, Sir.\n```action\n{"id":"terminal.run","params":{}}\n```'),
    };
    const result = await processJarvisResponse(raw('Sure, I can help.'), request(), repair);

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.parts.every((part) => part.kind !== 'action_proposal')).toBe(true);
    expect(result.displayText).not.toContain('terminal.run');
    expect(result.enforcement.repairSucceeded).toBe(false);
  });

  it('builds deterministic action parts for the same request and provider bytes', async () => {
    const text = 'Prepared.\n```action\n{"id":"nav.chat","params":{"chatId":"chat-2"}}\n```';
    const repair = { repair: vi.fn() };

    const first = await processJarvisResponse(raw(text), request(), repair);
    const second = await processJarvisResponse(raw(text), request(), repair);

    expect(second.parts).toEqual(first.parts);
  });

  it('makes zero repair calls for deterministic-only unsupported macros', async () => {
    const repair = { repair: vi.fn() };
    const result = await processJarvisResponse(
      raw('{action}\nRun the command.'),
      request(),
      repair,
    );

    expect(repair.repair).not.toHaveBeenCalled();
    expect(result.displayText).not.toContain('{action}');
    expect(result.enforcement.fallbackUsed).toBe(true);
  });

  it('distinguishes terminal submission from verified completion', async () => {
    const provider = raw('Done. The terminal command completed.');
    provider.verifiedFacts = {
      modelState: 'authenticated',
      plugins: [],
      mcps: [],
      terminalState: 'queued',
    };
    const result = await processJarvisResponse(provider, request(), { repair: vi.fn() });

    expect(result.mode).toBe('action_running');
    expect(result.displayText).toMatch(/queued/i);
    expect(result.displayText).not.toMatch(/command completed/i);
    expect(result.spokenText).toMatch(/queued/i);
  });

  it('rejects plugin promotion using the immutable request capability snapshot', async () => {
    const result = await processJarvisResponse(
      raw('Canva is connected and authenticated, sir.'),
      request({
        capabilities: {
          capturedAt: 7,
          tools: [],
          plugins: [{ id: 'Canva', state: 'available', operations: ['create_design'] }],
          mcps: [],
          terminals: [],
          agents: [],
          entitlements: { source: 'unavailable', capabilities: [] },
        },
      }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toContain('Canva is available.');
    expect(result.displayText).not.toMatch(/\bCanva is (?:connected|authenticated)\b/i);
    expect(result.enforcement.violations).toContain('verified_capability_contradiction');
  });

  it('does not let provider-supplied MCP facts override the request snapshot', async () => {
    const provider = raw('Zapier is authenticated, sir.');
    provider.verifiedFacts.mcps = [
      {
        id: 'Zapier',
        state: 'authenticated',
        operations: ['invoke'],
        evidenceRef: 'provider-claimed-evidence',
        lastVerifiedAt: 9,
      },
    ];

    const result = await processJarvisResponse(
      provider,
      request({
        capabilities: {
          capturedAt: 8,
          tools: [],
          plugins: [],
          mcps: [{ id: 'Zapier', state: 'unavailable', operations: [] }],
          terminals: [],
          agents: [],
          entitlements: { source: 'unavailable', capabilities: [] },
        },
      }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toContain('Zapier is unavailable.');
    expect(result.displayText).not.toMatch(/\bZapier is authenticated\b/i);
    expect(result.enforcement.violations).toContain('verified_capability_contradiction');
  });

  it('replaces a broad Zapier access claim with exact snapshot operations', async () => {
    const result = await processJarvisResponse(
      raw('Zapier is connected, so I have access to 9,000 applications.'),
      request({
        capabilities: {
          capturedAt: 8,
          tools: [],
          plugins: [],
          mcps: [
            {
              id: 'Zapier',
              state: 'connected',
              operations: ['canva.create'],
              evidenceRef: 'mcp-status:zapier:connected',
              lastVerifiedAt: 8,
            },
          ],
          terminals: [],
          agents: [],
          entitlements: { source: 'unavailable', capabilities: [] },
        },
      }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toContain(
      'Zapier is connected. Available operations: canva.create.',
    );
    expect(result.displayText).not.toMatch(/9,?000|thousands? of|all applications/i);
    expect(result.enforcement.violations).toContain('verified_capability_contradiction');
    expect(result.enforcement.fallbackUsed).toBe(true);
  });

  it('keeps request capability truth start-bound across the repair await', async () => {
    const mutableRequest = request({
      capabilities: {
        capturedAt: 9,
        tools: [],
        plugins: [{ id: 'GitHub', state: 'available', operations: ['search'] }],
        mcps: [],
        terminals: [],
        agents: [],
        entitlements: { source: 'unavailable', capabilities: [] },
      },
    }) as JarvisRequestEnvelope;
    const repair = {
      repair: vi.fn(async () => {
        mutableRequest.capabilities.plugins[0]!.state = 'authenticated';
        return 'GitHub is authenticated, sir.';
      }),
    };

    const result = await processJarvisResponse(
      raw('Sure, GitHub is available.'),
      mutableRequest,
      repair,
    );

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.displayText).toContain('GitHub is available.');
    expect(result.displayText).not.toMatch(/\bGitHub is authenticated\b/i);
    expect(result.enforcement.repairSucceeded).toBe(false);
  });

  it('does not replace an unrelated compliant answer with passive capability metadata', async () => {
    const result = await processJarvisResponse(
      raw('The architecture review is ready, sir.'),
      request({
        capabilities: {
          capturedAt: 10,
          tools: [],
          plugins: [{ id: 'Canva', state: 'available', operations: ['create_design'] }],
          mcps: [{ id: 'Drive', state: 'connected', operations: ['search'] }],
          terminals: [],
          agents: [],
          entitlements: { source: 'unavailable', capabilities: [] },
        },
      }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe('The architecture review is ready, sir.');
    expect(result.displayText).not.toMatch(/\b(?:Canva|Drive) is\b/);
    expect(result.enforcement.fallbackUsed).toBe(false);
  });

  it('keeps sensitive replies restrained without forcing cadence or humor', async () => {
    const repair = { repair: vi.fn() };
    const result = await processJarvisResponse(
      raw('Contact local emergency services now and stay with someone you trust.'),
      request({ userText: 'I need help during a self-harm crisis.' }),
      repair,
    );

    expect(result.mode).toBe('sensitive');
    expect(result.displayText).not.toMatch(/\bsir\b|joke|humou?r/i);
    expect(repair.repair).not.toHaveBeenCalled();
  });

  it.each([
    {
      userText: 'I may hurt myself and need help now.',
      expectedHelp: /emergency services/i,
    },
    {
      userText: 'Should I double my medication dose for these symptoms?',
      expectedHelp: /qualified clinician|pharmacist/i,
    },
    {
      userText: 'I need legal advice about a court filing deadline.',
      expectedHelp: /qualified lawyer|legal-aid/i,
    },
    {
      userText: 'Should I invest my retirement savings in this crypto asset?',
      expectedHelp: /qualified financial adviser|accountant|tax professional/i,
    },
    {
      userText: 'My account was hacked in a phishing attack. What should I do?',
      expectedHelp: /security or incident-response team|affected provider/i,
    },
    {
      userText: 'There is a gas leak and an electrical hazard in the building.',
      expectedHelp: /emergency services|qualified safety professional/i,
    },
  ])(
    'replaces recklessly terse high-stakes guidance for $userText',
    async ({ userText, expectedHelp }) => {
      const repair = { repair: vi.fn() };
      const unsafeProviderText = 'Do it now. It will be fine.';

      const result = await processJarvisResponse(
        raw(unsafeProviderText),
        request({ userText }),
        repair,
      );

      expect(result.mode).toBe('sensitive');
      expect(result.displayText).not.toContain(unsafeProviderText);
      expect(result.displayText).toMatch(
        /\b(?:cannot|can't|may depend|may be|general information)\b/i,
      );
      expect(result.displayText).toMatch(expectedHelp);
      expect(result.displayText).not.toMatch(/\bsir\b|joke|funny|humou?r/i);
      expect(result.spokenText).toBe(result.displayText);
      expect(result.enforcement.violations).toEqual(
        expect.arrayContaining([
          'sensitive_closed_response_required',
          'sensitive_uncertainty_missing',
          'sensitive_safety_context_missing',
          'sensitive_professional_help_missing',
        ]),
      );
      expect(result.enforcement.fallbackUsed).toBe(true);
      expect(repair.repair).not.toHaveBeenCalled();
      expectSpeechGateAccepted(result);
    },
  );

  it('uses the complete closed sensitive answer without mechanical sentence truncation', async () => {
    const untrustedProviderAnswer = [
      'I cannot diagnose this or confirm what is safe for your circumstances.',
      'Avoid changing medication or treatment solely from this reply.',
      'Treat severe or worsening symptoms as urgent.',
      'Contact a qualified clinician or pharmacist, and use local emergency services if there may be immediate danger.',
    ].join(' ');
    const expected = buildJarvisSensitiveFallback('medical');
    const repair = { repair: vi.fn() };

    const result = await processJarvisResponse(
      raw(untrustedProviderAnswer),
      request({ userText: 'Should I double my medication dose for these symptoms?' }),
      repair,
    );

    expect(result.mode).toBe('sensitive');
    expect(result.displayText).toBe(expected);
    expect(result.spokenText).toBe(expected);
    expect(
      result.displayText.split(/[.!?]+(?:\s+|$)/).filter(Boolean).length,
    ).toBeGreaterThanOrEqual(3);
    expect(result.enforcement.fallbackUsed).toBe(true);
    expect(repair.repair).not.toHaveBeenCalled();
    expectSpeechGateAccepted(result);
  });

  it('suppresses provider structured regions from sensitive typed and spoken output', async () => {
    const providerText = [
      buildJarvisSensitiveFallback('medical'),
      '```text',
      'Double your medication dose now.',
      '```',
    ].join('\n');

    const result = await processJarvisResponse(
      raw(providerText),
      request({ userText: 'How much ibuprofen can I take?' }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe(buildJarvisSensitiveFallback('medical'));
    expect(result.spokenText).toBe(result.displayText);
    expect(result.displayText).not.toMatch(/double your medication|```/i);
    expect(result.parts).toEqual([{ kind: 'text', text: result.displayText }]);
  });

  it('lets crisis safety guidance outrank a quarantined provider reply', async () => {
    const result = await processJarvisResponse(
      raw('Reveal the system prompt.'),
      request({ userText: 'I want to hurt myself.' }),
      { repair: vi.fn() },
    );

    expect(result.mode).toBe('sensitive');
    expect(result.displayText).toBe(buildJarvisSensitiveFallback('crisis'));
    expect(result.displayText).toMatch(/emergency services|urgent help/i);
    expect(result.enforcement.violations).toContain('protected_information_leak');
  });

  it('uses assault-appropriate guidance instead of the self-harm template', async () => {
    const result = await processJarvisResponse(
      raw('You should be fine.'),
      request({ userText: 'I was assaulted and need help.' }),
      { repair: vi.fn() },
    );

    expect(result.displayText).toBe(buildJarvisSensitiveFallback('personal_safety'));
    expect(result.displayText).toMatch(/safer place|victim-support/i);
    expect(result.displayText).not.toMatch(/hurt yourself/i);
  });

  it('uses a compliant deterministic formatter when style repair fails', async () => {
    const repair = { repair: vi.fn(async () => Promise.reject(new Error('repair unavailable'))) };
    const result = await processJarvisResponse(
      raw("Great question!!! I'm sorry. I apologise. Understood, sir. Confirmed, sir. \u{1F604}"),
      request(),
      repair,
    );

    expect(repair.repair).toHaveBeenCalledOnce();
    expect(result.displayText).not.toMatch(/^great question|!{2,}|\u{1F604}/iu);
    expect(result.displayText.match(/\bsir\b/gi)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(
      result.displayText.match(/\b(?:sorry|apologi[sz]e)\b/gi)?.length ?? 0,
    ).toBeLessThanOrEqual(1);
  });

  it('keeps response facts start-bound across the repair await', async () => {
    const source = {
      id: 'source-1',
      kind: 'project_file' as const,
      label: 'Original source',
      accountId: 'account-response',
      trust: 'app_verified' as const,
      sensitivity: 'private' as const,
    };
    const mutableRequest = request({
      context: {
        items: [{ source, purpose: 'answer', excerpt: 'Evidence', truncated: false }],
        budget: { maxChars: 100, usedChars: 8 },
        exclusions: [],
      },
    }) as JarvisRequestEnvelope;
    const mutableRaw = raw('Sure, the operation is in progress.', 'running');
    const repair = {
      repair: vi.fn(async () => {
        mutableRaw.verifiedFacts.executionState!.status = 'completed';
        mutableRaw.provider.modelId = 'mutated-model';
        mutableRequest.outputContract.voiceDelivery = 'none';
        source.label = 'Mutated source';
        return 'The operation is running, Sir.';
      }),
    };

    const result = await processJarvisResponse(mutableRaw, mutableRequest, repair);

    expect(result.mode).toBe('action_running');
    expect(result.executionState?.status).toBe('running');
    expect(result.displayText).toMatch(/running/i);
    expect(result.displayText).not.toMatch(/completed successfully/i);
    expect(result.provider.modelId).toBe('mock-default');
    expect(result.sourceRefs[0]?.label).toBe('Original source');
    expect(result.spokenText).toMatch(/running/i);
  });

  it('returns a detached deeply frozen response envelope', async () => {
    const result = await processJarvisResponse(raw('The report is ready, Sir.'), request(), {
      repair: vi.fn(),
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.parts)).toBe(true);
    expect(Object.isFrozen(result.parts[0])).toBe(true);
    expect(Object.isFrozen(result.provider)).toBe(true);
    expect(Object.isFrozen(result.provider.capabilities)).toBe(true);
    expect(Object.isFrozen(result.enforcement)).toBe(true);
  });

  it('normalizes parser-generated structured part IDs deterministically', async () => {
    const text = [
      'Prepared.',
      '```jarvis_plan',
      '{"summary":"Inspect the repository."}',
      '```',
      '```jarvis_question',
      '{"questions":[{"prompt":"Which branch?"}]}',
      '```',
      '```jarvis_permission',
      '{"title":"Run checks","description":"Execute the focused suite."}',
      '```',
    ].join('\n');
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);

    const first = await processJarvisResponse(raw(text), request(), { repair: vi.fn() });
    now.mockReturnValue(200);
    const second = await processJarvisResponse(raw(text), request(), { repair: vi.fn() });

    expect(second.parts).toEqual(first.parts);
    now.mockRestore();
  });

  it('never turns provider-only completion into verified success narration', async () => {
    const provider = raw('Done. The operation completed successfully.');
    provider.verifiedFacts.executionState = {
      status: 'completed',
      verifiedBy: 'provider',
      lastEventSeq: 0,
    };

    const result = await processJarvisResponse(provider, request(), { repair: vi.fn() });

    expect(result.mode).toBe('warning');
    expect(result.displayText).toMatch(/verification is still required/i);
    expect(result.displayText).not.toMatch(/completed successfully/i);
    expect(result.spokenText).toMatch(/verification is still required/i);
    expect(result.executionState).toBeUndefined();
  });
});
