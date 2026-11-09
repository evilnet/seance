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

/** `ab12…` → `AB:12:…`, the way certificate viewers show it. */
export function formatFingerprint(sha256: string): string {
	return (sha256.toUpperCase().match(/../g) ?? []).join(":");
}

/** The same in two lines of 16 bytes, so it fits a narrow dialog. */
function fingerprintLines(sha256: string): string {
	const pairs = sha256.toUpperCase().match(/../g) ?? [];
	return [pairs.slice(0, 16).join(":"), pairs.slice(16).join(":")].join("\n");
}

/** Why the certificate failed, as one sentence with the warning. */
function problemText(host: string, cert: UntrustedCertificate): string {
	if (cert.problem === "expired") {
		return t("certificate.prompt.expired", {host});
	}

	if (cert.problem === "name") {
		return t("certificate.prompt.name", {host});
	}

	if (cert.selfSigned) {
		return t("certificate.prompt.selfSigned", {host});
	}

	if (cert.problem === "issuer") {
		return t("certificate.prompt.issuer", {host});
	}

	return t("certificate.prompt.other", {host});
}

/** Who it names and who signed it, and when it is valid; nothing when the shell could not read it. */
function issuedText(cert: UntrustedCertificate): string | undefined {
	if (
		cert.subject === undefined ||
		cert.issuer === undefined ||
		cert.notBefore === undefined ||
		cert.notAfter === undefined
	) {
		return undefined;
	}

	const subject = cert.names && cert.names.length > 0 ? cert.names.join(", ") : cert.subject;

	return t("certificate.prompt.issued", {
		subject,
		issuer: cert.issuer,
		from: formatShortDay(cert.notBefore * 1000, true),
		until: formatShortDay(cert.notAfter * 1000, true),
	});
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
				note: issuedText(cert),
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
