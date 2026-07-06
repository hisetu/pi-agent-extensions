import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SYNC_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_TIMEOUT_MS = 15 * 1000;
const FILE_MUTATION_TOOLS = new Set(["edit", "write"]);

type ToolResultLike = {
  toolName?: string;
  input?: unknown;
  isError?: boolean;
};

async function isInitializedCodegraphProject(pi: ExtensionAPI, projectPath: string): Promise<boolean> {
  if (!existsSync(resolve(projectPath, ".codegraph"))) {
    return false;
  }

  try {
    const result = await pi.exec("codegraph", ["status"], {
      cwd: projectPath,
      timeout: STATUS_TIMEOUT_MS,
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return result.code === 0 && !output.includes("Not initialized");
  } catch {
    return false;
  }
}

async function findNearestCodegraphProject(pi: ExtensionAPI, startPath: string): Promise<string | undefined> {
  let current = resolve(startPath);

  while (true) {
    if (await isInitializedCodegraphProject(pi, current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function getProjectLabel(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts.at(-1) ?? projectPath;
}

function getInputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

async function resolveProjectForToolEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ToolResultLike,
): Promise<string | undefined> {
  const inputPath = getInputPath(event.input);
  if (inputPath) {
    return findNearestCodegraphProject(pi, resolve(ctx.cwd, inputPath));
  }
  return findNearestCodegraphProject(pi, ctx.cwd);
}

export default function codegraphAutoSyncExtension(pi: ExtensionAPI) {
  const pendingProjects = new Set<string>();
  const syncingProjects = new Set<string>();

  const setMergedStatus = (
    ctx: ExtensionContext,
    projectPath: string,
    options?: { syncing?: boolean },
  ) => {
    const projectLabel = getProjectLabel(projectPath);
    if (options?.syncing) {
      ctx.ui.setStatus("codegraph", `cg(↻): syncing (${projectLabel})`);
      return;
    }

    const pendingCount = pendingProjects.size + syncingProjects.size;
    const base = `cg(↻): ready (${projectLabel})`;
    ctx.ui.setStatus("codegraph", pendingCount > 0 ? `${base} • ${pendingCount} pending` : base);
  };

  const setIdleStatus = async (ctx: ExtensionContext) => {
    const currentProject = await findNearestCodegraphProject(pi, ctx.cwd);
    if (!currentProject) {
      return;
    }

    setMergedStatus(ctx, currentProject);
  };

  const queueProject = async (projectPath: string, ctx: ExtensionContext) => {
    pendingProjects.add(projectPath);
    await setIdleStatus(ctx);
  };

  const syncProject = async (
    projectPath: string,
    ctx: ExtensionContext,
    options?: { notifyOnSuccess?: boolean },
  ) => {
    if (syncingProjects.has(projectPath)) {
      return;
    }

    syncingProjects.add(projectPath);
    pendingProjects.delete(projectPath);
    setMergedStatus(ctx, projectPath, { syncing: true });

    try {
      const result = await pi.exec("codegraph", ["sync"], {
        cwd: projectPath,
        timeout: SYNC_TIMEOUT_MS,
      });

      if (result.code !== 0) {
        const errorText = (result.stderr?.trim() || result.stdout?.trim() || "unknown error").split("\n")[0];
        if (errorText.includes("Not initialized")) {
          return;
        }

        pendingProjects.add(projectPath);
        ctx.ui.notify(
          `CodeGraph autosync failed for ${getProjectLabel(projectPath)}: ${errorText}`,
          "error",
        );
        return;
      }

      if (options?.notifyOnSuccess) {
        ctx.ui.notify(
          `CodeGraph synced for ${getProjectLabel(projectPath)}`,
          "info",
        );
      }
    } catch (error) {
      pendingProjects.add(projectPath);
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `CodeGraph autosync failed for ${getProjectLabel(projectPath)}: ${message}`,
        "error",
      );
    } finally {
      syncingProjects.delete(projectPath);
      await setIdleStatus(ctx);
    }
  };

  const flushPending = async (ctx: ExtensionContext, options?: { notifyOnSuccess?: boolean }) => {
    for (const projectPath of [...pendingProjects]) {
      await syncProject(projectPath, ctx, options);
    }
    await setIdleStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    await setIdleStatus(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    const result = event as ToolResultLike;
    if (result.isError) return;
    if (!FILE_MUTATION_TOOLS.has(result.toolName ?? "")) return;

    const projectPath = await resolveProjectForToolEvent(pi, ctx, result);
    if (!projectPath) return;

    await queueProject(projectPath, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await flushPending(ctx);
  });

  pi.registerCommand("codegraph-autosync", {
    description: "Force CodeGraph sync for the current project and show merged CodeGraph autosync status",
    handler: async (_args, ctx) => {
      const projectPath = await findNearestCodegraphProject(pi, ctx.cwd);
      if (!projectPath) {
        ctx.ui.notify("No initialized CodeGraph project found from the current directory", "warning");
        return;
      }

      pendingProjects.add(projectPath);
      await flushPending(ctx, { notifyOnSuccess: true });
    },
  });
}
