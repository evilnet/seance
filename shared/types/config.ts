export type ConfigTheme = {
	displayName: string;
	name: string;
	themeColor: string | null;
};
type SharedConfigurationBase = {
	public: boolean;
	useHexIp: boolean;
	prefetch: boolean;
	fileUpload: boolean;
	ldapEnabled: boolean;
	isUpdateAvailable: boolean;
	applicationServerKey: string;
	version: string;
	/** The release this build is, or follows (Help links its notes). */
	release: string;
	/** Short sha the build was made from; null when unknown. */
	gitCommit: string | null;
	/** The Pages build this is (`release`, `develop`, `pr<N>`); empty for any other. */
	buildTrack: string;
	/** The branch a build made elsewhere was made from; null when unknown. */
	gitBranch: string | null;
	themes: ConfigTheme[];
	defaultTheme: string;
	fileUploadMaxFileSize?: number;
};

export type ConfigNetDefaults = {
	name: string;
	host: string;
	port: number;
	password: string;
	tls: boolean;
	rejectUnauthorized: boolean;
	nick: string;
	username: string;
	realname: string;
	join: string;
	leaveMessage: string;
	sasl: string;
	saslAccount: string;
	saslPassword: string;
};
export type LockedConfigNetDefaults = Omit<
	ConfigNetDefaults,
	"host" | "name" | "port" | "tls" | "rejectUnauthorized"
>;

export type LockedSharedConfiguration = SharedConfigurationBase & {
	lockNetwork: true;
	defaults: LockedConfigNetDefaults;
};

export type SharedConfiguration = SharedConfigurationBase & {
	lockNetwork: false;
	defaults: ConfigNetDefaults;
};
