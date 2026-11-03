import {expect} from "chai";
import sinon from "sinon";
import {EventBus} from "../../client/js/socket";

describe("client event bus", function () {
	let bus: EventBus;

	beforeEach(function () {
		bus = new EventBus();
	});

	it("delivers dispatched server events to subscribers", function () {
		const calls: Array<{network: string; nick: string}> = [];
		bus.on("nick", (data) => calls.push(data));

		const delivered = bus.dispatch("nick", {network: "abc", nick: "seance"});

		expect(delivered).to.be.true;
		expect(calls).to.deep.equal([{network: "abc", nick: "seance"}]);
	});

	it("reports when nobody is listening", function () {
		expect(bus.dispatch("nick", {network: "abc", nick: "seance"})).to.be.false;
	});

	it("removes listeners with off()", function () {
		const handler = sinon.spy();
		bus.on("open", handler);
		bus.off("open", handler);

		bus.dispatch("open", 1);

		expect(handler.called).to.be.false;
		expect(bus.listenerCount("open")).to.equal(0);
	});

	it("fires once() listeners a single time", function () {
		const handler = sinon.spy();
		bus.once("open", handler);

		bus.dispatch("open", 1);
		bus.dispatch("open", 2);

		expect(handler.calledOnce).to.be.true;
		expect(handler.firstCall.args).to.deep.equal([1]);
	});

	it("routes emits to the registered handler", function () {
		const handler = sinon.spy();
		bus.handle("input", handler);

		bus.emit("input", {target: 1, text: "hello"});

		expect(handler.calledOnce).to.be.true;
		expect(handler.firstCall.args).to.deep.equal([{target: 1, text: "hello"}]);
	});

	it("warns on emits that nobody handles", function () {
		const warn = sinon.stub(console, "warn");

		try {
			bus.emit("input", {target: 1, text: "hello"});

			expect(warn.calledOnce).to.be.true;
			expect(warn.firstCall.args[0]).to.equal("[bus] unhandled emit:");
			expect(warn.firstCall.args[1]).to.equal("input");
		} finally {
			warn.restore();
		}
	});

	it("tracks connect()/disconnect() without a transport", function () {
		expect(bus.connected).to.be.false;
		bus.open();
		expect(bus.connected).to.be.true;
		bus.disconnect();
		expect(bus.connected).to.be.false;
	});
});
