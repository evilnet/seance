import {expect} from "chai";
import {LABEL_ALLOWANCE, lineBudget, lineTooLongText} from "../../client/js/helpers/operLine";
import {MAX_LINE_BYTES} from "../../client/js/irc/message";
import {killLine} from "../../client/js/irc/profiles/nefarious/bans";

describe("oper line budget (helpers/operLine.ts)", function () {
	it("keeps room for the label the IRC layer adds", function () {
		expect(LABEL_ALLOWANCE).to.equal("@label=svc9999999 ".length);
	});

	it("passes a short kill", function () {
		const budget = lineBudget(killLine("spammer", "Spam"));
		expect(budget.over).to.equal(0);
		expect(lineTooLongText(budget)).to.equal("");
	});

	it("counts UTF-8 bytes, not characters", function () {
		// 250 characters, as the field allows, but 3 bytes each.
		const reason = "あ".repeat(250);
		const line = killLine("spammer", reason);
		const budget = lineBudget(line);
		expect(line.length).to.be.below(MAX_LINE_BYTES);
		expect(budget.bytes).to.equal("KILL spammer :".length + 750 + LABEL_ALLOWANCE);
		expect(budget.over).to.equal(budget.bytes - MAX_LINE_BYTES);
		expect(lineTooLongText(budget)).to.match(
			/^Too long to send: shorten the reason by \d+ bytes/
		);
	});

	it("counts an emoji's surrogate pair as four bytes", function () {
		expect(lineBudget("😀").bytes).to.equal(4 + LABEL_ALLOWANCE);
	});

	it("allows a line exactly at the cap", function () {
		const fill = "x".repeat(MAX_LINE_BYTES - LABEL_ALLOWANCE);
		expect(lineBudget(fill).over).to.equal(0);
		expect(lineBudget(fill + "x").over).to.equal(1);
		expect(lineTooLongText(lineBudget(fill + "x"))).to.contain("by 1 byte ");
	});
});
