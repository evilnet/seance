import {expect} from "chai";
import {
	categoryBadge,
	formatBytes,
	formatExpiry,
	relativeTime,
	reportText,
	valueText,
	wallopsBadge,
} from "../../client/js/helpers/operFormat";

describe("oper formatting (helpers/operFormat.ts)", function () {
	const now = Date.UTC(2026, 9, 9, 12, 0, 0);

	it("formats sizes and times", function () {
		expect(formatBytes(512)).to.equal("512 B");
		expect(formatBytes(1536)).to.equal("1.5 KiB");
		expect(formatBytes(160000)).to.equal("156 KiB");
		expect(relativeTime(now + 3 * 3600_000 + 20 * 60_000, now)).to.equal("in 3h 20m");
		expect(relativeTime(now - 5 * 60_000, now)).to.equal("5m ago");
		expect(relativeTime(now + 1000, now)).to.equal("now");
		expect(formatExpiry(0, now)).to.equal("never");
		expect(formatExpiry(now - 1, now)).to.equal("expired");
		expect(formatExpiry(now + 86400_000, now)).to.equal("in 1d");
	});

	it("turns values and reports into plain text", function () {
		expect(valueText({t: "channel", v: "#seance", prefix: "@"})).to.equal("@#seance");
		expect(valueText({t: "chips", v: ["KILL", "CHECK"]})).to.equal("KILL, CHECK");
		expect(
			valueText([
				{t: "bytes", v: 2048},
				{t: "text", v: "of"},
				{t: "bytes", v: 4096},
			])
		).to.equal("2.0 KiB of 4.0 KiB");
		expect(valueText({t: "time", v: now, text: "Fri Oct  9 12:00:00 2026"})).to.equal(
			"Fri Oct  9 12:00:00 2026"
		);

		const text = reportText(
			{
				kind: "stats",
				title: "G-lines",
				command: "STATS g",
				sections: [
					{
						table: {
							columns: [
								{key: "mask", label: "Mask"},
								{key: "expires", label: "Expires"},
							],
							rows: [
								{
									mask: {t: "mask", v: "*@1.2.3.4"},
									expires: {t: "expiry", v: now + 3600_000},
								},
							],
						},
					},
				],
				raw: [],
			},
			now
		);
		expect(text).to.equal("G-lines\nMask\tExpires\n*@1.2.3.4\tin 1h");
	});

	it("names notice categories and WALLOPS kinds", function () {
		expect(categoryBadge("GLINE")).to.deep.equal({label: "ban", family: "ban"});
		expect(categoryBadge("WEIRD")).to.deep.equal({label: "weird", family: "server"});
		expect(wallopsBadge("wallusers")).to.equal("wallusers");
		expect(wallopsBadge("desynch")).to.equal("desync");
	});
});
