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
 * Forgotten when the credentials are edited, when a refusal is final and
 * when the network is removed. Kept in `thelounge.state.saslOk`, which the
 * settings backup never carries (a restored file is a new device: its first
 * login has to prove itself). Vue-free and DOM-free; tests use
 * {@link useStorageBackend}.
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
