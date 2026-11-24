/**
 * Setting our own avatar, or a channel's, and keeping it alive. An upload
 * goes to the network's image host (`draft/FILEHOST` with a
 * `draft/authtoken` token, upload.ts `uploadFilehost`), whose URL is
 * written to the `avatar` key (irc/avatars.ts `setOwnAvatar`,
 * `setChannelAvatar`) and remembered with its picture on this device
 * (own.ts). On every connect, a while after the burst:
 *
 *   - an upload of ours that the host deletes within a week (own.ts
 *     `refreshDue`, `avatars.retentionDays` in config.json, 30 by default)
 *     is uploaded again and the key moved to the new URL, provided the key
 *     still holds the URL we uploaded (another device may have changed it);
 *     the same for a channel's that this device uploaded, while we can
 *     still set it (`canSetChannelAvatar`);
 *   - our own avatar is probed (an `<img>` load, the one cross-origin check
 *     a page has), and own.ts decides when failures mean it is gone.
 */

import {FILEHOST_SERVICE} from "../irc/authtoken";
import {canSetChannelAvatar, ownAvatarValue, setChannelAvatar, setOwnAvatar} from "../irc/avatars";
import {ChanState, ChanType} from "../../../shared/types/chan";
import type {IrcClient} from "../irc/client";
import {clientForNetwork} from "../irc/manager";
import socket from "../socket";
import {store} from "../store";
import {UploadError, uploadFilehost} from "../upload";
import {
	DEFAULT_RETENTION_DAYS,
	noteProbe,
	recentAvatars,
	refreshDue,
	rememberAvatar,
	type RecentAvatar,
} from "./own";
import {avatarsEnabled, clearFailed} from "./prefs";
import {avatarKnown, avatarOf} from "./registry";
import {parseAvatarUrl} from "./url";

/** After the connect burst, when the server has said what our avatar is. */
export const UPKEEP_DELAY_MS = 20_000;

export function retentionDays(): number {
	return store.state.branding.avatars?.retentionDays ?? DEFAULT_RETENTION_DAYS;
}

/** Whether this connection can take an uploaded avatar: an image host and an account. */
export function canUpload(client: IrcClient | undefined): boolean {
	return !!client && client.isConnected && !!client.account && !!client.filehostUrl();
}

/** Upload `blob` to the network's image host; resolves with its URL. */
export async function uploadAvatar(client: IrcClient, blob: Blob): Promise<string> {
	const endpoint = client.filehostUrl();

	if (!endpoint) {
		throw new UploadError("no image host");
	}

	const extension = blob.type === "image/jpeg" ? "jpg" : "webp";
	const file = new File([blob], `avatar.${extension}`, {type: blob.type});
	const url = await uploadFilehost(file, {
		endpoint,
		generate: (scope) => client.generateToken(FILEHOST_SERVICE, scope),
	});

	if (!parseAvatarUrl(url)) {
		throw new UploadError(url);
	}

	return url;
}

/** Write `url` as our avatar (or `channel`'s) and remember it here. */
export async function useAvatar(
	client: IrcClient,
	url: string,
	{uploaded, blob, channel}: {uploaded: boolean; blob?: Blob; channel?: string}
): Promise<RecentAvatar> {
	if (channel === undefined) {
		await setOwnAvatar(client, url);
		noteProbe(client.uuid, url, true, Date.now());
	} else {
		await setChannelAvatar(client, channel, url);
	}

	clearFailed(url);
	return rememberAvatar({uuid: client.uuid, channel, url, setAt: Date.now(), uploaded, blob});
}

/** Upload a kept picture again and make the new URL the avatar it was (ours or its channel's). */
export async function reupload(client: IrcClient, rec: RecentAvatar): Promise<RecentAvatar> {
	if (!rec.blob) {
		throw new UploadError("no picture kept");
	}

	const url = await uploadAvatar(client, rec.blob);
	return useAvatar(client, url, {uploaded: true, blob: rec.blob, channel: rec.channel});
}

/** Load `url` the way the page will, off-screen. */
export function probeImage(url: string, timeoutMs = 20_000): Promise<boolean> {
	return new Promise((resolve) => {
		const img = new Image();
		const timer = window.setTimeout(() => resolve(false), timeoutMs);
		img.referrerPolicy = "no-referrer";
		img.onload = () => {
			window.clearTimeout(timer);
			resolve(true);
		};
		img.onerror = () => {
			window.clearTimeout(timer);
			resolve(false);
		};
		img.src = url;
	});
}

/** The connect-time work above, for one network. */
export async function upkeep(client: IrcClient): Promise<void> {
	if (!avatarsEnabled(client.uuid) || !client.isConnected) {
		return;
	}

	await ownUpkeep(client);
	await channelUpkeep(client);
}

/**
 * The channels' avatars this device uploaded, still theirs as the server
 * last said, that the host deletes within a week: uploaded again and set
 * again, one channel after another, where we may still set them.
 */
async function channelUpkeep(client: IrcClient): Promise<void> {
	if (!canUpload(client)) {
		return;
	}

	for (const chan of [...client.channels]) {
		const value = avatarOf(client.uuid, chan.name)?.value;

		if (
			chan.type !== ChanType.CHANNEL ||
			chan.state !== ChanState.JOINED ||
			!value ||
			!avatarKnown(client.uuid, chan.name) ||
			!canSetChannelAvatar(client, chan.name)
		) {
			continue;
		}

		const rec = (await recentAvatars(client.uuid, chan.name)).find((r) => r.url === value);

		if (rec && refreshDue(rec, Date.now(), retentionDays())) {
			try {
				await reupload(client, rec);
			} catch {
				// Tried again on the next connect; the picture stays until the host drops it.
			}
		}
	}
}

/** Our own avatar's share of {@link upkeep}. */
async function ownUpkeep(client: IrcClient): Promise<void> {
	const value = ownAvatarValue(client);

	if (!value) {
		return;
	}

	const current = (await recentAvatars(client.uuid)).find((rec) => rec.url === value);

	if (canUpload(client) && current && refreshDue(current, Date.now(), retentionDays())) {
		try {
			await reupload(client, current);
			return;
		} catch {
			// The probe below tells the user if this leaves the avatar broken.
		}
	}

	if (typeof navigator !== "undefined" && navigator.onLine === false) {
		return;
	}

	const parsed = parseAvatarUrl(value);

	if (parsed) {
		noteProbe(client.uuid, parsed.href, await probeImage(parsed.href), Date.now());
	}
}

const timers = new Map<string, number>();

socket.on("network:status", ({network, connected}) => {
	window.clearTimeout(timers.get(network));
	timers.delete(network);

	if (!connected) {
		return;
	}

	timers.set(
		network,
		window.setTimeout(() => {
			timers.delete(network);
			const client = clientForNetwork(network);

			if (client) {
				void upkeep(client);
			}
		}, UPKEEP_DELAY_MS)
	);
});
