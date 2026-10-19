/**
 * Numeric error replies (4xx/5xx) → the `error` codes
 * `client/components/MessageTypes/error.vue` knows how to phrase, plus the
 * parameter layout of each so the channel/nick can be extracted. The code
 * strings are irc-framework's (which the old server forwarded verbatim).
 */

export interface ErrorSpec {
	code: string;
	/** Which param (after our own nick) names the channel, if any. */
	channel?: number;
	/** Which param (after our own nick) names the nick, if any. */
	nick?: number;
	/** Which param names the offending command (421). */
	command?: number;
}

const ERRORS: Record<string, ErrorSpec> = {
	"401": {code: "no_such_nick", nick: 0},
	"402": {code: "no_such_server"},
	"403": {code: "no_such_channel", channel: 0},
	"404": {code: "cannot_send_to_channel", channel: 0},
	"405": {code: "too_many_channels", channel: 0},
	"406": {code: "was_no_such_nick", nick: 0},
	"407": {code: "too_many_targets"},
	"411": {code: "no_recipient"},
	"412": {code: "no_text_to_send"},
	"421": {code: "unknown_command", command: 0},
	"431": {code: "no_nickname_given"},
	"432": {code: "erroneous_nickname", nick: 0},
	"433": {code: "nickname_in_use", nick: 0},
	"436": {code: "nick_collision", nick: 0},
	"437": {code: "resource_unavailable", channel: 0},
	"438": {code: "nick_change_too_fast", nick: 0},
	"441": {code: "user_not_in_channel", nick: 0, channel: 1},
	"442": {code: "not_on_channel", channel: 0},
	"443": {code: "user_on_channel", nick: 0, channel: 1},
	"451": {code: "not_registered"},
	"461": {code: "need_more_params", command: 0},
	"462": {code: "already_registered"},
	"464": {code: "password_mismatch"},
	"465": {code: "banned_from_network"},
	"467": {code: "key_set", channel: 0},
	"471": {code: "channel_is_full", channel: 0},
	"472": {code: "unknown_mode"},
	"473": {code: "invite_only_channel", channel: 0},
	"474": {code: "banned_from_channel", channel: 0},
	"475": {code: "bad_channel_key", channel: 0},
	"476": {code: "bad_channel_mask", channel: 0},
	"477": {code: "need_registered_nick", channel: 0},
	"481": {code: "no_privileges"},
	"482": {code: "chanop_privs_needed", channel: 0},
	"483": {code: "cant_kill_server"},
	"484": {code: "cannot_do_command", nick: 0},
	"485": {code: "common_channels_only", nick: 0},
	"486": {code: "account_only", nick: 0},
	"487": {code: "user_does_not_accept_pm"},
	"491": {code: "no_oper_host"},
	"501": {code: "unknown_user_mode_flag"},
	"502": {code: "users_dont_match"},
	"524": {code: "quarantined", channel: 0},
};

/** Spec for a numeric, or a generic one for unknown 4xx/5xx replies. */
export function errorSpec(numeric: string): ErrorSpec | undefined {
	const spec = ERRORS[numeric];

	if (spec) {
		return spec;
	}

	if (/^[45]\d\d$/.test(numeric)) {
		return {code: `err_${numeric}`};
	}

	return undefined;
}

/**
 * Numerics in the 4xx/5xx range that are replies, not errors: nefarious2
 * (ircu) put lists there — the oper MOTD (535-537), STATS S/Z rows (542,
 * 546), the end of the shun list (545) and the Z-line list (548, 549).
 */
const REPLIES_IN_ERROR_RANGE = new Set(["535", "536", "537", "542", "545", "546", "548", "549"]);

/** Whether a numeric is an error reply (4xx/5xx, minus the lists above). */
export function isErrorNumeric(command: string): boolean {
	return /^[45]\d\d$/.test(command) && !REPLIES_IN_ERROR_RANGE.has(command);
}
