"""Build a 4-bit ONNX graph from a WebLLM q4f16_1 model's own quantized weights.

The user (2026-09-13): "you needed to use the same quant level as the web
version to fit these." The fp16 web-equivalent graph (mlc-to-onnx.py) carries
the web build's 4-bit rounding exactly but stores every weight in float16, so
the 4B one (8 GB) does not fit an 8 GB card. Here every linear layer keeps
MLC's own packed nibbles and float16 group scales as ONNX Runtime's
MatMulNBits (com.microsoft): bits 4, block 32, zero point 7 (MLC's max_int;
MatMulNBits' default would be 8). MatMulNBits dequantizes to the very
`(q - 7) * scale` the web build computes, so the numbers are unchanged; only
the storage shrinks back to the web build's size.

- linear layers: MatMulNBits from q_weight/q_scale directly (the fused c_attn
  and gate_up_proj split by rows, which needs no dequantizing);
- output head: MatMulNBits from the embedding's own 4-bit data (tied, as on
  the web);
- embedding lookup: a float16 Gather over the exactly dequantized embedding
  (the same values the web build looks up);
- norms and everything else: taken from the fp16 web-equivalent graph.

    tmp/venv-quant/bin/python tools/translate-eval/mlc-to-q4.py <model id>

Reads tmp/models/mlc/<id> (shards) and tmp/models/web/<id> (fp16 graph); writes
tmp/models/web/<id>-q4/onnx/model_q4f16.onnx (+ _data) with the tokenizer and
config files beside it. Run tools/translate-eval/norm-fp32.py on the result for CUDA.
"""

import importlib.util
import math
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("mlc2onnx", ROOT / "tools" / "translate-eval" / "mlc-to-onnx.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

model_id = sys.argv[1]
os.chdir(ROOT)

GROUP = 32
ZERO_POINT = 7

mlc = tool.MlcTensors(model_id)
cfg = mlc.config
hidden = cfg["hidden_size"]
inter = cfg["intermediate_size"]
head_dim = cfg["head_dim"]
q_rows = cfg["num_attention_heads"] * head_dim
kv_rows = cfg["num_key_value_heads"] * head_dim
layers = cfg["num_hidden_layers"]

src = Path("tmp/models/web") / model_id
dst = Path("tmp/models/web") / f"{model_id}-q4"
(dst / "onnx").mkdir(parents=True, exist_ok=True)
for item in src.iterdir():
    if item.name != "onnx":
        if item.is_dir():
            shutil.copytree(item, dst / item.name, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dst / item.name)

graph_path = src / "onnx" / "model_fp16.onnx"
model = onnx.load(str(graph_path), load_external_data=False)
graph = model.graph
base = str(src / "onnx")


def packed(name, start=None, stop=None):
    """MatMulNBits B [rows, groups, 16] uint8, scales [rows*groups] fp16, zero points uint8."""
    words = mlc.raw(f"{name}.q_weight")
    scale = mlc.raw(f"{name}.q_scale")
    if start is not None:
        words, scale = words[start:stop], scale[start:stop]
    rows, groups = scale.shape
    if words.shape[1] != groups * (GROUP // tool.ELEMS_PER_WORD):
        raise RuntimeError(f"{name}: q_weight {words.shape} vs q_scale {scale.shape}")
    shifts = np.arange(tool.ELEMS_PER_WORD, dtype=np.uint32) * tool.BITS
    nibbles = ((words[:, :, None] >> shifts) & 0xF).astype(np.uint8).reshape(rows, groups * GROUP)
    if nibbles.max() > 2 * tool.MAX_INT:
        raise RuntimeError(f"{name}: nibble {nibbles.max()} outside 0..{2 * tool.MAX_INT}")
    # MatMulNBits packs two values a byte, the first in the low nibble -- the
    # order MLC's words already hold them in.
    blob = (nibbles[:, 0::2] | (nibbles[:, 1::2] << 4)).reshape(rows, groups, GROUP // 2)
    zero_points = np.full(rows * math.ceil(groups / 2), ZERO_POINT | (ZERO_POINT << 4), dtype=np.uint8)
    return blob, scale.astype(np.float16).reshape(-1), zero_points, rows, groups


# initializer name of the fp16 weight -> (mlc tensor, row range, in_features)
plan = {}
for i in range(layers):
    attn, mlp = f"model.layers.{i}.attn", f"model.layers.{i}.mlp"
    c_attn = f"model.layers.{i}.self_attn.c_attn"
    gate_up = f"model.layers.{i}.mlp.gate_up_proj"
    plan[f"{attn}.q_proj.MatMul.weight"] = (c_attn, (0, q_rows), hidden)
    plan[f"{attn}.k_proj.MatMul.weight"] = (c_attn, (q_rows, q_rows + kv_rows), hidden)
    plan[f"{attn}.v_proj.MatMul.weight"] = (c_attn, (q_rows + kv_rows, q_rows + 2 * kv_rows), hidden)
    plan[f"{attn}.o_proj.MatMul.weight"] = (f"model.layers.{i}.self_attn.o_proj", None, q_rows)
    plan[f"{mlp}.gate_proj.MatMul.weight"] = (gate_up, (0, inter), hidden)
    plan[f"{mlp}.up_proj.MatMul.weight"] = (gate_up, (inter, 2 * inter), hidden)
    plan[f"{mlp}.down_proj.MatMul.weight"] = (f"model.layers.{i}.mlp.down_proj", None, inter)

producers = {out: node for node in graph.node for out in node.output}
inits = {init.name: init for init in graph.initializer}
new_nodes, new_inits, dropped = [], [], set()
linear = head = 0

for node in graph.node:
    if node.op_type == "MatMul" and node.input[1] in plan:
        weight = node.input[1]
        tensor, rows, in_features = plan[weight]
        blob, scales, zps, n_rows, groups = packed(tensor, *(rows or (None, None)))
        if groups * GROUP < in_features or (groups - 1) * GROUP >= in_features:
            raise RuntimeError(f"{weight}: {groups} groups for {in_features} columns")
        stem = weight[: -len(".weight")]
        names = [f"{stem}.weight_Q4", f"{stem}.weight_scales", f"{stem}.weight_zp"]
        new_inits += [numpy_helper.from_array(blob, names[0]), numpy_helper.from_array(scales, names[1]),
                      numpy_helper.from_array(zps, names[2])]
        new_nodes.append(helper.make_node("MatMulNBits", [node.input[0], *names], list(node.output),
                                          name=f"{node.name}_Q4", domain="com.microsoft",
                                          K=in_features, N=n_rows, bits=4, block_size=GROUP))
        dropped.add(weight)
        linear += 1
        continue

    source = producers.get(node.input[1]) if node.op_type == "MatMul" and len(node.input) > 1 else None
    tied = node.op_type == "MatMul" and (
        node.input[1] == "model.embed_tokens.weight_transposed"
        or (source is not None and source.op_type == "Transpose" and source.input[0] == "model.embed_tokens.weight")
    )
    if tied:
        blob, scales, zps, n_rows, groups = packed("model.embed_tokens")
        names = ["lm_head.MatMul.weight_Q4", "lm_head.MatMul.weight_scales", "lm_head.MatMul.weight_zp"]
        new_inits += [numpy_helper.from_array(blob, names[0]), numpy_helper.from_array(scales, names[1]),
                      numpy_helper.from_array(zps, names[2])]
        new_nodes.append(helper.make_node("MatMulNBits", [node.input[0], *names], list(node.output),
                                          name=f"{node.name}_Q4", domain="com.microsoft",
                                          K=hidden, N=n_rows, bits=4, block_size=GROUP))
        head += 1
        continue

    new_nodes.append(node)

if linear != 7 * layers or head != 1:
    raise SystemExit(f"replaced {linear} linear layers (expected {7 * layers}) and {head} heads (expected 1)")

# A Transpose left with no consumer (the tied head's) goes too.
used = {inp for node in new_nodes for inp in node.input}
new_nodes = [n for n in new_nodes if not (n.op_type == "Transpose" and not any(o in used for o in n.output))]
used = {inp for node in new_nodes for inp in node.input}

kept = []
for init in graph.initializer:
    if init.name in dropped or init.name not in used:
        continue
    if init.data_location == TensorProto.EXTERNAL:
        if init.data_type != TensorProto.FLOAT16:
            raise SystemExit(f"external initializer {init.name} is not float16")
        array = tool.read_initializer(init, base)
        kept.append(numpy_helper.from_array(np.array(array, dtype=np.float16), init.name))
    else:
        kept.append(init)

del graph.node[:]
graph.node.extend(new_nodes)
del graph.initializer[:]
graph.initializer.extend(kept + new_inits)
if not any(o.domain == "com.microsoft" for o in model.opset_import):
    model.opset_import.append(helper.make_opsetid("com.microsoft", 1))

total = sum(int(np.prod(i.dims)) * (2 if i.data_type == TensorProto.FLOAT16 else 1) for i in graph.initializer)
print(f"{model_id}: {linear} linear layers and the tied head in 4 bits; weights {total / 1e9:.2f} GB")

out = dst / "onnx" / "model_q4f16.onnx"
onnx.save(model, str(out), save_as_external_data=True, all_tensors_to_one_file=True,
          location="model_q4f16.onnx_data", size_threshold=1024)
print("wrote", out)
