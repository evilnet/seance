import {expect} from "chai";
import friendlysize from "../../client/js/helpers/friendlysize";

describe("friendlysize helper", function () {
	it("should render human-readable version", function () {
		expect(friendlysize(51200)).to.equal("50 KiB");
		expect(friendlysize(2)).to.equal("2 B");
		expect(friendlysize(1023)).to.equal("1023 B");
		expect(friendlysize(1024)).to.equal("1 KiB");
		expect(friendlysize(Math.pow(1024, 2))).to.equal("1 MiB");
		expect(friendlysize(Math.pow(1024, 3))).to.equal("1 GiB");
		expect(friendlysize(Math.pow(1024, 4))).to.equal("1 TiB");
		expect(friendlysize(Math.pow(1024, 5))).to.equal("1 PiB");
	});

	it("should round with 1 digit", function () {
		expect(friendlysize(1234567)).to.equal("1.2 MiB");
	});

	it("should render special case 0 as 0 B", function () {
		expect(friendlysize(0)).to.equal("0 B");
	});

	it("should render max safe integer as petabytes", function () {
		expect(friendlysize(Number.MAX_SAFE_INTEGER)).to.equal("8 PiB");
	});
});
