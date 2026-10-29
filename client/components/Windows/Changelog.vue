<template>
	<div id="changelog" class="window" :aria-label="ariaLabel">
		<div class="header">
			<SidebarToggle />
		</div>
		<div class="container">
			<router-link id="back-to-help" to="/help">{{
				t("windows.changelog.back")
			}}</router-link>

			<h1 class="title">{{ t("windows.changelog.title", {version: build.release}) }}</h1>

			<p v-if="pastRelease">
				<I18nFrame
					:text="
						t('windows.changelog.pastReleaseLine', {
							commit: KEEP,
							version: build.release,
							since: KEEP,
						})
					"
					><template v-slot:commit
						><a :href="source.commit" target="_blank" rel="noopener"
							><I18nFrame :text="t('help.commitHash', {hash: KEEP})"
								><template v-slot:hash
									><code>{{ build.gitCommit }}</code></template
								></I18nFrame
							></a
						></template
					><template v-slot:since
						><a :href="source.sinceRelease" target="_blank" rel="noopener">{{
							t("windows.changelog.sinceReleaseLink")
						}}</a></template
					></I18nFrame
				>
			</p>
			<p>
				<I18nFrame
					:text="
						t('windows.changelog.notBundledLine', {readNotes: KEEP, allReleases: KEEP})
					"
					><template v-slot:readNotes
						><a :href="source.releaseNotes" target="_blank" rel="noopener">{{
							t("windows.changelog.readNotesLink", {version: build.release})
						}}</a></template
					><template v-slot:allReleases
						><a :href="source.releases" target="_blank" rel="noopener">{{
							t("windows.changelog.allReleasesLink")
						}}</a></template
					></I18nFrame
				>
			</p>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useStore} from "../../js/store";
import {useI18n} from "../../js/i18n";
import {buildIdentityOf, isPastRelease, sourceLinks} from "../../js/helpers/sourceLinks";
import SidebarToggle from "../SidebarToggle.vue";
import I18nFrame from "../I18nFrame.vue";
import {KEEP} from "../../js/i18n/core";

export default defineComponent({
	name: "Changelog",
	components: {
		SidebarToggle,
		I18nFrame,
	},
	setup() {
		const store = useStore();
		const {t} = useI18n();
		const build = computed(() => buildIdentityOf(store.state.serverConfiguration));
		const pastRelease = computed(() => isPastRelease(build.value));
		const source = computed(() => sourceLinks(store.state.branding.links?.source, build.value));
		const ariaLabel = computed(() => t("windows.changelog.aria"));

		return {
			t,
			KEEP,
			ariaLabel,
			build,
			pastRelease,
			source,
		};
	},
});
</script>
