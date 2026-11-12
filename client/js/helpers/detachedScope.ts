import {effectScope} from "vue";

/**
 * Run `make` outside whatever effect scope the caller is in: the watches
 * and computeds it registers belong to a scope of their own, which lives
 * until `stop` is called, not until the caller's component unmounts. For
 * something made lazily on first use (the translation service, made by
 * whichever component's computed asks first) whose watches must outlive
 * that component.
 */
export function runDetached<T>(make: () => T): {value: T; stop: () => void} {
	const scope = effectScope(true);

	try {
		// A fresh scope is active, so run() always calls `make`.
		const value = scope.run(make) as T;

		return {value, stop: () => scope.stop()};
	} catch (error) {
		scope.stop();
		throw error;
	}
}
