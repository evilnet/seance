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
import {THEMES} from "./themeRegistry";

const configuration: SharedConfiguration = {
	public: false,
	useHexIp: false,
	prefetch: false,
	// Off unless config.json provides `uploads` (see boot.ts).
	fileUpload: false,
	ldapEnabled: false,
	isUpdateAvailable: false,
	applicationServerKey: "",
	// The build's name, the release it is or follows, the commit it was
	// made from and which build it is (the Pages workflow's `release`,
	// `develop` or `pr<N>`, else the branch of a local build) — filled in by
	// the build (`resolveBuild`, from the release's tag; package.json carries
	// no version); Help links them.
	version: process.env.SEANCE_VERSION || "dev",
	release: process.env.SEANCE_RELEASE || "dev",
	gitCommit: process.env.SEANCE_COMMIT || null,
	buildTrack: process.env.SEANCE_TRACK || "",
	gitBranch: process.env.SEANCE_BRANCH || null,
	// One CSS file each under client/themes/, listed in themeRegistry.ts;
	// docs/resources/themes.md.
	themes: THEMES.map(({name, displayName, themeColor}) => ({name, displayName, themeColor})),
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
