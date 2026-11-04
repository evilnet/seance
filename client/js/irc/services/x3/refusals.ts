/**
 * What X3 says instead of running a command (modcmd.c `svccmd_can_invoke`,
 * main-common.c; docs/resources/x3-services.md §2), with formatting already
 * stripped. Any lookup can get one of these as its whole answer.
 */
export const REFUSED = new RegExp(
	"^(?:" +
		[
			// A command's name can be two words (`STATS ALERTS`). No colon, or a
			// realname or topic ending in these words would pass for a refusal.
			String.raw`[^:]+ is a (?:privileged service|privileged command|disabled command)\.`,
			String.raw`\S+ is an unknown command\.`,
			String.raw`Access denied\.`,
			String.raw`You must first authenticate with \S+\.`,
			String.raw`Your \S+ access has been suspended\.`,
			String.raw`Your account has been suspended\.`,
			String.raw`You lack access to \S+\.`,
			String.raw`You lack sufficient access in \S+ to use this command\.`,
			String.raw`You must be in \S+ \(or on its userlist\) to use this command\.`,
			String.raw`You must have security override \(helping mode\) on to use this command\.`,
		].join("|") +
		")$"
);
