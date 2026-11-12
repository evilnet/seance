import {expect} from "chai";
import {effectScope, nextTick, ref, watch} from "vue";
import {runDetached} from "../../client/js/helpers/detachedScope";

describe("helpers/detachedScope", () => {
	it("keeps a watch made inside a component's scope after that scope stops", async () => {
		const setting = ref(true);
		const seen: boolean[] = [];
		// The component whose computed happened to make the service first.
		const component = effectScope();
		let made: ReturnType<typeof runDetached<number>> | undefined;

		component.run(() => {
			made = runDetached(() => {
				watch(setting, (v) => seen.push(v));
				return 1;
			});
		});
		// The chat view unmounts (Settings opened).
		component.stop();

		setting.value = false;
		await nextTick();
		expect(seen).to.deep.equal([false]);
		expect(made?.value).to.equal(1);

		made?.stop();
		setting.value = true;
		await nextTick();
		expect(seen).to.deep.equal([false]);
	});

	it("a watch made without it stops with the caller's scope (what it guards against)", async () => {
		const setting = ref(true);
		const seen: boolean[] = [];
		const component = effectScope();

		component.run(() => watch(setting, (v) => seen.push(v)));
		component.stop();
		setting.value = false;
		await nextTick();
		expect(seen).to.deep.equal([]);
	});

	it("passes a throw from make through and leaves nothing running", () => {
		expect(() =>
			runDetached(() => {
				throw new Error("boom");
			})
		).to.throw("boom");
	});
});
