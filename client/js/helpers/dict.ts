/**
 * An empty dictionary with no prototype, for keys that come from outside:
 * network uuids, a script's storage keys, anything a restored settings file
 * can name. A plain `{}` answers `constructor`, `toString`, `__proto__` and
 * the rest of Object.prototype for keys nobody stored, and assigning
 * `__proto__` on it replaces its prototype instead of storing a value. This
 * one holds exactly the keys put into it, and `JSON.stringify` and
 * `Object.entries` see them as usual.
 */
export function dict<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}
