// The "Always show…" menu for a media preview: one entry per scope the
// preview belongs to (its host, the channel it was posted in, the sender's
// account), each either adding or removing that scope's trust. Shared by the
// veil's pill and the revealed toolbar's shield button (LinkPreview.vue).

import {t} from "../i18n/core";
import type {ContextMenuItem} from "./contextMenu";
import {
	isTrusted,
	mediaHost,
	trust,
	untrust,
	type RevealablePreview,
	type TrustKind,
} from "./mediaTrust";

type ScopeEntry = {kind: TrustKind; key: string; label: string};

/** The scopes a preview can be trusted through, with their display labels. */
export function mediaScopesOf(preview: RevealablePreview): ScopeEntry[] {
	const entries: ScopeEntry[] = [];
	const host = mediaHost(preview.link);

	if (host) {
		entries.push({kind: "host", key: host, label: t("link.trustFromHost", {name: host})});
	}

	if (preview.scope?.account && preview.scope.accountName) {
		entries.push({
			kind: "account",
			key: preview.scope.account,
			label: t("link.trustFromHost", {name: preview.scope.accountName}),
		});
	}

	if (preview.scope?.channel && preview.scope.channelName) {
		entries.push({
			kind: "channel",
			key: preview.scope.channel,
			label: t("link.trustInChannel", {name: preview.scope.channelName}),
		});
	}

	return entries;
}

/**
 * Menu items for the preview. `onChange(kind, trusted)` runs after a scope
 * was added or removed, so the caller can adjust the preview's own state.
 */
export function mediaTrustMenu(
	preview: RevealablePreview,
	onChange: (kind: TrustKind, trusted: boolean) => void
): ContextMenuItem[] {
	const scopes = mediaScopesOf(preview);
	const items: ContextMenuItem[] = [];

	const add = scopes.filter((s) => !isTrusted(s.kind, s.key));
	const remove = scopes.filter((s) => isTrusted(s.kind, s.key));

	for (const scope of add) {
		items.push({
			label: t("link.trustAdd", {scope: scope.label}),
			type: "item",
			class: `media-${scope.kind}`,
			action() {
				trust(scope.kind, scope.key);
				onChange(scope.kind, true);
			},
		});
	}

	if (add.length > 0 && remove.length > 0) {
		items.push({type: "divider"});
	}

	for (const scope of remove) {
		items.push({
			label: t("link.trustRemove", {scope: scope.label}),
			type: "item",
			class: `media-${scope.kind}-off`,
			action() {
				untrust(scope.kind, scope.key);
				onChange(scope.kind, false);
			},
		});
	}

	return items;
}
