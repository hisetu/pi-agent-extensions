/**
 * Split Fork Extension
 *
 * Adapted from mitsupi's split-fork extension, with herdr support added.
 *
 * Behavior:
 * - When running inside herdr, split the current herdr pane and start pi there
 * - Otherwise, on macOS, fall back to opening a right-hand Ghostty split
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return [process.execPath];
	}

	return ["pi"];
}

function buildPiCommand(sessionFile: string | undefined, prompt: string): string {
	const commandParts = [...getPiInvocationParts()];

	if (sessionFile) {
		commandParts.push("--session", sessionFile);
	}

	if (prompt.length > 0) {
		commandParts.push("--", prompt);
	}

	return commandParts.map(shellQuote).join(" ");
}

function buildPiStartupInput(sessionFile: string | undefined, prompt: string): string {
	return `${buildPiCommand(sessionFile, prompt)}\n`;
}

async function createForkedSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionDir = path.dirname(sessionFile);
	const branchEntries = ctx.sessionManager.getBranch();
	const currentHeader = ctx.sessionManager.getHeader();

	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const newSessionId = randomUUID();
	const newSessionFile = path.join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

	const newHeader = {
		type: "session",
		version: currentHeader?.version ?? 3,
		id: newSessionId,
		timestamp,
		cwd: currentHeader?.cwd ?? ctx.cwd,
		parentSession: sessionFile,
	};

	const lines = [JSON.stringify(newHeader), ...branchEntries.map((entry) => JSON.stringify(entry))].join("\n") + "\n";

	await fs.mkdir(sessionDir, { recursive: true });
	await fs.writeFile(newSessionFile, lines, "utf8");

	return newSessionFile;
}

function formatFailure(result: { stderr?: string; stdout?: string }, fallback: string): string {
	return result.stderr?.trim() || result.stdout?.trim() || fallback;
}

function isRunningInHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
}

async function launchInHerdr(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	command: string,
): Promise<{ ok: true; paneId: string } | { ok: false; reason: string }> {
	const currentPaneId = process.env.HERDR_PANE_ID;
	if (!currentPaneId) {
		return { ok: false, reason: "Missing HERDR_PANE_ID." };
	}

	const splitResult = await pi.exec("herdr", [
		"pane",
		"split",
		currentPaneId,
		"--direction",
		"right",
		"--cwd",
		ctx.cwd,
		"--no-focus",
	]);
	if (splitResult.code !== 0) {
		return {
			ok: false,
			reason: formatFailure(splitResult, "Failed to split current herdr pane."),
		};
	}

	let newPaneId: string | undefined;
	try {
		const payload = JSON.parse(splitResult.stdout) as {
			result?: { pane?: { pane_id?: string } };
		};
		newPaneId = payload.result?.pane?.pane_id;
	} catch {
		return {
			ok: false,
			reason: "herdr pane split returned invalid JSON.",
		};
	}

	if (!newPaneId) {
		return {
			ok: false,
			reason: "Could not determine the new herdr pane id.",
		};
	}

	const runResult = await pi.exec("herdr", ["pane", "run", newPaneId, command]);
	if (runResult.code !== 0) {
		return {
			ok: false,
			reason: formatFailure(runResult, `Failed to run pi in herdr pane ${newPaneId}.`),
		};
	}

	return { ok: true, paneId: newPaneId };
}

async function launchInGhostty(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	startupInput: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (process.platform !== "darwin") {
		return { ok: false, reason: "/split-fork requires herdr or macOS Ghostty." };
	}

	const result = await pi.exec("osascript", ["-e", GHOSTTY_SPLIT_SCRIPT, "--", ctx.cwd, startupInput]);
	if (result.code !== 0) {
		return {
			ok: false,
			reason: formatFailure(result, "Failed to launch Ghostty split."),
		};
	}

	return { ok: true };
}

export default function splitForkExtension(pi: ExtensionAPI): void {
	pi.registerCommand("split-fork", {
		description:
			"Fork this session into a new pi pane. Uses herdr when available, otherwise a right-hand Ghostty split on macOS. Usage: /split-fork [optional prompt]",
		handler: async (args, ctx) => {
			const wasBusy = !ctx.isIdle();
			const prompt = args.trim();
			const forkedSessionFile = await createForkedSession(ctx);
			const startupInput = buildPiStartupInput(forkedSessionFile, prompt);
			const startupCommand = buildPiCommand(forkedSessionFile, prompt);

			const launchResult = isRunningInHerdr()
				? await launchInHerdr(pi, ctx, startupCommand)
				: await launchInGhostty(pi, ctx, startupInput);

			if (!launchResult.ok) {
				ctx.ui.notify(`Failed to fork split: ${launchResult.reason}`, "error");
				if (forkedSessionFile) {
					ctx.ui.notify(`Forked session was created: ${forkedSessionFile}`, "info");
				}
				return;
			}

			if (forkedSessionFile) {
				const fileName = path.basename(forkedSessionFile);
				const suffix = prompt ? " and sent prompt" : "";
				const target = "paneId" in launchResult ? ` herdr pane ${launchResult.paneId}` : " Ghostty split";
				ctx.ui.notify(`Forked to ${fileName} in a new${target}${suffix}.`, "info");
				if (wasBusy) {
					ctx.ui.notify("Forked from current committed state (in-flight turn continues in original session).", "info");
				}
				return;
			}

			ctx.ui.notify("Opened a new pane for pi (no persisted session to fork).", "warning");
		},
	});
}
