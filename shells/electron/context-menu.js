"use strict";

// The menu for a right-click in the renderer, as plain data, plus the
// wiring that turns it into Electron MenuItems. Kept free of any Electron
// import so the rules below can be tested without a window.
//
// Chromium underlines misspellings on its own (`spellcheck: true`), but
// Electron shows no menu at all on right-click unless the app builds one —
// without this, a flagged word could never be corrected.

/**
 * @param {{isEditable?: boolean, misspelledWord?: string,
 *   dictionarySuggestions?: string[], editFlags?: Record<string, boolean>,
 *   selectionText?: string}} params the webContents `context-menu` params
 * @returns {Array<Record<string, unknown>>} menu item descriptors; empty
 *   means show no menu (the page's own Vue context menus live there)
 */
function contextMenuItems(params) {
	const flags = params.editFlags || {};

	if (!params.isEditable) {
		// Read-only text: Copy a selection, and nothing else. Everywhere
		// else the SPA opens its own menu (messages, channels, users), and
		// a native menu must not open over it.
		return params.selectionText && params.selectionText.trim()
			? [{role: "copy", enabled: true}]
			: [];
	}

	const items = [];

	if (params.misspelledWord) {
		const suggestions = params.dictionarySuggestions || [];

		if (suggestions.length > 0) {
			for (const suggestion of suggestions) {
				items.push({label: suggestion, action: "replaceMisspelling", suggestion});
			}
		} else {
			items.push({label: "No suggestions", enabled: false});
		}

		items.push({type: "separator"});
		items.push({label: "Add to Dictionary", action: "addToDictionary"});
		items.push({type: "separator"});
	}

	items.push(
		{role: "undo", enabled: Boolean(flags.canUndo)},
		{role: "redo", enabled: Boolean(flags.canRedo)},
		{type: "separator"},
		{role: "cut", enabled: Boolean(flags.canCut)},
		{role: "copy", enabled: Boolean(flags.canCopy)},
		{role: "paste", enabled: Boolean(flags.canPaste)},
		{type: "separator"},
		{role: "selectAll", enabled: Boolean(flags.canSelectAll)}
	);

	return items;
}

/**
 * Pop the native menu for a right-click in `win`. Only editable fields
 * (and a read-only selection, for Copy) get one; everywhere else the
 * SPA's own context menus own the right-click.
 *
 * @param {Electron.BrowserWindow} win
 * @param {typeof Electron.Menu} Menu
 */
function installContextMenu(win, Menu) {
	win.webContents.on("context-menu", (event, params) => {
		const template = contextMenuItems(params).map((item) => {
			if (item.action === "replaceMisspelling") {
				return {
					label: item.label,
					click: () => win.webContents.replaceMisspelling(item.suggestion),
				};
			}

			if (item.action === "addToDictionary") {
				return {
					label: item.label,
					click: () =>
						win.webContents.session.addWordToSpellCheckerDictionary(
							params.misspelledWord
						),
				};
			}

			return item;
		});

		if (template.length > 0) {
			Menu.buildFromTemplate(template).popup({window: win});
		}
	});
}

module.exports = {contextMenuItems, installContextMenu};
