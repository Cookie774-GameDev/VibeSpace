import { runBrowser } from './browser.mjs';
const [flag, session, ...args] = process.argv.slice(2);
if (flag !== '--session') throw Error('Usage: node browser/cli.mjs --session UNIQUE_TASK open URL');
process.exitCode = await runBrowser(session, args);
