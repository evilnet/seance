"""Compute a Qwen3 ONNX export's layer norms in float32 so ONNX Runtime CUDA stops returning NaN.

Measured 2026-09-13 (ORT 1.22 CUDA, RTX 4060): the stock q4f16 and the
web-equivalent fp16 exports give all-NaN logits on CUDA; the CUDA provider's
`enable_skip_layer_norm_strict_mode` fixes both (argmax equal to the CPU's,
max |diff| 0.12 / 0.07). onnxruntime-node cannot pass that provider option
(its binding reads only `deviceId`), so the model carries the fix instead:
every (Skip)SimplifiedLayerNormalization node gets float32 inputs (Casts in),
float32 scale, and Casts back to float16 on the outputs it had.

    tmp/venv-quant/bin/python tools/translate-eval/norm-fp32.py <src dir> <dst dir> [file name]

<src dir>/onnx/<file> (default model_fp16.onnx) -> <dst dir>/onnx/<same name>;
the other files of <src dir> are copied alongside.
"""

import collections
import shutil
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
name = sys.argv[3] if len(sys.argv) > 3 else "model_fp16.onnx"
(dst / "onnx").mkdir(parents=True, exist_ok=True)

for item in src.iterdir():
    if item.name != "onnx":
        if item.is_dir():
            shutil.copytree(item, dst / item.name, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dst / item.name)

model = onnx.load(str(src / "onnx" / name), load_external_data=True)
graph = model.graph

counts = collections.Counter(n.op_type for n in graph.node)
print("op counts:", dict(sorted(counts.items(), key=lambda kv: -kv[1])[:25]))

NORMS = {"SkipSimplifiedLayerNormalization", "SimplifiedLayerNormalization"}
F16, F32 = TensorProto.FLOAT16, TensorProto.FLOAT

inits = {i.name: i for i in graph.initializer}
new_inits = {}
new_nodes = []
wrapped = 0

for node in graph.node:
    if node.op_type not in NORMS:
        new_nodes.append(node)
        continue

    wrapped += 1
    inputs32 = []
    for inp in node.input:
        if not inp:
            inputs32.append(inp)
            continue
        if inp in inits and inits[inp].data_type == F16:
            key = f"{inp}__fp32"
            if key not in new_inits:
                arr = numpy_helper.to_array(inits[inp]).astype(np.float32)
                new_inits[key] = numpy_helper.from_array(arr, key)
            inputs32.append(key)
        else:
            cast_out = f"{node.name}__{inp}__to32".replace("/", "_")
            new_nodes.append(helper.make_node("Cast", [inp], [cast_out], to=F32, name=cast_out))
            inputs32.append(cast_out)

    outputs32 = []
    back_casts = []
    for out in node.output:
        if not out:
            outputs32.append(out)
            continue
        out32 = f"{out}__fp32"
        outputs32.append(out32)
        back_casts.append(helper.make_node("Cast", [out32], [out], to=F16, name=f"{out}__to16".replace("/", "_")))

    norm = helper.make_node(node.op_type, inputs32, outputs32, name=node.name, domain=node.domain)
    norm.attribute.extend(node.attribute)
    new_nodes.append(norm)
    new_nodes.extend(back_casts)

del graph.node[:]
graph.node.extend(new_nodes)
graph.initializer.extend(new_inits.values())

# Output types of the norms changed internally; stale value_info would contradict them.
kept = [v for v in graph.value_info if not v.name.endswith("__fp32")]
del graph.value_info[:]
graph.value_info.extend(kept)

print(f"wrapped {wrapped} norm nodes, {len(new_inits)} scales in float32")

out = dst / "onnx" / name
onnx.save(model, str(out), save_as_external_data=True, all_tensors_to_one_file=True,
          location=f"{name}_data", size_threshold=1024)
print("wrote", out)
