#!/usr/bin/env python3
"""Rebuild a WebLLM model's own q4f16_1 weights as a float16 ONNX model.

The app runs Qwen3 through WebLLM with MLC's q4f16_1 quantization; the offline
runner (tools/translate-llm.ts) runs ONNX through transformers.js. The ONNX
q4f16 export is quantized differently (MatMulNBits with zero points, and a
float16 embedding and output head), so its scores do not describe the web
model. This script takes the MLC build's quantized tensors, dequantizes them
exactly as the GPU does, and writes them into a copy of the float16 ONNX export
in place of the original weights: every weight then carries the web build's
4-bit rounding, the tied embedding and output head included, while compute
stays float16 as on the GPU.

    python3 tools/translate-eval/mlc-to-onnx.py download Qwen3-1.7B-q4f16_1-MLC
    python3 tools/translate-eval/mlc-to-onnx.py convert  Qwen3-1.7B-q4f16_1-MLC
    python3 tools/translate-eval/mlc-to-onnx.py report   Qwen3-1.7B-q4f16_1-MLC

Every step is resumable and stops cleanly after --budget seconds (default 540)
with exit code 3 ("run me again"), so it can be driven in bounded calls.

Files (relative to the working directory, normally the repository root):
    tmp/models/mlc/<model_id>/                  the MLC shards and tensor cache
    tmp/models/onnx-community/<Qwen3-xB-ONNX>/  the float16 ONNX export
    tmp/models/web/<model_id>/                  the result, loadable with
        npx tsx tools/translate-llm.ts --local tmp/models/web/<model_id> --dtype fp16

Needs numpy and onnx.

## The q4f16_1 packing (MLC-LLM, python/mlc_llm/quantization/)

quantization.py, the "q4f16_1" preset:
    GroupQuantize(group_size=32, quantize_dtype="int4", storage_dtype="uint32",
                  model_dtype="float16", linear_weight_layout="NK",
                  quantize_embedding=True, quantize_final_fc=True)
group_quantization.py, GroupQuantize.__post_init__:
    num_elem_per_storage = 32 // 4 = 8, num_storage_per_group = 32 // 8 = 4,
    max_int_value = 2 ** (4 - 1) - 1 = 7
group_quantization.py, GroupQuantize._quantize:
    scale = max_abs(group) / max_int
    q = clamp(round(w / scale + max_int), 0, 2 * max_int)   -> 0..14, offset 7
    packed with pack_weight(axis=-1) along the grouped axis
utils.py, pack_weight:
    word = sum_r q[r] << (r * bits)       -> element r in bits [4r, 4r + 4)
utils.py, convert_uint_to_float (ft_reorder=False):
    q[i] = (word[i // 8] >> ((i % 8) * 4)) & 0xF
group_quantization.py, GroupQuantize._dequantize:
    w[i] = (q[i] - max_int) * scale[i // group_size]
Linear layout "NK" means output_transpose=False and the group axis is the last
one: q_weight [out, ceil(in/32)*4], q_scale [out, ceil(in/32)], i.e. the
Hugging Face [out, in] layout. The embedding (GroupQuantizeEmbedding) is
[vocab, ceil(dim/32)*4] grouped along dim.

The shard bytes are raw little-endian uint32 / IEEE float16 as the record's
"dtype" says; the "f32-to-bf16" format label only changes how float32 records
are decoded by tvmjs, and there are none (checked: model.layers.0.
input_layernorm.weight is bit-identical to the ONNX export's).

(q - 7) * scale is computed in float32, where it is exact (a float16 scale
times an integer of magnitude <= 7), and then rounded to float16: the same
value float16 arithmetic on the GPU produces.

## Fused tensors (mlc_llm/model/qwen3/qwen3_loader.py)

    self_attn.c_attn   = concat([q_proj, k_proj, v_proj], axis=0)
                         rows: heads*head_dim, kv_heads*head_dim, kv_heads*head_dim
    mlp.gate_up_proj   = concat([gate_proj, up_proj], axis=0)
attention_bias is false for Qwen3, so there are no biases.

## The ONNX float16 export (onnx-community/Qwen3-*-ONNX, onnx/model_fp16.onnx)

MatMul weights are stored transposed, [in, out]; the embedding is [vocab,
hidden] and the output head is Transpose(model.embed_tokens.weight), so
replacing the embedding replaces the tied head as well (asserted below).
Tensors are replaced byte for byte at their external-data offsets in a copy
of the data files, so the graph and its external-data layout never change.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.request

import numpy as np
import onnx
from onnx import numpy_helper

MLC_BASE = "https://huggingface.co/mlc-ai/{model}/resolve/main/{file}"
HF_BASE = "https://huggingface.co/{repo}/resolve/main/{file}"
HF_TREE = "https://huggingface.co/api/models/{repo}/tree/main/{path}"

GROUP_SIZE = 32
BITS = 4
ELEMS_PER_WORD = 32 // BITS
MAX_INT = 2 ** (BITS - 1) - 1  # 7

ONNX_SIDE_FILES = ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json"]

EXIT_AGAIN = 3


class OutOfTime(Exception):
    pass


class Budget:
    def __init__(self, seconds):
        self.deadline = time.monotonic() + seconds

    def check(self):
        if time.monotonic() > self.deadline:
            raise OutOfTime()


def onnx_repo_for(model_id):
    match = re.fullmatch(r"(Qwen3-[0-9.]+B)-q4f16_1-MLC", model_id)
    if not match:
        sys.exit(f"no ONNX export known for {model_id} (expected Qwen3-<size>B-q4f16_1-MLC)")
    return f"onnx-community/{match.group(1)}-ONNX"


def mlc_dir(model_id):
    return os.path.join("tmp", "models", "mlc", model_id)


def onnx_dir(model_id):
    return os.path.join("tmp", "models", onnx_repo_for(model_id))


def web_dir(model_id):
    return os.path.join("tmp", "models", "web", model_id)


# --------------------------------------------------------------------------
# download


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def download(url, dest, size, budget, attempts=5):
    """Fetch url into dest, resuming a .part file, retrying transient failures."""
    for attempt in range(attempts):
        try:
            return download_once(url, dest, size, budget)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code == 404 or attempt == attempts - 1:
                raise
            print(f"  retrying {os.path.basename(dest)} after: {error}")
            budget.check()


def download_once(url, dest, size, budget):
    """Fetch url into dest, resuming a .part file; size is the expected length."""
    if os.path.exists(dest) and (size is None or os.path.getsize(dest) == size):
        return False
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    request = urllib.request.Request(url)
    if have:
        request.add_header("Range", f"bytes={have}-")
    with urllib.request.urlopen(request, timeout=60) as response:
        if have and response.status != 206:
            have = 0  # the server ignored the range: start over
        with open(part, "ab" if have else "wb") as out:
            while True:
                chunk = response.read(8 << 20)
                if not chunk:
                    break
                out.write(chunk)
                budget.check()
    got = os.path.getsize(part)
    if size is not None and got != size:
        raise RuntimeError(f"{dest}: got {got} bytes, expected {size}")
    os.replace(part, dest)
    print(f"  fetched {dest} ({got / 1e6:.1f} MB)")
    return True


def tree_sizes(repo, path=""):
    return {entry["path"]: entry.get("size") for entry in fetch_json(HF_TREE.format(repo=repo, path=path))}


def cmd_download(model_id, budget):
    # The MLC build: config, tensor cache, then every shard the cache names.
    mdir = mlc_dir(model_id)
    download(MLC_BASE.format(model=model_id, file="mlc-chat-config.json"), os.path.join(mdir, "mlc-chat-config.json"), None, budget)
    cache_path = os.path.join(mdir, "tensor-cache.json")
    try:
        download(MLC_BASE.format(model=model_id, file="tensor-cache.json"), cache_path, None, budget)
    except urllib.error.HTTPError:
        download(MLC_BASE.format(model=model_id, file="ndarray-cache.json"), cache_path, None, budget)
    with open(cache_path) as f:
        cache = json.load(f)
    for shard in cache["records"]:
        download(MLC_BASE.format(model=model_id, file=shard["dataPath"]), os.path.join(mdir, shard["dataPath"]), shard["nbytes"], budget)

    # The float16 ONNX export: side files, the graph, and its data files.
    repo = onnx_repo_for(model_id)
    odir = onnx_dir(model_id)
    top = tree_sizes(repo)
    for name in ONNX_SIDE_FILES:
        download(HF_BASE.format(repo=repo, file=name), os.path.join(odir, name), top.get(name), budget)
    sizes = tree_sizes(repo, "onnx")
    for path, size in sorted(sizes.items()):
        if re.fullmatch(r"onnx/model_fp16\.onnx(_data(_\d+)?)?", path):
            download(HF_BASE.format(repo=repo, file=path), os.path.join(odir, path), size, budget)
    print(f"download complete: {mdir}, {odir}")


# --------------------------------------------------------------------------
# dequantization


class MlcTensors:
    def __init__(self, model_id):
        self.dir = mlc_dir(model_id)
        with open(os.path.join(self.dir, "tensor-cache.json")) as f:
            cache = json.load(f)
        self.records = {}
        for shard in cache["records"]:
            for record in shard["records"]:
                self.records[record["name"]] = (shard["dataPath"], record)
        with open(os.path.join(self.dir, "mlc-chat-config.json")) as f:
            chat = json.load(f)
        if chat["quantization"] != "q4f16_1":
            sys.exit(f"{model_id} is {chat['quantization']}, this script only knows q4f16_1")
        self.config = chat["model_config"]
        self.last = None

    def raw(self, name):
        path, record = self.records[name]
        dtype = {"uint32": "<u4", "float16": "<f2", "float32": "<f4"}[record["dtype"]]
        count = int(np.prod(record["shape"]))
        array = np.fromfile(os.path.join(self.dir, path), dtype=dtype, count=count, offset=record["byteOffset"])
        if array.nbytes != record["nbytes"]:
            raise RuntimeError(f"{name}: {array.nbytes} bytes read, record says {record['nbytes']}")
        return array.reshape(record["shape"])

    def dequantize(self, name, in_features):
        """name without the .q_weight/.q_scale suffix; returns float16 [rows, in_features]."""
        # A fused tensor is asked for once per part it splits into.
        if self.last is not None and self.last[0] == (name, in_features):
            return self.last[1]
        out = self._dequantize(name, in_features)
        self.last = ((name, in_features), out)
        return out

    def _dequantize(self, name, in_features):
        words = self.raw(f"{name}.q_weight")
        scale = self.raw(f"{name}.q_scale")
        rows, num_words = words.shape
        groups = scale.shape[1]
        if num_words != groups * (GROUP_SIZE // ELEMS_PER_WORD) or scale.shape[0] != rows:
            raise RuntimeError(f"{name}: q_weight {words.shape} does not match q_scale {scale.shape}")
        if groups * GROUP_SIZE < in_features:
            raise RuntimeError(f"{name}: {groups} groups cannot hold {in_features} columns")
        shifts = (np.arange(ELEMS_PER_WORD, dtype=np.uint32) * BITS)
        nibbles = ((words[:, :, None] >> shifts) & 0xF).astype(np.int8).reshape(rows, -1)[:, :in_features]
        del words
        # Guard: nibbles are 0..14 by construction (clamp to 2 * max_int).
        if nibbles.max() > 2 * MAX_INT:
            raise RuntimeError(f"{name}: nibble {nibbles.max()} outside 0..{2 * MAX_INT}: wrong packing")
        group_scale = np.repeat(scale.astype(np.float32), GROUP_SIZE, axis=1)[:, :in_features]
        out = (nibbles.astype(np.float32) - MAX_INT) * group_scale
        return out.astype(np.float16)


def mlc_plan(mlc):
    """Yield (family, onnx initializer name, loader) for every tensor to replace."""
    c = mlc.config
    hidden = c["hidden_size"]
    inter = c["intermediate_size"]
    head_dim = c["head_dim"]
    q_rows = c["num_attention_heads"] * head_dim
    kv_rows = c["num_key_value_heads"] * head_dim
    layers = c["num_hidden_layers"]

    yield "model.embed_tokens (tied output head)", "model.embed_tokens.weight", lambda: mlc.dequantize("model.embed_tokens", hidden)
    yield "model.norm", f"model.layers.{layers}.final_norm_layernorm.weight", lambda: mlc.raw("model.norm.weight")

    for i in range(layers):
        mlc_attn = f"model.layers.{i}.self_attn"
        onnx_attn = f"model.layers.{i}.attn"
        mlp = f"model.layers.{i}.mlp"

        def c_attn(i=i, part=None):
            full = mlc.dequantize(f"model.layers.{i}.self_attn.c_attn", hidden)
            if full.shape[0] != q_rows + 2 * kv_rows:
                raise RuntimeError(f"c_attn has {full.shape[0]} rows, expected {q_rows}+{kv_rows}+{kv_rows}")
            return full

        def split(loader, start, stop):
            return lambda: loader()[start:stop].T

        yield "self_attn.c_attn -> q_proj", f"{onnx_attn}.q_proj.MatMul.weight", split(c_attn, 0, q_rows)
        yield "self_attn.c_attn -> k_proj", f"{onnx_attn}.k_proj.MatMul.weight", split(c_attn, q_rows, q_rows + kv_rows)
        yield "self_attn.c_attn -> v_proj", f"{onnx_attn}.v_proj.MatMul.weight", split(c_attn, q_rows + kv_rows, q_rows + 2 * kv_rows)
        yield "self_attn.o_proj", f"{onnx_attn}.o_proj.MatMul.weight", (lambda i=i: mlc.dequantize(f"model.layers.{i}.self_attn.o_proj", q_rows).T)

        def gate_up(i=i):
            full = mlc.dequantize(f"model.layers.{i}.mlp.gate_up_proj", hidden)
            if full.shape[0] != 2 * inter:
                raise RuntimeError(f"gate_up_proj has {full.shape[0]} rows, expected 2*{inter}")
            return full

        yield "mlp.gate_up_proj -> gate_proj", f"{mlp}.gate_proj.MatMul.weight", split(gate_up, 0, inter)
        yield "mlp.gate_up_proj -> up_proj", f"{mlp}.up_proj.MatMul.weight", split(gate_up, inter, 2 * inter)
        yield "mlp.down_proj", f"{mlp}.down_proj.MatMul.weight", (lambda i=i: mlc.dequantize(f"model.layers.{i}.mlp.down_proj", inter).T)
        yield "input_layernorm", f"model.layers.{i}.input_layernorm.weight", (lambda i=i: mlc.raw(f"model.layers.{i}.input_layernorm.weight"))
        yield "post_attention_layernorm", f"model.layers.{i}.post_attention_layernorm.weight", (lambda i=i: mlc.raw(f"model.layers.{i}.post_attention_layernorm.weight"))
        yield "self_attn.q_norm", f"{onnx_attn}.q_norm.layernorm.weight", (lambda i=i: mlc.raw(f"model.layers.{i}.self_attn.q_norm.weight"))
        yield "self_attn.k_norm", f"{onnx_attn}.k_norm.layernorm.weight", (lambda i=i: mlc.raw(f"model.layers.{i}.self_attn.k_norm.weight"))


# --------------------------------------------------------------------------
# convert


def copy_resumable(src, dest, budget):
    size = os.path.getsize(src)
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        return
    part = dest + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    with open(src, "rb") as fin, open(part, "ab") as fout:
        fin.seek(have)
        while True:
            chunk = fin.read(64 << 20)
            if not chunk:
                break
            fout.write(chunk)
            budget.check()
    os.replace(part, dest)
    print(f"  copied {dest} ({size / 1e9:.2f} GB)")


def external(initializer):
    return {entry.key: entry.value for entry in initializer.external_data}


def read_initializer(initializer, base):
    if initializer.data_location != onnx.TensorProto.EXTERNAL:
        return numpy_helper.to_array(initializer)
    info = external(initializer)
    with open(os.path.join(base, info["location"]), "rb") as f:
        f.seek(int(info.get("offset", 0)))
        data = f.read(int(info["length"]))
    return np.frombuffer(data, dtype="<f2").reshape(list(initializer.dims))


def cmd_convert(model_id, budget):
    mlc = MlcTensors(model_id)
    src = onnx_dir(model_id)
    dest = web_dir(model_id)
    os.makedirs(os.path.join(dest, "onnx"), exist_ok=True)
    for name in ONNX_SIDE_FILES:
        shutil.copyfile(os.path.join(src, name), os.path.join(dest, name))

    graph_src = os.path.join(src, "onnx", "model_fp16.onnx")
    model = onnx.load(graph_src, load_external_data=False)
    inits = {i.name: i for i in model.graph.initializer}

    # The output head must be the transposed embedding, not a weight of its own.
    head = [n for n in model.graph.node if n.name == "/lm_head/MatMul"]
    if len(head) != 1 or head[0].input[1] in inits:
        sys.exit("the ONNX output head is not tied to the embedding; this mapping does not apply")
    transpose = [n for n in model.graph.node if head[0].input[1] in n.output]
    if len(transpose) != 1 or transpose[0].op_type != "Transpose" or transpose[0].input[0] != "model.embed_tokens.weight":
        sys.exit("the ONNX output head does not read model.embed_tokens.weight")

    locations = sorted({external(i)["location"] for i in inits.values() if i.data_location == onnx.TensorProto.EXTERNAL})
    for location in locations:
        copy_resumable(os.path.join(src, "onnx", location), os.path.join(dest, "onnx", location), budget)

    state_path = os.path.join(dest, "conversion-state.json")
    state = {"done": {}}
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)

    plan = list(mlc_plan(mlc))
    graph_dirty = False
    covered = set()
    for family, onnx_name, loader in plan:
        covered.add(onnx_name)
        if onnx_name in state["done"] and inits[onnx_name].data_location == onnx.TensorProto.EXTERNAL:
            continue
        budget.check()
        initializer = inits.get(onnx_name)
        if initializer is None:
            sys.exit(f"no ONNX initializer {onnx_name}")
        if initializer.data_type != onnx.TensorProto.FLOAT16:
            sys.exit(f"{onnx_name} is not float16")
        original = read_initializer(initializer, os.path.join(src, "onnx"))
        new = np.ascontiguousarray(loader(), dtype=np.float16)
        if new.shape != original.shape:
            sys.exit(f"{onnx_name}: MLC gives {new.shape}, ONNX holds {original.shape} (wrong split or transpose)")
        if not np.isfinite(new).all():
            sys.exit(f"{onnx_name}: non-finite values after dequantization")
        a = original.astype(np.float64)
        b = new.astype(np.float64)
        rel = float(np.linalg.norm(b - a) / max(np.linalg.norm(a), 1e-30))
        cos = float((a.ravel() @ b.ravel()) / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-30))
        del a, b

        if initializer.data_location == onnx.TensorProto.EXTERNAL:
            info = external(initializer)
            if int(info["length"]) != new.nbytes:
                sys.exit(f"{onnx_name}: {new.nbytes} bytes do not fit the {info['length']} reserved")
            with open(os.path.join(dest, "onnx", info["location"]), "r+b") as f:
                f.seek(int(info.get("offset", 0)))
                f.write(new.astype("<f2").tobytes())
        else:
            replacement = numpy_helper.from_array(new.astype("<f2"), onnx_name)
            initializer.CopyFrom(replacement)
            graph_dirty = True

        state["done"][onnx_name] = {"family": family, "rel_error": rel, "cosine": cos, "shape": list(new.shape)}
        with open(state_path + ".tmp", "w") as f:
            json.dump(state, f, indent=1)
        os.replace(state_path + ".tmp", state_path)
        print(f"  {onnx_name:55s} rel err {rel:.4%}")

    # Inline initializers (the q/k norms) live in the graph file: write it once
    # every one of them has been set in this same run.
    graph_dest = os.path.join(dest, "onnx", "model_fp16.onnx")
    if graph_dirty or not os.path.exists(graph_dest):
        with open(graph_dest + ".tmp", "wb") as f:
            f.write(model.SerializeToString())
        os.replace(graph_dest + ".tmp", graph_dest)

    left = [n for n, i in inits.items() if n not in covered and len(i.dims) >= 1 and np.prod(i.dims) > 1]
    state["untouched"] = left
    with open(state_path, "w") as f:
        json.dump(state, f, indent=1)
    print(f"convert complete: {dest} ({len(state['done'])} tensors replaced; left as exported: {', '.join(left)})")


def cmd_report(model_id):
    with open(os.path.join(web_dir(model_id), "conversion-state.json")) as f:
        state = json.load(f)
    families = {}
    for name, entry in state["done"].items():
        families.setdefault(entry["family"], []).append(entry)
    print(f"{model_id}: relative error ||W_mlc - W_fp16|| / ||W_fp16|| per tensor family")
    print(f"| family | tensors | min | median | max | min cosine |")
    print(f"|---|---:|---:|---:|---:|---:|")
    for family, entries in families.items():
        errors = np.array([e["rel_error"] for e in entries])
        cosine = min(e["cosine"] for e in entries)
        print(f"| {family} | {len(entries)} | {errors.min():.3%} | {np.median(errors):.3%} | {errors.max():.3%} | {cosine:.5f} |")
    print(f"left as exported: {', '.join(state.get('untouched', []))}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=["download", "convert", "report"])
    parser.add_argument("model_id", help="e.g. Qwen3-1.7B-q4f16_1-MLC")
    parser.add_argument("--budget", type=float, default=540, help="seconds before stopping with exit code 3")
    args = parser.parse_args()
    budget = Budget(args.budget)
    try:
        if args.step == "download":
            cmd_download(args.model_id, budget)
        elif args.step == "convert":
            cmd_convert(args.model_id, budget)
        else:
            cmd_report(args.model_id)
    except OutOfTime:
        print(f"out of time after {args.budget:.0f} s; run the same command again to resume")
        sys.exit(EXIT_AGAIN)


if __name__ == "__main__":
    main()
