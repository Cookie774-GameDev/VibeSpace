import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { recordCodexProviderAccountProof, recordCodexProviderAccountInvalidation } from './codexProviderAccountProof';
type Metadata = Readonly<Record<string, string | number | boolean | null | undefined>>;
const binding = { requestId:'request',runId:'run',chatId:'chat',generation:'generation',connectionId:'openai-codex',modelId:'gpt-6-luna',accountScopeHash:'a'.repeat(64),protectedAttemptBound:true,effort:'low',fastVariant:'standard' };
const frame = {id:'rpc',result:{requiresOpenaiAuth:true,account:{type:'chatgpt',email:'synthetic@example.invalid',planType:'pro'}}};
const recorder = () => vi.fn((_kind:string,_phase:string,_data:Metadata)=>undefined);
it('records actual correlated account hash with exact protected turn scope and no private identity/plan',async()=>{
 const record=recorder(); await recordCodexProviderAccountProof(binding,'thread','rpc',async()=>frame,()=>true,record);
 expect(record).toHaveBeenCalledTimes(1); const data=record.mock.calls[0][2];
 expect(data).toMatchObject({requestId:'request',runId:'run',generation:'generation',sessionId:'thread',observation:'ACTUAL_PROVIDER_ACCOUNT_RPC',refreshToken:false});
 expect(data.authenticatedAccountHash).toBe(createHash('sha256').update('S61-codex-account-v1\0synthetic@example.invalid').digest('hex'));
 expect(JSON.stringify(data)).not.toContain('@'); expect(data).not.toHaveProperty('planType');
});
it('does not read for foreign connection or unprotected application account',async()=>{
 const read=vi.fn(async()=>frame),record=recorder();
 for(const override of [{protectedAttemptBound:false},{connectionId:'openai-api'},{accountScopeHash:'UUID'}])await recordCodexProviderAccountProof({...binding,...override},'thread','rpc',read,()=>true,record);
 expect(read).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
});
it('rejects foreign response correlation and RPC errors without retaining raw private error',async()=>{
 const record=recorder(); for(const bad of [{...frame,id:'other'},{...frame,error:{message:'PRIVATE_ERROR'}}])await recordCodexProviderAccountProof(binding,'thread','rpc',async()=>bad,()=>true,record);
 expect(record).not.toHaveBeenCalled();
});
it('does not substitute plan/type/application scope for missing unique provider identity',async()=>{
 const record=recorder(); for(const account of [{type:'chatgpt',planType:'pro'},{type:'chatgpt',email:''},{type:'apiKey',email:'synthetic@example.invalid'}])await recordCodexProviderAccountProof(binding,'thread','rpc',async()=>({id:'rpc',result:{requiresOpenaiAuth:true,account}}),()=>true,record);
 expect(record).not.toHaveBeenCalled();
});
it('rejects abort/generation release during the read',async()=>{
 let current=true;const record=recorder();await recordCodexProviderAccountProof(binding,'thread','rpc',async()=>{current=false;return frame;},()=>current,record);expect(record).not.toHaveBeenCalled();
});
it('native read failure remains unverified with zero retry and no thrown model failure',async()=>{
 const read=vi.fn(async()=>{throw Error('PRIVATE_ERROR');}),record=recorder();await recordCodexProviderAccountProof(binding,'thread','rpc',read,()=>true,record);expect(read).toHaveBeenCalledTimes(1);expect(record).not.toHaveBeenCalled();
});
it('same generation account notification during read invalidates the correlated proof',async()=>{
 let epoch=1;const record=recorder();await recordCodexProviderAccountProof(binding,'thread','rpc',async()=>{epoch++;return frame;},()=>true,record,()=>epoch);expect(record).not.toHaveBeenCalled();
});
it('records only safe native account invalidation enums, without notification params',()=>{
 const record=recorder();for(const method of ['account/updated','account/login/completed'])expect(recordCodexProviderAccountInvalidation('generation',2,{method,params:{email:'PRIVATE_EMAIL',token:'PRIVATE_TOKEN'}},record)).toBe(true);
 expect(record).toHaveBeenCalledTimes(2);expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE_');
 expect(recordCodexProviderAccountInvalidation('generation',3,{method:'turn/completed'},record)).toBe(false);
});