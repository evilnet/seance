// The build token: what tells one build of the app from the next.
//
// The build (`resolveBuild` in scripts/build-info.mts) derives it from the
// commit and stamps the same value into the asset URLs (`?v=`), the service
// worker's cache name and, through vite.config.mts `define`, here. A development build is `dev`
// everywhere. `pwa.ts` compares what a newly activated worker announces with
// this: a worker of another build under a running page means the page is
// stale, and Help offers "Reload to update".

export const BUILD: string = process.env.SEANCE_BUILD || "dev";

/** True when a worker announced a build that is not the one this page runs. */
export function isOtherBuild(announced: unknown): boolean {
	return typeof announced === "string" && announced !== "" && announced !== BUILD;
}
