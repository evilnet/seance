/* eslint-disable no-console */
// Checks that the published manifest the 1.7B's small-buffer build reads still
// splits the way its library expects, with the rewrite the worker itself does
// (client/js/translate/engines/splitManifest.ts), and prints what it would
// seed: every embedding record and the largest tensor.
//
//   npx tsx tools/translate-split/verify-manifest.ts             # the pinned revision
//   npx tsx tools/translate-split/verify-manifest.ts <manifest>  # a local tensor-cache.json
//   … --out /tmp/split.json                                      # write the rewrite too

import {readFileSync, writeFileSync} from "node:fs";
import {
	type TensorManifest,
	largestRecordBytes,
	manifestUrl,
	splitManifest,
} from "../../client/js/translate/engines/splitManifest";
import {LLM_CHOICES, QWEN3_1_7B_ID} from "../../client/js/translate/models";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : null;
const local = args.find((arg, i) => !arg.startsWith("--") && i !== outAt + 1) ?? null;
const build = LLM_CHOICES.find((ref) => ref.id === QWEN3_1_7B_ID)!.smallBuffer!;

async function main() {
	const source = local ?? manifestUrl(build.model);
	const manifest = (
		local ? JSON.parse(readFileSync(local, "utf8")) : await (await fetch(source)).json()
	) as TensorManifest;
	const rewritten = splitManifest(manifest, build.split);
	const largest = largestRecordBytes(rewritten);

	console.log(`source   ${source}`);
	console.log(`build    ${build.id}  lib ${build.lib}`);

	for (const shard of rewritten.records) {
		for (const record of shard.records) {
			if (record.name.startsWith("model.embed_tokens.")) {
				console.log(
					`  ${record.name.padEnd(36)} [${record.shape.join(", ")}] ${record.dtype} ` +
						`${shard.dataPath} @${record.byteOffset} +${record.nbytes}`
				);
			}
		}
	}

	console.log(`largest  ${largest} bytes (${(largest / 2 ** 20).toFixed(2)} MiB)`);

	if (largest !== build.largestBufferBytes) {
		throw new Error(`models.ts says ${build.largestBufferBytes}`);
	}

	if (out) {
		writeFileSync(out, JSON.stringify(rewritten));
		console.log(`wrote    ${out}`);
	}
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
