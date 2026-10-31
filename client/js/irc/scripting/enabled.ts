/**
 * The master switch for Lua scripting (Settings → Scripts → Enable scripting).
 *
 * Deliberately tiny and dependency-free: `settings.ts` writes it, the script
 * manager subscribes to it, and the router and Scripts tab read it. While it is off,
 * the manager never creates a sandbox, so the Fengari chunk (the Lua parser /
 * interpreter) is never fetched — not at boot, not for `/lua`, not for a
 * syntax check.
 */

let enabled = false;
let listener: ((value: boolean) => void) | null = null;

export function isScriptingEnabled(): boolean {
	return enabled;
}

export function setScriptingEnabled(value: boolean): void {
	const next = value === true;

	if (next === enabled) {
		return;
	}

	enabled = next;
	listener?.(next);
}

/** The manager is the only subscriber; it loads or tears down on a flip. */
export function onScriptingEnabledChange(fn: ((value: boolean) => void) | null): void {
	listener = fn;
}
