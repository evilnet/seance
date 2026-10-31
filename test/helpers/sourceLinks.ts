import {expect} from "chai";
import {
	buildIdentityOf,
	buildTrackOf,
	isPastRelease,
	sourceLinks,
} from "../../client/js/helpers/sourceLinks";

describe("sourceLinks", function () {
	const local = {buildTrack: "", gitBranch: null};
	const release = {version: "5.0.2", release: "5.0.2", gitCommit: "e5ed5af2", ...local};
	const past = {version: "5.0.2-1beda24a", release: "5.0.2", gitCommit: "1beda24a", ...local};

	it("points at upstream by default", function () {
		const links = sourceLinks(undefined, release);

		expect(links.repository).to.equal("https://github.com/evilnet/seance");
		expect(links.releaseNotes).to.equal(
			"https://github.com/evilnet/seance/releases/tag/v5.0.2"
		);
		expect(links.releases).to.equal("https://github.com/evilnet/seance/releases");
		expect(links.newIssue).to.equal("https://github.com/evilnet/seance/issues/new");
	});

	it("follows branding.links.source, trailing slash or not", function () {
		const links = sourceLinks("https://github.com/example/chat/", release);

		expect(links.repository).to.equal("https://github.com/example/chat");
		expect(links.newIssue).to.equal("https://github.com/example/chat/issues/new");
	});

	it("a release build links its commit but has nothing to compare", function () {
		expect(isPastRelease(release)).to.be.false;

		const links = sourceLinks(undefined, release);

		expect(links.commit).to.equal("https://github.com/evilnet/seance/commit/e5ed5af2");
		expect(links.sinceRelease).to.be.null;
		expect(links.behindDevelop).to.be.null;
	});

	it("a build past its release compares both ways", function () {
		expect(isPastRelease(past)).to.be.true;

		const links = sourceLinks(undefined, past);

		expect(links.sinceRelease).to.equal(
			"https://github.com/evilnet/seance/compare/v5.0.2...1beda24a"
		);
		expect(links.behindDevelop).to.equal(
			"https://github.com/evilnet/seance/compare/1beda24a...develop"
		);
	});

	it("a build without git is neither past nor comparable", function () {
		const unknown = {version: "5.0.2", release: "5.0.2", gitCommit: null, ...local};

		expect(isPastRelease(unknown)).to.be.false;
		expect(sourceLinks(undefined, unknown).commit).to.be.null;
	});

	it("reads the identity out of the configuration, blanks for what is missing", function () {
		expect(buildIdentityOf(null)).to.deep.equal({
			version: "",
			release: "",
			gitCommit: null,
			buildTrack: "",
			gitBranch: null,
		});
		expect(
			buildIdentityOf({version: "1", release: "1", gitCommit: "", gitBranch: ""})
		).to.deep.equal({
			version: "1",
			release: "1",
			gitCommit: null,
			buildTrack: "",
			gitBranch: null,
		});
	});

	describe("which build", function () {
		const pages = (buildTrack: string) => ({...past, buildTrack, gitBranch: null});

		it("names the Pages site's release and develop builds", function () {
			expect(buildTrackOf(pages("release"))).to.deep.equal({
				kind: "release",
				pr: null,
				branch: null,
			});
			expect(buildTrackOf(pages("develop"))).to.deep.equal({
				kind: "develop",
				pr: null,
				branch: null,
			});
		});

		it("names a pull request's preview and links the pull request", function () {
			expect(buildTrackOf(pages("pr142"))).to.deep.equal({kind: "pr", pr: 142, branch: null});
			expect(sourceLinks(undefined, pages("pr142")).pullRequest).to.equal(
				"https://github.com/evilnet/seance/pull/142"
			);
			expect(sourceLinks(undefined, pages("develop")).pullRequest).to.be.null;
		});

		it("takes any other build for a local one, with its branch", function () {
			expect(buildTrackOf({...past, gitBranch: "feat/help-modal"})).to.deep.equal({
				kind: "local",
				pr: null,
				branch: "feat/help-modal",
			});
			expect(buildTrackOf(past).branch).to.be.null;

			for (const odd of ["pr", "pr0", "pr12x", "staging"]) {
				expect(buildTrackOf(pages(odd)).kind, odd).to.equal("local");
			}
		});
	});
});
