import { z } from 'zod';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const short=z.string().max(2000),exact=z.boolean().optional();
const locator=z.union([
 z.object({role:short,name:short.optional(),exact}).strict(),
 z.object({label:short,exact}).strict(),z.object({text:short,exact}).strict(),
 z.object({testId:short}).strict(),z.object({css:short}).strict()
]);
const readTypes=['snapshot','text','input_value','assert_text','assert_text_contains','assert_value','wait','count','screenshot_inline'];
function actionSchema(types){return z.object({type:z.enum(types),selector:short.optional(),locator:locator.optional(),frame_selector:short.optional(),value:z.string().max(100000).optional(),state:z.enum(['visible','hidden','attached','detached']).optional(),x:z.number().int().min(0).max(10000).optional(),y:z.number().int().min(0).max(10000).optional(),to_x:z.number().int().min(0).max(10000).optional(),to_y:z.number().int().min(0).max(10000).optional(),delta_x:z.number().int().min(-10000).max(10000).optional(),delta_y:z.number().int().min(-10000).max(10000).optional(),steps:z.number().int().min(1).max(100).optional()}).strict().superRefine((a,c)=>{
 if(a.selector!==undefined&&a.locator!==undefined)c.addIssue({code:'custom',message:'Choose selector OR locator'});
 if(/\[exact\s*=/.test(a.selector||a.locator?.css||''))c.addIssue({code:'custom',message:'Raw [exact=true] is invalid. Use locator: {role:"button",name:"Create chat",exact:true}.'});
 if(['mouse_click','mouse_move','mouse_drag'].includes(a.type)&&(a.x===undefined||a.y===undefined))c.addIssue({code:'custom',message:a.type+' requires x and y viewport coordinates'});
 if(a.type==='mouse_drag'&&(a.to_x===undefined||a.to_y===undefined))c.addIssue({code:'custom',message:'mouse_drag requires to_x and to_y viewport coordinates'});
 if(a.type==='mouse_wheel'&&a.delta_y===undefined)c.addIssue({code:'custom',message:'mouse_wheel requires delta_y'});
 if(['keyboard_type','keyboard_press'].includes(a.type)&&a.value===undefined)c.addIssue({code:'custom',message:a.type+' requires value'});
});}
const common={session:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),owner:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),max_chars:z.number().int().min(100).max(65536).default(12000),timeout_ms:z.number().int().min(100).max(30000).default(10000)};
export const BrowserSessionSchema=z.object({...common,operation:z.enum(['open','attach','status','snapshot','actions','navigate','close','detach','pages','new_page','select_page']),url:z.string().max(4000).optional(),endpoint:z.string().max(4000).optional(),page_index:z.number().int().min(0).max(100).optional(),target_id:z.string().min(1).max(200).optional(),headed:z.boolean().default(false),actions:z.array(actionSchema([...readTypes,'click','fill','press','screenshot','hover','check','uncheck','select_option','scroll_into_view','mouse_click','mouse_move','mouse_drag','mouse_wheel','keyboard_type','keyboard_press'])).max(32).optional()}).strict();
export const BrowserObserveSchema=z.object({...common,session:common.session.optional(),operation:z.enum(['list','targets','status','snapshot','actions','pages']),endpoint:z.string().max(4000).optional(),actions:z.array(actionSchema(readTypes)).max(32).optional()}).strict().superRefine((a,c)=>{if(!['list','targets'].includes(a.operation)&&!a.session)c.addIssue({code:'custom',message:'session required except for list'});});
function endpointURL(value){let u;try{u=new URL(value);}catch{throw fault('INVALID_ARGUMENT','Valid loopback endpoint required');}if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password)throw fault('INVALID_ARGUMENT','An authorized loopback HTTP CDP endpoint is required');return u;}
export async function discoverTargets(endpoint,timeout=10000){
 const u=endpointURL(endpoint);u.pathname='/json/list';u.search='';u.hash='';
 try{
  const r=await fetch(u,{signal:AbortSignal.timeout(timeout),redirect:'error'});
  if(!r.ok){await r.body?.cancel();throw fault('CONNECTION_ERROR','Target inventory HTTP '+r.status);}
  const reader=r.body?.getReader();if(!reader)throw fault('INVALID_TARGET_INVENTORY','Empty CDP inventory response');
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)throw fault('TARGET_INVENTORY_TOO_LARGE','CDP inventory exceeds the 1 MiB discovery limit');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('INVALID_TARGET_INVENTORY','Endpoint did not return a JSON CDP inventory');}
  if(!Array.isArray(body)||body.length>1000||body.some(p=>!p||typeof p!=='object'||typeof p.type!=='string'||(p.type==='page'&&(typeof p.id!=='string'||!p.id||p.id.length>200||typeof p.url!=='string'))))throw fault('INVALID_TARGET_INVENTORY','Unexpected CDP target inventory; no window selected');
  return body.filter(p=>p.type==='page').slice(0,100).map(p=>({target_id:p.id,title:String(p.title||'').slice(0,2000),url:p.url.slice(0,4000)}));
 }catch(e){if(e.name==='TimeoutError'||e.name==='AbortError')throw fault('TIMEOUT','Read-only target discovery exceeded its deadline');throw e;}
}
async function pageTargetId(page){const cdp=await page.context().newCDPSession(page);try{return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;}finally{await cdp.detach();}}
const sessions=new Map(),queues=new Map(),targetOwners=new Map();
let playwright,opening=0;
export const browserArtifactsDirectory=path.join(process.env.PLUGIN3_DATA_DIR||path.join(os.homedir(),'.plugin3-data'),'browser-artifacts');
const response=(value,error=false,images=[])=>({isError:error,content:[{type:'text',text:JSON.stringify(value)},...images],structuredContent:value});
const fault=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
function safeURL(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol))throw fault('INVALID_ARGUMENT','Only HTTP(S) navigation supported');return u.href;}
function target(page,s){const l=s.locator;if(s.frame_selector)page=page.frameLocator(s.frame_selector);if(!l)return page.locator(s.selector||'body');if(l.role!==undefined)return page.getByRole(l.role,{name:l.name,exact:l.exact});if(l.label!==undefined)return page.getByLabel(l.label,{exact:l.exact});if(l.text!==undefined)return page.getByText(l.text,{exact:l.exact});if(l.testId!==undefined)return page.getByTestId(l.testId);return page.locator(l.css);}
function inventory(){return [...sessions].map(([session,s])=>({session,owner:s.owner??null,owned:s.owned,connected:s.browser.isConnected(),pageClosed:s.page.isClosed(),url:s.page.url(),endpoint:s.endpoint??null,page_index:s.pageIndex??null,createdAt:s.createdAt}));}
async function dispatch(input,readOnly){
 let a;try{a=(readOnly?BrowserObserveSchema:BrowserSessionSchema).parse(input);}catch(e){return response({code:'INVALID_ARGUMENT',layer:'input',error:e.message.slice(0,2000),completed:0,results:[],failedActionIndex:null,replaySafe:false},true);}
 if(readOnly&&a.operation==='targets'){try{return response({targets:await discoverTargets(a.endpoint,a.timeout_ms),attached:false,notice:'Discovery order is not a Playwright page index. Verify the authorized main-window URL/title, then use its target_id. This operation does not attach or control any page.'});}catch(e){return response({code:e.code||'CONNECTION_ERROR',layer:'discovery',error:e.message.slice(0,2000),completed:0,replaySafe:false},true);}}
 if(readOnly&&a.operation==='list')return response({sessions:inventory(),scope:'Browser worker process. Shared broker survives MCP reconnect; broker restart requires explicit attachment.'});
 const previous=queues.get(a.session)||Promise.resolve(),run=previous.catch(()=>{}).then(()=>execute(a,readOnly));queues.set(a.session,run);
 try{return await run;}finally{if(queues.get(a.session)===run)queues.delete(a.session);}
}
export const browserSession=input=>dispatch(input,false);
export const browserObserve=input=>dispatch(input,true);
async function execute(a,readOnly){
 const started=performance.now(),results=[],images=[];let failedActionIndex=null,remaining=a.max_chars;
 const clip=text=>{const n=remaining,v={text:text.slice(0,n),truncated:text.length>n,totalChars:text.length};remaining-=v.text.length;return v;};
 const deadline=()=>{const n=Math.floor(a.timeout_ms-(performance.now()-started));if(n<=0)throw fault('TIMEOUT','Action batch deadline reached');return n;};
 try{
  if(readOnly&&(!['status','snapshot','actions','pages'].includes(a.operation)||(a.actions||[]).some(s=>!readTypes.includes(s.type))))throw fault('INVALID_ARGUMENT','Read-only handler rejects mutations');
  let s=sessions.get(a.session);
  if(a.operation==='open'||a.operation==='attach'){
   if(s)throw fault('SESSION_EXISTS','Session already exists; use browser_observe list/status');
   if(sessions.size+opening>=8)throw fault('SESSION_LIMIT','Eight sessions already open or opening');
   opening++;
   try{
    playwright??=await import('playwright-core');
    if(a.operation==='attach'){
     if(a.target_id!==undefined&&a.page_index!==undefined)throw fault('INVALID_ARGUMENT','Choose target_id OR page_index, not both');
     const u=endpointURL(a.endpoint),browser=await playwright.chromium.connectOverCDP(u.href,{timeout:deadline()});
     try{
      const pages=browser.contexts().flatMap(c=>c.pages());let page,targetId;
      if(a.target_id){for(const p of pages){const id=await pageTargetId(p);if(id===a.target_id){page=p;targetId=id;break;}}}
      else if(a.page_index!==undefined)page=pages[a.page_index];
      else if(pages.length===1)page=pages[0];
      else throw fault('PAGE_SELECTION_REQUIRED','Multiple windows are available. Use read-only targets discovery and explicitly select the authorized main-window target_id; index 0 is not assumed.',{diagnostic:{pages:pages.map((p,index)=>({index,url:p.url()}))}});
      if(!page)throw fault('PAGE_NOT_FOUND','Requested target is absent. Refresh read-only discovery; never fall back to a different window.');
      targetId??=await pageTargetId(page);
      if(targetOwners.has(targetId))throw fault('TARGET_IN_USE','This physical page already belongs to session '+targetOwners.get(targetId));
      targetOwners.set(targetId,a.session);
      s={browser,page,targetId,owned:false,endpoint:u.href,pageIndex:pages.indexOf(page),createdAt:new Date().toISOString()};
     }catch(e){await browser.close();throw e;}
    }else{
     const url=a.url?safeURL(a.url):null,browser=await playwright.chromium.launch({channel:'msedge',headless:!a.headed,timeout:deadline()});
     try{const context=await browser.newContext(),page=await context.newPage();s={browser,page,owned:true,createdAt:new Date().toISOString()};sessions.set(a.session,s);if(url)await page.goto(url,{waitUntil:'domcontentloaded',timeout:deadline()});}
     catch(e){sessions.delete(a.session);await browser.close();throw e;}
    }
    s.owner=a.owner??null;sessions.set(a.session,s);
   }finally{opening--;}
  }
  if(!s)throw fault('SESSION_NOT_FOUND','Session not found. Use browser_observe operation:list and reuse its returned session ID; open or attach explicitly if needed.');
  if(s.owner&&s.owner!==a.owner)throw fault('SESSION_NOT_OWNED','Pass the owning controller ID; do not take another controller session');
  if(a.operation==='detach'){
   if(s.owned)throw fault('OPERATION_NOT_SUPPORTED','Use close for a browser created by this tool');
   await s.browser.close();sessions.delete(a.session);if(s.targetId)targetOwners.delete(s.targetId);return response({session:a.session,detached:true,nativeAppClosed:false});
  }
  if(!s.browser.isConnected())throw fault('BROWSER_DISCONNECTED','Browser disconnected. Inspect before establishing a fresh session; do not replay mutations.');
  const page=s.page;
  if(a.operation==='close'){
   if(!s.owned)throw fault('OPERATION_NOT_SUPPORTED','Cannot close an attached native app/browser');
   await s.browser.close();sessions.delete(a.session);return response({session:a.session,closed:true});
  }
  if(page.isClosed())throw fault('PAGE_CLOSED','Page closed; verify target before attaching again');
  if(a.operation==='pages')return response({session:a.session,pages:s.browser.contexts().flatMap(c=>c.pages()).map((p,i)=>({index:i,url:p.url().slice(0,2000),selected:p===s.page,closed:p.isClosed()})).slice(0,100)});
  if(a.operation==='new_page'||a.operation==='select_page'){
   if(!s.owned)throw fault('OPERATION_NOT_SUPPORTED','Attached native targets cannot create or switch pages; attach an explicitly verified target');
   const pages=s.browser.contexts().flatMap(c=>c.pages());
   if(a.operation==='select_page'&&a.page_index===undefined)throw fault('INVALID_ARGUMENT','select_page requires an explicit page_index');
   if(a.operation==='new_page'){
    if(pages.length>=8)throw fault('PAGE_LIMIT','Eight pages per owned browser maximum');
    const created=await page.context().newPage();try{if(a.url)await created.goto(safeURL(a.url),{waitUntil:'domcontentloaded',timeout:deadline()});s.page=created;}catch(e){await created.close();throw e;}
   }else{if(!pages[a.page_index])throw fault('PAGE_NOT_FOUND','Inspect pages before selecting index');s.page=pages[a.page_index];}
   return response({session:a.session,selected:true,url:s.page.url(),page_index:s.browser.contexts().flatMap(c=>c.pages()).indexOf(s.page)});
  }
  if(a.operation==='navigate'){
   if(!s.owned)throw fault('OPERATION_NOT_SUPPORTED','Navigation disabled for attached native app sessions');
   await page.goto(safeURL(a.url),{waitUntil:'domcontentloaded',timeout:deadline()});
  }
  const steps=a.operation==='snapshot'?[{type:'snapshot'}]:a.operation==='actions'?(a.actions??[]):[];
  for(const [index,step] of steps.entries()){
   failedActionIndex=index;const timeout=deadline(),loc=target(page,step);let data={type:step.type};
   if(step.type==='snapshot')data={...data,...clip(await loc.ariaSnapshot({timeout}))};
   else if(step.type==='text')data={...data,...clip(await loc.innerText({timeout}))};
   else if(step.type==='input_value')data={...data,...clip(await loc.inputValue({timeout}))};
   else if(step.type==='count')data.count=await loc.count();
   else if(step.type==='screenshot_inline'){
    if(images.length)throw fault('IMAGE_LIMIT','Only one inline screenshot per action batch');
    const bytes=await page.screenshot({type:'jpeg',quality:75,fullPage:false,timeout});
    if(bytes.length>1024*1024)throw fault('IMAGE_TOO_LARGE','Inline screenshot exceeds 1 MiB; use a smaller viewport or the file-backed screenshot action');
    images.push({type:'image',mimeType:'image/jpeg',data:bytes.toString('base64')});data.bytes=bytes.length;
   }
   else if(['assert_value','assert_text','assert_text_contains'].includes(step.type)){
    const actual=step.type==='assert_value'?await loc.inputValue({timeout}):await loc.innerText({timeout}),expected=step.value??'';
    if(!(step.type==='assert_text_contains'?actual.includes(expected):actual===expected)){
     const saved=remaining;remaining=Math.min(512,Math.floor(saved/2));const av=clip(actual);remaining=saved-av.text.length;
     throw fault('ASSERTION_MISMATCH',step.type+' failed: '+(step.type==='assert_text_contains'?'substring':'exact')+' mismatch',{diagnostic:{actual:av,expected:clip(expected)}});
    }data.matched=true;
   }else if(step.type==='click')await loc.click({timeout});
   else if(step.type==='mouse_click')await page.mouse.click(step.x,step.y);
   else if(step.type==='mouse_move')await page.mouse.move(step.x,step.y);
   else if(step.type==='mouse_wheel')await page.mouse.wheel(step.delta_x??0,step.delta_y);
   else if(step.type==='mouse_drag'){
    await page.mouse.move(step.x,step.y);await page.mouse.down();
    try{await page.mouse.move(step.to_x,step.to_y,{steps:step.steps??10});}finally{await page.mouse.up();}
   }
   else if(step.type==='fill')await loc.fill(step.value??'',{timeout});
   else if(step.type==='press')await loc.press(step.value??'',{timeout});
   else if(step.type==='keyboard_type')await page.keyboard.insertText(step.value);
   else if(step.type==='keyboard_press')await page.keyboard.press(step.value);
   else if(step.type==='hover')await loc.hover({timeout});
   else if(step.type==='check')await loc.check({timeout});
   else if(step.type==='uncheck')await loc.uncheck({timeout});
   else if(step.type==='select_option')await loc.selectOption(step.value??'',{timeout});
   else if(step.type==='scroll_into_view')await loc.scrollIntoViewIfNeeded({timeout});
   else if(step.type==='wait')await loc.waitFor({state:step.state||'visible',timeout});
   else if(step.type==='screenshot'){await fs.mkdir(browserArtifactsDirectory,{recursive:true});data.path=path.join(browserArtifactsDirectory,a.session+'-'+randomUUID()+'.png');await page.screenshot({path:data.path,timeout:deadline()});}
   results.push(data);failedActionIndex=null;
  }
  let timer;const title=await Promise.race([page.title(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('TIMEOUT','Title metadata deadline reached')),deadline());})]).finally(()=>clearTimeout(timer));
  const titleView=clip(title);
  return response({session:a.session,owned:s.owned,target_id:s.targetId??null,page_index:s.browser.contexts().flatMap(c=>c.pages()).indexOf(page),url:page.url(),title:titleView.text,titleTruncated:titleView.truncated,titleTotalChars:titleView.totalChars,results,completed:results.length,elapsedMs:Math.round((performance.now()-started)*100)/100},false,images);
 }catch(e){
  const code=e.code||(e.name==='TimeoutError'?'TIMEOUT':/strict mode violation|Unknown attribute|Unexpected token/.test(e.message)?'LOCATOR_ERROR':/ECONNREFUSED|ECONNRESET|WebSocket/.test(e.message)?'CONNECTION_ERROR':'BROWSER_ERROR');
  return response({session:a.session,code,layer:code==='INVALID_ARGUMENT'?'input':'browser',error:e.message.slice(0,2000),...(e.diagnostic?{diagnostic:e.diagnostic}:{}),results,completed:results.length,failedActionIndex,replaySafe:false,notice:'Completed actions remain completed. Inspect the page before retrying only unfinished work. Technical errors are not host-policy denials.',elapsedMs:Math.round((performance.now()-started)*100)/100},true,images);
 }
}
