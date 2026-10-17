import {expect} from "chai";
import {iosAlertId} from "../../client/js/helpers/nativeAlerts";

describe("iosAlertId", function () {
	it("is one id per conversation, whatever the case of its name", function () {
		expect(iosAlertId("net-1", "#Seance")).to.equal(iosAlertId("net-1", "#seance"));
	});

	it("tells conversations and networks apart", function () {
		const ids = new Set([
			iosAlertId("net-1", "#seance"),
			iosAlertId("net-1", "alice"),
			iosAlertId("net-2", "#seance"),
		]);
		expect(ids.size).to.equal(3);
	});

	it("is a positive 32-bit integer", function () {
		for (const target of ["#seance", "alice", "", "Ünïcødé"]) {
			const id = iosAlertId("0d3c5a8e-1111-4c2b-9d7e-5eeace0de001", target);
			expect(Number.isInteger(id)).to.equal(true);
			expect(id).to.be.within(1, 2 ** 31 - 1);
		}
	});
});
