import Mousetrap from "mousetrap";

import {nextTick} from "vue";
import {searchTucked} from "./searchPanel";
import {store} from "./store";
import {switchToChannel, router, navigate, leavePage} from "./router";
import {topEscapeLayer} from "./helpers/escapeLayer";
import isChannelCollapsed from "./helpers/isChannelCollapsed";
import isIgnoredKeybind from "./helpers/isIgnoredKeybind";
import listenForTwoFingerSwipes from "./helpers/listenForTwoFingerSwipes";
import {numberShortcutModifier} from "./helpers/numberShortcut";
import {nativeListen, nativePlatform} from "./helpers/shell";
import {ClientChan} from "./types";
import {ChanType} from "../../shared/types/chan";

// Switch to the next/previous window in the channel list.
Mousetrap.bind(["alt+up", "alt+down"], function (e, keys) {
	if (isIgnoredKeybind(e)) {
		return true;
	}

	navigateWindow(keys.split("+").pop() === "up" ? -1 : 1);

	return false;
});

listenForTwoFingerSwipes(function (cardinalDirection: string) {
	if (cardinalDirection === "e" || cardinalDirection === "w") {
		navigateWindow(cardinalDirection === "e" ? -1 : 1);
	}
});

/** The conversations in sidebar order, the collapsed networks' left out (lobbies stay). */
function visibleWindows(): ClientChan[] {
	const flat: ClientChan[] = [];

	for (const network of store.state.networks) {
		for (const channel of network.channels) {
			if (!isChannelCollapsed(network, channel)) {
				flat.push(channel);
			}
		}
	}

	return flat;
}

/** The Nth channel or query (1-based) in sidebar order; a network's lobby is not counted, as in other clients' ⌘1–9. */
function jumpToNthChannel(n: number) {
	const conversations = visibleWindows().filter((chan) => chan.type !== ChanType.LOBBY);
	const target = conversations[n - 1];

	if (target) {
		jumpToChannel(target);
	}
}

// Jump to the Nth channel or query with a digit: in the macOS app through
// the menu bar's Go menu (⌘1–9, the shell's install_mac_menu sends
// `go.channel.N`), so the shortcut is a real menu item and fires once;
// elsewhere through the keyboard, with the modifier each platform leaves
// free (Ctrl+1–9 in the app on Windows and Linux, Alt+1–9 in a browser on
// Windows, nothing where every chord is taken: helpers/numberShortcut.ts).
// From the composer too: no layout types a character with these chords.
if (nativePlatform() === "macos") {
	nativeListen("App", "menuAction", (data: {action?: unknown}) => {
		const match = /^go\.channel\.([1-9])$/.exec(
			typeof data?.action === "string" ? data.action : ""
		);

		if (match) {
			jumpToNthChannel(Number(match[1]));
		}
	});
} else {
	const numberModifier = numberShortcutModifier();

	if (numberModifier) {
		Mousetrap.bind(
			["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((n) => `${numberModifier}+${n}`),
			function (_e, keys) {
				jumpToNthChannel(Number(keys.split("+").pop()));
				return false;
			}
		);
	}
}

function navigateWindow(direction: number) {
	const flatChannels = visibleWindows();

	if (flatChannels.length === 0) {
		return;
	}

	const active = store.state.activeChannel?.channel;
	let index = active ? flatChannels.indexOf(active) : -1;

	// Circular array, and a modulo bug workaround because in JS it stays negative
	const length = flatChannels.length;
	index = (((index + direction) % length) + length) % length;

	jumpToChannel(flatChannels[index]);
}

// Switch to the next/previous lobby in the channel list
Mousetrap.bind(["alt+shift+up", "alt+shift+down"], function (e, keys) {
	if (isIgnoredKeybind(e)) {
		return true;
	}

	const length = store.state.networks.length;

	if (length === 0) {
		return false;
	}

	const direction = keys.split("+").pop() === "up" ? -1 : 1;
	let index = 0;

	// If we're in another window, jump to first lobby
	if (store.state.activeChannel) {
		index = store.state.networks.findIndex((n) => n === store.state.activeChannel?.network);

		// If we're in a channel, and it's not the lobby, jump to lobby of this network when going up
		if (direction !== -1 || store.state.activeChannel?.channel.type === ChanType.LOBBY) {
			index = (((index + direction) % length) + length) % length;
		}
	}

	jumpToChannel(store.state.networks[index].channels[0]);

	return false;
});

// Switch to the next/previous unread chat
Mousetrap.bind(["alt+mod+up", "alt+mod+down"], function (e, keys) {
	if (isIgnoredKeybind(e)) {
		return true;
	}

	const channels = store.state.networks
		.map((net) =>
			net.channels.filter(
				(chan) => chan.unread || chan === store.state.activeChannel?.channel
			)
		)
		.flat();

	if (channels.length === 0) {
		return;
	}

	let index = channels.findIndex((chan) => chan === store.state.activeChannel?.channel);

	const length = channels.length;
	const direction = keys.split("+").pop() === "up" ? -1 : 1;
	index = (((index + direction) % length) + length) % length;

	jumpToChannel(channels[index]);

	return false;
});

// Jump to the first window with a highlight in it, or the first with unread
// activity if there are none with highlights.
Mousetrap.bind(["alt+a"], function (e) {
	if (isIgnoredKeybind(e)) {
		return true;
	}

	let targetChannel;

	outer_loop: for (const network of store.state.networks) {
		for (const chan of network.channels) {
			if (chan.highlight) {
				targetChannel = chan;
				break outer_loop;
			}

			if (chan.unread && !targetChannel) {
				targetChannel = chan;
			}
		}
	}

	if (targetChannel) {
		jumpToChannel(targetChannel);
	}

	return false;
});

// Show the help menu.
Mousetrap.bind(["alt+/"], function (e) {
	if (isIgnoredKeybind(e)) {
		return true;
	}

	/* eslint-disable no-console */
	navigate("Help").catch((err) => console.log(err));
	return false;
});

// Search the open conversation: its search page, or that page's field. Works
// from the composer too (it carries the mousetrap class). Anywhere else, the
// browser's own find.
Mousetrap.bind(["mod+f"], function () {
	const channel = store.state.activeChannel?.channel;

	if (!channel || (channel.type !== ChanType.CHANNEL && channel.type !== ChanType.QUERY)) {
		return true;
	}

	if (router.currentRoute.value.name === "SearchResults") {
		searchTucked.value = false; // a phone's panel a hit tucked away comes back
		void nextTick(() =>
			document.querySelector<HTMLInputElement>(".search-query input")?.focus()
		);
	} else {
		void navigate("SearchResults", {id: channel.id});
	}

	return false;
});

function jumpToChannel(targetChannel: ClientChan) {
	switchToChannel(targetChannel);

	const element = document.querySelector(
		`#sidebar .channel-list-item[aria-controls="#chan-${targetChannel.id}"]`
	);

	if (element) {
		scrollIntoViewNicely(element);
	}
}

// Ignored keys which should not automatically focus the input bar
const ignoredKeys = {
	8: true, // Backspace
	9: true, // Tab
	12: true, // Clear
	16: true, // Shift
	17: true, // Control
	18: true, // Alt
	19: true, // Pause
	20: true, // CapsLock
	27: true, // Escape
	35: true, // End
	36: true, // Home
	37: true, // ArrowLeft
	38: true, // ArrowUp
	39: true, // ArrowRight
	40: true, // ArrowDown
	45: true, // Insert
	46: true, // Delete
	112: true, // F1
	113: true, // F2
	114: true, // F3
	115: true, // F4
	116: true, // F5
	117: true, // F6
	118: true, // F7
	119: true, // F8
	120: true, // F9
	121: true, // F10
	122: true, // F11
	123: true, // F12
	144: true, // NumLock
	145: true, // ScrollLock
	224: true, // Meta
};

document.addEventListener("keydown", (e) => {
	// Escape leaves the help, release notes, settings and oper modals. Not
	// `router.go(-1)`: the history is kept one deep (router.ts). Never from
	// inside a form field — settings are full of them, and Escape there
	// means "leave the field", not "throw me out of the page" — and never
	// while an overlay is up over the page (the script editor, a confirm
	// dialog): Escape closes that one alone (helpers/escapeLayer.ts; App.vue
	// marks the press it gave an overlay, which may be gone by now).
	if (
		e.key === "Escape" &&
		!e.defaultPrevented &&
		topEscapeLayer() === null &&
		(router.currentRoute.value.name === "Help" ||
			router.currentRoute.value.name === "Changelog" ||
			router.currentRoute.value.path.startsWith("/settings") ||
			router.currentRoute.value.name === "OperPanel") &&
		!(
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement ||
			e.target instanceof HTMLSelectElement
		)
	) {
		leavePage();
		return;
	}

	// Ignore any key that uses alt modifier
	// Ignore keys defined above
	if (e.altKey || ignoredKeys[e.which]) {
		return;
	}

	// Ignore all ctrl keys except for ctrl+v to allow pasting
	if ((e.ctrlKey || e.metaKey) && e.which !== 86) {
		return;
	}

	// An overlay up keeps its keys: Enter on its button is that button's.
	if (topEscapeLayer() !== null) {
		return;
	}

	// Redirect pagedown/pageup keys to messages container so it scrolls
	if (e.which === 33 || e.which === 34) {
		const chat = document.querySelector(".window .chat-content .chat");

		if (chat) {
			(chat as HTMLDivElement).focus();
		}

		return;
	}

	const tagName = (e.target as HTMLElement).tagName;

	// Ignore if we're already typing into <input>, <textarea> or an editor
	// (the script editor's CodeMirror is contenteditable)
	if (
		tagName === "INPUT" ||
		tagName === "TEXTAREA" ||
		(e.target as HTMLElement).isContentEditable
	) {
		return;
	}

	const input = document.getElementById("input");

	if (!input) {
		return;
	}

	input.focus();

	// On enter, focus the input but do not propagate the event
	// This way, a new line is not inserted
	if (e.which === 13) {
		e.preventDefault();
	}
});

function scrollIntoViewNicely(el) {
	// "nearest": a row already in sight stays where it is, as after a click;
	// one out of sight is brought to the nearer edge. "center" moved the list
	// on every keyboard switch, visible or not.
	// Ideally this would use behavior: "smooth", but that does not consistently work in e.g. Chrome
	// https://github.com/iamdustan/smoothscroll/issues/28#issuecomment-364061459
	el.scrollIntoView({block: "nearest", inline: "nearest"});
}
