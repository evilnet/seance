import {defineComponent} from "vue";

import {SharedChan} from "../../shared/types/chan";
import {SharedBouncerNetwork, SharedNetwork} from "../../shared/types/network";
import {SharedUser} from "../../shared/types/user";
import {SharedConfiguration, LockedSharedConfiguration} from "../../shared/types/config";
import {LinkPreview, SharedMsg} from "../../shared/types/msg";
import {SharedOperState} from "../../shared/types/oper";
import {TypingEntry} from "./helpers/typingState";

interface LoungeWindow extends Window {
	g_TheLoungeRemoveLoading?: () => void;
}

type ClientUser = SharedUser;

// we will eventually need to put client specific fields here
// which are not shared with the server
export type ClientMessage = SharedMsg;

type PastView = {
	rows: ClientMessage[];
	/** The msgid to go to once the rows have rendered. */
	reveal: string | null;
	loading: "BEFORE" | "AFTER" | null;
	/** The page on its way: an answer to any other has been cancelled. */
	requestId: number;
	canEarlier: boolean;
	canLater: boolean;
	/** Where the next page on each side starts, once a page has said (its edges). */
	from: {BEFORE?: string; AFTER?: string};
	failed: boolean;
	retryAt: number;
};

type ClientChan = Omit<SharedChan, "messages"> & {
	moreHistoryAvailable: boolean;
	editTopic: boolean;
	messages: ClientMessage[];

	// these are added in store/initChannel
	pendingMessage: string;
	inputHistoryPosition: number;
	inputHistory: string[];
	historyLoading: boolean;
	/** Older lines shown in place of `messages` (client/js/pastView.ts). */
	past: PastView | null;
	/** One is on its way: the bar says so. */
	pastOpening: boolean;
	/** Taken to an older message: not read until the list reaches the bottom. */
	readHeld: boolean;
	scrolledToBottom: boolean;
	usersOutdated: boolean;
	/** Reply parents fetched for their quotes because no loaded row has them, by msgid. */
	replyParents?: Record<string, {nick: string; text: string; id?: undefined}>;
	/** Message the next plain-text/`/me` input replies to (`+reply`). */
	replyTo: ClientMessage | null;
	/** Own message the next plain-text input replaces (the edit tags, `wire.ts` `editTags`). */
	editing: ClientMessage | null;
	/**
	 * Escape dismissed an edit: ArrowUp browses input history instead of
	 * re-entering edit mode, until the user types again.
	 */
	editDismissed: boolean;
	/** Who is typing here right now (`+typing`), pruned by helpers/typingExpiry.ts. */
	typing: TypingEntry[];
	/**
	 * The indicator line stays reserved (empty) after the last entry goes so
	 * the scrollback does not bounce; the next appended message releases it.
	 */
	typingReserved: boolean;
	/**
	 * Epoch ms until which the sidebar icon pulses because somebody spoke here
	 * (0 = quiet), set by socket-events/activity.ts and swept by
	 * helpers/activityPulse.ts.
	 */
	activityUntil: number;

	users: ClientUser[];
};

type InitClientChan = ClientChan & {
	// total messages is deleted after its use when init event is sent/handled
	totalMessages?: number;
};

// We omit channels so we can use ClientChan[] instead of Chan[]
type ClientNetwork = Omit<SharedNetwork, "channels"> & {
	isJoinChannelShown: boolean;
	isCollapsed: boolean;
	channels: ClientChan[];
	/** Being an oper here (`oper:state`, irc/oper.ts); absent until the first one. */
	oper?: SharedOperState;
	/** soju's networks, on a bouncer connection (`bouncer:networks`, irc/bouncer.ts). */
	bouncer?: SharedBouncerNetwork[];
};

type NetChan = {
	channel: ClientChan;
	network: ClientNetwork;
};

type ClientLinkPreview = LinkPreview & {
	sourceLoaded?: boolean;
	/**
	 * Click-to-reveal state (helpers/mediaTrust.ts): `true` once the reader
	 * revealed it (or posted it), `false` after they hid it, unset to follow
	 * the `mediaReveal` setting and the trusted hosts.
	 */
	revealed?: boolean;
	/** Where it was posted, as trust keys (helpers/mediaTrust.ts `MediaScope`). */
	scope?: {channel?: string; channelName?: string; account?: string; accountName?: string};
};

interface BeforeInstallPromptEvent extends Event {
	/**
	 * Returns an array of DOMString items containing the platforms on which the event was dispatched.
	 * This is provided for user agents that want to present a choice of versions to the user such as,
	 * for example, "web" or "play" which would allow the user to chose between a web version or
	 * an Android version.
	 */
	readonly platforms: Array<string>;

	/**
	 * Returns a Promise that resolves to a DOMString containing either "accepted" or "dismissed".
	 */
	readonly userChoice: Promise<{
		outcome: "accepted" | "dismissed";
		platform: string;
	}>;

	/**
	 * Allows a developer to show the install prompt at a time of their own choosing.
	 * This method returns a Promise.
	 */
	prompt(): Promise<void>;
}
