import fs from 'node:fs/promises';
export const GUIDE_URI='plugin3://agent-guide';
export const GUIDE_PROMPT='plugin3-operating-guide';
export const GUIDE_INSTRUCTIONS='Plugin 3 v0.4: read plugin3_guide once per version (also resource plugin3://agent-guide). Use shared workspace/read/edit/job tools for large repository work and agent mailboxes/leases for cooperating chats. agent_start prepares a host-controller handoff; it does not claim an unlaunched model is running. browser_observe is enforced read-only; browser_session retains explicit lifecycle, owner/frame/page controls and preserved partial receipts. Shared browser handles survive MCP reconnect, not broker restart. Diagnose exact technical errors; continue independent permitted work without bypassing host denials. Native VibeSpace QA requires verified official Tauri identity. Guide includes launch/cache paths, bounded recovery and task-owned commits.';
const guideFile=new URL('../../../../3/skills/plugin3-native-work/SKILL.md',import.meta.url);
let cached;
export async function guideText(){return cached??=await fs.readFile(guideFile,'utf8');}
export async function pluginGuide(args={}){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)return {isError:true,content:[{type:'text',text:'plugin3_guide accepts an empty object'}]};return {isError:false,content:[{type:'text',text:await guideText()}]};}
