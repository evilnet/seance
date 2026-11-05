import {expect} from "chai";
import {DESKTOP_THREAD_CAP, cpuThreads, isolationState} from "../../client/js/translate/threads";

describe("translate threads", function () {
	describe("cpuThreads", function () {
		it("gives a phone at most 4 threads, one core left to the page", function () {
			expect(cpuThreads(8, true)).to.equal(4);
			expect(cpuThreads(5, true)).to.equal(4);
			expect(cpuThreads(4, true)).to.equal(3);
			expect(cpuThreads(2, true)).to.equal(1);
			expect(cpuThreads(1, true)).to.equal(1);
		});

		it("leaves a computer's last core to the page, and never goes under one", function () {
			expect(cpuThreads(1, false)).to.equal(1);
			expect(cpuThreads(2, false)).to.equal(1);
			expect(cpuThreads(4, false)).to.equal(Math.min(3, DESKTOP_THREAD_CAP));
		});

		it("caps a big computer at the measured DESKTOP_THREAD_CAP", function () {
			expect(cpuThreads(56, false)).to.equal(DESKTOP_THREAD_CAP);
		});

		it("reads a missing or odd hardwareConcurrency as one core", function () {
			expect(cpuThreads(0, false)).to.equal(1);
			expect(cpuThreads(Number.NaN, true)).to.equal(1);
		});
	});

	describe("isolationState", function () {
		// Translation on (the worker isolates the next load), on a page the
		// worker has not served yet.
		const env = {
			crossOriginIsolated: false,
			controlled: false,
			servedIsolating: false,
			workerIsolates: true,
			webkit: false,
			workerCanServe: true,
		};

		it("is isolated when the page is cross-origin isolated", function () {
			expect(
				isolationState({
					...env,
					crossOriginIsolated: true,
					controlled: true,
					servedIsolating: true,
				})
			).to.equal("isolated");
			// However it got there: a deploy's own headers isolate a page the worker never serves.
			expect(
				isolationState({...env, crossOriginIsolated: true, workerCanServe: false})
			).to.equal("isolated");
			// ... and with translation off at the worker, too.
			expect(
				isolationState({...env, crossOriginIsolated: true, workerIsolates: false})
			).to.equal("isolated");
		});

		it("asks for a reload on a page the worker did not serve yet", function () {
			expect(isolationState(env)).to.equal("reload");
		});

		it("asks for a reload on a page the worker served while translation was off", function () {
			// Switched on since this load: the worker isolates the next one.
			expect(isolationState({...env, controlled: true, servedIsolating: false})).to.equal(
				"reload"
			);
		});

		it("is unsupported when the worker served the page isolating and it is still not isolated", function () {
			// A browser without `credentialless`, or a deploy's own conflicting
			// policy: a reload would change nothing.
			expect(isolationState({...env, controlled: true, servedIsolating: true})).to.equal(
				"unsupported"
			);
		});

		it("is unsupported while the worker does not isolate (translation off)", function () {
			expect(isolationState({...env, workerIsolates: false})).to.equal("unsupported");
			expect(isolationState({...env, controlled: true, workerIsolates: false})).to.equal(
				"unsupported"
			);
		});

		it("is unsupported under WebKit, which has no credentialless", function () {
			expect(isolationState({...env, webkit: true})).to.equal("unsupported");
			expect(isolationState({...env, webkit: true, controlled: true})).to.equal(
				"unsupported"
			);
		});

		it("is unsupported where the worker is never registered (plain http, the native shells)", function () {
			expect(isolationState({...env, workerCanServe: false})).to.equal("unsupported");
		});
	});
});
