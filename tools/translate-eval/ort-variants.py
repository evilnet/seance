"""One forward step of a Qwen3 ONNX export on CUDA under several session settings.

ORT 1.22 CUDA returns all-NaN logits for Qwen3 exports (stock q4f16 and the
web-equivalent fp16) while the CPU provider is fine. Each variant here changes
one thing: graph optimization level, or the CUDA provider's strict layer-norm
mode (fp16 SkipSimplifiedLayerNormalization is a known overflow source).

    LD_LIBRARY_PATH=/usr/local/cuda-12.6/lib64 \
      tmp/venv-quant/bin/python tools/translate-eval/ort-variants.py <model.onnx>
"""

import sys

import numpy as np
import onnxruntime as ort

path = sys.argv[1]
ids = [9707, 11, 1246, 525, 498, 30]


def feeds(sess):
    out = {}
    seq = len(ids)
    for i in sess.get_inputs():
        name, shape, typ = i.name, i.shape, i.type
        if name == "input_ids":
            out[name] = np.array([ids], dtype=np.int64)
        elif name == "attention_mask":
            out[name] = np.ones((1, seq), dtype=np.int64)
        elif name == "position_ids":
            out[name] = np.arange(seq, dtype=np.int64)[None, :]
        elif name.startswith("past_key_values"):
            dims = [d if isinstance(d, int) else 0 for d in shape]
            dims[0] = 1
            out[name] = np.zeros(dims, dtype=np.float16 if "float16" in typ else np.float32)
        else:
            raise SystemExit(f"unhandled input {name}")
    return out


LEVELS = {
    "all": ort.GraphOptimizationLevel.ORT_ENABLE_ALL,
    "basic": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC,
    "none": ort.GraphOptimizationLevel.ORT_DISABLE_ALL,
}

VARIANTS = [
    ("cuda, all opts", "all", {}),
    ("cuda, basic opts", "basic", {}),
    ("cuda, no opts", "none", {}),
    ("cuda, all opts, strict layer norm", "all", {"enable_skip_layer_norm_strict_mode": "1"}),
    ("cuda, all opts, no TunableOp, heuristic conv", "all", {"tunable_op_enable": "0", "cudnn_conv_algo_search": "HEURISTIC"}),
]

cpu_opts = ort.SessionOptions()
cpu_opts.intra_op_num_threads = 4
cpu = ort.InferenceSession(path, cpu_opts, providers=["CPUExecutionProvider"])
reference = cpu.run(["logits"], feeds(cpu))[0][0, -1].astype(np.float32)
print(f"cpu reference: argmax={int(reference.argmax())} max={reference.max():.3f}")
del cpu

for label, level, provider_options in VARIANTS:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    opts.graph_optimization_level = LEVELS[level]
    try:
        sess = ort.InferenceSession(
            path, opts, providers=[("CUDAExecutionProvider", provider_options), "CPUExecutionProvider"]
        )
        logits = sess.run(["logits"], feeds(sess))[0][0, -1].astype(np.float32)
        nan = int(np.isnan(logits).sum())
        if nan == logits.size:
            print(f"{label}: all NaN")
        else:
            diff = float(np.nanmax(np.abs(logits - reference)))
            print(f"{label}: nan={nan} argmax={int(np.nanargmax(logits))} max abs diff vs cpu={diff:.4f}")
        del sess
    except Exception as error:  # noqa: BLE001 -- report and go on to the next variant
        print(f"{label}: failed: {str(error)[:160]}")
