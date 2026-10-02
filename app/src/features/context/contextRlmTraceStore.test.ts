import { describe, expect, it } from 'vitest';
import type { RlmTerminalReceipt } from '@/features/context/rlmRuntime';
import { createRlmTraceStore, type RlmTraceScope } from './contextRlmTraceStore';

const scope: RlmTraceScope = { accountId: 'account', workspaceId: 'workspace', projectId: 'project', worktreeId: 'worktree', chatId: 'chat', contextRevision: 'revision-1' };
function terminal(runId='rlm-safe-1', status='completed') {
  return { runId, status, startedAt:10, endedAt:20, trace: { mode:'rlm', runId, wallTimeMs:10, events:[{type:'root_started',at:10,depth:0,detail:'PRIVATE-PROMPT-CANARY'}],toolInvocations:[],usage:{subcalls:0,toolCalls:0,openBytes:0,maxDepthReached:0},budgetExhausted:false },question:'PRIVATE-QUESTION-CANARY',answer:'PRIVATE-ANSWER-CANARY',auth:'PRIVATE-AUTH-CANARY' };
}
const receipt=(value:ReturnType<typeof terminal>)=>value as unknown as RlmTerminalReceipt;
describe('scoped bounded RLM terminal trace metadata',()=>{
 it('looks up real zero-call terminal metadata without retaining private payloads',()=>{
  const store=createRlmTraceStore();const input=terminal('rlm-zero-failure','failed');
  expect(store.publish(scope,receipt(input))).toBe(true);const result=store.lookup(scope,input.runId)!;
  expect(result).toMatchObject({runId:'rlm-zero-failure',status:'failed',trace:{toolInvocations:[],usage:{toolCalls:0},startedAt:10,endedAt:20}});
  expect(JSON.stringify(result)).not.toContain('PRIVATE-');
 });
 for(const field of ['accountId','workspaceId','projectId','worktreeId','chatId','contextRevision'] as const)it(`denies ${field} mismatch without a distinguishable not-found result`,()=>{
  const store=createRlmTraceStore();store.publish(scope,receipt(terminal()));
  expect(store.lookup({...scope,[field]:`${scope[field]}-other`},'rlm-safe-1')).toBeUndefined();
  expect(store.lookup(scope,'unknown')).toBeUndefined();
 });
 it('distinguishes absent optional scope fields from a real scoped identity',()=>{
  const store=createRlmTraceStore();const missing={...scope,worktreeId:undefined};store.publish(missing,receipt(terminal()));
  expect(store.lookup(scope,'rlm-safe-1')).toBeUndefined();expect(store.lookup(missing,'rlm-safe-1')).toBeDefined();
 });
 it('isolates caller mutation and rejects terminal receipt replacement',()=>{
  const store=createRlmTraceStore();const input=terminal();store.publish(scope,receipt(input));input.trace.usage.toolCalls=900;
  expect(store.lookup(scope,input.runId)!.trace.usage.toolCalls).toBe(0);
  const returned=store.lookup(scope,input.runId)!;expect(Object.isFrozen(returned.trace.usage)).toBe(true);
  expect(store.publish(scope,receipt(terminal(input.runId,'failed')))).toBe(false);expect(store.lookup(scope,input.runId)!.status).toBe('completed');
 });
 it('expires and evicts metadata within account and global bounds',()=>{
  let now=100;const store=createRlmTraceStore({now:()=>now,ttlMs:10,maxEntries:3,maxEntriesPerAccount:2});
  for(let i=1;i<=3;i++)store.publish(scope,receipt(terminal(`rlm-${i}`)));
  expect(store.lookup(scope,'rlm-1')).toBeUndefined();expect(store.lookup(scope,'rlm-2')).toBeDefined();
  store.publish({...scope,accountId:'second'},receipt(terminal('rlm-other-1')));store.publish({...scope,accountId:'third'},receipt(terminal('rlm-other-2')));
  expect(store.lookup(scope,'rlm-2')).toBeUndefined();expect(store.lookup(scope,'rlm-3')).toBeDefined();
  now=110;expect(store.lookup(scope,'rlm-3')).toBeUndefined();
 });
 it('rejects invalid scope and timing instead of inventing call timestamps',()=>{
  const store=createRlmTraceStore();expect(store.publish({...scope,chatId:''},receipt(terminal()))).toBe(false);
  const invalid=terminal();invalid.endedAt=9;expect(store.publish(scope,receipt(invalid))).toBe(false);
 });
 it('bounds metadata with explicit omitted counts and preserves actual usage',()=>{
  const store=createRlmTraceStore();const input=terminal();input.trace.events=Array.from({length:300},()=>({type:'root_started',at:10,depth:0,detail:'PRIVATE-PROMPT-CANARY'}));
  store.publish(scope,receipt(input));expect(store.lookup(scope,input.runId)!.trace).toMatchObject({metadataTruncated:true,omittedEvents:44,usage:{toolCalls:0}});
 });
 it('retains cancellation and timeout as distinct real terminal statuses',()=>{
  const store=createRlmTraceStore();for(const status of ['cancelled','timed_out']){const input=terminal(`rlm-${status}`,status);store.publish(scope,receipt(input));expect(store.lookup(scope,input.runId)!.status).toBe(status);}
 });
});
