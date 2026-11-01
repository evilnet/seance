# The small-buffer build of Qwen3 1.7B

The GPU translation model on a phone. Its user-facing story, and how the app
picks it, is `docs/resources/translation.md` § Phones and small GPUs; this is
how the library the app ships is made and checked.

## Why

A WebGPU device binds at most `maxStorageBufferBindingSize` bytes per storage
buffer, and an MLC model binds every weight tensor whole. WebGPU's floor is
128 MiB, and that is all many phone GPUs offer (Adreno 7xx). Qwen3's quantized
vocabulary table is a single tensor larger than that:

| tensor (q4f16_1)              | shape            | bytes                   |
| ----------------------------- | ---------------- | ----------------------- |
| `model.embed_tokens.q_weight` | 151936 × 256 u32 | 155,582,464 (148.4 MiB) |
| `model.embed_tokens.q_scale`  | 151936 × 64 f16  | 19,447,808              |

Every other tensor is far smaller, and the output head is tied to this table.
Our library splits the table by rows into `model.embed_tokens.part0.*` (rows
[0, 75968)) and `part1.*` (rows [75968, 151936)), so its largest tensor is
75968 × 1024 = 77,791,232 bytes (74.2 MiB). The embedding takes a row from the
half that holds it; the tied head computes both halves' logits and joins them
in vocabulary order. The 4B's table (194,478,080 bytes) would split the same
way; its library has never been built.

The weights are not rebuilt or hosted. Each half is a byte range of the same
record in the same published shard, so the app reads the published files
through a rewritten `tensor-cache.json` that names the four ranges
(`client/js/translate/engines/splitManifest.ts`, which the worker runs before
WebLLM loads the model, and seeds into WebLLM's own Cache Storage scope under
the URL WebLLM asks for). The rewrite is checked against the shapes the library
was compiled for, and a manifest that differs is refused: the build then does
not load, and says why.

## Files

- `qwen3-split.patch` — the whole model change, against MLC-LLM `2008fe8`
  (`python/mlc_llm/model/qwen3/qwen3_model.py`: `Qwen3SplitEmbedding`, switched
  on by the build's environment).
- `verify-manifest.ts` — runs the app's rewrite over the pinned published
  manifest (or a local one) and prints the four embedding records and the
  largest tensor, failing when that is not what `models.ts` says.
- The library itself: `client/models/qwen3-1.7b-q4f16_1-split-<sha256-8>.wasm`,
  copied to `public/models/` by webpack; `models.ts` `QWEN3_1_7B_SPLIT_LIB`
  names it. WebLLM caches a library by URL, so a rebuilt one needs a new name.

## Versions

The toolchain behind the libraries WebLLM 0.2.85 runs (its `v0_2_84` libs,
binary-mlc-llm-libs PR #165). A library from another toolchain does not load
into that runtime:

- TVM `apache/tvm` `bc1a904ec1ad89454ee6577d66cde1268b8f6bc8`
- MLC-LLM `mlc-ai/mlc-llm` `2008fe8343e1f40ef89ee57b9287aebcf1b86c98`, its
  `3rdparty/tvm` pointing at the TVM checkout above
- emsdk 4.0.23 (as TVM's `docker/install/ubuntu_install_emscripten.sh`)
- LLVM 20 with the WebAssembly backend (conda-forge `llvmdev=20`)
- the weights: `mlc-ai/Qwen3-1.7B-q4f16_1-MLC` at
  `80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc` (`models.ts`
  `QWEN3_1_7B_PINNED_MODEL`; its manifest was byte-identical to `main` on
  2026-10-28)

## Rebuilding

1. TVM at the commit above, with LLVM (`USE_LLVM` → conda's `llvm-config`,
   `HIDE_PRIVATE_SYMBOLS ON`, every GPU backend off), built with CMake + Ninja.
2. MLC-LLM at the commit above, `git apply tools/translate-split/qwen3-split.patch`,
   its C++ library built the same way (`set(TVM_SOURCE_DIR …)`,
   `USE_FLASHINFER OFF`; it needs Rust for the tokenizers).
3. The web runtimes: `make` in `tvm/web`, then in `mlc-llm/web`, with emsdk's
   environment sourced (`mlc_wasm_runtime.bc`).
4. Fetch the model's `mlc-chat-config.json` from the pinned revision and compile:

   ```sh
   source emsdk/emsdk_env.sh
   export PYTHONPATH=tvm/python:mlc-llm/python MLC_LLM_LIBRARY_PATH=mlc-llm/build \
     TVM_LIBRARY_PATH=mlc-llm/build/tvm TVM_SOURCE_DIR=tvm MLC_LLM_SOURCE_DIR=mlc-llm
   SEANCE_EMBEDDING_SPLIT=75968 python -m mlc_llm compile <dir>/mlc-chat-config.json \
     --device webgpu --quantization q4f16_1 --overrides "prefill_chunk_size=1024" \
     -o split-q4f16.wasm
   ```

   `prefill_chunk_size=1024` matches the prebuilt `_cs1k` library WebLLM ships
   for the model. Without `SEANCE_EMBEDDING_SPLIT` the same toolchain builds the
   stock library, which is how the toolchain itself was checked.

5. Copy it to `client/models/qwen3-1.7b-q4f16_1-split-<first 8 hex of sha256>.wasm`,
   delete the old file, update `QWEN3_1_7B_SPLIT_LIB`; `test/translate/smallBuffer.ts`
   checks the name against the bytes.

## Traps

- mlc-ai's prebuilt `llvm-22.1.0` has only the X86 backend (no WebAssembly) and
  bakes `/opt/llvm/lib/libzstd.a` into `llvm-config`; conda-forge
  `llvmdev=20` (`micromamba create -p conda -c conda-forge llvmdev=20 zlib zstd libxml2`)
  works without root.
- tvm-ffi needs `Python.h`: a Python with headers (uv's CPython 3.12 here).
- `mlc_llm compile` needs MLC-LLM's C++ library, where its object types are
  registered, not just the Python package.
- The compiler drops `model_config` keys it does not know, so the split row
  cannot ride in `mlc-chat-config.json`: it comes from the environment variable.
- No boolean tensors in the model: TVM stores a bool as `i8` and WGSL rejects
  `i8` without an extension — the shader fails to compile and the output is
  garbage. The half is chosen with integer arithmetic.
- A record's bytes per row are its `nbytes` over its rows, not shape × type
  width: a `"f32-to-bf16"` record of float32 values (the q4f32 builds) stores
  two bytes a value.

## Verifying

- `npx tsx tools/translate-split/verify-manifest.ts` — the pinned manifest
  still splits as the library expects (74.19 MiB largest).
- `test/translate/splitManifest.ts`, `smallBuffer.ts`, `webllmCache.ts` — the
  rewrite, the seeding, which build loads, the shipped file.
- On a GPU: the test switch (`translation.md` § Phones and small GPUs) makes a
  desktop bind 128 MiB, where the stock library fails and this one must not.
- Measured (2026-10-28, headless Chromium on SwiftShader, which has no
  `shader-f16`, so with the q4f32 twin of this library built the same way):
  the stock q4f32 library at a 128 MiB cap gives WebGPU validation errors and
  garbage; the split library with the rewritten manifest at the same cap gives
  no errors and the same greedy tokens as the stock library uncapped
  (`<think> </think> Guten Morgen, Fre`, 10 tokens). The f16 library the app
  ships has not run on a GPU here: it is built from the same source by the same
  toolchain, and its first run is on a real device.
