// The question the app asks when its raw TCP connection refuses a server's
// certificate (shells/tauri socket.rs, irc/shellSocket.ts): trust that exact
// certificate for good, for this session, or not at all. "Always" saves its
// SHA-256 with the network (manager.ts), where the network's settings can
// remove it again; a renewed or different certificate asks again.
import eventbus from "./eventbus";
import {t} from "./i18n/core";
import {formatShortDay} from "./i18n/dates";
import type {UntrustedCertificate} from "./irc/shellSocket";

export type CertificateAnswer = "always" | "once" | "no";

/** `ab12…` → `["AB", "12", …]`: the bytes certificate viewers show joined
 * by colons, kept apart for a display that breaks between them. */
export function fingerprintPairs(sha256: string): string[] {
	return sha256.toUpperCase().match(/../g) ?? [];
}

/** `AB:12:…` in two lines of 16 bytes, so it fits a narrow dialog. */
function fingerprintLines(sha256: string): string {
	const pairs = fingerprintPairs(sha256);
	return [pairs.slice(0, 16).join(":"), pairs.slice(16).join(":")].join("\n");
}

/** Why the certificate failed, as one sentence with the warning. */
function problemText(host: string, cert: UntrustedCertificate): string {
	switch (cert.problem) {
		case "expired":
			return t("certificate.prompt.expired", {host});
		case "name":
			return t("certificate.prompt.name", {host});
		case "selfSigned":
			return t("certificate.prompt.selfSigned", {host});
		case "issuer":
			return t("certificate.prompt.issuer", {host});
		default:
			return t("certificate.prompt.other", {host});
	}
}

/** What the shell could say about it: when it expired, or whom it is for. */
function detailText(cert: UntrustedCertificate): string | undefined {
	if (cert.problem === "expired" && cert.notAfter !== undefined) {
		return t("certificate.prompt.expiredOn", {
			date: formatShortDay(cert.notAfter * 1000, true),
		});
	}

	if (cert.problem === "name" && cert.names && cert.names.length > 0) {
		return t("certificate.prompt.names", {names: cert.names.join(", ")});
	}

	return undefined;
}

/** Ask whether to trust `cert` for `host`. Waits behind any dialog already up. */
export function askCertificateTrust(
	host: string,
	cert: UntrustedCertificate
): Promise<CertificateAnswer> {
	return new Promise((resolve) => {
		eventbus.emit(
			"confirm-dialog",
			{
				title: t("certificate.prompt.title"),
				text: problemText(host, cert),
				note: detailText(cert),
				code: {
					label: t("certificate.prompt.fingerprint"),
					value: fingerprintLines(cert.sha256),
				},
				button: t("certificate.prompt.always"),
				alt: t("certificate.prompt.once"),
				cancel: t("certificate.prompt.no"),
				// Not primary: the focus goes to "Don't connect", so an Enter
				// meant for the composer never trusts a certificate.
				wait: true,
			},
			(yes: boolean, alt?: boolean) => resolve(!yes ? "no" : alt ? "once" : "always")
		);
	});
}
