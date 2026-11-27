// This is a simple localStorage wrapper because browser can throw errors
// in different situations, including:
// - Unable to store data if storage is full
// - Local storage is blocked if "third-party cookies and site data" is disabled
//
// For more details, see:
// https://stackoverflow.com/q/14555347/1935861
// https://github.com/thelounge/thelounge/issues/2699
// https://www.chromium.org/for-testers/bug-reporting-guidelines/uncaught-securityerror-failed-to-read-the-localstorage-property-from-window-access-is-denied-for-this-document

const writeListeners = new Set<(key: string) => void>();

/**
 * Hear every write this page makes through the wrapper (another tab's
 * arrive as `storage` events): settings sync dates a change the moment it
 * is stored (sync/index.ts). Returns the unsubscribe.
 */
export function onStorageWrite(listener: (key: string) => void): () => void {
	writeListeners.add(listener);
	return () => writeListeners.delete(listener);
}

function wrote(key: string): void {
	for (const listener of writeListeners) {
		listener(key);
	}
}

export default {
	set(key: string, value: string) {
		try {
			window.localStorage.setItem(key, value);
		} catch (e) {
			return;
		}

		wrote(key);
	},
	get(key: string) {
		try {
			return window.localStorage.getItem(key);
		} catch (e) {
			// Return null as if data is not set
			return null;
		}
	},
	remove(key: string) {
		try {
			window.localStorage.removeItem(key);
		} catch (e) {
			return;
		}

		wrote(key);
	},
	keys(): string[] {
		try {
			return Object.keys(window.localStorage);
		} catch (e) {
			return [];
		}
	},
	clear() {
		try {
			window.localStorage.clear();
		} catch (e) {
			//
		}
	},
};
