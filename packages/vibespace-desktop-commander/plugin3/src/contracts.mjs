import {createRequire} from 'node:module';
const require=createRequire(new URL('../runtime/desktop-commander-v3/package.json',import.meta.url));
const {z}=require('zod'),{zodToJsonSchema}=require('zod-to-json-schema');
const id=z.string().regex(/^[\w.-]{1,120}$/),text=z.string().max(16000),root=z.string().max(4000),request_id=id,workspace=id,agent=id;
const obj=o=>z.object(o).strict(),read={agent,limit:z.number().int().min(1).max(100).optional(),max_chars:z.number().int().min(100).max(65536).optional(),include_acknowledged:z.boolean().optional()};
export const schemas={
 health:obj({}),workspace_open:obj({root,request_id}),workspace_status:obj({workspace}),
 read_batch:obj({workspace,files:z.array(obj({path:root,offset:z.number().int().nonnegative().optional(),length:z.number().int().min(1).max(1048576).optional()})).min(1).max(64),max_bytes:z.number().int().min(100).max(1048576).optional()}),
 query_repo:obj({workspace,query:z.string().max(2000).optional(),mode:z.enum(['files','text']).optional(),max_chars:z.number().int().min(100).max(65536).optional()}),
 agent_register:obj({agent,task:text,model:z.string().max(120),parent:id.optional(),request_id}),
 agent_start:obj({agent,task:text,model:z.string().max(120),parent:id.optional(),request_id}),
 agent_update:obj({agent,state:z.enum(['registered','working','waiting','blocked','complete','stopped']).optional(),model_observed:z.string().max(120).optional(),url:root.optional(),evidence:text.optional(),request_id}),
 agent_status:obj({agent:agent.optional()}),agent_send:obj({from:agent,to:agent,text:text.min(1),request_id}),agent_read:obj(read),agent_wait:obj({...read,wait_ms:z.number().int().min(0).max(25000).optional()}),
 agent_ack:obj({agent,message_ids:z.array(id).max(100),request_id}),
 lease_claim:obj({agent,workspace,paths:z.array(root).min(1).max(500),request_id}),lease_release:obj({agent,lease:id,request_id}),
 edit_plan:obj({workspace,agent,lease:id,manifest:root,wait_ms:z.number().int().min(0).max(25000).optional(),request_id}),edit_status:obj({plan:id,wait_ms:z.number().int().min(0).max(25000).optional()}),edit_apply:obj({plan:id,agent,wait_ms:z.number().int().min(0).max(25000).optional(),request_id}),edit_rollback:obj({plan:id,agent,wait_ms:z.number().int().min(0).max(25000).optional(),request_id}),
 job_start:obj({workspace,executable:root,args:z.array(z.string().max(32000)).max(100),timeout_ms:z.number().int().min(100).max(3600000).optional(),request_id}),
 job_read:obj({job:id,offset:z.number().int().nonnegative().optional(),max_bytes:z.number().int().min(100).max(131072).optional()}),
 job_wait:obj({job:id,offset:z.number().int().nonnegative().optional(),max_bytes:z.number().int().min(100).max(131072).optional(),wait_ms:z.number().int().min(0).max(25000).optional()}),job_cancel:obj({job:id,request_id})
};
const descriptions={
 edit_plan:'Start validation of a local staged-file manifest and freeze it as a durable plan. Uses the existing streaming engine: up to 500 files, 1 GiB/file, 4 GiB staging/backup budget. Requires active owning file lease, expected target/source hashes and a matching registered root.',
 edit_status:'Read persisted edit plan state and transaction receipts; optionally wait up to 25 seconds. Only planned/applied/rolled_back states confirm completion. Interrupted mutations remain uncertain; never infer all files committed.',
 edit_apply:'Apply a previously validated plan under its owning lease. Preflights hashes, journals stage/commit and preserves backups. Returns within wait_ms (default 1000 ms); poll edit_status while applying. Not atomic across files; inspect uncertain state before any further mutation.',
 edit_rollback:'Rollback an applied plan under its owning lease using guarded receipt hashes. Refuses to overwrite later external edits; returns while rolling_back if wait_ms elapses; poll edit_status. Never a blanket Git reset.',
 health:'Shared Plugin 3 service health, version and honest capability status.',
 workspace_open:'Register an absolute repository/workspace root; returns stable ID and live Git state. Does not change repository files.',workspace_status:'Live Git state and active cooperative leases for a registered workspace.',
 read_batch:'Read 1-64 UTF-8 file byte ranges with eight concurrent readers, a bounded shared output budget, exact range hashes and freshness checks. Whole-file SHA256 only when complete. No stale cache presented as live.',
 query_repo:'Bounded live ripgrep path/text query within a registered workspace; ignored dependencies excluded. Exact text search, not semantic refactoring.',
 agent_register:'Register a cooperating agent/task and requested model; up to three active agents. This creates mailbox identity, not a model turn. Use browser or an authorized host to launch the chat; never claim a model launched from registration alone.',
 agent_start:'Prepare a durable subagent launch handoff with prompt, parent, requested model and mailbox ID. Returns launched:false/awaiting_host_controller. An available authorized browser controller must open ChatGPT, verify model/plugin and submit once; agent_update records observed launch. Does not silently create a paid API call or claim an unstarted model is running.',
 agent_update:'Record observed chat URL/model, progress or completion with evidence. Caller-observed model identity is explicitly distinguished from server attestation.',
 agent_status:'Read registered agent task/status/model evidence; does not infer whether a browser model is still thinking.',
 agent_send:'Durably enqueue a message for another registered agent with idempotency and append it to the shared AGENT-MESSAGES.jsonl file. Check shared_file_written separately; SQLite remains canonical. Does not wake an idle model or interrupt an active turn. Same request ID requires identical arguments.',
 agent_read:'Read bounded messages without acknowledging or changing them. Explicitly acknowledge fully consumed messages with agent_ack.',agent_wait:'Wait up to 25 seconds for unread mailbox messages; does not wake the receiving model.',
 agent_ack:'Acknowledge fully read message IDs belonging to this recipient; messages remain in durable history and acknowledgements append to the shared communication file.',
 lease_claim:'Atomically claim canonical workspace paths for a cooperating agent; ancestor/descendant conflicts rejected. No automatic stealing, expiry or overwrite. External/legacy tools are not sandboxed by leases.',lease_release:'Release only the specified owning agent lease. Repository coordination rules remain authoritative.',
 job_start:'Start a bounded noninteractive executable plus argument array in a registered workspace. Persists job identity/exit/logs, survives MCP reconnection; never replays an uncertain start. Four active jobs, bounded logs; no shell inference.',job_read:'Read durable job state, actual exit code and bounded stdout/stderr using byte cursors.',job_wait:'Wait up to 25 seconds for a job state change/completion and return bounded output.',job_cancel:'Cancel only a live child process tree created and still owned by the shared service; no PID-name guessing.'
};
const writes=new Set(['workspace_open','agent_register','agent_start','agent_update','agent_send','agent_ack','lease_claim','lease_release','job_start','job_cancel','edit_plan','edit_apply','edit_rollback']);
export const serviceTools=Object.entries(schemas).map(([name,schema])=>({name,description:descriptions[name],inputSchema:zodToJsonSchema(schema),annotations:{readOnlyHint:!writes.has(name),destructiveHint:['job_start','job_cancel','edit_apply','edit_rollback'].includes(name),idempotentHint:name!=='job_cancel',openWorldHint:['job_start','query_repo'].includes(name)}}));
