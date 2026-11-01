import {expect} from "chai";
import {
	capBufferLimits,
	getBufferCap,
	installBufferLimits,
	noteDeviceLoss,
	raiseBufferLimits,
	setBufferCap,
	takeDeviceLoss,
	WEBLLM_FULL_REQUEST,
} from "../../client/js/translate/engines/gpuLimits";

const MiB = 1024 * 1024;

/** What WebLLM 0.2.85's detectGPUDevice asks an adapter under 1 GiB for. */
const webllmFallback = () => ({
	requiredLimits: {
		maxBufferSize: 256 * MiB,
		maxStorageBufferBindingSize: 128 * MiB,
		maxComputeWorkgroupStorageSize: 32 * 1024,
	},
	requiredFeatures: ["shader-f16"],
});

describe("gpuLimits", () => {
	describe("raiseBufferLimits", () => {
		it("asks a phone for what it offers instead of WebGPU's floor", () => {
			const raised = raiseBufferLimits(webllmFallback(), {
				maxBufferSize: 512 * MiB,
				maxStorageBufferBindingSize: 512 * MiB,
			});
			expect(raised?.requiredLimits).to.deep.equal({
				maxBufferSize: 512 * MiB,
				maxStorageBufferBindingSize: 512 * MiB,
				maxComputeWorkgroupStorageSize: 32 * 1024,
			});
			expect(raised?.requiredFeatures).to.deep.equal(["shader-f16"]);
		});

		it("never asks for more than WebLLM's own 1 GiB, so a desktop is unchanged", () => {
			const request = {
				requiredLimits: {
					maxBufferSize: WEBLLM_FULL_REQUEST,
					maxStorageBufferBindingSize: WEBLLM_FULL_REQUEST,
				},
			};
			const offered = {maxBufferSize: 4096 * MiB, maxStorageBufferBindingSize: 2047 * MiB};
			expect(raiseBufferLimits(request, offered)).to.equal(request);
		});

		it("caps a raise at 1 GiB, and a binding at the buffer it binds", () => {
			const raised = raiseBufferLimits(webllmFallback(), {
				maxBufferSize: 768 * MiB,
				maxStorageBufferBindingSize: 2048 * MiB,
			});
			expect(raised?.requiredLimits?.maxBufferSize).to.equal(768 * MiB);
			expect(raised?.requiredLimits?.maxStorageBufferBindingSize).to.equal(768 * MiB);
		});

		it("leaves an adapter at the floor and a request without limits alone", () => {
			const request = webllmFallback();
			expect(
				raiseBufferLimits(request, {
					maxBufferSize: 256 * MiB,
					maxStorageBufferBindingSize: 128 * MiB,
				})
			).to.equal(request);
			expect(raiseBufferLimits({}, {maxBufferSize: 1})).to.deep.equal({});
			expect(raiseBufferLimits(undefined, {maxBufferSize: 1})).to.equal(undefined);
		});

		it("with a cap, lowers a desktop's 1 GiB request to it", () => {
			const raised = raiseBufferLimits(
				{
					requiredLimits: {
						maxBufferSize: WEBLLM_FULL_REQUEST,
						maxStorageBufferBindingSize: WEBLLM_FULL_REQUEST,
						maxComputeWorkgroupStorageSize: 32 * 1024,
					},
				},
				{maxBufferSize: 4096 * MiB, maxStorageBufferBindingSize: 2047 * MiB},
				128 * MiB
			);
			expect(raised?.requiredLimits).to.deep.equal({
				maxBufferSize: 128 * MiB,
				maxStorageBufferBindingSize: 128 * MiB,
				maxComputeWorkgroupStorageSize: 32 * 1024,
			});
		});

		it("with a cap, raises a small request no further than it", () => {
			const raised = raiseBufferLimits(
				webllmFallback(),
				{maxBufferSize: 1024 * MiB, maxStorageBufferBindingSize: 1024 * MiB},
				192 * MiB
			);
			// The buffer was asked 256 MiB (over the cap: lowered), the binding
			// 128 MiB (raised to the cap, not to what the adapter offers).
			expect(raised?.requiredLimits?.maxBufferSize).to.equal(192 * MiB);
			expect(raised?.requiredLimits?.maxStorageBufferBindingSize).to.equal(192 * MiB);
		});

		it("capBufferLimits only lowers, and is the request itself without a cap", () => {
			const request = webllmFallback();
			expect(capBufferLimits(request, null)).to.equal(request);
			expect(capBufferLimits(request, 512 * MiB)).to.equal(request);
			expect(capBufferLimits(request, 128 * MiB)?.requiredLimits).to.deep.include({
				maxBufferSize: 128 * MiB,
				maxStorageBufferBindingSize: 128 * MiB,
			});
		});
	});

	describe("installBufferLimits", () => {
		/** A stand-in for GPUAdapter.prototype that records every request. */
		function fakeAdapterClass(refuseAbove = Infinity) {
			const seen: unknown[] = [];

			class FakeAdapter {
				limits: Record<string, number>;

				constructor(limits: Record<string, number>) {
					this.limits = limits;
				}

				requestDevice(request?: {requiredLimits?: Record<string, number>}) {
					seen.push(request);
					const binding = request?.requiredLimits?.maxStorageBufferBindingSize ?? 0;

					return binding > refuseAbove
						? Promise.reject(new Error("OperationError"))
						: Promise.resolve({request});
				}
			}

			return {FakeAdapter, seen};
		}

		it("makes WebLLM's request go through the raise", async () => {
			const {FakeAdapter, seen} = fakeAdapterClass();
			expect(installBufferLimits(FakeAdapter.prototype)).to.equal(true);
			expect(installBufferLimits(FakeAdapter.prototype), "idempotent").to.equal(true);
			const adapter = new FakeAdapter({
				maxBufferSize: 512 * MiB,
				maxStorageBufferBindingSize: 512 * MiB,
			});
			await adapter.requestDevice(webllmFallback());
			expect(seen).to.have.length(1);
			expect(
				(seen[0] as {requiredLimits: Record<string, number>}).requiredLimits
					.maxStorageBufferBindingSize
			).to.equal(512 * MiB);
		});

		it("falls back to the original request when the raised one is refused", async () => {
			const {FakeAdapter, seen} = fakeAdapterClass(128 * MiB);
			installBufferLimits(FakeAdapter.prototype);
			const adapter = new FakeAdapter({
				maxBufferSize: 512 * MiB,
				maxStorageBufferBindingSize: 512 * MiB,
			});
			const device = (await adapter.requestDevice(webllmFallback())) as {
				request: {requiredLimits: Record<string, number>};
			};
			expect(seen).to.have.length(2);
			expect(device.request.requiredLimits.maxStorageBufferBindingSize).to.equal(128 * MiB);
		});

		it("holds every request to the cap set since, its fallback too", async () => {
			const {FakeAdapter, seen} = fakeAdapterClass(64 * MiB);
			installBufferLimits(FakeAdapter.prototype);
			const adapter = new FakeAdapter({
				maxBufferSize: 4096 * MiB,
				maxStorageBufferBindingSize: 2047 * MiB,
			});
			const desktop = () => ({
				requiredLimits: {
					maxBufferSize: WEBLLM_FULL_REQUEST,
					maxStorageBufferBindingSize: WEBLLM_FULL_REQUEST,
				},
			});

			try {
				setBufferCap(128 * MiB);
				expect(getBufferCap()).to.equal(128 * MiB);
				// The fake refuses anything above 64 MiB: the capped request is
				// refused and its fallback is the capped one again, never 1 GiB.
				await adapter.requestDevice(desktop()).catch(() => undefined);
				const asked = seen.map(
					(request) =>
						(request as {requiredLimits: Record<string, number>}).requiredLimits
							.maxStorageBufferBindingSize
				);
				expect(asked).to.deep.equal([128 * MiB]);

				setBufferCap(null);
				expect(getBufferCap()).to.equal(null);
				seen.length = 0;
				await adapter.requestDevice(desktop()).catch(() => undefined);
				expect(
					(seen[0] as {requiredLimits: Record<string, number>}).requiredLimits
						.maxStorageBufferBindingSize
				).to.equal(WEBLLM_FULL_REQUEST);
			} finally {
				setBufferCap(null);
			}
		});

		it("records why a device it handed out was lost, once", async () => {
			let lose: (info: {reason: string; message: string}) => void = () => {};

			class LosingAdapter {
				limits = {maxBufferSize: 512 * MiB, maxStorageBufferBindingSize: 512 * MiB};

				requestDevice() {
					return Promise.resolve({lost: new Promise((resolve) => (lose = resolve))});
				}
			}

			installBufferLimits(LosingAdapter.prototype);
			takeDeviceLoss();
			await new LosingAdapter().requestDevice();
			expect(takeDeviceLoss()).to.equal(null);
			lose({reason: "unknown", message: "GPU process terminated"});
			await Promise.resolve();
			await Promise.resolve();
			expect(takeDeviceLoss()).to.deep.equal({
				reason: "unknown",
				message: "GPU process terminated",
			});
			expect(takeDeviceLoss(), "taken once").to.equal(null);
		});

		it("does not count a device destroyed on purpose as lost", () => {
			takeDeviceLoss();
			noteDeviceLoss({reason: "destroyed", message: "Device was destroyed."});
			expect(takeDeviceLoss()).to.equal(null);
			noteDeviceLoss(undefined);
			expect(takeDeviceLoss()).to.deep.equal({reason: "unknown", message: ""});
		});

		it("does nothing without WebGPU", () => {
			expect(installBufferLimits(undefined)).to.equal(false);
			expect(installBufferLimits(null)).to.equal(false);
		});
	});
});
