import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";

interface IDESelection {
	text: string;
	startLine: number;
	endLine: number;
}

interface IDEStateUpdate {
	editor: "vscode" | "cursor" | "trae";
	activeFile: string | null;
	workspaceRoot: string | null;
	workspaceRoots: string[];
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

const MAX_PORT_ATTEMPTS = 10;
const INSERT_CLIPBOARD_DELAY_MS = 100;
const DEFAULT_HEARTBEAT_MS = 5000;

function detectEditor(): "vscode" | "cursor" | "trae" {
	const appName = vscode.env.appName.toLowerCase();
	if (appName.includes("trae")) return "trae";
	if (appName.includes("cursor")) return "cursor";
	return "vscode";
}

function getActiveFile(): string | null {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return null;
	return editor.document.uri.fsPath;
}

function getWorkspaceRoot(): string | null {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) return null;
	return folders[0].uri.fsPath;
}

function getWorkspaceRoots(): string[] {
	return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

function getOpenFiles(): string[] {
	return vscode.workspace.textDocuments
		.filter((doc) => !doc.isUntitled && doc.uri.scheme === "file")
		.map((doc) => doc.uri.fsPath);
}

function getSelection(editor: vscode.TextEditor): IDESelection | null {
	const selection = editor.selection;
	if (selection.isEmpty) return null;
	const text = editor.document.getText(selection);
	return {
		text,
		startLine: selection.start.line,
		endLine: selection.end.line,
	};
}

function getAgentDir(): string {
	return process.env.PI_AGENT_DIR ?? path.join(require("os").homedir(), ".pi", "agent");
}

function getPortFilePath(): string {
	return path.join(getAgentDir(), "ide-bridge.port");
}

function readPortFile(): number | null {
	try {
		const text = fs.readFileSync(getPortFilePath(), "utf8").trim();
		const parsed = Number.parseInt(text, 10);
		return Number.isNaN(parsed) ? null : parsed;
	} catch {
		return null;
	}
}

function sendRequestToPort(
	port: number,
	path: string,
	body: string,
	logger: vscode.LogOutputChannel,
): void {
	const req = http.request(
		{
			hostname: "127.0.0.1",
			port,
			path,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
			},
		},
		(res) => {
			res.resume();
		},
	);
	req.on("error", (err) => {
		logger.debug(`Pi not listening on port ${port}: ${err.message}`);
	});
	req.write(body);
	req.end();
}

function broadcastRequest(
	basePort: number,
	path: string,
	body: string,
	logger: vscode.LogOutputChannel,
): void {
	// If a specific port file exists, try it first; fall back to scanning the range
	// so multiple Pi instances still receive updates.
	const pinnedPort = readPortFile();
	const ports = new Set<number>();
	if (pinnedPort !== null) ports.add(pinnedPort);
	for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
		ports.add(basePort + offset);
	}
	for (const port of ports) {
		sendRequestToPort(port, path, body, logger);
	}
}

function broadcastState(basePort: number, state: IDEStateUpdate, logger: vscode.LogOutputChannel): void {
	broadcastRequest(basePort, "/ide-state", JSON.stringify(state), logger);
}

function broadcastInsert(basePort: number, request: IDEInsertRequest, logger: vscode.LogOutputChannel): void {
	broadcastRequest(basePort, "/editor-insert", JSON.stringify(request), logger);
}

function broadcastPing(basePort: number, logger: vscode.LogOutputChannel): void {
	broadcastRequest(basePort, "/ide-ping", JSON.stringify({}), logger);
}

async function readTerminalSelection(): Promise<string | undefined> {
	const terminal = vscode.window.activeTerminal;
	if (!terminal) {
		void vscode.window.showWarningMessage("No active terminal.");
		return undefined;
	}

	// VS Code does not expose terminal selection directly. Copy the current
	// selection to the clipboard and read it back. This briefly overwrites the
	// user's clipboard.
	const previousClipboard = await vscode.env.clipboard.readText();
	await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
	await new Promise((resolve) => setTimeout(resolve, INSERT_CLIPBOARD_DELAY_MS));
	const selectedText = await vscode.env.clipboard.readText();

	// Best-effort restore of the previous clipboard content.
	try {
		await vscode.env.clipboard.writeText(previousClipboard);
	} catch {
		// Ignore restore failures.
	}

	return selectedText || undefined;
}

export function activate(context: vscode.ExtensionContext): void {
	const logger = vscode.window.createOutputChannel("Pi IDE Bridge", { log: true });
	logger.info("Pi IDE Bridge activated");

	const config = vscode.workspace.getConfiguration("piIdeBridge");
	let enabled = config.get<boolean>("enabled", true);
	let basePort = config.get<number>("port", 17325);
	let heartbeatMs = config.get<number>("heartbeatInterval", DEFAULT_HEARTBEAT_MS);
	let debounceTimer: NodeJS.Timeout | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;

	function updateState(): void {
		if (!enabled) return;
		const editor = vscode.window.activeTextEditor;
		const activeFile = getActiveFile();
		const state: IDEStateUpdate = {
			editor: detectEditor(),
			activeFile,
			workspaceRoot: getWorkspaceRoot(),
			workspaceRoots: getWorkspaceRoots(),
			openFiles: getOpenFiles(),
			selection: editor && !editor.selection.isEmpty ? getSelection(editor) : null,
		};
		logger.debug("Broadcasting state", state);
		broadcastState(basePort, state, logger);
	}

	function scheduleUpdate(): void {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(updateState, 150);
	}

	function startHeartbeat(): void {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (heartbeatMs <= 0) return;
		heartbeatTimer = setInterval(() => {
			if (!enabled) return;
			broadcastPing(basePort, logger);
		}, heartbeatMs);
	}

	async function insertFile(uri: unknown): Promise<void> {
		const fileUri = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
		if (!fileUri || fileUri.scheme !== "file") {
			void vscode.window.showWarningMessage("No file selected.");
			return;
		}
		broadcastInsert(basePort, { type: "file", path: fileUri.fsPath }, logger);
		logger.info(`Inserted file: ${fileUri.fsPath}`);
	}

	async function insertSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			void vscode.window.showWarningMessage("No text selected in editor.");
			return;
		}
		const text = editor.document.getText(editor.selection);
		broadcastInsert(basePort, { type: "terminal", text }, logger);
		logger.info(`Inserted editor selection (${text.length} chars)`);
	}

	async function insertTerminalSelection(): Promise<void> {
		const text = await readTerminalSelection();
		if (!text) {
			void vscode.window.showWarningMessage("No text selected in terminal.");
			return;
		}
		broadcastInsert(basePort, { type: "terminal", text }, logger);
		logger.info(`Inserted terminal selection (${text.length} chars)`);
	}

	const disposables = [
		vscode.window.onDidChangeActiveTextEditor(scheduleUpdate),
		vscode.window.onDidChangeTextEditorSelection(scheduleUpdate),
		vscode.workspace.onDidOpenTextDocument(scheduleUpdate),
		vscode.workspace.onDidCloseTextDocument(scheduleUpdate),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("piIdeBridge")) {
				const updated = vscode.workspace.getConfiguration("piIdeBridge");
				enabled = updated.get<boolean>("enabled", true);
				basePort = updated.get<number>("port", 17325);
				heartbeatMs = updated.get<number>("heartbeatInterval", DEFAULT_HEARTBEAT_MS);
				if (enabled) {
					scheduleUpdate();
					startHeartbeat();
				} else if (heartbeatTimer) {
					clearInterval(heartbeatTimer);
					heartbeatTimer = undefined;
				}
			}
		}),
		vscode.commands.registerCommand("piIdeBridge.enable", () => {
			void vscode.workspace.getConfiguration("piIdeBridge").update("enabled", true, true);
		}),
		vscode.commands.registerCommand("piIdeBridge.disable", () => {
			void vscode.workspace.getConfiguration("piIdeBridge").update("enabled", false, true);
		}),
		vscode.commands.registerCommand("piIdeBridge.insertFile", insertFile),
		vscode.commands.registerCommand("piIdeBridge.insertSelection", insertSelection),
		vscode.commands.registerCommand("piIdeBridge.insertTerminalSelection", insertTerminalSelection),
	];

	context.subscriptions.push(...disposables);
	context.subscriptions.push({
		dispose: () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
		},
	});

	if (enabled) {
		scheduleUpdate();
		startHeartbeat();
	}
}

export function deactivate(): void {
	// Intervals and subscriptions are disposed automatically via context.subscriptions.
}
