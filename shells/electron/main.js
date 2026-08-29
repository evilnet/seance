"use strict";

// Seance desktop shell. Serves the built SPA (../../public in development,
// resources/public when packaged) over a privileged app:// scheme so that the
// service worker, fetch("./config.json") and relative URLs behave exactly as
// they do on a web deploy. No remote content is ever loaded into the window.

const {app, BrowserWindow, Menu, protocol, net, screen, shell} = require("electron");
const fs = require("fs");
const path = require("path");
const {pathToFileURL} = require("url");

const APP_SCHEME = "app";
const APP_HOST = "seance";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_URL = `${APP_ORIGIN}/index.html`;
const SMOKE = process.argv.includes("--smoke");

const publicDir = app.isPackaged
	? path.join(process.resourcesPath, "public")
	: path.resolve(__dirname, "../../public");

// Loaded before "ready" so app.setName() takes effect for the whole process.
const branding = readBranding();
const appName = branding.appName;
app.setName(appName);

const windowStateFile = () => path.join(app.getPath("userData"), "window-state.json");
const iconFile = path.join(publicDir, "img", "logo-grey-bg-512x512px.png");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
};

// 'self' is app://seance. Inline styles are needed for #user-specified-css
// and Vue-injected style attributes; https: images/media cover link
// previews and uploads; ws:/wss: (and https: for the uploader) may target any
// host because the user picks the network. Everything else is denied.
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"media-src 'self' data: blob: https:",
	"font-src 'self' data:",
	"connect-src 'self' ws: wss: https:",
	"worker-src 'self'",
	"manifest-src 'self'",
	"object-src 'none'",
	"frame-src 'none'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'none'",
].join("; ");

let mainWindow = null;
let pendingIrcUrl = null;

function readBranding() {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(publicDir, "config.json"), "utf8"));

		if (parsed && typeof parsed.appName === "string" && parsed.appName.trim()) {
			return {appName: parsed.appName.trim()};
		}
	} catch (e) {
		// Missing or invalid config.json: fall through to the default.
	}

	return {appName: "Seance"};
}

// `web+irc://host[:port][/#chan]` — the WebSocket-endpoint scheme the SPA
// understands. `irc:`/`ircs:` are deliberately not claimed: they name a TCP
// port we cannot dial (see docs/resources/irc-links.md).
function isIrcUrl(value) {
	return typeof value === "string" && /^web\+irc:\/\//i.test(value);
}

function ircUrlFromArgv(argv) {
	return argv.find((arg) => isIrcUrl(arg)) || null;
}

// --- app:// scheme -----------------------------------------------------------

protocol.registerSchemesAsPrivileged([
	{
		scheme: APP_SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			allowServiceWorkers: true,
			corsEnabled: true,
			stream: true,
		},
	},
]);

function resolvePublicPath(urlPath) {
	let decoded;

	try {
		decoded = decodeURIComponent(urlPath);
	} catch (e) {
		return null;
	}

	let relative = decoded.replace(/^\/+/, "");

	if (relative === "" || relative.endsWith("/")) {
		relative += "index.html";
	}

	const file = path.resolve(publicDir, relative);
	const root = path.resolve(publicDir) + path.sep;

	if (!file.startsWith(root)) {
		return null;
	}

	return file;
}

async function serveApp(request) {
	const url = new URL(request.url);

	if (url.host !== APP_HOST) {
		return new Response("Not found", {status: 404});
	}

	let file = resolvePublicPath(url.pathname);

	if (file === null) {
		return new Response("Forbidden", {status: 403});
	}

	let stat = await fs.promises.stat(file).catch(() => null);

	if (stat && stat.isDirectory()) {
		file = path.join(file, "index.html");
		stat = await fs.promises.stat(file).catch(() => null);
	}

	// Extensionless paths fall back to the SPA entry point.
	if (!stat && path.extname(file) === "") {
		file = path.join(publicDir, "index.html");
		stat = await fs.promises.stat(file).catch(() => null);
	}

	if (!stat || !stat.isFile()) {
		return new Response("Not found", {status: 404, headers: {"Content-Type": "text/plain"}});
	}

	const response = await net.fetch(pathToFileURL(file).toString());
	const headers = new Headers();
	headers.set(
		"Content-Type",
		MIME[path.extname(file).toLowerCase()] || "application/octet-stream"
	);
	headers.set("Content-Length", String(stat.size));
	headers.set("Content-Security-Policy", CSP);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Cache-Control", "no-cache");

	return new Response(response.body, {status: 200, headers});
}

// --- window state ------------------------------------------------------------

function loadWindowState() {
	const defaults = {width: 1200, height: 800};

	try {
		const saved = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
		const state = {...defaults};

		for (const key of ["x", "y", "width", "height"]) {
			if (Number.isInteger(saved[key])) {
				state[key] = saved[key];
			}
		}

		state.maximized = saved.maximized === true;

		if (state.x !== undefined && state.y !== undefined) {
			// Only restore a position that is at least partly on a current display.
			const visible = screen.getAllDisplays().some(({workArea}) => {
				return (
					state.x < workArea.x + workArea.width &&
					state.x + state.width > workArea.x &&
					state.y < workArea.y + workArea.height &&
					state.y + state.height > workArea.y
				);
			});

			if (!visible) {
				delete state.x;
				delete state.y;
			}
		}

		return state;
	} catch (e) {
		return defaults;
	}
}

function saveWindowState(win) {
	if (!win || win.isDestroyed()) {
		return;
	}

	const maximized = win.isMaximized();
	const bounds = maximized ? win.getNormalBounds() : win.getBounds();

	try {
		fs.mkdirSync(app.getPath("userData"), {recursive: true});
		fs.writeFileSync(windowStateFile(), JSON.stringify({...bounds, maximized}));
	} catch (e) {
		// Not fatal: the next launch simply uses the default size.
	}
}

// --- window ------------------------------------------------------------------

function appUrlFor(ircUrl) {
	return ircUrl ? `${APP_URL}?uri=${encodeURIComponent(ircUrl)}` : APP_URL;
}

function isAppUrl(url) {
	return url.startsWith(`${APP_ORIGIN}/`);
}

function openExternalIfSafe(url) {
	if (/^https?:\/\//i.test(url)) {
		void shell.openExternal(url);
	}
}

function createWindow() {
	const state = loadWindowState();

	const win = new BrowserWindow({
		x: state.x,
		y: state.y,
		width: state.width,
		height: state.height,
		minWidth: 400,
		minHeight: 300,
		title: appName,
		icon: fs.existsSync(iconFile) ? iconFile : undefined,
		show: !SMOKE,
		autoHideMenuBar: process.platform !== "darwin",
		backgroundColor: "#415364",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: true,
			additionalArguments: [`--seance-shell-version=${app.getVersion()}`],
		},
	});

	if (state.maximized) {
		win.maximize();
	}

	// target=_blank and window.open() never create Electron windows.
	win.webContents.setWindowOpenHandler(({url}) => {
		openExternalIfSafe(url);
		return {action: "deny"};
	});

	// The renderer may only ever navigate inside the app:// origin.
	win.webContents.on("will-navigate", (event, url) => {
		if (!isAppUrl(url)) {
			event.preventDefault();
			openExternalIfSafe(url);
		}
	});

	let saveTimer = null;

	const scheduleSave = () => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveWindowState(win), 250);
	};

	win.on("resize", scheduleSave);
	win.on("move", scheduleSave);
	win.on("maximize", scheduleSave);
	win.on("unmaximize", scheduleSave);
	win.on("close", () => {
		clearTimeout(saveTimer);
		saveWindowState(win);
	});
	win.on("closed", () => {
		if (mainWindow === win) {
			mainWindow = null;
		}
	});

	if (SMOKE) {
		installSmokeTest(win);
	}

	const ircUrl = pendingIrcUrl;
	pendingIrcUrl = null;
	void win.loadURL(appUrlFor(ircUrl));

	mainWindow = win;
	return win;
}

function focusWindow(win) {
	if (win.isMinimized()) {
		win.restore();
	}

	win.show();
	win.focus();
}

// Hands a web+irc:// URL to the SPA. boot.ts reads ?uri= on startup
// and pushes the parsed values onto the Connect route, so this reloads the
// document; a warm hand-off over IPC is a follow-up.
function openIrcUrl(ircUrl) {
	if (!isIrcUrl(ircUrl)) {
		return;
	}

	if (!mainWindow) {
		pendingIrcUrl = ircUrl;

		if (app.isReady()) {
			createWindow();
		}

		return;
	}

	focusWindow(mainWindow);
	void mainWindow.loadURL(appUrlFor(ircUrl));
}

// --- smoke test ----------------------------------------------------------------

function installSmokeTest(win) {
	const errors = [];
	const out = (line) => process.stdout.write(`${line}\n`);

	win.webContents.on("console-message", (details) => {
		const level = details.level;
		const message = details.message;

		out(`[renderer:${level}] ${message}`);

		if (level === "error") {
			errors.push(message);
		}
	});

	win.webContents.on("did-fail-load", (event, code, description, url) => {
		out(`smoke: failed to load ${url}: ${code} ${description}`);
		app.exit(1);
	});

	win.webContents.on("did-finish-load", () => {
		// Give the SPA a moment to boot (branding fetch, router, SW registration).
		setTimeout(() => {
			const probe = `(async () => ({
				title: document.title,
				shell: typeof window.seanceShell === "object" ? window.seanceShell : null,
				secureContext: window.isSecureContext,
				serviceWorkers: "serviceWorker" in navigator
					? (await navigator.serviceWorker.getRegistrations()).length
					: -1,
				// The SPA only registers its worker on https:/localhost, so
				// exercise the scheme's service-worker support directly.
				serviceWorkerProbe: await navigator.serviceWorker
					.register("service-worker.js", {scope: "./"})
					.then((registration) => registration.unregister())
					.then(() => "ok")
					.catch((e) => String(e)),
			}))()`;

			win.webContents
				.executeJavaScript(probe, true)
				.then((result) => {
					out(`smoke: loaded ${win.webContents.getURL()}`);
					out(`smoke: title "${result.title}"`);
					out(`smoke: seanceShell ${JSON.stringify(result.shell)}`);
					out(`smoke: secure context ${result.secureContext}`);
					out(`smoke: service worker registrations ${result.serviceWorkers}`);
					out(`smoke: service worker probe ${result.serviceWorkerProbe}`);

					if (errors.length > 0) {
						out(`smoke: FAIL (${errors.length} renderer error(s))`);
						app.exit(1);
						return;
					}

					out("smoke: OK");
					app.exit(0);
				})
				.catch((e) => {
					out(`smoke: FAIL ${String(e)}`);
					app.exit(1);
				});
		}, 1500);
	});
}

// --- menu ----------------------------------------------------------------------

function buildMenu() {
	const isMac = process.platform === "darwin";

	const template = [
		...(isMac
			? [
					{
						label: appName,
						submenu: [
							{role: "about"},
							{type: "separator"},
							{role: "hide"},
							{role: "hideOthers"},
							{role: "unhide"},
							{type: "separator"},
							{role: "quit"},
						],
					},
			  ]
			: [{label: "File", submenu: [{role: "quit"}]}]),
		{
			label: "Edit",
			submenu: [
				{role: "undo"},
				{role: "redo"},
				{type: "separator"},
				{role: "cut"},
				{role: "copy"},
				{role: "paste"},
				{role: "selectAll"},
			],
		},
		{
			label: "View",
			submenu: [
				{role: "reload"},
				{role: "toggleDevTools"},
				{type: "separator"},
				{role: "resetZoom"},
				{role: "zoomIn"},
				{role: "zoomOut"},
				{type: "separator"},
				{role: "togglefullscreen"},
			],
		},
		{
			label: "Window",
			submenu: [{role: "minimize"}, {role: "close"}],
		},
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle -----------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", (event, argv) => {
		const ircUrl = ircUrlFromArgv(argv);

		if (ircUrl) {
			openIrcUrl(ircUrl);
		} else if (mainWindow) {
			focusWindow(mainWindow);
		}
	});

	// macOS delivers protocol links here (possibly before "ready").
	app.on("open-url", (event, url) => {
		event.preventDefault();
		openIrcUrl(url);
	});

	// Windows/Linux deliver protocol links on the command line.
	pendingIrcUrl = ircUrlFromArgv(process.argv.slice(1));

	if (!SMOKE) {
		if (app.isPackaged || process.platform === "darwin") {
			app.setAsDefaultProtocolClient("web+irc");
		} else if (process.argv.length >= 2) {
			// Running from source: register "electron <this dir>" as the handler.
			const args = [path.resolve(process.argv[1])];
			app.setAsDefaultProtocolClient("web+irc", process.execPath, args);
		}
	}

	app.whenReady().then(() => {
		protocol.handle(APP_SCHEME, serveApp);
		buildMenu();
		createWindow();

		app.on("activate", () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				createWindow();
			} else if (mainWindow) {
				focusWindow(mainWindow);
			}
		});
	});

	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") {
			app.quit();
		}
	});

	app.on("web-contents-created", (event, contents) => {
		// Belt and braces: no webviews, no navigation off-origin anywhere.
		contents.on("will-attach-webview", (e) => e.preventDefault());
	});
}
