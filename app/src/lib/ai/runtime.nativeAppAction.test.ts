import { describe,it,expect,vi } from 'vitest';
import { hasExplicitNativeAppAction } from '@/lib/ai/runtime';
import type { JarvisRequestEnvelope } from '@/lib/jarvis/contracts';
import type { JarvisActionCatalog } from '@/lib/jarvis/actions/catalog';
const fence = (id='milestone.create',params: unknown={title:'S61 fixture'}) => '```action\n'+JSON.stringify({id,params})+'\n```';
const req = { interactionMode:'agent',outputContract:{allowActionBlocks:true},capabilities:{actionSchemas:[{id:'milestone.create',version:1}]}} as JarvisRequestEnvelope;
const validateParameters=vi.fn((params) => { if(typeof params.title!=='string' || !params.title) throw Error('invalid title'); return params; });
const definition={id:'milestone.create',version:1,exposeToAI:true,validateParameters};
const catalog={resolve:(id:string)=>id==='milestone.create'?definition:undefined} as unknown as JarvisActionCatalog;
describe('native explicit app action admission',()=>{
 it('admits valid advertised milestone with Agent contract and parameter validation',()=>{expect(hasExplicitNativeAppAction(fence(),req,catalog)).toBe(true);expect(validateParameters).toHaveBeenCalledWith({title:'S61 fixture'});});
 it('keeps refusal prose out of the action path',()=>expect(hasExplicitNativeAppAction('I cannot create that milestone.',req,catalog)).toBe(false));
 it('rejects Ask even when an erroneous output contract permits blocks',()=>expect(hasExplicitNativeAppAction(fence(),{...req,interactionMode:'ask'},catalog)).toBe(false));
 it('rejects disabled output contract',()=>expect(hasExplicitNativeAppAction(fence(),{...req,outputContract:{...req.outputContract,allowActionBlocks:false}},catalog)).toBe(false));
 it('rejects malformed JSON and schema-invalid params',()=>{expect(hasExplicitNativeAppAction('```action\n{broken}\n```',req,catalog)).toBe(false);expect(hasExplicitNativeAppAction(fence('milestone.create',{title:42}),req,catalog)).toBe(false);});
 it('rejects unregistered, unadvertised and retired actions',()=>{expect(hasExplicitNativeAppAction(fence('not.registered'),req,catalog)).toBe(false);expect(hasExplicitNativeAppAction(fence(),{...req,capabilities:{...req.capabilities,actionSchemas:[]}},catalog)).toBe(false);expect(hasExplicitNativeAppAction(fence('terminal.run'),req,{resolve:()=>definition} as unknown as JarvisActionCatalog)).toBe(false);});
 it('does not admit a mixed or multiple action batch',()=>expect(hasExplicitNativeAppAction(fence()+'\n'+fence('terminal.run'),req,catalog)).toBe(false));
});

import { processJarvisResponse,type RawProviderResponse } from '@/lib/jarvis/response/pipeline';
import { prependOpenCodePublicTimeline } from '@/lib/ai/runtime';
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


it('keeps a parsed pending app proposal through the real native timeline projection',async()=>{
 const text='Prepared.\n\n```action\n{"id":"milestone.create","params":{"title":"S61 fixture"}}\n```';
 const processed=await processJarvisResponse(raw(text),request(),{repair:vi.fn(async()=>{throw Error('no repair');})});
 const merged=prependOpenCodePublicTimeline(processed,[{kind:'text',text}]);
 expect(merged.parts.filter(part=>part.kind==='action_proposal')).toEqual([expect.objectContaining({kind:'action_proposal',action_id:'milestone.create',status:'pending',call_id:'jarvis_action_jreq_response_1_0'})]);
});
