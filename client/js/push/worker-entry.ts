/**
 * Entry of the service worker's push chunk (public/js/push.js, built by
 * the second webpack configuration). The worker `importScripts` it at
 * start-up and reaches everything through `self.seancePush`; keep this
 * object's shape in step with `push()` in client/service-worker.js.
 */
import {interpolate, t} from "../i18n/core";
import {applyLocale} from "./i18n";
import {CONCAT_TAG, lineIndexOf, parsePushLine} from "./line";
import {addMessage, MERGE_KEEP, renderMergedBody} from "./merge";
import {appUrlFromScope, networkFromScope} from "./scope";
import {notificationText, stripFormatting} from "./strip";

export const seancePush = {
	networkFromScope,
	appUrlFromScope,
	parsePushLine,
	lineIndexOf,
	CONCAT_TAG,
	notificationText,
	stripFormatting,
	addMessage,
	renderMergedBody,
	MERGE_KEEP,
	// The worker's own copy (notification actions, title fragments, the
	// fallback body): applyLocale installs the prefs' locale per push —
	// client/service-worker.js awaits it before composing anything — and
	// t/interpolate resolve the labels through the same catalog the app
	// uses. The overlay's transport is the worker's global fetch, bound
	// here (client/js/push/i18n.ts explains why it is fetched, not
	// webpack-imported).
	applyLocale: (appUrl: string, tag?: string | null) => applyLocale(fetch, appUrl, tag),
	t,
	interpolate,
};

(self as unknown as {seancePush: typeof seancePush}).seancePush = seancePush;
