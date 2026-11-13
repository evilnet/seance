// "Is it downloaded" / "delete it" for a seq2seq model's copy on one device
// (spec docs/projects/translation-devices.md § Engines and the worker). Both
// copies of a model live side by side in transformers.js's one cache, under
// the same repo: the CPU's q8 files and the GPU's fp16 or q4f16 ones, with
// the config and tokenizer shared. A copy is its dtype's ONNX files, named by
// the library's suffix (`DEFAULT_DTYPE_SUFFIX_MAPPING`, @huggingface/
// transformers 4.2.0 utils/dtypes.js). Vue-free and library-free: the store
// arrives from seq2seq.real.ts.

import {Device, ModelRef} from "../engine";
import {CacheApi} from "../models";

/** The cached URLs, and a way to drop one. */
export interface UrlStore {
	keys(): Promise<string[]>;
	delete(url: string): Promise<void>;
}

/** transformers.js's file suffix per dtype; a file with none is fp32. */
const SUFFIXES: [string, string][] = [
	["_quantized", "q8"],
	["_fp16", "fp16"],
	["_int8", "int8"],
	["_uint8", "uint8"],
	["_q4f16", "q4f16"],
	["_q4", "q4"],
	["_q2f16", "q2f16"],
	["_q2", "q2"],
	["_q1f16", "q1f16"],
	["_q1", "q1"],
	["_bnb4", "bnb4"],
];

const ONNX = /^(.*)\.onnx(?:_data(?:_\d+)?)?$/;

/** The dtype of an ONNX weights file (its external data included); null for any other file. */
export function onnxDtype(url: string): string | null {
	const file = url.split(/[?#]/)[0].split("/").pop() ?? "";
	const stem = ONNX.exec(file)?.[1];

	if (stem === undefined) {
		return null;
	}

	return SUFFIXES.find(([suffix]) => stem.endsWith(suffix))?.[1] ?? "fp32";
}

/**
 * The repo a copy's files are cached under: its `source`, which a pair that
 * shares its repo with another has apart from its catalog id
 * (models.ts `sharedPairId`).
 */
function sourceOf(ref: ModelRef, device: Device): string {
	return ref.copies[device]?.source ?? ref.id;
}

export function seq2seqCacheApi(store: UrlStore): CacheApi {
	const urlsOf = async (id: string) =>
		(await store.keys()).filter((url) => url.includes(`/${id}/`));

	return {
		async has(ref, device: Device) {
			const dtype = ref.copies[device]?.dtype;

			if (!dtype) {
				return false;
			}

			return (await urlsOf(sourceOf(ref, device))).some((url) => onnxDtype(url) === dtype);
		},
		// The copy's own weights go; the shared files go with the last copy,
		// so deleting one device's copy leaves the other's loadable.
		async delete(ref, device: Device) {
			const dtype = ref.copies[device]?.dtype;

			if (!dtype) {
				return;
			}

			const urls = await urlsOf(sourceOf(ref, device));
			const own = urls.filter((url) => onnxDtype(url) === dtype);
			const othersRemain = urls.some((url) => {
				const kind = onnxDtype(url);

				return kind !== null && kind !== dtype;
			});
			const shared = othersRemain ? [] : urls.filter((url) => onnxDtype(url) === null);

			for (const url of [...own, ...shared]) {
				await store.delete(url);
			}
		},
	};
}

/**
 * Delete every cached file of `repos`: the models a build replaced
 * (models.ts `retiredRepos`), which Settings no longer lists and so could
 * never delete.
 */
export async function dropRepos(store: UrlStore, repos: string[]): Promise<void> {
	if (repos.length === 0) {
		return;
	}

	for (const url of await store.keys()) {
		if (repos.some((repo) => url.includes(`/${repo}/`))) {
			await store.delete(url);
		}
	}
}
