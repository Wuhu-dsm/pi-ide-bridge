/**
 * IDE Bridge Extension for pi-coding-agent.
 *
 * Provides IDE context awareness for VS Code / Cursor / Trae:
 * - Receives active file, open files, workspace roots, and current selection.
 * - Displays the active file/selection in the footer status bar.
 * - Injects the active file and selection into the LLM context on each prompt,
 *   then clears the selection so stale code is not carried into follow-ups.
 * - Enhances `@` autocompletion with IDE open files.
 * - Accepts file/terminal insertions from the companion IDE extension.
 * - Tracks IDE heartbeats and reverts to "not connected" when the IDE goes away.
 * - Provides `/ide init` to download and install the companion IDE extension.
 *
 * Each new Pi terminal binds to the first free port in the configured range so
 * multiple Pi instances can run side by side without EADDRINUSE errors.
 *
 * Requires the companion VS Code / Cursor / Trae extension.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions, KeyId } from "@earendil-works/pi-tui";

interface IDESelection {
	text: string;
	startLine: number;
	endLine: number;
}

type IDEEditor = "vscode" | "cursor" | "trae";

interface IDEStateUpdate {
	editor: string;
	activeFile: string | null;
	workspaceRoot: string | null;
	workspaceRoots?: string[] | null;
	openFiles: string[];
	selection: IDESelection | null;
}

interface IDEFileInsert {
	type: "file";
	path: string;
}

interface IDETerminalInsert {
	type: "terminal";
	text: string;
}

type IDEInsertRequest = IDEFileInsert | IDETerminalInsert;

interface IDEState {
	connected: boolean;
	editor: IDEEditor | null;
	activeFile: string | null;
	workspaceRoots: string[];
	openFiles: string[];
	selection: IDESelection | null;
}

const DEFAULT_PORT = 17325;
const MAX_PORT_ATTEMPTS = 10;
const MAX_SELECTION_CHARS = 4000;
const MAX_SELECTION_LINES = 100;
const MAX_OPEN_FILES_IN_AUTOCOMPLETE = 20;
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;

const EDITOR_LABELS: Record<IDEEditor, string> = {
	vscode: "VS Code",
	cursor: "Cursor",
	trae: "Trae",
};

function getAgentDir(): string {
	return process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function getPortFilePath(): string {
	return path.join(getAgentDir(), "ide-bridge.port");
}

function normalizeEditor(editor: string | null | undefined): IDEEditor | null {
	if (!editor) return null;
	const normalized = editor.toLowerCase().trim().replace(/\s+/g, "");
	switch (normalized) {
		case "vscode":
		case "visualstudiocode":
		case "code":
			return "vscode";
		case "cursor":
			return "cursor";
		case "trae":
		case "traecn":
			return "trae";
		default:
			return null;
	}
}

function getEditorLabel(editor: IDEEditor | null): string {
	return editor ? (EDITOR_LABELS[editor] ?? "IDE") : "IDE";
}

function getRelativeFileDisplay(activeFile: string, workspaceRoots: string[]): string {
	const baseName = path.posix.basename(activeFile.replace(/\\/g, "/"));
	if (workspaceRoots.length === 0) return baseName;

	let best: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const root of workspaceRoots) {
		const rel = path.win32.relative(path.win32.normalize(root), path.win32.normalize(activeFile));
		if (!rel || rel.startsWith("..") || path.win32.isAbsolute(rel)) continue;
		const normalized = rel.replace(/\\/g, "/");
		// Prefer shorter, shallower relative paths.
		const score = normalized.length + normalized.split("/").length;
		if (score < bestScore) {
			bestScore = score;
			best = normalized;
		}
	}

	return best ?? baseName;
}

function getBasePort(): number {
	const env = process.env.PI_IDE_BRIDGE_PORT;
	if (!env) return DEFAULT_PORT;
	const parsed = Number.parseInt(env, 10);
	return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
}

function truncateSelection(selection: IDESelection): IDESelection {
	const lines = selection.text.split("\n");
	let truncated = selection.text;
	let endLine = selection.endLine;

	if (lines.length > MAX_SELECTION_LINES) {
		truncated = `${lines.slice(0, MAX_SELECTION_LINES).join("\n")}\n... (selection truncated)`;
		endLine = selection.startLine + MAX_SELECTION_LINES - 1;
	}

	if (truncated.length > MAX_SELECTION_CHARS) {
		truncated = `${truncated.slice(0, MAX_SELECTION_CHARS)}\n... (selection truncated)`;
	}

	return {
		text: truncated,
		startLine: selection.startLine,
		endLine,
	};
}

function formatStatus(state: IDEState, boundPort: number | null): string | undefined {
	if (!state.connected) {
		return boundPort !== null ? `IDE: not connected (port ${boundPort})` : "IDE: not connected";
	}

	const editorLabel = getEditorLabel(state.editor);
	const fileName = state.activeFile
		? getRelativeFileDisplay(state.activeFile, state.workspaceRoots)
		: "connected";
	const selectionInfo = state.selection ? ` [${state.selection.startLine + 1}-${state.selection.endLine + 1}]` : "";

	return `${editorLabel}: ${fileName}${selectionInfo}`;
}

function buildContextMessage(state: IDEState): string {
	const parts: string[] = [];

	const workspaceRoot = state.workspaceRoots[0];
	if (workspaceRoot) {
		parts.push(`IDE workspace root: ${workspaceRoot}`);
	}

	if (state.activeFile) {
		parts.push(`Active IDE file: ${state.activeFile}`);
	}

	if (state.selection?.text) {
		const sel = state.selection;
		const langHint = state.activeFile ? (state.activeFile.split(".").pop() ?? "") : "";
		const fenceOpen = langHint ? `\`\`\`${langHint}` : "\`\`\`";
		parts.push(
			`Selected code in IDE (lines ${sel.startLine + 1}-${sel.endLine + 1}):\n${fenceOpen}\n${sel.text}\n\`\`\``,
		);
	}

	return parts.join("\n\n");
}

function extractAtToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|[\t ])@([^\s]*)$/);
	return match?.[1];
}

function createIDEAutocompleteProvider(current: AutocompleteProvider, getState: () => IDEState): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractAtToken(textBeforeCursor);
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const state = getState();
			if (!state.connected || state.openFiles.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const query = token.toLowerCase();
			const uniqueFiles = Array.from(
				new Set([state.activeFile, ...state.openFiles].filter((file): file is string => file !== null)),
			);

			const matches: AutocompleteItem[] = [];
			for (const file of uniqueFiles.slice(0, MAX_OPEN_FILES_IN_AUTOCOMPLETE)) {
				if (query && !file.toLowerCase().includes(query)) continue;
				matches.push({
					value: `@${file}`,
					label: getRelativeFileDisplay(file, state.workspaceRoots),
					description: file,
				});
			}

			if (matches.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return {
				items: matches,
				prefix: `@${token}`,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function fileToMarkdownLink(filePath: string): string {
	const name = path.posix.basename(filePath.replace(/\\/g, "/")) || filePath;
	const url = `file://${encodeURI(filePath.replace(/\\/g, "/"))}`;
	return `[${name}](${url})`;
}

function readJsonBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		let length = 0;
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			length += Buffer.byteLength(chunk, "utf8");
			if (length > MAX_REQUEST_BODY_BYTES) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			body += chunk;
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function tryListen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function startServer(server: Server, basePort: number): Promise<number> {
	for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
		const port = basePort + offset;
		try {
			await tryListen(server, port);
			return port;
		} catch (err: unknown) {
			const errnoError = err as NodeJS.ErrnoException;
			if (errnoError.code !== "EADDRINUSE" || offset === MAX_PORT_ATTEMPTS - 1) {
				throw err;
			}
		}
	}
	throw new Error(`Could not bind IDE bridge server after ${MAX_PORT_ATTEMPTS} attempts`);
}

function validateIDEStateUpdate(update: unknown): update is IDEStateUpdate {
	if (typeof update !== "object" || update === null) return false;
	const u = update as Record<string, unknown>;
	if (typeof u.editor !== "string") return false;
	if (u.activeFile !== null && typeof u.activeFile !== "string") return false;
	if (u.workspaceRoot !== null && typeof u.workspaceRoot !== "string") return false;
	if (u.workspaceRoots !== undefined && u.workspaceRoots !== null) {
		if (!Array.isArray(u.workspaceRoots) || !u.workspaceRoots.every((r) => typeof r === "string")) return false;
	}
	if (!Array.isArray(u.openFiles) || !u.openFiles.every((f) => typeof f === "string")) return false;
	if (u.selection !== null) {
		if (typeof u.selection !== "object") return false;
		const s = u.selection as Record<string, unknown>;
		if (typeof s.text !== "string") return false;
		if (typeof s.startLine !== "number") return false;
		if (typeof s.endLine !== "number") return false;
	}
	return true;
}

function validateIDEInsertRequest(request: unknown): request is IDEInsertRequest {
	if (typeof request !== "object" || request === null) return false;
	const r = request as Record<string, unknown>;
	if (r.type === "file") return typeof r.path === "string";
	if (r.type === "terminal") return typeof r.text === "string";
	return false;
}

function isSameSelection(a: IDESelection | null, b: IDESelection | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.text === b.text && a.startLine === b.startLine && a.endLine === b.endLine;
}

function isSameStringArray(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

function isSameState(a: IDEState, b: IDEStateUpdate, normalizedEditor: IDEEditor | null): boolean {
	if (a.editor !== normalizedEditor) return false;
	if (a.activeFile !== b.activeFile) return false;
	const roots = b.workspaceRoots ?? (b.workspaceRoot ? [b.workspaceRoot] : []);
	if (!isSameStringArray(a.workspaceRoots, roots)) return false;
	if (!isSameStringArray(a.openFiles, b.openFiles)) return false;
	if (!isSameSelection(a.selection, b.selection)) return false;
	return true;
}

// ============================================================================
// One-click companion extension installer ("/ide init")
// ============================================================================

const GITHUB_OWNER = "Wuhu-dsm";
const GITHUB_REPO = "pi-ide-bridge";
const VSIX_ASSET_PREFIX = "pi-ide-bridge-vscode-";
const VSIX_ASSET_SUFFIX = ".vsix";
const INSTALL_TIMEOUT_MS = 60_000;

interface GitHubReleaseAsset {
	name: string;
	browser_download_url: string;
	content_type?: string;
}

interface GitHubRelease {
	tag_name: string;
	assets: GitHubReleaseAsset[];
}

interface EditorCandidate {
	name: string;
	cli: string;
}

interface DetectedEditor {
	name: string;
	cli: string;
	version: string;
}

const EDITOR_CANDIDATES: EditorCandidate[] = [
	{ name: "VS Code", cli: "code" },
	{ name: "VS Code Insiders", cli: "code-insiders" },
	{ name: "Cursor", cli: "cursor" },
	{ name: "Trae", cli: "trae" },
	{ name: "Trae CN", cli: "trae.cn" },
];

async function fetchLatestRelease(): Promise<{ version: string; assetUrl: string; assetName: string }> {
	const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
	const response = await fetch(url, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "pi-ide-bridge-extension",
		},
	});
	if (!response.ok) {
		throw new Error(`GitHub API returned ${response.status} ${response.statusText}`);
	}

	const release = (await response.json()) as GitHubRelease;
	const asset = release.assets.find(
		(a) => a.name.startsWith(VSIX_ASSET_PREFIX) && a.name.endsWith(VSIX_ASSET_SUFFIX),
	);
	if (!asset) {
		throw new Error(`No .vsix asset found in release ${release.tag_name}`);
	}

	const version = release.tag_name.replace(/^v/, "");
	return { version, assetUrl: asset.browser_download_url, assetName: asset.name };
}

async function downloadVsix(assetUrl: string, assetName: string): Promise<string> {
	const response = await fetch(assetUrl);
	if (!response.ok) {
		throw new Error(`Download returned ${response.status} ${response.statusText}`);
	}

	const buffer = await response.arrayBuffer();
	const tempPath = path.join(os.tmpdir(), `pi-ide-bridge-${Date.now()}-${assetName}`);
	await fsp.writeFile(tempPath, new Uint8Array(buffer));
	return tempPath;
}

async function execEditorCli(
	pi: ExtensionAPI,
	cli: string,
	args: string[],
	options: { timeout: number },
): Promise<ExecResult> {
	// On Windows, editor CLIs ship as .cmd wrappers in a directory on PATH.
	// pi.exec uses Node's spawn with shell:false, which cannot resolve or
	// execute .cmd files directly. Run via cmd /c so PATH resolution works.
	if (process.platform === "win32") {
		return pi.exec("cmd", ["/c", cli, ...args], options);
	}
	return pi.exec(cli, args, options);
}

async function detectInstalledEditors(pi: ExtensionAPI): Promise<DetectedEditor[]> {
	const detected: DetectedEditor[] = [];
	for (const candidate of EDITOR_CANDIDATES) {
		const result = await execEditorCli(pi, candidate.cli, ["--version"], { timeout: 5_000 });
		if (result.code === 0) {
			const version = result.stdout.split(/\r?\n/)[0]?.trim() || "unknown";
			detected.push({ ...candidate, version });
		}
	}
	return detected;
}

async function installVsix(pi: ExtensionAPI, cli: string, vsixPath: string): Promise<ExecResult> {
	return execEditorCli(pi, cli, ["--install-extension", vsixPath, "--force"], { timeout: INSTALL_TIMEOUT_MS });
}

export default function (pi: ExtensionAPI): void {
	let state: IDEState = {
		connected: false,
		editor: null,
		activeFile: null,
		workspaceRoots: [],
		openFiles: [],
		selection: null,
	};

	let server: Server | null = null;
	let boundPort: number | null = null;
	let serverErrorNotified = false;
	let currentCtx: ExtensionContext | undefined;
	let lastActivityAt = 0;
	let heartbeatTimer: NodeJS.Timeout | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		const status = formatStatus(state, boundPort);
		if (status !== undefined) {
			ctx.ui.setStatus("ide-bridge", status);
		}
	}

	function resetState(): void {
		state = {
			connected: false,
			editor: null,
			activeFile: null,
			workspaceRoots: [],
			openFiles: [],
			selection: null,
		};
	}

	function markActivity(ctx?: ExtensionContext): void {
		lastActivityAt = Date.now();
		if (!state.connected) {
			state.connected = true;
			if (ctx) updateStatus(ctx);
		}
	}

	function writePortFile(): void {
		if (boundPort === null) return;
		try {
			fs.mkdirSync(getAgentDir(), { recursive: true });
			fs.writeFileSync(getPortFilePath(), String(boundPort), "utf8");
		} catch {
			// Best-effort; the companion extension can still scan the port range.
		}
	}

	function deletePortFile(): void {
		try {
			if (fs.existsSync(getPortFilePath())) {
				fs.unlinkSync(getPortFilePath());
			}
		} catch {
			// Ignore cleanup errors.
		}
	}

	function checkHeartbeat(): void {
		if (!state.connected) return;
		if (Date.now() - lastActivityAt > HEARTBEAT_TIMEOUT_MS) {
			state.connected = false;
			if (currentCtx) updateStatus(currentCtx);
		}
	}

	function insertIntoEditor(ctx: ExtensionContext | undefined, request: IDEInsertRequest): void {
		if (!ctx) return;
		if (ctx.mode !== "tui") return;

		if (request.type === "file") {
			ctx.ui.pasteToEditor(fileToMarkdownLink(request.path));
		} else {
			const text = request.text.trim();
			if (!text) return;
			ctx.ui.pasteToEditor(text);
		}

		// pasteToEditor mutates the editor state directly; the TUI only re-renders
		// automatically on real terminal input. Force an immediate render by
		// refreshing the footer status (which calls requestRender internally).
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		currentCtx = ctx;
		if (server !== null) {
			updateStatus(ctx);
			return;
		}

		const basePort = getBasePort();

		server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			if (req.method !== "POST") {
				res.writeHead(404);
				res.end("not found");
				return;
			}

			let body: string;
			try {
				body = await readJsonBody(req);
			} catch {
				res.writeHead(413);
				res.end("payload too large");
				return;
			}
			const ctxRef = currentCtx ?? ctx;

			if (req.url === "/ide-ping") {
				markActivity(ctxRef);
				res.writeHead(200);
				res.end("ok");
				return;
			}

			if (req.url === "/ide-state") {
				let update: unknown;
				try {
					update = JSON.parse(body);
				} catch {
					res.writeHead(400);
					res.end("bad request");
					return;
				}
				if (!validateIDEStateUpdate(update)) {
					res.writeHead(400);
					res.end("invalid state");
					return;
				}

				const normalizedEditor = normalizeEditor(update.editor);
				const roots = update.workspaceRoots ?? (update.workspaceRoot ? [update.workspaceRoot] : []);

				// Skip redundant updates to avoid spamming the footer and re-rendering.
				if (!isSameState(state, update, normalizedEditor)) {
					state = {
						connected: true,
						editor: normalizedEditor,
						activeFile: update.activeFile,
						workspaceRoots: roots,
						openFiles: update.openFiles,
						selection: update.selection ? truncateSelection(update.selection) : null,
					};
					updateStatus(ctxRef);
				}
				markActivity(ctxRef);
				res.writeHead(200);
				res.end("ok");
				return;
			}

			if (req.url === "/editor-insert") {
				let request: unknown;
				try {
					request = JSON.parse(body);
				} catch {
					res.writeHead(400);
					res.end("bad request");
					return;
				}
				if (!validateIDEInsertRequest(request)) {
					res.writeHead(400);
					res.end("invalid insert request");
					return;
				}

				markActivity(ctxRef);
				insertIntoEditor(ctxRef, request);
				res.writeHead(200);
				res.end("ok");
				return;
			}

			res.writeHead(404);
			res.end("not found");
		});

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (!serverErrorNotified) {
				serverErrorNotified = true;
				ctx.ui.notify(`IDE bridge server error: ${err.message}`, "error");
			}
		});

		try {
			boundPort = await startServer(server, basePort);
			writePortFile();
			ctx.ui.notify(`IDE bridge listening on 127.0.0.1:${boundPort}`, "info");
			ctx.ui.addAutocompleteProvider((current) => createIDEAutocompleteProvider(current, () => state));
			updateStatus(ctx);
			heartbeatTimer = setInterval(checkHeartbeat, HEARTBEAT_INTERVAL_MS);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`IDE bridge failed to start: ${message}`, "error");
			if (server !== null) {
				server.close();
				server = null;
			}
		}
	});

	pi.on("session_shutdown", async () => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (server !== null) {
			server.close();
			server = null;
		}
		deletePortFile();
		boundPort = null;
		serverErrorNotified = false;
		currentCtx = undefined;
		resetState();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!state.activeFile && !state.selection) return;

		const message = buildContextMessage(state);
		if (!message) return;

		// Clear the selection after it has been used so it does not pollute
		// follow-up turns indefinitely.
		const hadSelection = state.selection !== null;
		state.selection = null;
		if (hadSelection) updateStatus(ctx);

		return {
			message: {
				customType: "ide-bridge",
				content: message,
				display: false,
			},
		};
	});

	pi.registerCommand("ide-state", {
		description: "Show IDE bridge state",
		handler: async (_args, ctx) => {
			const lines = [
				`Bound port: ${boundPort ?? "none"}`,
				`Connected: ${state.connected ? "yes" : "no"}`,
				`Editor: ${state.editor ?? "none"}`,
				`Active file: ${state.activeFile ?? "none"}`,
				`Workspace roots: ${state.workspaceRoots.length}`,
				`Open files: ${state.openFiles.length}`,
			];
			if (state.selection) {
				lines.push(
					`Selection: lines ${state.selection.startLine + 1}-${state.selection.endLine + 1} (${state.selection.text.length} chars)`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("ide-bridge-port", {
		description: "Show the IDE bridge port range",
		handler: async (_args, ctx) => {
			const basePort = getBasePort();
			ctx.ui.notify(
				`Base port: ${basePort}, range: ${basePort}-${basePort + MAX_PORT_ATTEMPTS - 1}, current: ${boundPort ?? "not bound"}`,
				"info",
			);
		},
	});

	pi.registerCommand("ide-insert-active-file", {
		description: "Insert the active IDE file into the editor",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.activeFile) {
				ctx.ui.notify("No active IDE file", "warning");
				return;
			}
			ctx.ui.pasteToEditor(fileToMarkdownLink(state.activeFile));
			updateStatus(ctx);
		},
	});

	pi.registerCommand("ide-insert-selection", {
		description: "Insert the current IDE selection into the editor as a code block",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.selection?.text) {
				ctx.ui.notify("No IDE selection", "warning");
				return;
			}
			const sel = state.selection;
			const langHint = state.activeFile ? (state.activeFile.split(".").pop() ?? "") : "";
			const fenceOpen = langHint ? `\`\`\`${langHint}` : "\`\`\`";
			ctx.ui.pasteToEditor(`${fenceOpen}\n${sel.text}\n\`\`\``);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("ide-open-files", {
		description: "Pick an open IDE file and insert it into the editor",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.connected || state.openFiles.length === 0) {
				ctx.ui.notify("No open IDE files", "warning");
				return;
			}
			const uniqueFiles = Array.from(new Set(state.openFiles));
			const chosen = await ctx.ui.select("Open IDE files", uniqueFiles);
			if (!chosen) return;
			ctx.ui.pasteToEditor(fileToMarkdownLink(chosen));
			updateStatus(ctx);
		},
	});

	pi.registerCommand("ide-clear-selection", {
		description: "Clear the cached IDE selection",
		handler: async (_args, ctx) => {
			if (state.selection) {
				state.selection = null;
				updateStatus(ctx);
			}
			ctx.ui.notify("IDE selection cleared", "info");
		},
	});

	pi.registerCommand("ide", {
		description: "Install the companion VS Code/Cursor/Trae extension (/ide init)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				// eslint-disable-next-line no-console
				console.log("/ide init is only available in Pi's interactive TUI.");
				return;
			}

			const subcommand = args.trim().toLowerCase();
			if (subcommand !== "init") {
				ctx.ui.notify("Usage: /ide init  (installs the companion IDE extension)", "warning");
				return;
			}

			ctx.ui.notify("🔍 Checking for the latest companion IDE extension...", "info");

			let release: { version: string; assetUrl: string; assetName: string };
			try {
				release = await fetchLatestRelease();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					`Could not fetch latest release: ${message}\nPlease install manually from https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
					"error",
				);
				return;
			}

			ctx.ui.notify(`📦 Latest companion extension: ${release.version}`, "info");

			let editors: DetectedEditor[];
			try {
				editors = await detectInstalledEditors(pi);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Could not detect editors: ${message}`, "error");
				return;
			}

			if (editors.length === 0) {
				ctx.ui.notify(
					"No supported editor CLI found on PATH.\nSupported: code, code-insiders, cursor, trae, trae.cn\nMake sure your editor's command line tools are installed, then run /ide init again.",
					"warning",
				);
				return;
			}

			const editorList = editors.map((e) => `${e.name} (${e.version})`).join(", ");
			ctx.ui.notify(`Detected editors: ${editorList}`, "info");

			const confirmed = await ctx.ui.confirm(
				"Install Pi IDE Bridge companion extension?",
				`Editors: ${editorList}\n\nThis will download ${release.assetName} and install it into each detected editor.`,
			);
			if (!confirmed) {
				ctx.ui.notify("Installation cancelled.", "info");
				return;
			}

			let vsixPath: string;
			try {
				vsixPath = await downloadVsix(release.assetUrl, release.assetName);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Download failed: ${message}`, "error");
				return;
			}

			ctx.ui.notify("Installing companion extension...", "info");

			const results: string[] = [];
			for (const editor of editors) {
				ctx.ui.notify(`⏳ Installing for ${editor.name}...`, "info");
				const result = await installVsix(pi, editor.cli, vsixPath);
				if (result.code === 0) {
					results.push(`✅ ${editor.name}: installed`);
				} else {
					const detail = (result.stderr || result.stdout || "unknown error").trim();
					results.push(`❌ ${editor.name}: ${detail}`);
				}
			}

			try {
				await fsp.unlink(vsixPath);
			} catch {
				// Ignore cleanup failure.
			}

			ctx.ui.notify(`Installation results:\n${results.join("\n")}`, "info");
			ctx.ui.notify(
				"🔄 If the companion extension does not activate automatically, reload your editor window (Command Palette → 'Developer: Reload Window').",
				"info",
			);
		},
	});

	pi.registerShortcut("ctrl+shift+a" as KeyId, {
		description: "Insert the active IDE file into the editor",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.activeFile) {
				ctx.ui.notify("No active IDE file", "warning");
				return;
			}
			ctx.ui.pasteToEditor(fileToMarkdownLink(state.activeFile));
			updateStatus(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+s" as KeyId, {
		description: "Insert the current IDE selection into the editor",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			if (!state.selection?.text) {
				ctx.ui.notify("No IDE selection", "warning");
				return;
			}
			const sel = state.selection;
			const langHint = state.activeFile ? (state.activeFile.split(".").pop() ?? "") : "";
			const fenceOpen = langHint ? `\`\`\`${langHint}` : "\`\`\`";
			ctx.ui.pasteToEditor(`${fenceOpen}\n${sel.text}\n\`\`\``);
			updateStatus(ctx);
		},
	});
}
