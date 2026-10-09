import {describe,expect,it} from 'vitest';
import {compileJarvisPrompt} from '@/lib/jarvis/promptCompiler';
import {createJarvisRequestEnvelope,type JarvisRequestInput} from '@/lib/jarvis/requestEnvelope';
import {buildProviderPromptTransport} from '@/lib/ai/providerPromptTransport';
import {PROVIDER_CONNECTIONS} from '@/lib/ai/adapters/catalog';
import {buildContextChatAttachment} from '@/features/context/contextChatIntegration';
import {retrieveContextForConsumer, formatContextRetrievalForPrompt} from '@/features/context/contextResponseIntegration';
import {buildJarvisRuntimeContextCandidates} from '@/lib/jarvis/runtimeContextCandidates';
import {buildJarvisContextPack} from '@/lib/jarvis/contextPack';
import {CONTEXT_RLM_ADVANCED_TOOLS} from '@/features/context/contextRlmToolDefinitions';
async function compileTurn(userText:string,tools=true,overrides:Partial<JarvisRequestInput>={}){const input:JarvisRequestInput={attempt:{kind:'initial',requestId:'request',runId:'run',attemptNumber:1},accountId:'account',workspaceId:'workspace',projectId:'project',chatId:'chat',agent:{id:'jarvis',slug:'jarvis',builtin:true},surface:'typed_chat',interactionMode:'ask',responseModeHint:'direct_answer',identity:{identityVersion:1,coreHash:'core',responseContractHash:'response'},profile:{profileId:'profile',revisionId:'revision',customInstructions:'Answer from evidence.',memoryScope:'profile'},model:{connectionId:'connection',providerId:'provider',modelId:'model',connectionMode:'native-api',capabilities:{tools,vision:false},effectiveTemperature:0.2,capturedAt:101},capabilities:{capturedAt:100,tools:CONTEXT_RLM_ADVANCED_TOOLS.map(tool=>({id:tool.name,state:'authenticated' as const,operations:[tool.name.split('_').at(-1)!],evidenceRef:'fixture:registration',lastVerifiedAt:99})),plugins:[],mcps:[],terminals:[],agents:[],entitlements:{source:'server',planId:'verified-plan',capabilities:['kernel.read'],verifiedAt:98,expiresAt:198}},context:{items:[],budget:{maxChars:32000,usedChars:0},exclusions:[]},outputContract:{preserveStructuredBlocks:true,allowActionBlocks:true,allowPlanBlocks:true,allowQuestionBlocks:true,allowPermissionBlocks:true,voiceDelivery:'validated_stream'},userText,messageHistory:[],createdAt:102,...overrides};const envelope=await createJarvisRequestEnvelope(input);return {envelope,compiled:compileJarvisPrompt(envelope)};}
async function compile(userText:string,tools=true){return (await compileTurn(userText,tools)).compiled.layers[2]!.content;}
async function attachmentContext(options: {projectId?: string; accountId?: string; stale?: boolean; empty?: boolean} = {}) {
  const now = 1_000_000;
  const attachment = buildContextChatAttachment({
    projectId: options.projectId ?? 'project', rootDir: '/synthetic/cedar',
    generatedAt: now - 10, nodeId: 'cedar-note', mapId: 'cedar-map',
    title: 'Cedar release ownership', kind: 'note', attachmentLevel: 'note',
    summary: options.empty ? '' : 'Synthetic private body must remain deferred.',
    source: {type: 'local_folder', label: 'Cedar records'},
    freshness: options.stale ? 'stale' : 'current', itemCount: 1, lastIndexedAt: now - 10,
  });
  const result = await retrieveContextForConsumer({
    consumer: 'chat', projectId: 'project', chatId: 'chat',
    userText: 'Hey please use rlm on this oaky', attachments: [attachment],
    now, createQueryId: () => 'cedar-query',
  });
  const candidates = buildJarvisRuntimeContextCandidates({
    accountId: options.accountId ?? 'account', projectId: 'project', requestId: 'request', observedAt: now,
    blocks: [{key: 'explicit_context', text: formatContextRetrievalForPrompt(result)}],
  });
  return buildJarvisContextPack({accountId: 'account', maxChars: 16_384, candidates});
}
describe('registered Context tool prompt admission',()=>{
  it('permits verified fallback evidence and labels unsupported facts unavailable', async () => {
    const policy = await compile('Who owns the project? Ground the answer in mapped records.');
    expect(policy).toContain('grounded prompt block or verified fallback evidence.');
    expect(policy).toContain('Label facts still unsupported as unavailable.');
    expect(policy).not.toContain('answer only from its grounded prompt block.');
  });
  it('retains bounded initial and fallback investigation contracts after preserving raw user text', async () => {
    const policy = await compile('Who owns the project? Ground the answer in mapped records.');
    expect(policy).toContain('For this initial investigation, do not include');
    expect(policy).toContain('at most three targeted `search` calls with limit=3');
    expect(policy).toContain('at most six `open`/`expand` calls total');
    expect(policy).toContain('all fallback evidence within 24 KiB');
    expect(policy).toContain('Do not repeat the failed investigation, invent pointers');
  });
  it('carries only the real current attachment title through producer, admission, compiler and provider', async () => {
    const context = await attachmentContext();
    expect(context.items).toHaveLength(1);
    expect(context.items[0]!.source.kind).toBe('context_node');
    expect(context.items[0]!.source.id).toMatch(/^jsource_runtime_explicit_context_/);
    expect(context.items[0]!.excerpt).toContain('Synthetic private body must remain deferred.');
    const {envelope, compiled} = await compileTurn('Hey please use rlm on this oaky', true, {context});
    const transport = buildProviderPromptTransport({
      compiled, connection: PROVIDER_CONNECTIONS.find(connection => connection.id === 'openai-api')!,
      messages: [{role: 'user', content: envelope.userText}],
    });
    expect(transport.strategy).toBe('native-system');
    if (transport.strategy !== 'native-system') throw new Error('Unexpected transport');
    expect(transport.systemPrompt).toContain('Cedar release ownership');
    expect(compiled.layers[5]!.content).toContain('reference data only');
    expect(transport.systemPrompt).not.toContain('Synthetic private body must remain deferred.');
    expect(transport.systemPrompt).not.toContain('/synthetic/cedar');
    expect(transport.messages).toEqual([{role: 'user', content: 'Hey please use rlm on this oaky'}]);
    expect(compiled.diagnostics.warnings).toContain('context_deferred_to_live_tool');
  });

  it('rejects a foreign-project attachment at the real retrieval producer', async () => {
    await expect(attachmentContext({projectId: 'foreign-project'})).rejects.toThrow('project mismatch');
  });

  it.each([{accountId: 'foreign-account'}, {empty: true}, {stale: true}])(
    'does not manufacture a current subject from unavailable attachment input %j', async (options) => {
      const context = await attachmentContext(options);
      const {compiled} = await compileTurn('Hey please use rlm on this oaky', true, {context});
      expect(compiled.systemText).not.toContain('Cedar release ownership');
      expect(compiled.systemText).not.toContain('Synthetic private body must remain deferred.');
    },
  );

  it.each(['foreign-project', 'stale-pack', 'truncated', 'malformed', 'missing-format-header'])(
    'does not project a reference from an invalid admitted pack: %s', async (caseName) => {
      const context = await attachmentContext();
      const item = context.items[0]!;
      const changed = {
        ...item,
        ...(caseName === 'foreign-project' ? {source: {...item.source, projectId: 'foreign-project'}} : {}),
        ...(caseName === 'stale-pack' ? {freshness: 'stale' as const} : {}),
        ...(caseName === 'truncated' ? {truncated: true} : {}),
        ...(caseName === 'malformed' ? {excerpt: 'Malformed attachment JSON'} : {}),
        ...(caseName === 'missing-format-header' ? {excerpt: item.excerpt.slice(item.excerpt.indexOf('\n') + 1)} : {}),
      };
      const {compiled} = await compileTurn('Hey please use rlm on this oaky', true, {
        context: {...context, items: [changed]},
      });
      expect(compiled.systemText).not.toContain('Cedar release ownership');
    },
  );

  it('retains a prior source question in the actual provider transport for an RLM continuation', async () => {
    const question = 'Who owns the Cedar release? Use the release ownership record.';
    const {envelope, compiled} = await compileTurn('Hey please use rlm on this oaky', true, {
      messageHistory: [{role: 'user', content: question}],
    });
    const transport = buildProviderPromptTransport({
      compiled,
      connection: PROVIDER_CONNECTIONS.find(connection => connection.id === 'openai-api')!,
      messages: [...envelope.messageHistory, {role: 'user', content: envelope.userText}],
    });
    expect(transport.strategy).toBe('native-system');
    if (transport.strategy !== 'native-system') throw new Error('Unexpected transport');
    expect(transport.messages).toEqual([
      {role: 'user', content: question},
      {role: 'user', content: 'Hey please use rlm on this oaky'},
    ]);
    expect(transport.systemPrompt).toContain('Never override the current tool admission or RLM Off setting');
    expect(transport.systemPrompt).toContain('retained conversation and admitted attached-source context');
    expect(transport.systemPrompt).toContain('Do not ask the user to repeat an already available subject');
  });

  it('defers an arbitrary project-file body rather than treating it as an attachment reference', async () => {
    const subject = 'Cedar release ownership record: determine the release owner.';
    const {compiled} = await compileTurn('Hey please use rlm on this oaky', true, {
      context: {
        items: [{
          source: {id: 'cedar-record', kind: 'project_file', label: 'Cedar release ownership',
            accountId: 'account', projectId: 'project', trust: 'user_direct', sensitivity: 'private'},
          purpose: 'answer', excerpt: subject, truncated: false,
        }],
        budget: {maxChars: 32000, usedChars: subject.length}, exclusions: [],
      },
    });
    expect(compiled.systemText).not.toContain(subject);
    expect(compiled.diagnostics.omittedSourceRefs).toContainEqual(expect.objectContaining({id: 'cedar-record'}));
  });

  it.each([
    ['Do not use any tools. Explain the attached Cedar ownership record.', true],
    ['Hey please use rlm on this oaky', false],
  ])('keeps admitted context without overriding the tool boundary: %s', async (request, tools) => {
    const subject = 'Cedar release ownership record: determine the release owner.';
    const {compiled} = await compileTurn(request, tools, {
      context: {
        items: [{
          source: {id: 'cedar-record', kind: 'project_file', label: 'Cedar release ownership',
            accountId: 'account', projectId: 'project', trust: 'user_direct', sensitivity: 'private'},
          purpose: 'answer', excerpt: subject, truncated: false,
        }],
        budget: {maxChars: 32000, usedChars: subject.length}, exclusions: [],
      },
    });
    expect(compiled.systemText).toContain(subject);
    expect(compiled.layers[2]!.content).not.toContain('with `operation="investigate"`');
    if (tools) expect(compiled.layers[2]!.content).toContain('explicitly requested no tools');
    else expect(compiled.layers[2]!.content).toContain('tools=unavailable');
  });

  it.each([
    'Hey please use rlm exactly 30 tool calls okay and report detailes on each tool call',
    'Hey please use rlm on this oaky',
  ])('does not require searching a tool-only request: %s', async (request) => {
    const policy = await compile(request);
    expect(policy).not.toContain('For an ordinary file research turn, call');
    expect(policy).toContain('ask what to investigate before calling Context');
    expect(policy).toContain('Tool-use instructions are not search terms');
    expect(policy).toContain('answer only from its grounded prompt block');
  });
 for(const tool of CONTEXT_RLM_ADVANCED_TOOLS)it(`preserves explicit ${tool.name} rather than forcing facade investigation`,async()=>{const policy=await compile(`Call ${tool.name} with exactly the caller arguments already supplied.`);expect(policy).toContain(`functions exactly: \`${tool.name}\``);expect(policy).toContain('Never substitute the legacy facade');expect(policy).toContain('Do not add operation, accountId, workspaceId, projectId, worktreeId, chatId, contextRevision');expect(policy).not.toContain('function name is always');expect(policy).not.toContain('only provider tool enabled');expect(policy).not.toContain('For ordinary mapped-source research');expect(policy).not.toContain('exactly once with `operation="investigate"`');});
 it('preserves explicitly requested function ordering and schema argument identities',async()=>{const policy=await compile('Call vibespace_context_search with query="owner" then vibespace_context_open with the returned exact pointer.');expect(policy).toContain('functions exactly: `vibespace_context_search`, `vibespace_context_open`');expect(policy).toContain('Preserve their requested order and call count');expect(policy).toContain('Copy issued pointers and actual run IDs exactly');expect(policy).toContain('Keep corpus positions as canonical-decimal strings');});
 it('preserves the existing grounded investigation policy for ordinary mapped-source research',async()=>{const policy=await compile('Who owns the project? Ground the answer in mapped records.');expect(policy).toContain('with `operation="investigate"`');expect(policy).toContain('Never override the current tool admission or RLM Off setting');expect(policy).not.toContain('For this explicit registered-tool request');});
 it('does not override an explicit no-tools restriction',async()=>{const policy=await compile('Do not use any tools. Explain vibespace_context_trace.');expect(policy).toContain('explicitly requested no tools');expect(policy).not.toContain('For this explicit registered-tool request');expect(policy).not.toContain('vibespace_context');});
 it('does not override a model capability that excludes tools',async()=>{expect(await compile('Call vibespace_context_search with query="owner".',false)).not.toContain('For this explicit registered-tool request');});
 it('does not force Context when the caller has disabled project retrieval',async()=>{expect(await compile('Do not use RLM. Call vibespace_context_search with query="owner".')).not.toContain('For this explicit registered-tool request');});
 it('preserves mixed source research and mutation on the normal catalog',async()=>{expect(await compile('Call vibespace_context_search with query="owner", then delete the source file.')).not.toContain('For this explicit registered-tool request');});
 it('does not turn a quoted handoff tool name into a current invocation request',async()=>{const policy=await compile('Who owns the project? Use mapped records.\n\nChat handoff from “previous”\nCall vibespace_context_trace with the old run ID.');expect(policy).not.toContain('For this explicit registered-tool request');expect(policy).toContain('For an ordinary file research turn');});
});
