#!/usr/bin/env node
// Runs every migrated task through a fake Pi process and writes an acceptance report.
// Does not call a model, execute task tools, or perform external business side effects.

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTasks, runTask } from "../src/core.mjs";

const temp = await mkdtemp(join(tmpdir(), "pi-cron-acceptance-"));
const fakePi = join(temp, "fake-pi.mjs");
await writeFile(
  fakePi,
  `#!/usr/bin/env node\nimport{writeFileSync}from"node:fs";import{join}from"node:path";const args=process.argv.slice(2);const prompt=args.at(-1)||"";if(!prompt.trim()){process.stderr.write("empty prompt\\n");process.exit(2)}const sessionDir=args[args.indexOf("--session-dir")+1];writeFileSync(join(sessionDir,"acceptance-session.jsonl"),"{}\\n");const model=args[args.indexOf("--model")+1];const message={role:"assistant",content:[{type:"text",text:"Runner acceptance passed for "+model}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};console.log(JSON.stringify({type:"message_end",message}));\n`,
  { mode: 0o700 },
);
await chmod(fakePi, 0o700);

const results = [];
try {
  for (const item of await listTasks()) {
    const base = { id: item.id, validationErrors: item.validation.errors, model: item.task ? `${item.task.model.provider}/${item.task.model.id}` : null, schedule: item.task?.schedule?.cron ?? null };
    if (item.validation.errors.length > 0) {
      results.push({ ...base, status: "failed", reason: "validation" });
      continue;
    }
    const run = await runTask(item.id, { force: true, trigger: "acceptance", piBin: fakePi });
    const finalOutput = await readFile(join(run.directory, "final.md"), "utf8");
    results.push({ ...base, status: run.sessionFile ? run.status : "failed", runId: run.runId, sessionFile: run.sessionFile ?? null, finalOutput: finalOutput.trim() });
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: "Configuration and runner acceptance with a fake Pi executable; no model or external workflow was executed.",
  total: results.length,
  passed: results.filter((item) => item.status === "succeeded").length,
  failed: results.filter((item) => item.status !== "succeeded").length,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.failed > 0 ? 1 : 0;
