// Static, client-built configuration.
//
// TheLounge received this object from its Node server on every connection
// (`configuration` socket event). Seance has no such server, so the values
// are baked in at build time. Per-deployment values (app name, default
// network, default theme) come from `config.json` instead — see
// `client/js/branding.ts`; `boot.ts` folds `branding.theme` into
// `defaultTheme` below before the store sees this object, and turns on
// `fileUpload` (with `fileUploadMaxFileSize`) when `branding.uploads` names
// an uploader endpoint.

import type {SharedConfiguration} from "../../shared/types/config";

const configuration: SharedConfiguration = {
	public: false,
	useHexIp: false,
	prefetch: false,
	// Off unless config.json provides `uploads` (see boot.ts).
	fileUpload: false,
	ldapEnabled: false,
	isUpdateAvailable: false,
	applicationServerKey: "",
	// The build's name, the release it is or follows, and the commit it was
	// made from — filled in by webpack (`resolveBuild`, from the release's
	// tag; package.json carries no version); Help links them.
	version: process.env.SEANCE_VERSION || "dev",
	release: process.env.SEANCE_RELEASE || "dev",
	gitCommit: process.env.SEANCE_COMMIT || null,
	// One CSS file each under client/themes/; docs/resources/themes.md. The
	// four handoff themes (Ink & Amber, Cobalt Frost) carry their titlebar
	// tone as the browser chrome colour, the older two leave it to the
	// deploy's themeColor.
	themes: [
		{name: "coffee", displayName: "Coffee", themeColor: "#1a1816"},
		{name: "creama", displayName: "Creama", themeColor: "#efe9de"},
		{name: "cobalt", displayName: "Cobalt", themeColor: "#101720"},
		{name: "frost", displayName: "Frost", themeColor: "#eef2f7"},
		{name: "molokai", displayName: "Molokai", themeColor: "#1b1d1e"},
		{name: "princess", displayName: "Princess", themeColor: "#f2f7fc"},
		{name: "princess_", displayName: "Princess_", themeColor: "#000000"},
		{name: "keeki", displayName: "Keeki", themeColor: "#22143a"},
		{name: "sandrof", displayName: "Sandrof", themeColor: "#020402"},
		{name: "oikarinen", displayName: "Oikarinen", themeColor: "#040301"},
		{name: "bourbaki", displayName: "Bourbaki", themeColor: "#000000"},
		{name: "gates", displayName: "Gates", themeColor: "#0000aa"},
		{name: "mardam", displayName: "Mardam", themeColor: "#d4d0c8"},
		{name: "zelenzy", displayName: "Zelenzy", themeColor: "#ece9d8"},
		{name: "panasync", displayName: "Panasync", themeColor: "#000000"},
		{name: "day", displayName: "Day", themeColor: null},
		{name: "morning", displayName: "Morning", themeColor: null},
	],
	defaultTheme: "coffee",
	lockNetwork: false,
	defaults: {
		name: "",
		host: "",
		port: 6697,
		password: "",
		tls: true,
		rejectUnauthorized: true,
		nick: "",
		username: "",
		realname: "",
		join: "",
		leaveMessage: "",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
	},
};

export default configuration;
