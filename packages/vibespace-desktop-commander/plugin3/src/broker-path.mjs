import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
export const dataDir=path.resolve(process.env.PLUGIN3_DATA_DIR||fileURLToPath(new URL('../state/shared-v1',import.meta.url)));
const hash=crypto.createHash('sha256').update(dataDir+os.userInfo().username).digest('hex').slice(0,24);
export const endpoint=process.platform==='win32'?`\\\\.\\pipe\\plugin3-${hash}`:path.join(os.tmpdir(),`plugin3-${hash}.sock`);
