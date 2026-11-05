import {expect} from "chai";
import {emptyContext, type TranslateRequest} from "../../client/js/translate/engine";
import {OnDevice} from "../../client/js/translate/engines/onDevice";
import {buildCatalog} from "../../client/js/translate/models";
import {FakeEngine} from "./fakeEngine";

const catalog = buildCatalog();
const ref = catalog.nllb;

function req(device?: "gpu" | "cpu"): TranslateRequest {
	return {
		id: 1,
		device,
		model: ref.id,
		text: "hello",
		from: "en",
		to: "de",
		purpose: "read",
		context: emptyContext(),
	};
}

function make() {
	const gpu = new FakeEngine("seq2seq", (r) => [`gpu:${r.text}`]);
	const cpu = new FakeEngine("seq2seq", (r) => [`cpu:${r.text}`]);

	return {gpu, cpu, engine: new OnDevice("seq2seq", {gpu, cpu})};
}

async function drain(it: AsyncIterable<{text: string}>): Promise<string> {
	let last = "";

	for await (const chunk of it) {
		last = chunk.text;
	}

	return last;
}

describe("OnDevice", () => {
	it("loading on the GPU after the CPU unloads the CPU engine first", async () => {
		const {gpu, cpu, engine} = make();
		const order: string[] = [];
		const unloadCpu = cpu.unload.bind(cpu);

		cpu.unload = () => {
			order.push("cpu unload");
			return unloadCpu();
		};

		await engine.load(ref, "cpu", () => {});
		expect(engine.isLoaded(ref.id, "cpu")).to.equal(true);

		const loadGpu = gpu.load.bind(gpu);

		gpu.load = (r, d, p) => {
			order.push("gpu load");
			return loadGpu(r, d, p);
		};

		await engine.load(ref, "gpu", () => {});
		expect(order).to.deep.equal(["cpu unload", "gpu load"]);
		expect(cpu.loadedModels()).to.deep.equal([]);
		expect(engine.isLoaded(ref.id, "gpu")).to.equal(true);
		expect(engine.isLoaded(ref.id, "cpu")).to.equal(false);
		expect(engine.loadedModels()).to.deep.equal([ref.id]);
	});

	it("a request goes to its device's engine; without one, to the loaded device", async () => {
		const {engine} = make();

		await engine.load(ref, "cpu", () => {});
		expect(await drain(engine.translate(req("cpu"), new AbortController().signal))).to.equal(
			"cpu:hello"
		);
		expect(await drain(engine.translate(req(), new AbortController().signal))).to.equal(
			"cpu:hello"
		);

		await engine.load(ref, "gpu", () => {});
		expect(await drain(engine.translate(req(), new AbortController().signal))).to.equal(
			"gpu:hello"
		);
	});

	it("status and capabilities are the active engine's", async () => {
		const {engine} = make();

		expect(engine.status()).to.equal("cold");
		await engine.load(ref, "gpu", () => {});
		expect(engine.status()).to.equal("ready");
		expect(engine.capabilities()).to.deep.equal({streams: false, batches: false});
	});

	it("a device switch lets the running request finish", async () => {
		const {cpu, engine} = make();
		const events: string[] = [];

		let release: () => void = () => {};

		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = cpu.translate.bind(cpu);

		cpu.translate = async function* (r, s) {
			await gate;
			yield* original(r, s);
			events.push("cpu finished");
		};

		const unloadCpu = cpu.unload.bind(cpu);

		cpu.unload = () => {
			events.push("cpu unload");
			return unloadCpu();
		};

		await engine.load(ref, "cpu", () => {});

		const running = drain(engine.translate(req("cpu"), new AbortController().signal));
		const switching = engine.load(ref, "gpu", () => {});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(events).to.deep.equal([]);
		release();
		expect(await running).to.equal("cpu:hello");
		await switching;
		expect(events).to.deep.equal(["cpu finished", "cpu unload"]);
	});

	it("a load on one device waits for the other device's load in flight, then unloads it", async () => {
		// A language model's reload is listed only once it finishes: a CPU
		// pin while the GPU copy still loads must not leave both resident.
		const {gpu, cpu, engine} = make();
		const events: string[] = [];

		let release: () => void = () => {};

		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loadGpu = gpu.load.bind(gpu);

		gpu.load = async (r, d, p) => {
			events.push("gpu load");
			await gate;
			await loadGpu(r, d, p);
			events.push("gpu loaded");
		};

		const unloadGpu = gpu.unload.bind(gpu);

		gpu.unload = () => {
			events.push("gpu unload");
			return unloadGpu();
		};

		const loadCpu = cpu.load.bind(cpu);

		cpu.load = (r, d, p) => {
			events.push("cpu load");
			return loadCpu(r, d, p);
		};

		const onGpu = engine.load(ref, "gpu", () => {});
		const onCpu = engine.load(ref, "cpu", () => {});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(events).to.deep.equal(["gpu load"]);
		release();
		await onGpu;
		await onCpu;
		expect(events).to.deep.equal(["gpu load", "gpu loaded", "gpu unload", "cpu load"]);
		expect(engine.loadedModels()).to.deep.equal([ref.id]);
		expect(engine.isLoaded(ref.id, "cpu")).to.equal(true);
		expect(engine.isLoaded(ref.id, "gpu")).to.equal(false);
	});

	it("a failed load on the other device does not stop this one", async () => {
		const {gpu, engine} = make();
		const failure = new Error("GPU_LOST");

		gpu.load = () => Promise.reject(failure);

		const onGpu = engine.load(ref, "gpu", () => {});
		const onCpu = engine.load(ref, "cpu", () => {});

		let caught: unknown = null;

		await onGpu.catch((e: unknown) => (caught = e));
		await onCpu;
		expect(caught).to.equal(failure);
		expect(engine.isLoaded(ref.id, "cpu")).to.equal(true);
	});
});
