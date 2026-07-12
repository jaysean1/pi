// Stores versioned prompt-derived workflow summaries for the Cron Manager Pipeline tab.
// Uses a new module path when its export contract changes so Pi hot reload cannot reuse stale exports.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKFLOW_FORMAT_VERSION = 2;
const CRON_ROOT = resolve(process.env.PI_CRON_ROOT ?? "/Users/jayseanqian/Desktop/on_board/cron_jobs");
export const WORKFLOWS_ROOT = join(CRON_ROOT, ".pi-cron", "workflows");

export const WORKFLOW_SYSTEM_PROMPT = `你负责解释定时自动化的工作流程。分析任务描述和提示词，只返回以下结构的 JSON：
{"summary":"一句简短中文说明","steps":[{"title":"2至6个中文字的标题","detail":"一句简短中文说明"}],"outcome":"一句简短中文说明"}

规则：
- 所有可见内容必须使用简体中文。
- 返回 3 至 7 个顺序步骤，解释自动化如何工作。
- 描述业务流程、判断条件、验证关卡和交付结果，不复制命令或文件路径。
- 标题和说明应简洁，适合放入流程图。
- 保留重要分支，例如停止条件或仅在特定日期执行的交付。
- 不得添加来源中不存在的行为。`;

export function parseWorkflowResponse(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps
      .filter((step) => step && typeof step.title === "string" && step.title.trim())
      .slice(0, 7)
      .map((step) => ({ title: step.title.trim(), detail: typeof step.detail === "string" ? step.detail.trim() : undefined }))
    : [];
  if (steps.length < 3) throw new Error("Workflow response must contain at least three steps");
  const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "自动化工作流程";
  const outcome = typeof parsed.outcome === "string" && parsed.outcome.trim() ? parsed.outcome.trim() : "流程执行完成并输出结果。";
  const visibleFields = [summary, outcome, ...steps.flatMap((step) => [step.title, step.detail].filter(Boolean))];
  if (visibleFields.some((field) => !/[\u3400-\u9fff]/.test(field))) {
    throw new Error("Every workflow field must use Chinese");
  }
  return { summary, steps, outcome };
}

export function buildFallbackWorkflow(description, prompt) {
  const source = `${description ?? ""}\n${prompt ?? ""}`;
  const lower = source.toLowerCase();
  const steps = [];
  if (/read |setup|context|date|timezone|workspace/.test(lower)) {
    steps.push({ title: "准备运行环境", detail: "读取必要指引，确认日期、工作范围和安全边界。" });
  }
  if (/collect|download|query|source|input|fetch|read the live|read source/.test(lower)) {
    steps.push({ title: "收集所需输入", detail: "只获取任务允许的数据和完成判断所需的证据。" });
  }
  const coreDetail = /terminal coding agent|update_terminal_agents/.test(lower)
    ? "运行指定更新流程，仅更新允许范围内的终端编码工具。"
    : /brains.*quer|temporary quer|cleanup_queries/.test(lower)
      ? "先检查符合条件的临时查询，再按安全规则执行可恢复的清理。"
      : "按照任务说明执行核心处理，不扩大操作范围。";
  steps.push({ title: "执行核心流程", detail: coreDetail });
  if (/validate|verify|dry.run|stop|fail|non-zero|missing/.test(lower)) {
    steps.push({ title: "验证处理结果", detail: "执行规定检查；证据缺失或验证失败时安全停止。" });
  }
  if (/sync|send|email|google doc|ticket|draft|write|update|archive/.test(lower)) {
    steps.push({ title: "交付允许结果", detail: "验证通过后，仅执行任务明确允许的同步、更新或交付。" });
  }
  steps.push({ title: "汇报运行结果", detail: "汇总结果、证据位置、失败原因和需要人工复核的事项。" });
  while (steps.length < 3) steps.splice(steps.length - 1, 0, { title: "应用安全限制", detail: "遵守任务约束，避免任何未经批准的副作用。" });
  return {
    summary: "按任务规则完成输入收集、核心处理、结果验证和安全交付。",
    steps: steps.slice(0, 7),
    outcome: "流程产出明确结果；若条件不满足，则安全停止并说明原因。",
  };
}

export function describeSchedule(expression, timezone) {
  const fields = String(expression ?? "").trim().split(/\s+/);
  const timezoneLabel = timezone === "Australia/Sydney" ? "悉尼时间" : (timezone || "本地时间");
  if (fields.length !== 5) return `按既定计划自动运行（${timezoneLabel}）`;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || dayOfMonth !== "*" || month !== "*") {
    return `按既定计划自动运行（${timezoneLabel}）`;
  }
  const time = `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
  const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  let frequency = "每天";
  if (dayOfWeek !== "*") {
    const values = dayOfWeek.split(",").map(Number);
    if (values.every((value) => Number.isInteger(value) && value >= 0 && value <= 6)) {
      const contiguous = values.length > 1 && values.every((value, index) => index === 0 || value === values[index - 1] + 1);
      frequency = contiguous ? `每${days[values[0]]}至${days[values.at(-1)]}` : `每${values.map((value) => days[value]).join("、")}`;
    } else {
      return `按既定计划自动运行（${timezoneLabel}）`;
    }
  }
  return `${frequency} ${time} 自动运行（${timezoneLabel}）`;
}

export function workflowSourceHash(description, prompt) {
  return createHash("sha256").update(`${WORKFLOW_FORMAT_VERSION}\n${description ?? ""}\n\u0000\n${prompt ?? ""}`).digest("hex");
}

export async function loadWorkflow(taskId, sourceHash) {
  if (!ID_RE.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  try {
    const workflow = JSON.parse(await readFile(join(WORKFLOWS_ROOT, `${taskId}.json`), "utf8"));
    if (workflow.sourceHash !== sourceHash || !Array.isArray(workflow.steps) || workflow.steps.length === 0) return null;
    return workflow;
  } catch {
    return null;
  }
}

export async function saveWorkflow(taskId, workflow) {
  if (!ID_RE.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  const path = join(WORKFLOWS_ROOT, `${taskId}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(workflow, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return workflow;
}
