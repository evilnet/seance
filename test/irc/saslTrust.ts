import {expect} from "chai";
import {
	forgetLogin,
	loginTrusted,
	trustLogin,
	typedCredentialsDiffer,
	useStorageBackend,
} from "../../client/js/irc/saslTrust";

describe("saslTrust", function () {
	let store: Map<string, string>;

	beforeEach(function () {
		store = new Map();
		useStorageBackend({
			get: (key) => store.get(key) ?? null,
			set: (key, value) => void store.set(key, value),
			remove: (key) => void store.delete(key),
		});
	});

	afterEach(function () {
		useStorageBackend(null);
	});

	it("remembers one account per network and forgets it", function () {
		trustLogin("a", "alice");
		trustLogin("b", "bob");
		expect(loginTrusted("a", "alice")).to.equal(true);
		expect(loginTrusted("a", "bob")).to.equal(false);
		expect(loginTrusted("a", "")).to.equal(false);
		forgetLogin("a");
		expect(loginTrusted("a", "alice")).to.equal(false);
		expect(loginTrusted("b", "bob")).to.equal(true);
		forgetLogin("b");
		expect(store.has("thelounge.state.saslOk")).to.equal(false);
	});

	describe("typedCredentialsDiffer: what the connect form posts against the saved entry", function () {
		const remembered = {saslAccount: "alice", saslPassword: "hunter2"};
		const typedEachTime = {saslAccount: "alice", saslPassword: ""};

		it("the same credentials, or none posted, change nothing", function () {
			expect(typedCredentialsDiffer(remembered, remembered)).to.equal(false);
			expect(typedCredentialsDiffer(remembered, {})).to.equal(false);
			expect(typedCredentialsDiffer(remembered, {saslAccount: "alice"})).to.equal(false);
			expect(typedCredentialsDiffer(remembered, {saslPassword: ""})).to.equal(false);
		});

		it("another account or another password than the remembered one", function () {
			expect(typedCredentialsDiffer(remembered, {saslAccount: "bob"})).to.equal(true);
			expect(typedCredentialsDiffer(remembered, {saslPassword: "hunter3"})).to.equal(true);
		});

		it("a password the entry does not remember differs at every sign-in", function () {
			expect(typedCredentialsDiffer(typedEachTime, {saslPassword: "hunter2"})).to.equal(true);
			expect(typedCredentialsDiffer(undefined, {saslPassword: "hunter2"})).to.equal(true);
			expect(typedCredentialsDiffer(undefined, {saslAccount: "alice"})).to.equal(true);
			expect(typedCredentialsDiffer(undefined, {})).to.equal(false);
		});
	});
});
