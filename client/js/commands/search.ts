import {store} from "../store";
import {router} from "../router";

// `/search <query>` — open the search window for the active channel.
export function input(args: string[]): boolean {
	const channel = store.state.activeChannel?.channel;

	if (!channel) {
		return false;
	}

	router
		.push({
			name: "SearchResults",
			params: {
				id: channel.id,
			},
			query: {
				q: args.join(" "),
			},
		})
		.catch((e: Error) => {
			// eslint-disable-next-line no-console
			console.error(`Failed to push SearchResults route: ${e.message}`);
		});

	return true;
}
