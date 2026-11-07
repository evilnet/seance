/**
 * Logins that have worked: per network uuid, the SASL account this device
 * last logged in as. A bare `904 :SASL authentication failed` reads the same
 * for a wrong password and for a server that could not reach its login
 * backend (nefarious2 sends it when Keycloak times out or is down,
 * `sasl_auth.c`), so the client treats it as a refusal unless the same
 * account has logged in on that network before: then it is probably the
 * server, and a few more connections are tried before the network is given
 * up (IrcClient `saslFailed`, `SASL_TRUSTED_RETRIES`).
 *
 * Forgotten when the credentials are edited or typed anew on the connect
 * form ({@link typedCredentialsDiffer}), when a refusal is final for a login
 * that was not trusted, when the network is removed and when a settings
 * backup is restored (helpers/settingsBackup.ts `CLEARED_ON_RESTORE`: a
 * restored file is a new device, its first login has to prove itself, and
 * the backup never carries this key). Kept in `thelounge.state.saslOk`.
 * Vue-free and DOM-free; tests use {@link useStorageBackend}.
 */

import storage from "../localStorage";
import {recordReader} from "../helpers/jsonRecord";

export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

const STORAGE_KEY = "thelounge.state.saslOk";
let backend: StorageBackend = storage;
const readRecord = recordReader<unknown>();

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

function read(): Record<string, unknown> {
	return readRecord(backend.get(STORAGE_KEY));
}

function write(all: Record<string, unknown>): void {
	if (Object.keys(all).length === 0) {
		backend.remove(STORAGE_KEY);
	} else {
		backend.set(STORAGE_KEY, JSON.stringify(all));
	}
}

/** `account` has logged in on network `uuid`. */
export function trustLogin(uuid: string, account: string): void {
	if (!account || read()[uuid] === account) {
		return;
	}

	write({...read(), [uuid]: account});
}

/** Whether `account` has logged in on network `uuid` before. */
export function loginTrusted(uuid: string, account: string): boolean {
	return account !== "" && read()[uuid] === account;
}

/**
 * Whether credentials posted by the connect form are not the saved entry's:
 * another account, or a password where the entry remembers a different one
 * or none. A form that posts no password, or an empty one, changes nothing
 * (the entry's remembered password stands). A password the entry does not
 * remember is typed at every sign-in and differs every time, so such a
 * network starts untrusted at each one — the user is there to read a
 * refusal, and the retries are for the logins nobody watches.
 */
export function typedCredentialsDiffer(
	existing: {saslAccount?: string; saslPassword?: string} | undefined,
	typed: {saslAccount?: string; saslPassword?: string}
): boolean {
	if (typed.saslAccount !== undefined && typed.saslAccount !== (existing?.saslAccount ?? "")) {
		return true;
	}

	return Boolean(typed.saslPassword) && typed.saslPassword !== (existing?.saslPassword ?? "");
}

/** Forget network `uuid`'s login (credentials edited, refused for good, network removed). */
export function forgetLogin(uuid: string): void {
	const all = read();

	if (!(uuid in all)) {
		return;
	}

	const next = {...all};
	delete next[uuid];
	write(next);
}
