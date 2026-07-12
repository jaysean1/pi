// Registers the /cron TUI and narrow tools for Pi-managed scheduled tasks.
// Does not mutate crontab or run side-effecting tasks without explicit confirmation.

import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  displayPath,
  listRuns,
  listTasks,
  loadTask,
  planCrontab,
  readUserCrontab,
  runTask,
  setTaskEnabled,
  splitManagedCrontab,
  syncCrontab,
} from "../../src/core.mjs";
import { enableMouseWheel, isMouseSequence, parseWheelEvents } from "../../src/mouse.mjs";

type DashboardAction =
  | { type: "close" }
  | { type: "refresh" }
  | { type: "new" }
  | { type: "run"; id: string }
  | { type: "toggle"; id: string }
  | { type: "edit-prompt"; id: string }
  | { type: "resume-run"; id: string; runId: string; sessionFile: string };

type TaskView = {
  id: string;
  task: any;
  validation: { errors: string[]; warnings: string[] };
  runs: any[];
  prompt: string;
  external?: boolean;
};

const TABS = ["Runs", "Overview", "Prompt", "Pipeline", "Model"] as const;
const CRON_SHORTCUT = Key.superShift("j");
const CRON_SHORTCUT_KAKU = "\x1b[995~";
let activeDashboardClose: (() => void) | undefined;
let shortcutCleanup: (() => void) | undefined;
let dashboardCache: TaskView[] | undefined;
let dashboardRefresh: Promise<TaskView[]> | undefined;
let lastShortcutAt = 0;

function isCronShortcut(data: string): boolean {
  return data === CRON_SHORTCUT_KAKU || matchesKey(data, CRON_SHORTCUT);
}

function padAnsi(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width), "…", true);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function statusIcon(view: TaskView, theme: Theme): string {
  if (view.external) return theme.fg("muted", "◇");
  if (view.validation.errors.length > 0) return theme.fg("error", "!");
  if (view.runs[0]?.status === "failed") return theme.fg("error", "!");
  if (view.task?.enabled) return theme.fg("success", "●");
  return theme.fg("dim", "○");
}

class CronDashboard {
  private views: TaskView[];
  private loading: boolean;
  private loadError: string | undefined;
  private selected = 0;
  private tab = 0;
  private listScroll = 0;
  private contentScroll = 0;
  private runsFocus = false;
  private selectedRun = 0;
  private lastContentWidth = 80;
  private lastContentRows = 12;
  private readonly disableMouse: () => void;

  constructor(
    private readonly tui: {
      terminal: { rows: number; write: (data: string) => void };
      requestRender: () => void;
    },
    initialViews: TaskView[],
    private readonly theme: Theme,
    private readonly done: (action: DashboardAction) => void,
    loading = false,
  ) {
    this.views = initialViews;
    this.loading = loading;
    this.disableMouse = enableMouseWheel(tui.terminal);
  }

  dispose(): void {
    this.disableMouse();
  }

  setViews(views: TaskView[]): void {
    const selectedId = this.current()?.id;
    this.views = views;
    this.selected = selectedId ? Math.max(0, views.findIndex((view) => view.id === selectedId)) : 0;
    this.loading = false;
    this.loadError = undefined;
    this.listScroll = 0;
    this.ensureListSelection(this.bodyRows());
    this.tui.requestRender();
  }

  setLoadError(error: unknown): void {
    this.loading = false;
    this.loadError = error instanceof Error ? error.message : String(error);
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const wheel = parseWheelEvents(data);
    if (wheel.length > 0) {
      const delta = wheel.reduce((total, direction) => total + (direction === "down" ? 3 : -3), 0);
      this.scrollContent(delta);
      return;
    }
    if (isMouseSequence(data)) return;
    if (matchesKey(data, Key.ctrl("c"))) this.done({ type: "close" });
    else if (matchesKey(data, Key.escape)) {
      if (this.runsFocus) this.runsFocus = false;
      else this.done({ type: "close" });
    } else if (matchesKey(data, Key.up)) {
      if (this.runsFocus) this.moveRunSelection(-1);
      else this.moveSelection(-1);
    } else if (matchesKey(data, Key.down)) {
      if (this.runsFocus) this.moveRunSelection(1);
      else this.moveSelection(1);
    } else if (matchesKey(data, Key.enter) && this.tab === 0) this.openOrFocusRun();
    else if (matchesKey(data, Key.pageUp)) this.scrollContent(-this.lastContentRows);
    else if (matchesKey(data, Key.pageDown)) this.scrollContent(this.lastContentRows);
    else if (matchesKey(data, Key.left)) {
      if (this.runsFocus) this.runsFocus = false;
      else this.switchTab(-1);
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.switchTab(1);
    else if (matchesKey(data, Key.home)) this.scrollContent(-Number.MAX_SAFE_INTEGER);
    else if (matchesKey(data, Key.end)) this.scrollContent(Number.MAX_SAFE_INTEGER);
    else if (matchesKey(data, "g")) this.done({ type: "refresh" });
    else if (matchesKey(data, "n")) this.done({ type: "new" });
    else if (matchesKey(data, "r") && this.current()?.task && !this.current()?.external) this.done({ type: "run", id: this.current()!.id });
    else if (matchesKey(data, Key.space) && this.current()?.task && !this.current()?.external) this.done({ type: "toggle", id: this.current()!.id });
    else if (matchesKey(data, "e") && this.current()?.task && !this.current()?.external) this.done({ type: "edit-prompt", id: this.current()!.id });
    this.tui.requestRender();
  }

  invalidate(): void {}

  private bodyRows(): number {
    return Math.max(6, this.tui.terminal.rows - 4);
  }

  private moveSelection(delta: number): void {
    if (this.views.length === 0) return;
    this.selected = (this.selected + delta % this.views.length + this.views.length) % this.views.length;
    this.contentScroll = 0;
    this.selectedRun = 0;
    this.ensureListSelection(this.bodyRows());
  }

  private moveRunSelection(delta: number): void {
    const runs = this.current()?.runs ?? [];
    this.selectedRun = Math.max(0, Math.min(runs.length - 1, this.selectedRun + delta));
    this.contentScroll = Math.max(0, this.selectedRun * 5 - 2);
  }

  private openOrFocusRun(): void {
    const view = this.current();
    const runs = view?.runs ?? [];
    if (!view || runs.length === 0) return;
    if (!this.runsFocus) {
      this.runsFocus = true;
      return;
    }
    const run = runs[this.selectedRun];
    if (run?.sessionFile) this.done({ type: "resume-run", id: view.id, runId: run.runId, sessionFile: run.sessionFile });
  }

  private switchTab(delta: number): void {
    this.tab = (this.tab + TABS.length + delta) % TABS.length;
    this.contentScroll = 0;
    this.runsFocus = false;
    this.selectedRun = 0;
  }

  private current(): TaskView | undefined {
    return this.views[this.selected];
  }

  private content(view: TaskView): string[] {
    const th = this.theme;
    if (view.external) {
      return [th.fg("accent", "External cron entry"), "", view.prompt, "", th.fg("dim", "Read-only. Pi Cron Manager will preserve this line exactly.")];
    }
    if (!view.task) return [th.fg("error", `Invalid task: ${view.id}`), ...view.validation.errors.map((error) => `• ${error}`)];
    const task = view.task;
    if (this.tab === 1) {
      const latest = view.runs[0];
      return [
        `${th.bold(task.name)}  ${task.enabled ? th.fg("success", "● Active") : th.fg("dim", "○ Paused")}`,
        task.description || "",
        "",
        `${th.fg("muted", "Schedule")}     ${task.schedule.cron} · ${task.schedule.timezone}`,
        `${th.fg("muted", "Working dir")}  ${displayPath(task.cwd)}`,
        `${th.fg("muted", "Model")}        ${task.model.provider}/${task.model.id} · ${task.model.thinking}`,
        `${th.fg("muted", "Pipeline")}     ${task.pipeline.length} stage(s)`,
        `${th.fg("muted", "Timeout")}      ${task.timeoutMinutes} minutes`,
        `${th.fg("muted", "Latest run")}   ${latest ? `${latest.status} · ${latest.startedAt ?? "unknown"}` : "No runs"}`,
        "",
        ...(view.validation.errors.length ? [th.fg("error", "Validation errors"), ...view.validation.errors.map((error) => `• ${error}`)] : []),
        ...(view.validation.warnings.length ? [th.fg("warning", "Warnings"), ...view.validation.warnings.map((warning) => `• ${warning}`)] : []),
      ];
    }
    if (this.tab === 2) return view.prompt.split("\n");
    if (this.tab === 3) {
      return task.pipeline.flatMap((stage: any, index: number) => [
        `${th.fg("accent", `${index + 1}.`)} ${th.bold(stage.name ?? stage.id)}`,
        `   Prompt: ${stage.promptFile}`,
        `   Input: ${stage.input ?? "none"}`,
        `   Continue on error: ${stage.continueOnError ? "yes" : "no"}`,
        "",
      ]);
    }
    if (this.tab === 4) {
      return [
        `${th.fg("muted", "Provider")}  ${task.model.provider}`,
        `${th.fg("muted", "Model")}     ${task.model.id}`,
        `${th.fg("muted", "Thinking")}  ${task.model.thinking}`,
        `${th.fg("muted", "Tools")}     ${task.tools.join(", ")}`,
      ];
    }
    if (view.runs.length === 0) return [th.fg("dim", "No run records")];
    return view.runs.flatMap((run, index) => {
      const selected = this.runsFocus && index === this.selectedRun;
      const prefix = selected ? th.fg("accent", "›") : " ";
      const status = run.status === "succeeded" ? th.fg("success", "✓") : run.status === "failed" ? th.fg("error", "✗") : th.fg("warning", "○");
      const session = run.sessionFile ? th.fg("success", "session available") : th.fg("dim", "no saved session");
      const title = `${prefix} ${status} ${run.startedAt ?? run.runId}`;
      return [
        selected ? th.bg("selectedBg", title) : title,
        `    ${run.trigger ?? "unknown"} · ${run.durationMs ?? 0} ms · ${run.model ?? "unknown model"}`,
        `    ${session}`,
        ...(run.error ? [`    ${th.fg("error", run.error)}`] : []),
        `    ${th.fg("dim", displayPath(run.directory))}`,
        "",
      ];
    });
  }

  private wrappedContent(view: TaskView, width: number): string[] {
    return this.content(view).flatMap((line) => line === "" ? [""] : wrapTextWithAnsi(line, Math.max(1, width)));
  }

  private maxContentScroll(): number {
    const current = this.current();
    if (!current) return 0;
    return Math.max(0, this.wrappedContent(current, this.lastContentWidth).length - this.lastContentRows);
  }

  private scrollContent(delta: number): void {
    this.contentScroll = Math.max(0, Math.min(this.maxContentScroll(), this.contentScroll + delta));
    this.tui.requestRender();
  }

  private ensureListSelection(rows: number): void {
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    else if (this.selected >= this.listScroll + rows) this.listScroll = this.selected - rows + 1;
  }

  private tabs(): string {
    return TABS.map((tab, index) => index === this.tab ? this.theme.fg("accent", `[${tab}]`) : this.theme.fg("dim", ` ${tab} `)).join(" ");
  }

  render(width: number): string[] {
    const th = this.theme;
    const bodyRows = this.bodyRows();
    const lines: string[] = [];
    const active = this.views.filter((view) => view.task?.enabled).length;
    const failed = this.views.filter((view) => view.validation.errors.length || view.runs[0]?.status === "failed").length;
    lines.push(truncateToWidth(th.fg("accent", th.bold("Pi Scheduled Tasks")) + th.fg("dim", `  ${this.views.length} entries · ${active} active · ${failed} need attention`), width));
    lines.push(th.fg("border", "─".repeat(width)));
    if (this.views.length === 0) {
      if (this.loading) {
        lines.push(`${th.fg("accent", "◌")} Loading task details…`);
        lines.push(th.fg("dim", "The dashboard is already interactive; data is loading in the background."));
      } else if (this.loadError) {
        lines.push(th.fg("error", `Unable to load tasks: ${this.loadError}`));
        lines.push(th.fg("dim", "Press g to retry, or Esc to close."));
      } else {
        lines.push("No tasks or user crontab entries.");
        lines.push(th.fg("dim", "Press n to create a task with /skill:create-cron-job, or Esc to close."));
      }
      while (lines.length < bodyRows + 2) lines.push("");
    } else {
      const current = this.current()!;
      if (width < 100) {
        const listRows = Math.min(this.views.length, Math.max(5, Math.floor(bodyRows * 0.36)));
        const contentRows = Math.max(1, bodyRows - listRows - 2);
        this.ensureListSelection(listRows);
        this.lastContentWidth = width;
        this.lastContentRows = contentRows;
        this.contentScroll = Math.min(this.contentScroll, this.maxContentScroll());
        for (let row = 0; row < listRows; row++) {
          const index = this.listScroll + row;
          const view = this.views[index];
          const text = view ? `${index === this.selected ? th.fg("accent", "›") : " "} ${statusIcon(view, th)} ${view.task?.name ?? view.id}` : "";
          lines.push(padAnsi(text, width));
        }
        lines.push(th.fg("border", "─".repeat(width)));
        lines.push(padAnsi(this.tabs(), width));
        const content = this.wrappedContent(current, width).slice(this.contentScroll, this.contentScroll + contentRows);
        for (let row = 0; row < contentRows; row++) lines.push(padAnsi(content[row] ?? "", width));
      } else {
        const leftWidth = Math.min(36, Math.floor(width * 0.32));
        const rightWidth = width - leftWidth - 3;
        const contentRows = Math.max(1, bodyRows - 2);
        this.ensureListSelection(bodyRows);
        this.lastContentWidth = rightWidth;
        this.lastContentRows = contentRows;
        this.contentScroll = Math.min(this.contentScroll, this.maxContentScroll());
        const content = this.wrappedContent(current, rightWidth).slice(this.contentScroll, this.contentScroll + contentRows);
        const right = [this.tabs(), "", ...content];
        for (let row = 0; row < bodyRows; row++) {
          const index = this.listScroll + row;
          const view = this.views[index];
          const left = view ? `${index === this.selected ? th.fg("accent", "›") : " "} ${statusIcon(view, th)} ${view.task?.name ?? view.id}` : "";
          lines.push(`${padAnsi(left, leftWidth)} ${th.fg("border", "│")} ${padAnsi(right[row] ?? "", rightWidth)}`);
        }
      }
    }
    lines.push(th.fg("border", "─".repeat(width)));
    const help = this.runsFocus
      ? "↑↓ history  Enter open saved session  ←/Esc task list  touchpad/PgUp/PgDn scroll"
      : "↑↓ task  ←→ tab  Runs: Enter history  touchpad/PgUp/PgDn scroll  n new  r run  space toggle  g refresh  esc close";
    lines.push(truncateToWidth(th.fg("dim", help), width));
    return lines.slice(0, this.tui.terminal.rows);
  }
}

async function buildViews(): Promise<TaskView[]> {
  const [tasks, currentCrontab] = await Promise.all([listTasks(), readUserCrontab()]);
  const views = await Promise.all(tasks.map(async (item): Promise<TaskView> => {
    const promptFile = item.task?.pipeline?.[0]?.promptFile;
    const [prompt, runs] = await Promise.all([
      promptFile
        ? readFile(`${item.directory}/${promptFile}`, "utf8").catch(() => "Prompt file is unavailable.")
        : Promise.resolve(""),
      listRuns(item.id, 20),
    ]);
    return { id: item.id, task: item.task, validation: item.validation, runs, prompt };
  }));
  const unmanaged = splitManagedCrontab(currentCrontab);
  const externalLines = [unmanaged.before, unmanaged.after].join("\n").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !/^\w+=/.test(line));
  externalLines.forEach((line, index) => views.push({ id: `external-${index + 1}`, task: null, validation: { errors: [], warnings: [] }, runs: [], prompt: line, external: true }));
  return views;
}

function refreshDashboardViews(): Promise<TaskView[]> {
  if (!dashboardRefresh) {
    dashboardRefresh = buildViews()
      .then((views) => {
        dashboardCache = views;
        return views;
      })
      .finally(() => {
        dashboardRefresh = undefined;
      });
  }
  return dashboardRefresh;
}

function prioritiseView(views: TaskView[], id?: string): TaskView[] {
  const ordered = [...views];
  if (!id) return ordered;
  const index = ordered.findIndex((view) => view.id === id);
  if (index > 0) [ordered[0], ordered[index]] = [ordered[index], ordered[0]];
  return ordered;
}

async function openDashboard(ctx: ExtensionContext | ExtensionCommandContext, initialId?: string): Promise<void> {
  let requestedId = initialId;
  while (true) {
    const selectedId = requestedId;
    requestedId = undefined;
    const initialViews = prioritiseView(dashboardCache ?? [], selectedId);
    const refresh = refreshDashboardViews();
    let dashboard: CronDashboard | undefined;
    let overlayOpen = true;
    const action = await ctx.ui.custom<DashboardAction>(
      (tui, theme, _keybindings, done) => {
        activeDashboardClose = () => done({ type: "close" });
        dashboard = new CronDashboard(tui, initialViews, theme, done, true);
        void refresh.then(
          (views) => {
            if (overlayOpen) dashboard?.setViews(prioritiseView(views, selectedId));
          },
          (error) => {
            if (overlayOpen) dashboard?.setLoadError(error);
          },
        );
        return dashboard;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-left",
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
      },
    );
    overlayOpen = false;
    activeDashboardClose = undefined;
    if (!action || action.type === "close") return;
    if (action.type === "refresh") continue;
    if (action.type === "new") {
      ctx.ui.setEditorText("/skill:create-cron-job Create a new scheduled Pi task");
      return;
    }
    if (action.type === "resume-run") {
      try {
        await readFile(action.sessionFile, "utf8");
      } catch {
        ctx.ui.notify(`Saved session is unavailable: ${action.sessionFile}`, "error");
        requestedId = action.id;
        continue;
      }
      if (!("switchSession" in ctx)) {
        ctx.ui.notify("Open Automation Runs in the session switcher to resume this run, or open /cron as a command.", "warning");
        requestedId = action.id;
        continue;
      }
      const result = await ctx.switchSession(action.sessionFile, {
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify(`Opened cron run ${action.runId}. You can continue the conversation here.`, "info");
        },
      });
      if (result.cancelled) {
        requestedId = action.id;
        continue;
      }
      return;
    }
    if (action.type === "run") {
      const loaded = await loadTask(action.id);
      const ok = await ctx.ui.confirm("Run scheduled task now?", `${loaded.task.name}\n\nThis executes the real prompt and may cause external side effects.`);
      if (ok) {
        ctx.ui.notify(`Running ${action.id}...`, "info");
        const result = await runTask(action.id, { trigger: "manual", force: true });
        ctx.ui.notify(`${action.id}: ${result.status}`, result.status === "succeeded" ? "info" : "error");
      }
      requestedId = action.id;
      continue;
    }
    if (action.type === "toggle") {
      const loaded = await loadTask(action.id);
      const nextEnabled = !loaded.task.enabled;
      const ok = await ctx.ui.confirm(nextEnabled ? "Enable task?" : "Pause task?", `${loaded.task.name}\n\nThe managed user crontab will be updated after a preview.`);
      if (!ok) { requestedId = action.id; continue; }
      await setTaskEnabled(action.id, nextEnabled);
      const plan = await planCrontab();
      const install = await ctx.ui.confirm("Install crontab change?", plan.changed ? plan.next : "No crontab change is required.");
      if (install && plan.changed) await syncCrontab({ execute: true, expectedCurrent: plan.current });
      else if (!install) await setTaskEnabled(action.id, !nextEnabled);
      requestedId = action.id;
      continue;
    }
    if (action.type === "edit-prompt") {
      const loaded = await loadTask(action.id);
      const promptPath = `${loaded.directory}/${loaded.task.pipeline[0].promptFile}`;
      const current = await readFile(promptPath, "utf8");
      const next = await ctx.ui.editor(`Edit prompt: ${action.id}`, current);
      if (next !== undefined && next !== current) {
        ctx.ui.notify("Prompt editing from /cron is read-only in version 0.1. Use the create-cron-job skill to apply a reviewed file change.", "warning");
      }
      requestedId = action.id;
    }
  }
}

export default function cronExtension(pi: ExtensionAPI) {
  const openFromShortcut = async (ctx: ExtensionContext) => {
    const now = Date.now();
    if (now - lastShortcutAt < 200) return;
    lastShortcutAt = now;
    if (activeDashboardClose) {
      activeDashboardClose();
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait until Pi is idle before opening Cron Manager.", "warning");
      return;
    }
    await openDashboard(ctx);
  };

  pi.registerShortcut(CRON_SHORTCUT, {
    description: "Open Pi Cron Manager",
    handler: async (ctx) => openFromShortcut(ctx),
  });

  pi.on("session_shutdown", () => {
    shortcutCleanup?.();
    shortcutCleanup = undefined;
    activeDashboardClose = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    shortcutCleanup?.();
    shortcutCleanup = ctx.ui.onTerminalInput((data) => {
      if (!isCronShortcut(data)) return undefined;
      void openFromShortcut(ctx);
      return { consume: true };
    });
  });

  pi.registerCommand("cron", {
    description: "Open the local Pi cron task manager",
    getArgumentCompletions: (prefix: string) => null,
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/cron requires TUI mode", "error");
        return;
      }
      await openDashboard(ctx, args.trim() || undefined);
    },
  });

  pi.registerTool({
    name: "cron_task_list",
    label: "Cron Tasks",
    description: "List Pi-managed cron tasks and validation status.",
    parameters: Type.Object({}),
    async execute() {
      const tasks = await listTasks();
      const data = tasks.map((item) => ({ id: item.id, name: item.task?.name, enabled: item.task?.enabled, schedule: item.task?.schedule, model: item.task?.model, errors: item.validation.errors }));
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: { tasks: data } };
    },
  });

  pi.registerTool({
    name: "cron_task_get",
    label: "Cron Task",
    description: "Get one Pi-managed cron task and its recent runs.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      const loaded = await loadTask(params.id);
      const runs = await listRuns(params.id, 10);
      const data = { task: loaded.task, validation: loaded.validation, runs };
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
    },
  });

  pi.registerTool({
    name: "cron_task_run",
    label: "Run Cron Task",
    description: "Run a Pi-managed task. This executes the real prompt and may cause external side effects.",
    parameters: Type.Object({ id: Type.String(), confirmSideEffects: Type.Boolean() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!params.confirmSideEffects) throw new Error("confirmSideEffects must be true");
      if (ctx.hasUI && !(await ctx.ui.confirm("Run scheduled task?", `${params.id}\nThis may cause external side effects.`))) throw new Error("Cancelled by user");
      const run = await runTask(params.id, { trigger: "manual", force: true });
      return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }], details: run };
    },
  });

  pi.registerTool({
    name: "cron_task_sync_schedule",
    label: "Sync Cron Schedule",
    description: "Preview or install the managed user crontab block. Defaults to preview only.",
    parameters: Type.Object({ execute: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!params.execute) {
        const plan = await planCrontab();
        return { content: [{ type: "text", text: plan.next }], details: plan };
      }
      if (!ctx.hasUI) throw new Error("Schedule installation requires TUI confirmation");
      const plan = await planCrontab();
      if (!(await ctx.ui.confirm("Install managed crontab?", plan.next))) throw new Error("Cancelled by user");
      const result = await syncCrontab({ execute: true, expectedCurrent: plan.current });
      return { content: [{ type: "text", text: result.executed ? "Managed crontab installed and verified." : "No change required." }], details: result };
    },
  });

  pi.registerTool({
    name: "cron_task_set_status",
    label: "Set Cron Task Status",
    description: "Enable or pause a managed task, then optionally install its crontab change.",
    parameters: Type.Object({ id: Type.String(), status: StringEnum(["enabled", "paused"] as const), sync: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const enabled = params.status === "enabled";
      if (params.sync && (!ctx.hasUI || !(await ctx.ui.confirm("Change scheduled task?", `${params.id} → ${params.status}`)))) throw new Error("TUI confirmation is required");
      await setTaskEnabled(params.id, enabled);
      const syncResult = params.sync ? await syncCrontab({ execute: true }) : await planCrontab();
      return { content: [{ type: "text", text: `${params.id} is ${params.status}. ${params.sync ? "Crontab synced." : "Crontab not changed."}` }], details: syncResult };
    },
  });
}
