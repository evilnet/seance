import {expect} from "chai";
import {computed, reactive} from "vue";
import {filehostHost, viewFor} from "../../client/js/avatars/view";
import type {TypedStore} from "../../client/js/store";
import {AVATAR_MAX_BYTES, avatarLinkProblem, parseAvatarUrl} from "../../client/js/avatars/url";
import {
	avatarView,
	normalizeAvatarLoad,
	proxiedSrc,
	type AvatarInputs,
} from "../../client/js/avatars/policy";
import {
	avatarKnown,
	avatarOf,
	bindNetwork,
	clearAvatars,
	SEEN_KEY_PREFIX,
	forgetAvatar,
	forgetSeen,
	markAvatarsStale,
	noteAccount,
	renameAvatar,
	saveSeen,
	setAvatarValue,
	useSeenBackend,
} from "../../client/js/avatars/registry";
import {
	STORAGE_KEY,
	avatarsEnabled,
	forgetNetworkAvatarPrefs,
	isPersonTrusted,
	personKey,
	setAvatarsEnabled,
	splitPersonKey,
	trustPerson,
	trustedPeople,
	untrustPerson,
	useStorageBackend,
} from "../../client/js/avatars/prefs";
import {
	MemoryRecentBackend,
	PROBE_KEY,
	PROBE_SPAN_MS,
	RECENT_MAX,
	avatarUnavailable,
	forgetNetworkAvatars,
	noteProbe,
	recentAvatars,
	refreshDue,
	rememberAvatar,
	useProbeStorage,
	useRecentBackend,
	type RecentAvatar,
} from "../../client/js/avatars/own";

function memoryStorage() {
	const data = new Map<string, string>();
	return {
		data,
		get: (key: string) => data.get(key) ?? null,
		set: (key: string, value: string) => void data.set(key, value),
		remove: (key: string) => void data.delete(key),
	};
}

const DAY = 24 * 60 * 60 * 1000;

describe("avatar URLs (avatars/url.ts)", function () {
	it("accepts plain https URLs and normalizes the host", function () {
		expect(parseAvatarUrl("https://Files.Example.ORG/a/b.webp")).to.deep.equal({
			href: "https://files.example.org/a/b.webp",
			host: "files.example.org",
		});
	});

	it("refuses http, ports, credentials, SVG and junk", function () {
		for (const value of [
			"http://example.org/a.png",
			"https://example.org:8443/a.png",
			"https://user:pw@example.org/a.png",
			"https://example.org/a.svg",
			"https://example.org/a.SVGZ",
			"javascript:alert(1)",
			"data:image/png;base64,AAAA",
			"not a url",
			"",
			undefined,
			null,
		]) {
			expect(parseAvatarUrl(value), String(value)).to.equal(null);
		}
	});

	it("refuses a value over the server's byte limit", function () {
		const base = "https://example.org/";
		const fits = base + "a".repeat(AVATAR_MAX_BYTES - base.length);
		expect(parseAvatarUrl(fits)).to.not.equal(null);
		expect(parseAvatarUrl(fits + "a")).to.equal(null);
	});

	it("names what is wrong with a typed link", function () {
		expect(avatarLinkProblem("  ")).to.equal("empty");
		expect(avatarLinkProblem("http://example.org/a.png")).to.equal("notHttps");
		expect(avatarLinkProblem("https://example.org/a.svg")).to.equal("svg");
		expect(avatarLinkProblem("https://example.org/" + "a".repeat(300))).to.equal("tooLong");
		expect(avatarLinkProblem("nope")).to.equal("invalid");
		expect(avatarLinkProblem("https://example.org:444/a.png")).to.equal("invalid");
		expect(avatarLinkProblem("https://example.org/a.png")).to.equal(null);
	});
});

describe("avatar loading policy (avatars/policy.ts)", function () {
	const href = "https://pics.example.net/dmitri.webp";

	function inputs(over: Partial<AvatarInputs> = {}): AvatarInputs {
		return {
			value: href,
			self: false,
			enabled: true,
			setting: "trusted",
			filehostHost: "files.afternet.org",
			deployHosts: [],
			hostTrusted: () => false,
			personTrusted: () => false,
			loadedOnce: () => false,
			failed: () => false,
			...over,
		};
	}

	it("normalizes the setting", function () {
		expect(normalizeAvatarLoad("any")).to.equal("any");
		expect(normalizeAvatarLoad("none")).to.equal("none");
		expect(normalizeAvatarLoad("bogus")).to.equal("trusted");
		expect(normalizeAvatarLoad(undefined)).to.equal("trusted");
	});

	it("veils a picture on a site nobody trusts", function () {
		expect(avatarView(inputs())).to.deep.equal({
			kind: "veiled",
			href,
			host: "pics.example.net",
		});
	});

	it("loads from the image host, the deploy's hosts, trusted hosts and people", function () {
		const image = {kind: "image", src: href, href, host: "pics.example.net"};
		expect(avatarView(inputs({filehostHost: "pics.example.net"}))).to.deep.equal(image);
		expect(avatarView(inputs({deployHosts: ["pics.example.net"]}))).to.deep.equal(image);
		expect(avatarView(inputs({hostTrusted: (h) => h === "pics.example.net"}))).to.deep.equal(
			image
		);
		expect(avatarView(inputs({personTrusted: (h) => h === "pics.example.net"}))).to.deep.equal(
			image
		);
		expect(avatarView(inputs({loadedOnce: (u) => u === href}))).to.deep.equal(image);
		expect(avatarView(inputs({self: true}))).to.deep.equal(image);
		expect(avatarView(inputs({setting: "any"}))).to.deep.equal(image);
	});

	it("shows nothing when off, set to none, unusable or failed", function () {
		expect(avatarView(inputs({enabled: false}))).to.deep.equal({kind: "none"});
		expect(avatarView(inputs({setting: "none", self: true}))).to.deep.equal({kind: "none"});
		expect(avatarView(inputs({value: "http://x.example/a.png"}))).to.deep.equal({
			kind: "none",
		});
		expect(avatarView(inputs({value: ""}))).to.deep.equal({kind: "none"});
		expect(avatarView(inputs({failed: () => true, self: true}))).to.deep.equal({kind: "none"});
	});

	it("loads everything through the deploy's proxy", function () {
		const proxy = "https://proxy.example/img?u={url}";
		expect(avatarView(inputs({proxy}))).to.deep.equal({
			kind: "image",
			src: `https://proxy.example/img?u=${encodeURIComponent(href)}`,
			href,
			host: "pics.example.net",
		});
	});

	it("ignores a proxy template that is not https or has no {url}", function () {
		expect(proxiedSrc("http://proxy.example/{url}", href)).to.equal(undefined);
		expect(proxiedSrc("https://proxy.example/", href)).to.equal(undefined);
		expect(proxiedSrc(undefined, href)).to.equal(undefined);
		expect(avatarView(inputs({proxy: "http://proxy.example/{url}"})).kind).to.equal("veiled");
	});
});

describe("avatar view (avatars/view.ts)", function () {
	const uuid = "view-net";

	beforeEach(function () {
		bindNetwork(uuid, (s) => s.toLowerCase());
		clearAvatars(uuid);
	});

	// A page load draws the kept lines' avatars before the connection says
	// the network's upload host: the view must look again once the store does.
	it("draws a picture on the network's upload host once the store knows the host, though drawn before it did", function () {
		setAvatarValue(uuid, "bob", "https://files.example/f/bob.png");
		const state = reactive({
			networks: [{uuid, serverOptions: {} as {FILEHOST?: string}}],
			branding: {},
			settings: {avatarLoad: "trusted"},
		});
		const store = {state} as unknown as TypedStore;
		const kind = computed(() => viewFor(store, {uuid, nick: "bob"}).kind);

		expect(filehostHost(store, uuid)).to.equal(null);
		expect(kind.value).to.equal("veiled");

		state.networks[0].serverOptions.FILEHOST = "https://files.example/upload";
		expect(filehostHost(store, uuid)).to.equal("files.example");
		expect(kind.value).to.equal("image");
	});
});

describe("avatar registry (avatars/registry.ts)", function () {
	const uuid = "reg-net";

	beforeEach(function () {
		bindNetwork(uuid, (s) => s.toLowerCase());
		clearAvatars(uuid);
	});

	it("records values and tells known from unknown", function () {
		expect(avatarKnown(uuid, "Alice")).to.equal(false);
		setAvatarValue(uuid, "Alice", "https://a.example/a.png");
		expect(avatarKnown(uuid, "alice")).to.equal(true);
		expect(avatarOf(uuid, "ALICE")?.value).to.equal("https://a.example/a.png");
		setAvatarValue(uuid, "bob", "");
		expect(avatarKnown(uuid, "bob")).to.equal(true);
	});

	it("an account alone does not make the value known", function () {
		noteAccount(uuid, "carol", "carol");
		expect(avatarOf(uuid, "carol")?.account).to.equal("carol");
		expect(avatarKnown(uuid, "carol")).to.equal(false);
		setAvatarValue(uuid, "carol", "");
		expect(avatarKnown(uuid, "carol")).to.equal(true);
		expect(avatarOf(uuid, "carol")?.account).to.equal("carol");
	});

	it("follows a nick change and drops what the new nick had", function () {
		setAvatarValue(uuid, "alice", "https://a.example/a.png");
		setAvatarValue(uuid, "alice2", "https://a.example/old.png");
		renameAvatar(uuid, "alice", "Alice2");
		expect(avatarKnown(uuid, "alice")).to.equal(false);
		expect(avatarOf(uuid, "alice2")?.value).to.equal("https://a.example/a.png");
	});

	it("carries the unknown mark across a rename", function () {
		noteAccount(uuid, "dave", "dave");
		renameAvatar(uuid, "dave", "dave_");
		expect(avatarOf(uuid, "dave_")?.account).to.equal("dave");
		expect(avatarKnown(uuid, "dave_")).to.equal(false);
	});

	it("forgets one nick, or all of a network", function () {
		setAvatarValue(uuid, "alice", "x");
		setAvatarValue(uuid, "bob", "y");
		forgetAvatar(uuid, "alice");
		expect(avatarKnown(uuid, "alice")).to.equal(false);
		expect(avatarKnown(uuid, "bob")).to.equal(true);
		clearAvatars(uuid);
		expect(avatarKnown(uuid, "bob")).to.equal(false);
	});
});

describe("avatar registry between connections and launches", function () {
	let mem: ReturnType<typeof memoryStorage>;
	let n = 0;
	let uuid = "";

	beforeEach(function () {
		mem = memoryStorage();
		useSeenBackend(mem);
		uuid = `seen-net-${n++}`;
	});

	afterEach(function () {
		useSeenBackend(null);
	});

	it("a new connection keeps the pictures drawn but asks again", function () {
		bindNetwork(uuid, (s) => s.toLowerCase());
		setAvatarValue(uuid, "alice", "https://a.example/a.png");
		markAvatarsStale(uuid);
		expect(avatarOf(uuid, "alice")?.value).to.equal("https://a.example/a.png");
		expect(avatarKnown(uuid, "alice")).to.equal(false);
		setAvatarValue(uuid, "alice", "https://a.example/b.png");
		expect(avatarKnown(uuid, "alice")).to.equal(true);
	});

	it("a saved network's values come back on the next launch, as not known", function () {
		bindNetwork(
			uuid,
			(s) => s.toLowerCase(),
			() => true
		);
		setAvatarValue(uuid, "Alice", "https://a.example/a.png");
		noteAccount(uuid, "alice", "alice");
		setAvatarValue(uuid, "bob", "");
		saveSeen(uuid);
		const kept = JSON.parse(mem.get(SEEN_KEY_PREFIX + uuid) ?? "[]");
		expect(kept).to.deep.equal([["alice", "https://a.example/a.png", "alice"]]);

		// The next launch: a fresh registry for the network reads it back.
		const next = `${uuid}-next`;
		mem.set(SEEN_KEY_PREFIX + next, JSON.stringify(kept));
		bindNetwork(
			next,
			(s) => s.toLowerCase(),
			() => true
		);
		expect(avatarOf(next, "ALICE")).to.deep.equal({
			value: "https://a.example/a.png",
			account: "alice",
		});
		expect(avatarKnown(next, "alice")).to.equal(false);
	});

	it("a network that is not saved keeps nothing; a removed one forgets", function () {
		bindNetwork(
			uuid,
			(s) => s.toLowerCase(),
			() => false
		);
		setAvatarValue(uuid, "alice", "x");
		saveSeen(uuid);
		expect(mem.get(SEEN_KEY_PREFIX + uuid)).to.equal(null);

		const saved = `${uuid}-saved`;
		bindNetwork(
			saved,
			(s) => s.toLowerCase(),
			() => true
		);
		setAvatarValue(saved, "alice", "x");
		saveSeen(saved);
		expect(mem.get(SEEN_KEY_PREFIX + saved)).to.not.equal(null);
		forgetSeen(saved);
		expect(mem.get(SEEN_KEY_PREFIX + saved)).to.equal(null);
	});

	it("a damaged record is dropped", function () {
		mem.set(SEEN_KEY_PREFIX + uuid, "{not json");
		bindNetwork(
			uuid,
			(s) => s.toLowerCase(),
			() => true
		);
		expect(avatarOf(uuid, "alice")).to.equal(undefined);
		expect(mem.get(SEEN_KEY_PREFIX + uuid)).to.equal(null);
	});
});

describe("avatar preferences (avatars/prefs.ts)", function () {
	let mem: ReturnType<typeof memoryStorage>;

	beforeEach(function () {
		mem = memoryStorage();
		useStorageBackend(mem);
	});

	after(function () {
		useStorageBackend(null);
	});

	it("is on by default and remembers a network switched off", function () {
		expect(avatarsEnabled("n1")).to.equal(true);
		setAvatarsEnabled("n1", false);
		expect(avatarsEnabled("n1")).to.equal(false);
		expect(JSON.parse(mem.data.get(STORAGE_KEY)!).off).to.deep.equal(["n1"]);
		useStorageBackend(mem);
		expect(avatarsEnabled("n1")).to.equal(false);
		setAvatarsEnabled("n1", true);
		expect(avatarsEnabled("n1")).to.equal(true);
	});

	it("trusts a person by account and host, not either alone", function () {
		trustPerson("n1", "Dmitri", "pics.example.net");
		expect(isPersonTrusted("n1", "dmitri", "pics.example.net")).to.equal(true);
		expect(isPersonTrusted("n1", "dmitri", "other.example")).to.equal(false);
		expect(isPersonTrusted("n2", "dmitri", "pics.example.net")).to.equal(false);
		expect(isPersonTrusted("n1", null, "pics.example.net")).to.equal(false);
		expect(trustedPeople()).to.deep.equal(["n1/dmitri@pics.example.net"]);
	});

	it("takes a person key apart", function () {
		expect(splitPersonKey(personKey("n1", "dmitri", "pics.example.net"))).to.deep.equal({
			network: "n1",
			account: "dmitri",
			host: "pics.example.net",
		});
	});

	it("stops trusting, and forgets a removed network", function () {
		trustPerson("n1", "a", "h.example");
		trustPerson("n2", "b", "h.example");
		setAvatarsEnabled("n1", false);
		untrustPerson("n2/b@h.example");
		expect(trustedPeople()).to.deep.equal(["n1/a@h.example"]);
		forgetNetworkAvatarPrefs("n1");
		expect(trustedPeople()).to.deep.equal([]);
		expect(avatarsEnabled("n1")).to.equal(true);
	});
});

describe("own avatar upkeep (avatars/own.ts)", function () {
	const NOW = Date.UTC(2026, 10, 23);

	function rec(over: Partial<RecentAvatar> = {}): RecentAvatar {
		return {
			id: "r1",
			uuid: "n1",
			url: "https://files.example/a.webp",
			setAt: NOW,
			uploaded: true,
			blob: new Blob(["x"]),
			...over,
		};
	}

	it("re-uploads a week before the host deletes the file", function () {
		expect(refreshDue(rec({setAt: NOW - 22 * DAY}), NOW)).to.equal(false);
		expect(refreshDue(rec({setAt: NOW - 23 * DAY}), NOW)).to.equal(true);
		expect(refreshDue(rec({setAt: NOW - 5 * DAY}), NOW, 10)).to.equal(true);
		expect(refreshDue(rec({setAt: NOW - 4 * DAY}), NOW, 10)).to.equal(false);
	});

	it("never re-uploads a link, a lost picture, or with no retention", function () {
		const old = NOW - 40 * DAY;
		expect(refreshDue(rec({setAt: old, uploaded: false}), NOW)).to.equal(false);
		expect(refreshDue(rec({setAt: old, blob: undefined}), NOW)).to.equal(false);
		expect(refreshDue(rec({setAt: old}), NOW, 0)).to.equal(false);
		expect(refreshDue(undefined, NOW)).to.equal(false);
	});

	describe("recent avatars", function () {
		beforeEach(function () {
			useRecentBackend(new MemoryRecentBackend());
		});

		after(function () {
			useRecentBackend(null);
		});

		it("keeps the newest first, one entry per URL, keeping the picture", async function () {
			const blob = new Blob(["pic"]);
			const first = await rememberAvatar({
				uuid: "n1",
				url: "https://a.example/1.png",
				setAt: 1,
				uploaded: true,
				blob,
			});
			await rememberAvatar({
				uuid: "n1",
				url: "https://a.example/2.png",
				setAt: 2,
				uploaded: false,
			});
			const again = await rememberAvatar({
				uuid: "n1",
				url: "https://a.example/1.png",
				setAt: 3,
				uploaded: true,
			});
			expect(again.id).to.equal(first.id);
			expect(again.blob).to.equal(blob);
			const list = await recentAvatars("n1");
			expect(list.map((r) => r.url)).to.deep.equal([
				"https://a.example/1.png",
				"https://a.example/2.png",
			]);
			expect(await recentAvatars("n2")).to.deep.equal([]);
		});

		it(`keeps at most ${RECENT_MAX} per network`, async function () {
			for (let i = 0; i < RECENT_MAX + 3; i++) {
				await rememberAvatar({
					uuid: "n1",
					url: `https://a.example/${i}.png`,
					setAt: i,
					uploaded: false,
				});
			}

			const list = await recentAvatars("n1");
			expect(list).to.have.length(RECENT_MAX);
			expect(list[0].url).to.equal(`https://a.example/${RECENT_MAX + 2}.png`);
		});

		it("forgets a removed network's pictures", async function () {
			await rememberAvatar({
				uuid: "n1",
				url: "https://a.example/1.png",
				setAt: 1,
				uploaded: false,
			});
			await rememberAvatar({
				uuid: "n2",
				url: "https://a.example/2.png",
				setAt: 1,
				uploaded: false,
			});
			await forgetNetworkAvatars("n1");
			expect(await recentAvatars("n1")).to.deep.equal([]);
			expect(await recentAvatars("n2")).to.have.length(1);
		});
	});

	describe("probe", function () {
		let mem: ReturnType<typeof memoryStorage>;
		const url = "https://files.example/a.webp";

		beforeEach(function () {
			mem = memoryStorage();
			useProbeStorage(mem);
		});

		after(function () {
			useProbeStorage(null);
		});

		it("needs two failures half an hour apart", function () {
			expect(noteProbe("n1", url, false, NOW)).to.equal(false);
			expect(noteProbe("n1", url, false, NOW + 60_000)).to.equal(false);
			expect(avatarUnavailable("n1", url, NOW + 60_000)).to.equal(false);
			expect(noteProbe("n1", url, false, NOW + PROBE_SPAN_MS)).to.equal(true);
			expect(avatarUnavailable("n1", url, NOW + PROBE_SPAN_MS)).to.equal(true);
			expect(
				avatarUnavailable("n1", "https://files.example/b.webp", NOW + PROBE_SPAN_MS)
			).to.equal(false);
		});

		it("starts over on a load or another URL", function () {
			noteProbe("n1", url, false, NOW);
			noteProbe("n1", url, true, NOW + 1);
			expect(mem.data.has(PROBE_KEY)).to.equal(false);
			noteProbe("n1", url, false, NOW);
			noteProbe("n1", "https://files.example/b.webp", false, NOW + PROBE_SPAN_MS);
			expect(
				avatarUnavailable("n1", "https://files.example/b.webp", NOW + PROBE_SPAN_MS)
			).to.equal(false);
		});
	});
});
