import {isNavigationFailure, NavigationFailureType} from "vue-router";
import {store} from "../store";
import {router} from "../router";
import eventbus from "../eventbus";

// `/search <query>` — open the search window for the active channel.
export function input(args: string[]): boolean {
	const channel = store.state.activeChannel?.channel;

	if (!channel) {
		return false;
	}

	const q = args.join(" ");

	router
		.push({
			name: "SearchResults",
			params: {
				id: channel.id,
			},
			query: {
				q,
			},
		})
		.then((failure) => {
			// The search already showing: the router resolves with a failure
			// instead of navigating, so the panel's route watch never fires.
			// It searches again, as its own field does with the same query.
			if (isNavigationFailure(failure, NavigationFailureType.duplicated)) {
				eventbus.emit("search:again", q);
			}
		})
		.catch((e: Error) => {
			// eslint-disable-next-line no-console
			console.error(`Failed to push SearchResults route: ${e.message}`);
		});

	return true;
}
