// Client-side link previews.
//
// TheLounge generated previews on its Node server (fetching every page,
// parsing OpenGraph metadata, proxying thumbnails). Seance has no server in
// the middle, so previews are limited to what the browser can render safely
// on its own: direct media URLs recognised by their path extension. No
// metadata is fetched, no oEmbed is consulted and nothing is proxied.

import {cleanIrcMessage} from "../../../shared/irc";
import {findLinksWithSchema} from "../../../shared/linkify";
import type {LinkPreview} from "../../../shared/types/msg";
import type {ClientLinkPreview} from "../types";

export type MediaPreviewType = "image" | "video" | "audio";

/**
 * HOOK: external preview service.
 *
 * A later deploy-time option may point Seance at an external service that
 * returns metadata (title/description/thumbnail) for links that are not
 * direct media. Such a resolver receives every non-media `https://` link that
 * survived dedupe/cap and returns a `LinkPreview` (any `type` the
 * `LinkPreview.vue` component knows how to render) or `null` to skip it.
 *
 * Nothing wires one up today; `buildMediaPreviews` only calls it when passed
 * via `MediaPreviewOptions.external`. Keep it synchronous-and-cheap or
 * return a placeholder and patch the preview object in place later (the
 * store holds a reference to it, exactly as the old `msg:preview` flow did).
 */
export type ExternalPreviewResolver = (link: string) => LinkPreview | null;

export type MediaPreviewOptions = {
	/** The user's `media` setting. When false no previews are produced at all. */
	media: boolean;
	/** Allow `http://` media. Only sensible when the page itself is served over http. */
	allowHttp?: boolean;
	/** Maximum number of previews per message (default `MAX_PREVIEWS_PER_MESSAGE`). */
	maxPreviews?: number;
	/** Optional external preview resolver, see `ExternalPreviewResolver`. */
	external?: ExternalPreviewResolver | null;
};

export const MAX_PREVIEWS_PER_MESSAGE = 5;

const imageExtensions: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
};

const videoExtensions: Readonly<Record<string, string>> = {
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
};

const audioExtensions: Readonly<Record<string, string>> = {
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	wav: "audio/wav",
	flac: "audio/flac",
	m4a: "audio/mp4",
	aac: "audio/aac",
	weba: "audio/webm",
};

export type MediaMatch = {
	type: MediaPreviewType;
	mediaType: string;
};

/**
 * Classifies a URL as previewable media by its path extension. Query strings
 * and fragments are ignored; matching is case-insensitive. Returns `null` for
 * anything that is not `https://` (or `http://` when `allowHttp` is set), has
 * no extension, or has an extension we do not preview.
 */
export function classifyMediaUrl(link: string, allowHttp = false): MediaMatch | null {
	let url: URL;

	try {
		url = new URL(link);
	} catch {
		return null;
	}

	if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
		return null;
	}

	const path = url.pathname;
	const lastSlash = path.lastIndexOf("/");
	const lastDot = path.lastIndexOf(".");

	if (lastDot <= lastSlash + 1 || lastDot === path.length - 1) {
		return null;
	}

	const ext = path.slice(lastDot + 1).toLowerCase();

	if (Object.prototype.hasOwnProperty.call(imageExtensions, ext)) {
		return {type: "image", mediaType: imageExtensions[ext]};
	}

	if (Object.prototype.hasOwnProperty.call(videoExtensions, ext)) {
		return {type: "video", mediaType: videoExtensions[ext]};
	}

	if (Object.prototype.hasOwnProperty.call(audioExtensions, ext)) {
		return {type: "audio", mediaType: audioExtensions[ext]};
	}

	return null;
}

function makeMediaPreview(link: string, match: MediaMatch): ClientLinkPreview {
	return {
		type: match.type,
		head: "",
		body: "",
		// `thumb` doubles as the image-viewer's "this is an image" marker,
		// so only images get one.
		thumb: match.type === "image" ? link : "",
		size: -1,
		link,
		shown: true,
		media: match.type === "image" ? undefined : link,
		mediaType: match.mediaType,
		sourceLoaded: false,
	};
}

/**
 * Builds the `previews` array for a message from its text. Only direct media
 * URLs are considered (see module comment). Links are deduplicated and the
 * result is capped at `maxPreviews` entries, counting in text order.
 */
export function buildMediaPreviews(text: string, opts: MediaPreviewOptions): ClientLinkPreview[] {
	if (!opts.media || !text) {
		return [];
	}

	const allowHttp = opts.allowHttp === true;
	const max = opts.maxPreviews ?? MAX_PREVIEWS_PER_MESSAGE;
	const previews: ClientLinkPreview[] = [];
	const seen = new Set<string>();

	for (const part of findLinksWithSchema(cleanIrcMessage(text))) {
		if (previews.length >= max) {
			break;
		}

		if (seen.has(part.link)) {
			continue;
		}

		seen.add(part.link);

		const match = classifyMediaUrl(part.link, allowHttp);

		if (match) {
			previews.push(makeMediaPreview(part.link, match));
			continue;
		}

		// HOOK: external preview service (see ExternalPreviewResolver).
		if (opts.external && /^https:\/\//i.test(part.link)) {
			const external = opts.external(part.link);

			if (external) {
				previews.push({...external, sourceLoaded: false});
			}
		}
	}

	return previews;
}
