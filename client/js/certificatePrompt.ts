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

/** Who it names and who signed it, when, and its fingerprint. */
function detailsText(cert: UntrustedCertificate): string {
	const fingerprint = formatFingerprint(cert.sha256);

	if (
		cert.subject === undefined ||
		cert.issuer === undefined ||
		cert.notBefore === undefined ||
		cert.notAfter === undefined
	) {
		return t("certificate.prompt.fingerprintOnly", {fingerprint});
	}

	const subject = cert.names && cert.names.length > 0 ? cert.names.join(", ") : cert.subject;

	return t("certificate.prompt.details", {
		subject,
		issuer: cert.issuer,
		from: formatShortDay(cert.notBefore * 1000, true),
		until: formatShortDay(cert.notAfter * 1000, true),
		fingerprint,
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
				note: detailsText(cert),
				button: t("certificate.prompt.always"),
				alt: t("certificate.prompt.once"),
				cancel: t("certificate.prompt.no"),
				primary: true,
				wait: true,
			},
			(yes: boolean, alt?: boolean) => resolve(!yes ? "no" : alt ? "once" : "always")
		);
	});
}
