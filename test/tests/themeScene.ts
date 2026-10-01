import {expect} from "chai";
import {
	createSceneHost,
	SCENES,
	type SceneHandle,
	type SceneHostState,
	type SceneLoader,
	type SceneModule,
} from "../../client/js/themeScene";

const ROOT = {} as HTMLElement;

/** A scene module that records what happened to it. */
function fakeScene() {
	const log: string[] = [];
	const mod: SceneModule = {
		mount(root, state): SceneHandle {
			log.push(`mount ${root === ROOT} ${state.visible} ${state.view}`);
			return {
				update: (s: SceneHostState) => log.push(`update ${s.visible} ${s.view}`),
				destroy: () => log.push("destroy"),
			};
		},
	};
	return {log, mod};
}

/** A loader that resolves only when told to. */
function deferred(mod: SceneModule) {
	let release: () => void = () => undefined;
	const loader: SceneLoader = () => new Promise((resolve) => (release = () => resolve(mod)));
	return {loader, release: () => release()};
}

/** A loader that rejects on its first call, then resolves on every call after. */
function rejectOnceThenResolve(mod: SceneModule): SceneLoader {
	let calls = 0;

	return () => {
		calls += 1;
		return calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(mod);
	};
}

/** A loader that rejects on its first `failures` calls, then resolves. Exposes how many times it was called. */
function rejectNTimesThenResolve(mod: SceneModule, failures: number) {
	let calls = 0;

	const loader: SceneLoader = () => {
		calls += 1;
		return calls <= failures ? Promise.reject(new Error("offline")) : Promise.resolve(mod);
	};

	return {loader, calls: () => calls};
}

/** A loader that rejects on its first call, then hangs until told to resolve. Exposes how many times it was called. */
function rejectOnceThenHang(mod: SceneModule) {
	let calls = 0;
	let release: () => void = () => undefined;

	const loader: SceneLoader = () => {
		calls += 1;

		if (calls === 1) {
			return Promise.reject(new Error("offline"));
		}

		return new Promise((resolve) => (release = () => resolve(mod)));
	};

	return {loader, release: () => release(), calls: () => calls};
}

const host = (loaders: Record<string, SceneLoader>, warn?: (m: string, e: unknown) => void) =>
	createSceneHost({root: () => ROOT, loaders, state: {visible: true, view: "channel"}, warn});

describe("the theme-scene hook (client/js/themeScene.ts)", function () {
	it("has a scene for ps and for no other theme", function () {
		expect(Object.keys(SCENES)).to.deep.equal(["ps"]);
	});

	it("mounts the applied theme's scene with the current state", async function () {
		const {log, mod} = fakeScene();
		const h = host({ps: () => Promise.resolve(mod)});
		await h.setTheme("ps");
		expect(h.mounted).to.equal("ps");
		expect(log).to.deep.equal(["mount true true channel"]);
	});

	it("mounts nothing for a theme without a scene, and takes the previous one down", async function () {
		const {log, mod} = fakeScene();
		const h = host({ps: () => Promise.resolve(mod)});
		await h.setTheme("ps");
		await h.setTheme("coffee");
		expect(h.mounted).to.equal(null);
		expect(log).to.deep.equal(["mount true true channel", "destroy"]);
	});

	it("never mounts a scene whose theme was switched away while it loaded", async function () {
		const {log, mod} = fakeScene();
		const d = deferred(mod);
		const h = host({ps: d.loader});
		const loading = h.setTheme("ps");
		await h.setTheme("coffee");
		d.release();
		await loading;
		expect(h.mounted).to.equal(null);
		expect(log).to.deep.equal([]);
	});

	it("mounts exactly once when a theme is re-applied, or left and re-applied quickly", async function () {
		const {log, mod} = fakeScene();
		const h = host({ps: () => Promise.resolve(mod)});
		const first = h.setTheme("ps");
		await h.setTheme("ps");
		await first;
		expect(log).to.deep.equal(["mount true true channel"]);
		const away = h.setTheme("coffee");
		const back = h.setTheme("ps");
		await Promise.all([away, back]);
		expect(log.filter((l) => l.startsWith("mount"))).to.have.length(2);
		expect(log.filter((l) => l === "destroy")).to.have.length(1);
		expect(h.mounted).to.equal("ps");
	});

	it("leaves nothing mounted and warns once when a scene fails to load", async function () {
		const warnings: string[] = [];
		const h = host({ps: () => Promise.reject(new Error("offline"))}, (m) => warnings.push(m));
		await h.setTheme("ps");
		expect(h.mounted).to.equal(null);
		expect(warnings).to.have.length(1);
	});

	it('treats a theme name that collides with an inherited key ("toString") as having no scene: mounts nothing, warns nothing, and does not throw', async function () {
		const warnings: string[] = [];
		const h = host({ps: () => Promise.resolve(fakeScene().mod)}, (m) => warnings.push(m));
		await h.setTheme("toString");
		expect(h.mounted).to.equal(null);
		expect(warnings).to.have.length(0);
	});

	it("leaves nothing mounted, warns once and empties the root when a scene's mount throws synchronously", async function () {
		const warnings: string[] = [];
		let replaceCalls = 0;
		const throwing: SceneModule = {
			mount(): SceneHandle {
				throw new Error("boom");
			},
		};
		const fakeRoot = {
			replaceChildren() {
				replaceCalls += 1;
			},
		} as unknown as HTMLElement;
		const h = createSceneHost({
			root: () => fakeRoot,
			loaders: {ps: () => Promise.resolve(throwing)},
			state: {visible: true, view: "channel"},
			warn: (m) => warnings.push(m),
		});
		await h.setTheme("ps");
		expect(h.mounted).to.equal(null);
		expect(warnings).to.have.length(1);
		expect(replaceCalls).to.equal(1);
	});

	it("forwards visibility and view to the mounted scene, only when they change", async function () {
		const {log, mod} = fakeScene();
		const h = host({ps: () => Promise.resolve(mod)});
		h.setView("query");
		await h.setTheme("ps");
		h.setVisible(false);
		h.setVisible(false);
		h.setView("query");
		h.setView("channel");
		expect(log).to.deep.equal([
			"mount true true query",
			"update false query",
			"update false channel",
		]);
	});

	describe("retrying a failed scene", function () {
		it("mounts the scene when retry() is called after a failed load", async function () {
			const {log, mod} = fakeScene();
			const warnings: string[] = [];
			const h = host({ps: rejectOnceThenResolve(mod)}, (m) => warnings.push(m));
			await h.setTheme("ps");
			expect(h.mounted).to.equal(null);
			expect(warnings).to.have.length(1);

			await h.retry();

			expect(h.mounted).to.equal("ps");
			expect(log).to.deep.equal(["mount true true channel"]);
			expect(warnings).to.have.length(1);
		});

		it("mounts a failed scene once the page becomes visible again", async function () {
			const {log, mod} = fakeScene();
			const warnings: string[] = [];
			const h = createSceneHost({
				root: () => ROOT,
				loaders: {ps: rejectOnceThenResolve(mod)},
				state: {visible: false, view: "channel"},
				warn: (m) => warnings.push(m),
			});
			await h.setTheme("ps");
			expect(h.mounted).to.equal(null);
			expect(warnings).to.have.length(1);

			h.setVisible(true);
			await new Promise((resolve) => setImmediate(resolve));

			expect(h.mounted).to.equal("ps");
			expect(log).to.deep.equal(["mount true true channel"]);
			expect(warnings).to.have.length(1);
		});

		it("cancels a pending retry when the theme is switched before it resolves", async function () {
			const {log, mod} = fakeScene();
			const warnings: string[] = [];
			const {loader, release, calls} = rejectOnceThenHang(mod);
			const h = host({ps: loader}, (m) => warnings.push(m));
			await h.setTheme("ps");
			expect(h.mounted).to.equal(null);
			expect(warnings).to.have.length(1);

			const retrying = h.retry();
			// The retry's own load has actually started (not a no-op retry that
			// would also leave `mounted` null and the log empty).
			expect(calls()).to.equal(2);

			await h.setTheme("coffee");
			release();
			await retrying;

			expect(h.mounted).to.equal(null);
			expect(log).to.deep.equal([]);
			expect(warnings).to.have.length(1);
		});

		it("warns once even when a retry fails again, and mounts once it stops failing", async function () {
			const {log, mod} = fakeScene();
			const warnings: string[] = [];
			const {loader} = rejectNTimesThenResolve(mod, 2);
			const h = host({ps: loader}, (m) => warnings.push(m));
			await h.setTheme("ps");
			expect(h.mounted).to.equal(null);
			expect(warnings).to.have.length(1);

			await h.retry();
			expect(h.mounted).to.equal(null);
			expect(warnings).to.have.length(1);

			await h.retry();
			expect(h.mounted).to.equal("ps");
			expect(log).to.deep.equal(["mount true true channel"]);
			expect(warnings).to.have.length(1);
		});

		it("does nothing when retried for a theme that is no longer asked", async function () {
			const {log, mod} = fakeScene();
			const warnings: string[] = [];
			const h = host({ps: rejectOnceThenResolve(mod)}, (m) => warnings.push(m));
			await h.setTheme("ps");
			expect(h.mounted).to.equal(null);
			expect(warnings).to.have.length(1);

			await h.setTheme("coffee");
			await h.retry();

			expect(h.mounted).to.equal(null);
			expect(log).to.deep.equal([]);
			expect(warnings).to.have.length(1);
		});

		it("does nothing when nothing has failed", async function () {
			const {log, mod} = fakeScene();
			const h = host({ps: () => Promise.resolve(mod)});
			await h.retry();
			expect(h.mounted).to.equal(null);
			expect(log).to.deep.equal([]);
		});
	});
});
