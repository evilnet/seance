/**
 * Entry of the service worker's push chunk (public/js/push.js, built by
 * vite.push.config.mts). The worker `importScripts` it at
 * start-up and reaches everything through `self.seancePush`; keep this
 * object's shape in step with `push()` in client/service-worker.js.
 */
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
};

(self as unknown as {seancePush: typeof seancePush}).seancePush = seancePush;
