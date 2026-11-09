import {expect} from "chai";
import sinon from "sinon";
import {
	TranslationSwitch,
	considersLine,
	readsHere,
	translationAllowed,
	translationOffBlock,
} from "../../client/js/translate/switch";
import {
	getChannelTranslation,
	setChannelTranslation,
	useStorageBackend,
} from "../../client/js/translate/channelStore";

function memoryBackend() {
	const data = new Map<string, string>();

	return {
		data,
		get: (key: string) => data.get(key) ?? null,
		set: (key: string, value: string) => void data.set(key, value),
		remove: (key: string) => void data.delete(key),
	};
}

/** A switch over a predicate the test moves, with every create, destroy and change logged in order. */
function harness(initial: boolean) {
	let on = initial;
	const made: {id: number; destroyed: boolean}[] = [];
	const log: string[] = [];
	const sw = new TranslationSwitch({
		on: () => on,
		create() {
			const service = {id: made.length + 1, destroyed: false};

			made.push(service);
			log.push(`create ${service.id}`);

			return service;
		},
		destroy(service) {
			service.destroyed = true;
			log.push(`destroy ${service.id}`);
		},
	});

	sw.onChange((value) => log.push(value ? "on" : "off"));

	return {
		sw,
		made,
		log,
		set(value: boolean) {
			on = value;
		},
	};
}

describe("translate/switch", () => {
	describe("translationAllowed", () => {
		it("is on only where the deploy allows it and the user switched it on", () => {
			// The deploy's `translation.enabled` defaults to true (branding.ts);
			// the user's `translationEnabled` defaults to false (settings.ts).
			expect(translationAllowed(undefined, true)).to.equal(true);
			expect(translationAllowed({}, true)).to.equal(true);
			expect(translationAllowed({enabled: true}, true)).to.equal(true);

			expect(translationAllowed({enabled: false}, true)).to.equal(false);
			expect(translationAllowed({enabled: true}, false)).to.equal(false);
			expect(translationAllowed(undefined, false)).to.equal(false);
			expect(translationAllowed({enabled: false}, false)).to.equal(false);
		});

		it("reads a setting that was never stored, or is not a boolean, as off", () => {
			expect(translationAllowed(undefined, undefined)).to.equal(false);
			expect(translationAllowed(undefined, null)).to.equal(false);
			expect(translationAllowed(undefined, "true")).to.equal(false);
			expect(translationAllowed(undefined, 1)).to.equal(false);
		});
	});

	describe("translationOffBlock", () => {
		it("is null while translation is on", () => {
			expect(translationOffBlock(undefined, true)).to.equal(null);
			expect(translationOffBlock({enabled: true}, true)).to.equal(null);
		});

		it("says the user switched it off where the deploy allows it", () => {
			expect(translationOffBlock(undefined, false)).to.deep.equal({
				kind: "disabled",
				by: "user",
			});
			expect(translationOffBlock({}, undefined)).to.deep.equal({
				kind: "disabled",
				by: "user",
			});
		});

		it("says the deploy switched it off whatever the setting says", () => {
			// The deploy's reason is models.ts modelBlock's own `disabled`, by nobody named.
			expect(translationOffBlock({enabled: false}, true)).to.deep.equal({kind: "disabled"});
			expect(translationOffBlock({enabled: false}, false)).to.deep.equal({kind: "disabled"});
		});

		it("agrees with translationAllowed everywhere", () => {
			for (const deploy of [undefined, {}, {enabled: true}, {enabled: false}]) {
				for (const setting of [true, false, undefined, "true"]) {
					expect(translationOffBlock(deploy, setting) === null).to.equal(
						translationAllowed(deploy, setting)
					);
				}
			}
		});
	});

	describe("considersLine", () => {
		it("considers nothing while translation is off, a forced line included", () => {
			expect(considersLine(false, true, false)).to.equal(false);
			expect(considersLine(false, true, true)).to.equal(false);
			expect(considersLine(false, false, true)).to.equal(false);
		});

		it("while on, a line of a reading channel, or one someone asked for", () => {
			expect(considersLine(true, true, false)).to.equal(true);
			expect(considersLine(true, false, true)).to.equal(true);
			expect(considersLine(true, false, false)).to.equal(false);
		});
	});

	describe("TranslationSwitch", () => {
		it("creates nothing while off, however often it is asked", () => {
			const h = harness(false);

			expect(h.sw.service()).to.equal(null);
			expect(h.sw.service()).to.equal(null);
			expect(h.sw.current()).to.equal(null);
			expect(h.sw.on).to.equal(false);
			expect(h.made).to.have.length(0);
			expect(h.log).to.deep.equal([]);
		});

		it("creates the service once, on the first ask while on", () => {
			const h = harness(true);

			expect(h.made).to.have.length(0);

			const first = h.sw.service();

			expect(first).to.not.equal(null);
			expect(h.sw.service()).to.equal(first);
			expect(h.made).to.have.length(1);
		});

		it("current() never creates one", () => {
			const h = harness(true);

			expect(h.sw.current()).to.equal(null);
			expect(h.made).to.have.length(0);

			const made = h.sw.service();

			expect(h.sw.current()).to.equal(made);
		});

		it("off tells the listeners first, with the service already out of reach, then destroys it", () => {
			const h = harness(true);
			const service = h.sw.service()!;
			const seenDuringStop: unknown[] = [];

			h.sw.onChange(() => {
				seenDuringStop.push(h.sw.service(), h.sw.current());
			});
			h.set(false);
			h.sw.sync();

			expect(h.log).to.deep.equal(["create 1", "off", "destroy 1"]);
			expect(service.destroyed).to.equal(true);
			// A listener that stops the queues may ask again (a dropped line's
			// update does): nothing is handed out, and nothing new is made.
			expect(seenDuringStop).to.deep.equal([null, null]);
			expect(h.sw.service()).to.equal(null);
			expect(h.made).to.have.length(1);
		});

		it("notices the change on the next ask, without a sync", () => {
			const h = harness(true);

			h.sw.service();
			h.set(false);

			expect(h.sw.service()).to.equal(null);
			expect(h.log).to.deep.equal(["create 1", "off", "destroy 1"]);

			h.set(true);

			expect(h.sw.on).to.equal(true);
			expect(h.log).to.deep.equal(["create 1", "off", "destroy 1", "on"]);
		});

		it("on again tells the listeners, and the next ask makes a fresh service", () => {
			const h = harness(true);
			const first = h.sw.service();

			h.set(false);
			h.sw.sync();
			h.set(true);
			h.sw.sync();

			expect(h.log).to.deep.equal(["create 1", "off", "destroy 1", "on"]);
			// Switching on makes nothing by itself: the first thing that
			// needs the service does.
			expect(h.made).to.have.length(1);

			const second = h.sw.service();

			expect(second).to.not.equal(first);
			expect(h.made).to.have.length(2);
		});

		it("an off with no service made tells the listeners and destroys nothing", () => {
			const h = harness(true);

			h.set(false);
			h.sw.sync();

			expect(h.log).to.deep.equal(["off"]);
		});

		it("a sync that finds nothing changed fires nothing", () => {
			const h = harness(true);

			h.sw.service();
			h.sw.sync();
			h.sw.sync();
			h.set(false);
			h.set(true);
			h.sw.sync();

			expect(h.log).to.deep.equal(["create 1"]);
		});

		it("a listener that throws stops neither the others nor the destroy", () => {
			const h = harness(true);
			const boom = new Error("a listener broke");
			const logged = sinon.stub(console, "error");

			try {
				h.sw.service();
				h.sw.onChange(() => {
					throw boom;
				});
				h.sw.onChange((value) => h.log.push(`after ${value ? "on" : "off"}`));
				h.set(false);
				h.sw.sync();

				// The worker is not left running behind a broken listener.
				expect(h.log).to.deep.equal(["create 1", "off", "after off", "destroy 1"]);
				expect(h.made[0].destroyed).to.equal(true);
				expect(h.sw.service()).to.equal(null);
				expect(logged.callCount).to.equal(1);
				expect(logged.firstCall.args).to.include(boom);

				// Switched on again: the same listener throws, the rest still hear it.
				h.set(true);
				h.sw.sync();

				expect(h.log.slice(-2)).to.deep.equal(["on", "after on"]);
				expect(logged.callCount).to.equal(2);
			} finally {
				logged.restore();
			}
		});

		it("a destroy that throws leaves the switch off and says so", () => {
			const logged = sinon.stub(console, "error");
			let on = true;
			const sw = new TranslationSwitch({
				on: () => on,
				create: () => ({}),
				destroy() {
					throw new Error("dispose failed");
				},
			});

			try {
				sw.service();
				on = false;

				expect(() => sw.sync()).to.not.throw();
				expect(sw.service()).to.equal(null);
				expect(logged.callCount).to.equal(1);
			} finally {
				logged.restore();
			}
		});

		it("a listener taken off hears nothing more", () => {
			const h = harness(true);
			const heard: boolean[] = [];
			const off = h.sw.onChange((value) => heard.push(value));

			h.set(false);
			h.sw.sync();
			off();
			h.set(true);
			h.sw.sync();

			expect(heard).to.deep.equal([false]);
		});
	});

	describe("readsHere (the effective-reading rule)", () => {
		beforeEach(() => {
			useStorageBackend(memoryBackend());
		});

		afterEach(() => {
			useStorageBackend(null);
		});

		it("reads every channel and query while on, unless excluded", () => {
			expect(readsHere(true, "channel", false)).to.equal(true);
			expect(readsHere(true, "query", false)).to.equal(true);
			expect(readsHere(true, "channel", true)).to.equal(false);
			expect(readsHere(true, "query", true)).to.equal(false);
		});

		it("never a lobby or a special window, and nothing while off", () => {
			expect(readsHere(true, "lobby", false)).to.equal(false);
			expect(readsHere(true, "special", false)).to.equal(false);
			expect(readsHere(false, "channel", false)).to.equal(false);
		});

		it("a write target neither switches reading on nor undoes an exclusion", () => {
			setChannelTranslation("net-a", "#writing", {write: "de"});
			setChannelTranslation("net-a", "#quiet", {exclude: true});
			setChannelTranslation("net-a", "#quiet", {write: "pt"});

			const excluded = (name: string) => getChannelTranslation("net-a", name).exclude;

			expect(readsHere(true, "channel", excluded("#writing"))).to.equal(true);
			expect(readsHere(true, "channel", excluded("#quiet"))).to.equal(false);
			// A conversation nobody touched reads.
			expect(readsHere(true, "channel", excluded("#untouched"))).to.equal(true);
		});
	});
});
