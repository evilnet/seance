import {nextTick, onMounted, onUnmounted, type Ref} from "vue";
import {trapTab} from "../helpers/trapTab";

/**
 * Focus for a layer over the settings (Settings/ScriptEdit.vue,
 * Settings/AliasesOverlay.vue), a modal dialog opened from a row of the
 * Scripts tab. As it opens, focus goes into the pane (not a field: a phone
 * would raise its keyboard); while it is up, Tab comes round inside it
 * rather than reaching the settings under it; as it closes, focus goes back
 * to what opened it, the element focused when it opened or, when nothing
 * was (a reload, a link straight to the layer, a browser that does not
 * focus a clicked link), to `opener()`, so it does not drop to <body>.
 */
export function useLayerFocus(
	pane: Ref<HTMLElement | undefined>,
	opener: () => HTMLElement | null
): {onTab: (event: KeyboardEvent) => void} {
	const active = document.activeElement;
	const from = active instanceof HTMLElement && active !== document.body ? active : null;

	onMounted(() => {
		pane.value?.focus();
	});

	onUnmounted(() => {
		// After the list under it has re-rendered. Only when the focus went
		// down with the layer: whatever took it since keeps it.
		void nextTick(() => {
			if (document.activeElement && document.activeElement !== document.body) {
				return;
			}

			(from?.isConnected ? from : opener())?.focus();
		});
	});

	const onTab = (event: KeyboardEvent) => {
		// The code field's own Tab indents (CodeMirror takes it first).
		if (!event.defaultPrevented && pane.value) {
			trapTab(event, pane.value);
		}
	};

	return {onTab};
}
