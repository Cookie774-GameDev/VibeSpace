import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({rows:[] as unknown[], query:Promise.resolve(undefined) as Promise<unknown>}));
vi.mock('dexie-react-hooks',()=>({useLiveQuery:(query:()=>Promise<unknown>)=>{mocks.query=query();return undefined;}}));
vi.mock('@/lib/db',()=>({db:{chats:{get:async()=>({project_id:'p'})},cao_missions:{toArray:async()=>mocks.rows}}}));
vi.mock('./mission/missionStore',()=>({createCaoMissionStoreFromDatabase:()=>({list:async(scope:unknown)=>{expect(scope).toEqual({accountId:'a',workspaceId:'w'});return mocks.rows;}})}));
vi.mock('@/stores/auth',()=>({useAuthStore:(selector:(state:unknown)=>unknown)=>selector({localUserId:'a',workspaceId:'w',cloudSession:null})}));
vi.mock('@/stores/ui',()=>({useUIStore:(selector:(state:unknown)=>unknown)=>selector({activeChatId:'chat'})}));
vi.mock('@/lib/accountIdentity',()=>({resolveAccountIdentity:()=>({accountId:'a'})}));
import { useIdleCaoMission } from './useIdleCaoMission';
beforeEach(()=>{mocks.rows=[]});
it('uses only active missions in this account and workspace, preferring the current project',async()=>{
 mocks.rows=[{id:'foreign',accountId:'other',workspaceId:'w',projectId:'p',status:'running',updatedAt:999},
 {id:'finished',accountId:'a',workspaceId:'w',projectId:'p',status:'completed',updatedAt:999},
 {id:'other-project',accountId:'a',workspaceId:'w',projectId:'q',status:'running',updatedAt:80},
 {id:'current',accountId:'a',workspaceId:'w',projectId:'p',status:'running',updatedAt:20}];
 renderHook(()=>useIdleCaoMission(true));expect(await mocks.query).toMatchObject({id:'current'});
});
it('falls back to the clock when there is no active mission or the option is disabled',async()=>{
 renderHook(()=>useIdleCaoMission(true));expect(await mocks.query).toBeUndefined();
 mocks.rows=[{id:'m',accountId:'a',workspaceId:'w',status:'running'}];
 renderHook(()=>useIdleCaoMission(false));expect(await mocks.query).toBeUndefined();
});
