<template>
	<div
		id="changelog"
		v-backdrop="close"
		class="window screen-overlay"
		role="dialog"
		aria-modal="true"
		aria-label="Release notes"
	>
		<div class="settings-modal changelog-modal">
			<div class="settings-modal-header">
				<h1>Release notes for v{{ build.release }}</h1>
				<button
					class="settings-modal-close"
					type="button"
					aria-label="Close the release notes"
					@click="close"
				>
					✕
				</button>
			</div>
			<div class="settings-modal-body">
				<div class="container">
					<p v-if="pastRelease">
						This build is
						<a :href="source.commit" target="_blank" rel="noopener"
							>commit <code>{{ build.gitCommit }}</code></a
						>, after v{{ build.release }}:
						<a :href="source.sinceRelease" target="_blank" rel="noopener"
							>what changed since the release</a
						>.
					</p>
					<p>
						Release notes are not bundled with the build.
						<a :href="source.releaseNotes" target="_blank" rel="noopener"
							>Read the notes for v{{ build.release }}</a
						>
						or
						<a :href="source.releases" target="_blank" rel="noopener"
							>see all releases</a
						>.
					</p>
				</div>
			</div>
			<div class="settings-modal-footer">
				<router-link id="back-to-help" to="/help">« Help</router-link>
				<button class="btn settings-modal-done" type="button" @click="close">Done</button>
			</div>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useStore} from "../../js/store";
import {buildIdentityOf, isPastRelease, sourceLinks} from "../../js/helpers/sourceLinks";
import {leavePage} from "../../js/router";

export default defineComponent({
	name: "Changelog",
	setup() {
		const store = useStore();
		const build = computed(() => buildIdentityOf(store.state.serverConfiguration));
		const pastRelease = computed(() => isPastRelease(build.value));
		const source = computed(() => sourceLinks(store.state.branding.links?.source, build.value));

		const close = () => {
			leavePage();
		};

		return {
			build,
			close,
			pastRelease,
			source,
		};
	},
});
</script>
