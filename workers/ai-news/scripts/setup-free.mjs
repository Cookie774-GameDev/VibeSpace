import { spawnSync } from "node:child_process";
import process from "node:process";

const command = process.platform === "win32" ? "npx.cmd" : "npx";

function run(args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("VibeSpace free hourly AI news setup");
console.log("Cloudflare may open a browser once so you can sign in.");

run(["wrangler", "deploy", "--config", "wrangler.jsonc"]);
run([
  "wrangler", "d1", "execute", "DB", "--remote",
  "--file", "migrations/0001_init.sql", "--yes",
  "--config", "wrangler.jsonc",
]);
run(["wrangler", "deploy", "--config", "wrangler.jsonc"]);

console.log("\nSetup complete.");
console.log("Open the workers.dev URL printed above and add /api/news.");
console.log("The first request loads data immediately; Cron refreshes it every hour at minute 7.");
