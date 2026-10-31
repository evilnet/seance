// Links into the repository a build comes from, for the Help and Changelog
// windows. `branding.links.source` names the repository (GitHub URL shapes;
// the default is upstream, a fork points it at itself) and the build's
// identity comes from `configuration.ts` — `version`, `release`, `gitCommit`,
// `buildTrack`, `gitBranch`, filled in by webpack's `resolveBuild`. Vue-free:
// test/helpers/sourceLinks.ts.

import {UPSTREAM_REPOSITORY} from "../branding";

export interface BuildIdentity {
	/** `5.0.2` for a release, `5.0.2-e5ed5af2` for a build past one. */
	version: string;
	/** The release the build is, or follows. */
	release: string;
	/** Short sha the build was made from; null when unknown. */
	gitCommit: string | null;
	/** The Pages build this is (`release`, `develop`, `pr<N>`); empty for any other. */
	buildTrack: string;
	/** The branch a build made elsewhere was made from; null when unknown. */
	gitBranch: string | null;
}

/**
 * Which build this is, for Help: one of the Pages site's — the release at
 * the root, `develop/`, a pull request's `pr<N>/` — or one made anywhere
 * else (`yarn build` on someone's machine, a native shell's), which names
 * its branch when it knows it.
 */
export interface BuildTrack {
	kind: "release" | "develop" | "pr" | "local";
	/** The pull request's number, for `pr`. */
	pr: number | null;
	/** The branch, for `local`. */
	branch: string | null;
}

export interface SourceLinks {
	repository: string;
	/** The release's notes. */
	releaseNotes: string;
	/** All releases. */
	releases: string;
	/** The new-issue form. */
	newIssue: string;
	/** The commit the build was made from; null when unknown. */
	commit: string | null;
	/** The release compared with the build's commit; null for a release build. */
	sinceRelease: string | null;
	/** The build's commit compared with develop; null for a release build. */
	behindDevelop: string | null;
	/** The pull request a preview build is of; null for any other build. */
	pullRequest: string | null;
}

/** The build's identity out of the configuration object, absent parts blank. */
export function buildIdentityOf(config: Partial<BuildIdentity> | null | undefined): BuildIdentity {
	return {
		version: config?.version ?? "",
		release: config?.release ?? "",
		gitCommit: config?.gitCommit || null,
		buildTrack: config?.buildTrack ?? "",
		gitBranch: config?.gitBranch || null,
	};
}

export function buildTrackOf(build: BuildIdentity): BuildTrack {
	const track = build.buildTrack;

	if (track === "release" || track === "develop") {
		return {kind: track, pr: null, branch: null};
	}

	const pr = /^pr([1-9][0-9]*)$/.exec(track);

	if (pr) {
		return {kind: "pr", pr: Number(pr[1]), branch: null};
	}

	return {kind: "local", pr: null, branch: build.gitBranch};
}

/** True for a build made from a commit past its release, rather than the release itself. */
export function isPastRelease(build: BuildIdentity): boolean {
	return build.gitCommit !== null && build.version !== build.release;
}

export function sourceLinks(source: string | undefined, build: BuildIdentity): SourceLinks {
	const repository = (source || UPSTREAM_REPOSITORY).replace(/\/+$/, "");
	const commit = build.gitCommit;
	const past = isPastRelease(build);
	const track = buildTrackOf(build);

	return {
		repository,
		releaseNotes: `${repository}/releases/tag/v${build.release}`,
		releases: `${repository}/releases`,
		newIssue: `${repository}/issues/new`,
		commit: commit ? `${repository}/commit/${commit}` : null,
		sinceRelease: past ? `${repository}/compare/v${build.release}...${commit}` : null,
		behindDevelop: past ? `${repository}/compare/${commit}...develop` : null,
		pullRequest: track.pr !== null ? `${repository}/pull/${track.pr}` : null,
	};
}
