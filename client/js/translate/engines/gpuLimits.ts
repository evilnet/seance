// WebLLM asks the GPU for its buffers in two sizes only: 1 GiB, or, when the
// adapter cannot give that, WebGPU's 128 MiB floor for a storage binding
// (256 MiB for a buffer) — nothing in between (@mlc-ai/web-llm 0.2.85,
// `detectGPUDevice`). Most phones offer something in between, and a model
// binds each weight tensor whole: Qwen3 1.7B's embedding is one 148 MiB
// tensor, so on a phone that offers 512 MiB WebLLM asked for 128 MiB and the
// model could not load. This raises what WebLLM's `requestDevice` asks for to
// what the adapter offers, never above the 1 GiB WebLLM itself would ask a
// larger adapter for, so a desktop's device is unchanged. The worker installs
// it before WebLLM runs (webllm.real.ts); Vue-free and DOM-free, so mocha
// tests it with a stand-in prototype.
//
// It also holds a request to a cap (`setBufferCap`): the test switch
// (translate/gpuTestLimit.ts) that makes a desktop GPU bind no more than a
// phone's, so the small-buffer build can be tried there. A cap lowers what
// WebLLM asks for, never raises it; WebGPU gives at least its defaults
// (256 MiB buffers, 128 MiB bindings) whatever is asked, so a cap below
// those binds 128 MiB.

/** What WebLLM asks for from an adapter that can give it. */
export const WEBLLM_FULL_REQUEST = 1024 * 1024 * 1024;

type Limits = Record<string, number | undefined>;

export interface DeviceRequest {
	requiredLimits?: Limits;
	[key: string]: unknown;
}

const RAISED = ["maxBufferSize", "maxStorageBufferBindingSize"] as const;

/** The cap the worker was configured with (`setBufferCap`); null: none. */
let bufferCap: number | null = null;

/**
 * Hold every device request from now on to `bytes` per buffer and binding
 * (null lifts it). The worker sets it from its `configure` message; the
 * page reads the switch, since a worker has no localStorage.
 */
export function setBufferCap(bytes: number | null | undefined): void {
	bufferCap = typeof bytes === "number" && bytes > 0 ? bytes : null;
}

export function getBufferCap(): number | null {
	return bufferCap;
}

/**
 * `request` with its buffer limits raised to what `adapterLimits` offers (at
 * most 1 GiB), or `request` itself when nothing would change. A binding is
 * never asked larger than the buffer it binds. With a `cap`, no limit is
 * asked above it: raised to it at most, and lowered to it when WebLLM asked
 * for more (its 1 GiB on a desktop).
 */
export function raiseBufferLimits(
	request: DeviceRequest | undefined,
	adapterLimits: Limits,
	cap: number | null = null
): DeviceRequest | undefined {
	const asked = request?.requiredLimits;

	if (!request || !asked) {
		return request;
	}

	const limits: Limits = {...asked};
	let changed = false;

	for (const name of RAISED) {
		const wanted = asked[name];
		const offered = adapterLimits[name];

		if (typeof wanted !== "number") {
			continue;
		}

		const ceiling = cap ?? Infinity;

		if (wanted > ceiling) {
			limits[name] = ceiling;
			changed = true;
			continue;
		}

		if (typeof offered !== "number") {
			continue;
		}

		const target = Math.min(offered, WEBLLM_FULL_REQUEST, ceiling);

		if (target > wanted) {
			limits[name] = target;
			changed = true;
		}
	}

	if (!changed) {
		return request;
	}

	const buffer = limits.maxBufferSize;
	const binding = limits.maxStorageBufferBindingSize;

	if (typeof buffer === "number" && typeof binding === "number" && binding > buffer) {
		limits.maxStorageBufferBindingSize = buffer;
	}

	return {...request, requiredLimits: limits};
}

interface AdapterPrototype {
	// A property, not a method: it is taken off the prototype unbound and
	// called with each adapter as `this`.
	requestDevice: (this: {limits: Limits}, request?: DeviceRequest) => Promise<unknown>;
}

/**
 * Why the GPU went away. A generation on a lost device fails with whatever
 * WebGPU call it was in ("Failed to execute 'mapAsync' on 'GPUBuffer':
 * Buffer was unmapped before mapping was resolved", on the user's iPhone),
 * which says nothing of why; the device's `lost` promise does (WebKit: a
 * Metal command buffer that failed, memory, work from the background). A
 * device destroyed on purpose is no loss.
 */
export interface DeviceLoss {
	reason: string;
	message: string;
}

let lastLoss: DeviceLoss | null = null;

/** Records a lost device's reason (the shim's watch, and tests). */
export function noteDeviceLoss(
	info: {reason?: unknown; message?: unknown} | null | undefined
): void {
	const reason = String(info?.reason ?? "unknown");

	if (reason === "destroyed") {
		return;
	}

	lastLoss = {reason, message: String(info?.message ?? "").trim()};
}

/** The last loss recorded, once: the next failure does not inherit it. */
export function takeDeviceLoss(): DeviceLoss | null {
	const loss = lastLoss;

	lastLoss = null;
	return loss;
}

function watchDeviceLoss(device: unknown): void {
	const lost = (device as {lost?: Promise<{reason?: unknown; message?: unknown}>} | null)?.lost;

	if (lost && typeof lost.then === "function") {
		lost.then(noteDeviceLoss, () => {});
	}
}

const INSTALLED = Symbol.for("seance.gpuLimits");

/** Two requests that ask the same buffer limits: a cap that only lowered leaves nothing to fall back to. */
function sameBufferLimits(a: DeviceRequest | undefined, b: DeviceRequest | undefined): boolean {
	return RAISED.every((name) => a?.requiredLimits?.[name] === b?.requiredLimits?.[name]);
}

/**
 * `request` held to `cap` and nothing else: what a refused raise falls back
 * to, so the fallback never asks above the cap either.
 */
export function capBufferLimits(
	request: DeviceRequest | undefined,
	cap: number | null
): DeviceRequest | undefined {
	return cap === null ? request : raiseBufferLimits(request, {}, cap);
}

/**
 * Wraps `proto.requestDevice` (the worker's `GPUAdapter.prototype`) so a
 * request below what the adapter offers is raised, and every request is
 * held to the cap (`setBufferCap`) when one is set; should the raised
 * request be refused, the original one is made — capped — so a device that
 * worked before still does. Idempotent. Returns whether it installed (false
 * without WebGPU).
 */
export function installBufferLimits(proto: AdapterPrototype | undefined | null): boolean {
	if (!proto || typeof proto.requestDevice !== "function") {
		return false;
	}

	const marked = proto as AdapterPrototype & {[INSTALLED]?: true};

	if (marked[INSTALLED]) {
		return true;
	}

	const original = proto.requestDevice;

	proto.requestDevice = async function (this: {limits: Limits}, request?: DeviceRequest) {
		const cap = bufferCap;
		const raised = raiseBufferLimits(request, this.limits, cap);
		const fallback = capBufferLimits(request, cap);
		let device: unknown;

		if (raised === fallback || sameBufferLimits(raised, fallback)) {
			device = await original.call(this, fallback);
		} else {
			try {
				device = await original.call(this, raised);
			} catch {
				device = await original.call(this, fallback);
			}
		}

		watchDeviceLoss(device);
		return device;
	};

	marked[INSTALLED] = true;

	return true;
}
