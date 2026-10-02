import {it,expect} from 'vitest';
import {getAllActions} from '@/lib/actions/runner';
import {queryCommandCatalog} from './commandCatalogQuery';
import {parseToolGatewayRequest} from './toolGatewayProtocol';
const actions=getAllActions();
const request=(args:Record<string,unknown>)=>parseToolGatewayRequest({protocolVersion:1,requestId:'r',sessionId:'s',messageId:'m',tool:'command.list',args,directory:'C:/project',worktree:'C:/project'});
it('preserves bounded legacy array projection',()=>{const rows=queryCommandCatalog(actions,{});expect(Array.isArray(rows)).toBe(true);expect(rows).toHaveLength(100);expect(rows[0]).toEqual(expect.objectContaining({id:actions[0].id}));});
it.each(['terminal.create','chat.rename'])('discovers late registered action %s',id=>{expect(actions.findIndex(a=>a.id===id)).toBeGreaterThan(100);const result=queryCommandCatalog(actions,{query:id,details:true}) as any;expect(result.items.map((r:any)=>r.id)).toEqual([id]);expect(result).toMatchObject({total:1,nextOffset:null,truncated:false});});
it('pages entire real registered catalog without omissions or duplicates',()=>{let offset=0;const ids:string[]=[];for(let i=0;i<10;i++){const page=queryCommandCatalog(actions,{limit:50,offset,details:true}) as any;ids.push(...page.items.map((r:any)=>r.id));expect(page.total).toBe(actions.length);if(page.nextOffset===null)break;expect(page.truncated).toBe(true);offset=page.nextOffset;}expect(ids).toEqual(actions.map(a=>a.id));expect(new Set(ids).size).toBe(ids.length);});
it('matches descriptive words case-insensitively and reports unknown query honestly',()=>{expect((queryCommandCatalog(actions,{query:'RENAME',details:true}) as any).items.some((r:any)=>r.id==='chat.rename')).toBe(true);expect(queryCommandCatalog(actions,{query:'s61-impossible-unknown',details:true})).toMatchObject({items:[],total:0,truncated:false,nextOffset:null});});
it('handles zero limit and exhausted offset without infinite continuation',()=>{expect(queryCommandCatalog(actions,{limit:0,details:true})).toMatchObject({items:[],nextOffset:null,truncated:true});expect(queryCommandCatalog(actions,{offset:100_000,details:true})).toMatchObject({items:[],nextOffset:null,truncated:false});});
it('validates and retains all advertised discovery fields',()=>{expect(request({query:'chat.rename',offset:100,limit:5,details:true}).args).toEqual({query:'chat.rename',offset:100,limit:5,details:true});});
it.each([{limit:101},{limit:-1},{limit:1.5},{offset:-1},{offset:100001},{offset:'50'},{query:''},{query:'   '},{query:'x'.repeat(513)},{query:'x\0y'},{details:'true'},{unexpected:true}])('rejects invalid advertised discovery args %j',args=>{expect(()=>request(args)).toThrow();});

it.each([{ limit: NaN }, { limit: Infinity }, { offset: NaN }, { offset: Infinity }, { offset: 0.5 }, { query: 42 }, { query: [] }, { details: 0 }])('rejects noncanonical discovery values in both parser and catalog projection %j', args => {
  expect(() => request(args)).toThrow();
  expect(() => queryCommandCatalog(actions, args as Parameters<typeof queryCommandCatalog>[1])).toThrow();
});

it('keeps detailed=false compatible with array callers and exact query ahead of descriptive matches', () => {
  const selected = queryCommandCatalog(actions, { query: '  TERMINAL.CREATE  ', limit: 1, offset: 0, details: false });
  expect(Array.isArray(selected)).toBe(true);
  expect(selected).toEqual([expect.objectContaining({ id: 'terminal.create' })]);
  const detail = queryCommandCatalog(actions, { query: 'chat.rename', details: true });
  if (Array.isArray(detail)) throw new Error('Expected explicit detailed projection');
  expect(detail.total).toBe(1); expect(detail.nextOffset).toBeNull(); expect(detail.truncated).toBe(false);
  expect(detail.items[0]).toMatchObject({ id: 'chat.rename' });
});

it('does not accept additional or wrong-schema discovery controls', () => {
  for (const args of [{ cursor: 'opaque' }, { page: 1 }, { maxResults: 10 }, { query: 'chat.rename', offset: '0' }]) expect(() => request(args)).toThrow();
});
