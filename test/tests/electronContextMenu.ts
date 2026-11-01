import {expect} from "chai";
// @ts-ignore no types for the Electron shell's plain CommonJS modules
import {contextMenuItems, installContextMenu} from "../../shells/electron/context-menu";

type MenuItem = {
	label?: string;
	suggestion?: string;
	action?: string;
	role?: string;
	enabled?: boolean;
	type?: string;
	click?: () => void;
};

const editable = {
	isEditable: true,
	misspelledWord: "",
	dictionarySuggestions: [] as string[],
	editFlags: {},
	selectionText: "",
};

describe("the Electron shell's context menu", function () {
	it("offers the dictionary suggestions for a misspelled word", function () {
		const items: MenuItem[] = contextMenuItems({
			...editable,
			misspelledWord: "teh",
			dictionarySuggestions: ["the", "tea"],
			editFlags: {canCut: true, canCopy: true, canPaste: true},
			selectionText: "teh",
		});
		const suggestions = items.filter((item) => item.action === "replaceMisspelling");

		expect(suggestions.map((item) => item.label)).to.deep.equal(["the", "tea"]);
		expect(suggestions.map((item) => item.suggestion)).to.deep.equal(["the", "tea"]);
		expect(items.some((item) => item.action === "addToDictionary")).to.equal(true);
	});

	it("says so when the dictionary has no suggestion", function () {
		const items: MenuItem[] = contextMenuItems({
			...editable,
			misspelledWord: "zxqw",
			selectionText: "zxqw",
		});

		expect(items[0]).to.include({label: "No suggestions", enabled: false});
	});

	it("keeps the editing actions, gated on what can be done", function () {
		const items: MenuItem[] = contextMenuItems({
			...editable,
			editFlags: {canUndo: true, canCopy: true, canSelectAll: true},
		});
		const byRole = new Map(items.map((item) => [item.role, item]));

		expect(byRole.get("undo")?.enabled).to.equal(true);
		expect(byRole.get("redo")?.enabled).to.equal(false);
		expect(byRole.get("cut")?.enabled).to.equal(false);
		expect(byRole.get("copy")?.enabled).to.equal(true);
		expect(byRole.get("paste")?.enabled).to.equal(false);
		expect(byRole.get("selectAll")?.enabled).to.equal(true);
	});

	it("greys out Select All when the field has nothing to select", function () {
		const items: MenuItem[] = contextMenuItems({...editable, editFlags: {}});
		const selectAll = items.find((item) => item.role === "selectAll");

		expect(selectAll?.enabled).to.equal(false);
	});

	it("offers Copy alone for selected read-only text", function () {
		const items: MenuItem[] = contextMenuItems({
			...editable,
			isEditable: false,
			selectionText: "hello",
		});

		expect(items).to.deep.equal([{role: "copy", enabled: true}]);
	});

	it("wires a clicked suggestion to replaceMisspelling", function () {
		let handler: ((event: unknown, params: unknown) => void) | undefined;
		let poppedWith: {template: MenuItem[]; options: {window: unknown}} | undefined;
		const replaced: string[] = [];
		const added: string[] = [];
		const win = {
			webContents: {
				on(name: string, fn: (event: unknown, params: unknown) => void) {
					expect(name).to.equal("context-menu");
					handler = fn;
				},
				replaceMisspelling(word: string) {
					replaced.push(word);
				},
				session: {
					addWordToSpellCheckerDictionary(word: string) {
						added.push(word);
					},
				},
			},
		};
		const Menu = {
			buildFromTemplate(template: MenuItem[]) {
				return {
					popup(options: {window: unknown}) {
						poppedWith = {template, options};
					},
				};
			},
		};

		installContextMenu(win, Menu);
		handler!(null, {
			...editable,
			misspelledWord: "teh",
			dictionarySuggestions: ["the"],
			selectionText: "teh",
		});

		expect(poppedWith!.options.window).to.equal(win);
		poppedWith!.template[0].click!();
		expect(replaced).to.deep.equal(["the"]);
		poppedWith!.template.find((item) => item.label === "Add to Dictionary")!.click!();
		expect(added).to.deep.equal(["teh"]);
	});

	it("stays out of the way where the page has its own menu", function () {
		// Messages, channels and users open the SPA's own context menu on
		// right-click; a native menu must not open over it.
		const items: MenuItem[] = contextMenuItems({...editable, isEditable: false});

		expect(items).to.deep.equal([]);
	});
});
