import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

type DeliveryMode = "send" | "steer" | "followUp";

type PromptActionOutcome = {
	closeOverlay: boolean;
	mutated: boolean;
	preferredId?: string;
};

interface PromptEntry {
	id: string;
	title: string;
	text: string;
	createdAt: number;
	updatedAt: number;
}

interface PromptStore {
	version: 1;
	entries: PromptEntry[];
}

const STORE_PATH = join(getAgentDir(), "prompt-stash.json");
const MAX_PREVIEW_LEN = 56;
const MAX_BODY_LINES = 14;
const MAX_BODY_CHARS = 2400;
const EMPTY_VALUE = "__empty__";

function ensureStoreDir() {
	mkdirSync(dirname(STORE_PATH), { recursive: true });
}

function defaultStore(): PromptStore {
	return { version: 1, entries: [] };
}

function loadStore(): PromptStore {
	ensureStoreDir();
	if (!existsSync(STORE_PATH)) return defaultStore();

	try {
		const raw = readFileSync(STORE_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<PromptStore>;
		const entries = Array.isArray(parsed.entries)
			? parsed.entries.filter(
				(entry): entry is PromptEntry =>
					!!entry &&
					typeof entry.id === "string" &&
					typeof entry.title === "string" &&
					typeof entry.text === "string" &&
					typeof entry.createdAt === "number" &&
					typeof entry.updatedAt === "number",
			)
			: [];
		return { version: 1, entries };
	} catch {
		return defaultStore();
	}
}

function saveStore(store: PromptStore) {
	ensureStoreDir();
	writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function sortEntries(entries: PromptEntry[]): PromptEntry[] {
	return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
}

function listEntries(): PromptEntry[] {
	return sortEntries(loadStore().entries);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function preview(text: string, maxLen: number = MAX_PREVIEW_LEN): string {
	const normalized = oneLine(text);
	if (!normalized) return "(empty)";
	return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}

function deriveTitle(text: string): string {
	const firstLine = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	return firstLine ? preview(firstLine, 32) : "Untitled prompt";
}

function formatDate(ts: number): string {
	return new Date(ts).toLocaleString();
}

function entryLabel(entry: PromptEntry): string {
	return preview(entry.text, 40);
}

function previewBody(text: string): string {
	const normalized = text.trim();
	if (!normalized) return "(empty)";

	let body = normalized;
	let truncatedByChars = false;
	if (body.length > MAX_BODY_CHARS) {
		body = `${body.slice(0, MAX_BODY_CHARS).trimEnd()}\n…`;
		truncatedByChars = true;
	}

	const lines = body.split(/\r?\n/);
	if (lines.length > MAX_BODY_LINES) {
		const hidden = lines.length - MAX_BODY_LINES;
		body = `${lines.slice(0, MAX_BODY_LINES).join("\n")}\n… (${hidden} more line${hidden === 1 ? "" : "s"})`;
	} else if (truncatedByChars) {
		body = `${body}\n_(truncated)_`;
	}

	return body;
}

function updateStatus(ctx: ExtensionContext) {
	const count = loadStore().entries.length;
	ctx.ui.setStatus("prompt-stash", count > 0 ? `prompts:${count}` : undefined);
}

function createPromptEntry(text: string): PromptEntry {
	const now = Date.now();
	return {
		id: randomUUID(),
		title: deriveTitle(text),
		text,
		createdAt: now,
		updatedAt: now,
	};
}

function insertPromptEntry(text: string): PromptEntry {
	const store = loadStore();
	const entry = createPromptEntry(text);
	store.entries.unshift(entry);
	saveStore({ ...store, entries: sortEntries(store.entries) });
	return entry;
}

function updatePromptEntry(id: string, text: string): PromptEntry | undefined {
	const store = loadStore();
	let updated: PromptEntry | undefined;
	store.entries = store.entries.map((entry) => {
		if (entry.id !== id) return entry;
		updated = {
			...entry,
			title: deriveTitle(text),
			text,
			updatedAt: Date.now(),
		};
		return updated;
	});

	if (!updated) return undefined;
	saveStore({ ...store, entries: sortEntries(store.entries) });
	return updated;
}

function removePromptEntry(id: string): PromptEntry | undefined {
	const store = loadStore();
	const removed = store.entries.find((entry) => entry.id === id);
	if (!removed) return undefined;
	store.entries = store.entries.filter((entry) => entry.id !== id);
	saveStore(store);
	return removed;
}

async function pickEntry(ctx: ExtensionContext, title: string): Promise<PromptEntry | undefined> {
	const entries = listEntries();
	if (entries.length === 0) {
		ctx.ui.notify("No saved prompts yet", "info");
		return undefined;
	}

	const options = entries.map((entry, index) => {
		const stamp = new Date(entry.updatedAt).toLocaleDateString();
		return `${index + 1}. ${entryLabel(entry)} · ${stamp}`;
	});

	const selected = await ctx.ui.select(title, options);
	if (!selected) return undefined;

	const match = selected.match(/^(\d+)\./);
	if (!match) return undefined;
	const index = Number(match[1]) - 1;
	return entries[index];
}

async function sendPrompt(pi: ExtensionAPI, ctx: ExtensionContext, text: string, mode: DeliveryMode) {
	if (mode === "send") {
		if (ctx.isIdle()) {
			pi.sendUserMessage(text);
		} else {
			const choice = await ctx.ui.select("Agent is busy. Choose delivery mode", ["Steer", "Follow-up", "Cancel"]);
			if (choice === "Steer") {
				pi.sendUserMessage(text, { deliverAs: "steer" });
				ctx.ui.notify("Added to steering queue", "info");
			} else if (choice === "Follow-up") {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
				ctx.ui.notify("Added to follow-up queue", "info");
			}
		}
		return;
	}

	if (ctx.isIdle()) {
		pi.sendUserMessage(text);
		return;
	}

	pi.sendUserMessage(text, { deliverAs: mode });
	ctx.ui.notify(mode === "steer" ? "Added to steering queue" : "Added to follow-up queue", "info");
}

async function saveCurrentEditorAsPrompt(ctx: ExtensionContext): Promise<PromptEntry | undefined> {
	let text = ctx.ui.getEditorText();
	if (!text.trim()) {
		const composed = await ctx.ui.editor("Enter prompt to save", "");
		if (!composed?.trim()) {
			ctx.ui.notify("Not saved: prompt is empty", "warning");
			return undefined;
		}
		text = composed;
	}

	const savedEntry = insertPromptEntry(text);
	ctx.ui.notify(`Saved prompt: ${entryLabel(savedEntry)}`, "info");
	updateStatus(ctx);
	return savedEntry;
}

async function editPromptEntryWithDialog(ctx: ExtensionContext, entry: PromptEntry): Promise<PromptEntry | undefined> {
	const edited = await ctx.ui.editor(`Edit: ${entryLabel(entry)}`, entry.text);
	if (!edited?.trim()) {
		ctx.ui.notify("Not updated: prompt is empty", "warning");
		return undefined;
	}

	const updated = updatePromptEntry(entry.id, edited);
	if (!updated) return undefined;
	ctx.ui.notify(`Updated: ${preview(updated.text, 40)}`, "info");
	updateStatus(ctx);
	return updated;
}

async function deletePromptEntryWithConfirm(ctx: ExtensionContext, entry: PromptEntry): Promise<boolean> {
	const ok = await ctx.ui.confirm("Delete prompt", `Delete \"${entryLabel(entry)}\"?\n\nLast updated: ${formatDate(entry.updatedAt)}`);
	if (!ok) return false;
	const removed = removePromptEntry(entry.id);
	if (!removed) return false;
	ctx.ui.notify(`Deleted: ${entryLabel(entry)}`, "info");
	updateStatus(ctx);
	return true;
}

async function runPromptActionMenu(pi: ExtensionAPI, ctx: ExtensionContext, entry: PromptEntry): Promise<PromptActionOutcome> {
	const action = await ctx.ui.select(`"${entry.title}"`, [
		"Load into editor",
		"Send now",
		"Send as steering",
		"Send as follow-up",
		"Edit and save",
		"Delete",
		"Cancel",
	]);
	if (!action || action === "Cancel") {
		return { closeOverlay: false, mutated: false, preferredId: entry.id };
	}

	if (action === "Load into editor") {
		ctx.ui.setEditorText(entry.text);
		ctx.ui.notify(`Loaded: ${entryLabel(entry)}`, "info");
		return { closeOverlay: true, mutated: false, preferredId: entry.id };
	}

	if (action === "Send now") {
		await sendPrompt(pi, ctx, entry.text, "send");
		return { closeOverlay: true, mutated: false, preferredId: entry.id };
	}

	if (action === "Send as steering") {
		await sendPrompt(pi, ctx, entry.text, "steer");
		return { closeOverlay: true, mutated: false, preferredId: entry.id };
	}

	if (action === "Send as follow-up") {
		await sendPrompt(pi, ctx, entry.text, "followUp");
		return { closeOverlay: true, mutated: false, preferredId: entry.id };
	}

	if (action === "Edit and save") {
		const updated = await editPromptEntryWithDialog(ctx, entry);
		return {
			closeOverlay: false,
			mutated: Boolean(updated),
			preferredId: updated?.id ?? entry.id,
		};
	}

	if (action === "Delete") {
		const deleted = await deletePromptEntryWithConfirm(ctx, entry);
		return {
			closeOverlay: false,
			mutated: deleted,
			preferredId: entry.id,
		};
	}

	return { closeOverlay: false, mutated: false, preferredId: entry.id };
}

class PromptStashOverlay {
	private readonly markdownTheme = getMarkdownTheme();
	private entries: PromptEntry[] = [];
	private selectedId?: string;
	private container: Container = new Container();
	private selectList?: SelectList;
	private summaryText?: Text;
	private previewHeaderText?: Text;
	private previewMetaText?: Text;
	private previewBody?: Markdown;
	private helpText?: Text;
	private busy = false;
	private closed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly tui: { requestRender: () => void },
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: (value: void) => void,
	) {
		this.rebuildUI();
	}

	private reloadEntries(preferredId?: string) {
		this.entries = listEntries();
		const availableIds = new Set(this.entries.map((entry) => entry.id));
		if (preferredId && availableIds.has(preferredId)) {
			this.selectedId = preferredId;
		} else if (!this.selectedId || !availableIds.has(this.selectedId)) {
			this.selectedId = this.entries[0]?.id;
		}
	}

	private getSelectedEntry(): PromptEntry | undefined {
		if (!this.selectedId) return this.entries[0];
		return this.entries.find((entry) => entry.id === this.selectedId) ?? this.entries[0];
	}

	private buildItems(): SelectItem[] {
		if (this.entries.length === 0) {
			return [
				{
					value: EMPTY_VALUE,
					label: "No saved prompts yet",
					description: "Press Ctrl+S to save the current editor content",
				},
			];
		}

		return this.entries.map((entry) => ({
			value: entry.id,
			label: entry.title,
			description: `${preview(entry.text, 72)} · ${new Date(entry.updatedAt).toLocaleDateString()}`,
		}));
	}

	private updateTexts() {
		const count = this.entries.length;
		this.summaryText?.setText(
			this.theme.fg(
				"muted",
				count > 0
					? `${count} prompt${count === 1 ? "" : "s"} • Enter for actions • Ctrl+S to save current editor`
					: "No saved prompts yet • Ctrl+S to save current editor",
			),
		);

		const entry = this.getSelectedEntry();
		if (!entry) {
			this.previewHeaderText?.setText(this.theme.fg("accent", this.theme.bold("Prompt Preview")));
			this.previewMetaText?.setText(this.theme.fg("dim", "Press Ctrl+S to save the current editor content."));
			this.previewBody?.setText("There are no saved prompts yet.\n\nWrite a prompt in the editor, then press Ctrl+S to save it.");
		} else {
			this.previewHeaderText?.setText(
				this.theme.fg("accent", this.theme.bold(`Prompt Preview — ${entry.title}`)),
			);
			this.previewMetaText?.setText(
				this.theme.fg(
					"dim",
					`Updated ${formatDate(entry.updatedAt)} • Created ${formatDate(entry.createdAt)}`,
				),
			);
			this.previewBody?.setText(previewBody(entry.text));
		}

		this.helpText?.setText(
			this.theme.fg(
				"dim",
				"↑↓ navigate • Enter actions • Esc close\nActions: load into editor / send / edit / delete",
			),
		);
	}

	private rebuildUI(preferredId?: string) {
		this.reloadEntries(preferredId);
		const items = this.buildItems();
		const selectedEntry = this.getSelectedEntry();
		const selectedIndex = selectedEntry ? this.entries.findIndex((entry) => entry.id === selectedEntry.id) : 0;

		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Prompt Stash")), 1, 0));

		this.summaryText = new Text("", 1, 0);
		container.addChild(this.summaryText);
		container.addChild(new Spacer(1));

		const selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 10), {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("warning", text),
		});
		if (selectedIndex >= 0) {
			selectList.setSelectedIndex(selectedIndex);
		}
		selectList.onCancel = () => this.close();
		selectList.onSelect = (item) => {
			if (item.value === EMPTY_VALUE) return;
			void this.openActions(item.value);
		};
		selectList.onSelectionChange = (item) => {
			if (item.value === EMPTY_VALUE) return;
			this.selectedId = item.value;
			this.updateTexts();
			this.requestRender();
		};
		this.selectList = selectList;
		container.addChild(selectList);

		container.addChild(new Spacer(1));
		this.previewHeaderText = new Text("", 1, 0);
		container.addChild(this.previewHeaderText);
		this.previewMetaText = new Text("", 1, 0);
		container.addChild(this.previewMetaText);
		this.previewBody = new Markdown("", 1, 0, this.markdownTheme);
		container.addChild(this.previewBody);

		container.addChild(new Spacer(1));
		this.helpText = new Text("", 1, 0);
		container.addChild(this.helpText);
		container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));

		this.container = container;
		this.updateTexts();
	}

	private requestRender() {
		if (this.closed) return;
		this.tui.requestRender();
	}

	private close() {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
	}

	private async saveCurrentEditor() {
		if (this.busy) return;
		this.busy = true;
		try {
			const saved = await saveCurrentEditorAsPrompt(this.ctx);
			if (!saved) return;
			this.rebuildUI(saved.id);
			this.requestRender();
		} finally {
			this.busy = false;
		}
	}

	private async openActions(entryId: string) {
		if (this.busy) return;
		const entry = this.entries.find((item) => item.id === entryId);
		if (!entry) return;

		this.busy = true;
		try {
			const outcome = await runPromptActionMenu(this.pi, this.ctx, entry);
			if (outcome.closeOverlay) {
				this.close();
				return;
			}
			if (outcome.mutated) {
				this.rebuildUI(outcome.preferredId);
				this.requestRender();
			}
		} finally {
			this.busy = false;
		}
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	invalidate(): void {
		this.rebuildUI(this.selectedId);
	}

	handleInput(data: string): void {
		if (this.busy) return;
		if (matchesKey(data, Key.ctrl("s"))) {
			void this.saveCurrentEditor();
			return;
		}

		this.selectList?.handleInput(data);
		this.requestRender();
	}
}

async function showLegacyPromptList(pi: ExtensionAPI, ctx: ExtensionContext) {
	const entry = await pickEntry(ctx, "Choose a saved prompt");
	if (!entry) return;
	await runPromptActionMenu(pi, ctx, entry);
}

async function openPromptStashOverlay(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (ctx.mode !== "tui") {
		await showLegacyPromptList(pi, ctx);
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new PromptStashOverlay(pi, ctx, tui, theme, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "70%",
				minWidth: 72,
				maxHeight: "80%",
				margin: 1,
			},
		},
	);
}

export default function promptStashExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.registerCommand("prompt-stash", {
		description: "Open the prompt stash manager",
		handler: async (_args, ctx) => {
			await openPromptStashOverlay(pi, ctx);
		},
	});
}
