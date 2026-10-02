import {useAuthStore} from '@/stores/auth';
import {getActiveAccountIdentity} from '@/lib/accountIdentity';
import {chatRepo,eventRepo} from '@/lib/db/repositories';
import {assertActionRequestLive} from '@/lib/actions/types';
import type {ActionRunContext} from '@/lib/actions/types';
export type ActionResourceScope={accountId:string;workspaceId:string;projectId:string};
type Row={workspace_id:string;project_id?:string|null};
export type ActionResourceScopeDependencies={current():ActionResourceScope|null;chat(id:string):Promise<Row|undefined|null>;event(id:string):Promise<Row|undefined|null>};
const production:ActionResourceScopeDependencies={
 current(){const auth=useAuthStore.getState();const accountId=getActiveAccountIdentity()?.accountId;return accountId&&auth.workspaceId&&auth.projectId?{accountId,workspaceId:String(auth.workspaceId),projectId:String(auth.projectId)}:null;},
 chat:(id)=>chatRepo.getById(id as never),event:(id)=>eventRepo.getById(id as never),
};
function matches(row:Row|undefined|null,scope:ActionResourceScope){return Boolean(row&&String(row.workspace_id)===scope.workspaceId&&String(row.project_id??'')===scope.projectId);}
/** Manual UI callers retain their existing path; canonical AI mutations require owner scope and a live approved request. */
export async function assertRegisteredResourceScope(context:ActionRunContext,kind:'chat'|'schedule'|'project',id:string,dependencies:ActionResourceScopeDependencies=production):Promise<()=>Promise<void>>{
 if(context.source!=='ai')return async()=>assertActionRequestLive(context);
 if(!context.accountId||!context.runId||!context.approvalId||!context.requestId||!context.chatId)throw new Error('Approved action correlation is required.');
 const scope=dependencies.current();
 if(!scope||scope.accountId!==context.accountId)throw new Error('The active action account is unavailable.');
 await assertActionRequestLive(context);
 const caller=await dependencies.chat(context.chatId);
 const target=kind==='project'?caller:kind==='chat'?await dependencies.chat(id):await dependencies.event(id);
 if(!matches(caller,scope)||!matches(target,scope))throw new Error('The action resource is outside the active project.');
 const recheck=async()=>{await assertActionRequestLive(context);const current=dependencies.current();if(!current||current.accountId!==scope.accountId||current.workspaceId!==scope.workspaceId||current.projectId!==scope.projectId)throw new Error('The active action scope changed.');};
 await recheck();return recheck;
}
