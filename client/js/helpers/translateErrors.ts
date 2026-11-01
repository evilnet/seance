// The failure reasons the translation layer reports are codes, not copy:
// `translate/service.ts`, `translate/client.ts`, `translate/queue.ts` and
// `translate/outgoing.ts` are Vue-free and never import the i18n runtime,
// so the constant's value is an identifier and the phrase lives here, in
// the catalog — one mapping for the reading line and the composer strip.
// Anything else is an engine's own text and renders verbatim.

import {t} from "../i18n/core";
import {WORKER_DISPOSED} from "../translate/client";
import {CONTEXT_OVERFLOW, parseGpuLost} from "../translate/engine";
import {ABORTED, TIMED_OUT} from "../translate/outgoing";
import {TRANSLATION_UNAVAILABLE} from "../translate/service";
import {parseNeedsDownload} from "../translate/consent";
import {needsDownloadText} from "./translateWhy";

/**
 * `explain` answers a bare "no engine can take this request" with why, as
 * it stands now (translateWhy.ts over reader.ts `pairVerdict`): the CPU
 * models switched off, a device without the GPU model. Empty when the pair
 * would route now, and the generic phrase stays.
 */
export function translateErrorText(error: string, explain?: () => string): string {
	if (error === TIMED_OUT) {
		return t("translate.error.timedOut");
	}

	if (error === ABORTED) {
		return t("translate.error.aborted");
	}

	if (error === WORKER_DISPOSED) {
		return t("translate.error.workerDisposed");
	}

	if (error === CONTEXT_OVERFLOW) {
		return t("translate.error.tooLong");
	}

	// The GPU went away under the request: the platform's reason, then the
	// call that failed on it (engine.ts `gpuLost`), both the browser's text.
	const lost = parseGpuLost(error);

	if (lost) {
		return t("translate.error.gpuLost", {reason: lost.reason, detail: lost.detail});
	}

	// A download the user said "not now" to: the model, its size, and
	// where to download it (translate/consent.ts).
	const need = parseNeedsDownload(error);

	if (need) {
		return needsDownloadText(need, need.device);
	}

	if (error === TRANSLATION_UNAVAILABLE) {
		return explain?.() || t("translate.error.unavailable");
	}

	// The service appends the last load error to the same code when it has
	// one; the detail is the library's own text and stays as it is.
	if (error.startsWith(`${TRANSLATION_UNAVAILABLE}: `)) {
		return t("translate.error.unavailableDetail", {
			detail: error.slice(TRANSLATION_UNAVAILABLE.length + 2),
		});
	}

	return error;
}
