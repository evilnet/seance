/**
 * The ps theme's NG scene (ps NG plan 1). A stub until Task 5 brings the real
 * one: it mounts nothing, so ps.css's daylight fallback shows. It imports
 * nothing from scenes/ps/scene.ts, so classic's stepper never rides along.
 */
import type {SceneHandle, SceneHostState} from "../../themeScene";

export function mount(_root: HTMLElement, _state: SceneHostState): SceneHandle {
	return {
		update: () => undefined,
		destroy: () => undefined,
	};
}
