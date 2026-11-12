<template>
	<!-- Offered in place (translate/discover.ts): translation is off by the
	     user's own switch, and the people here mostly write in a language
	     that is not theirs. One card, per conversation; "Not now" is kept
	     on this device. -->
	<div
		v-if="shown"
		class="translate-suggest translate-discover"
		role="region"
		aria-labelledby="translate-discover-lead"
	>
		<p id="translate-discover-lead" class="translate-suggest-lead">{{ lead }}</p>
		<p class="translate-suggest-note">{{ t("translate.panel.enableHint") }}</p>
		<div class="translate-suggest-actions">
			<button
				type="button"
				class="btn btn-sm translate-suggest-accept translate-discover-accept"
				@click="accept"
			>
				{{ t("translate.discover.accept") }}
			</button>
			<button
				type="button"
				class="btn btn-sm translate-suggest-decline translate-discover-decline"
				@click="decline"
			>
				{{ t("translate.discover.decline") }}
			</button>
		</div>
	</div>
</template>

<script lang="ts">
import {type PropType, computed, defineComponent, onBeforeUnmount, ref, toRaw, watch} from "vue";
import type {ClientChan, ClientNetwork} from "../js/types";
import {ChanType} from "../../shared/types/chan";
import {useStore} from "../js/store";
import {useI18n} from "../js/i18n";
import {alsoReadLanguages, readingLanguage, translationOffByUser} from "../js/translate/reader";
import {languageName} from "../js/translate/languages";
import {discoverLanguage} from "../js/translate/discover";
import {detectLanguage} from "../js/translate/detect";
import {plainTextOf, wordCount} from "../js/translate/eligibility";
import {namesFor} from "../js/translate/names";
import {channelKey} from "../js/translate/channelStore";
import {declineDiscovery, discoveryDeclined} from "../js/translate/offerDeclines";

/**
 * A line shorter than this is not placed by the detector: one or two words
 * ("ok", "lol", a name) are a guess, and the card should not rest on guesses.
 * The sender's tag places a line of any length.
 */
const DETECT_MIN_WORDS = 3;

/** Lines arrive in bursts (a join's history); one observation per burst. */
const SETTLE_MS = 1500;

export default defineComponent({
	name: "TranslationDiscovery",
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const store = useStore();
		const {t} = useI18n();

		const key = computed(() => channelKey(props.network.uuid, props.channel.name));

		// Whether this conversation may be offered anything at all. Off by
		// the deploy is not off by the user: nothing is offered then.
		const eligible = computed(
			() =>
				translationOffByUser() &&
				(props.channel.type === ChanType.CHANNEL ||
					props.channel.type === ChanType.QUERY) &&
				!discoveryDeclined(props.network.uuid, props.channel.name)
		);

		// The newest observation: the conversation it was made in, and what
		// it found there.
		const found = ref<{key: string; code: string} | null>(null);
		let generation = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const observe = async () => {
			const mine = ++generation;
			const at = key.value;
			const channel = props.channel;
			const messages = toRaw(channel.messages);
			const nicks = namesFor({
				users: toRaw(channel.users),
				target: channel.name,
				messages,
			});
			const reading = readingLanguage();
			// Stripped once a line: the word count and the detector read the same text.
			const plain = new Map<string, string>();
			const plainOf = (text: string) => {
				let out = plain.get(text);

				if (out === undefined) {
					out = plainTextOf(text, nicks);
					plain.set(text, out);
				}

				return out;
			};
			let code: string | null = null;

			try {
				code = await discoverLanguage(
					messages,
					{reading, alsoRead: alsoReadLanguages()},
					async (text) =>
						(
							await detectLanguage(plainOf(text), null, [], {
								exclude: reading,
								learn: false,
							})
						).lang,
					(text) => wordCount(plainOf(text)) >= DETECT_MIN_WORDS
				);
			} catch {
				// The detector would not load: there is nothing to go by, so
				// nothing is offered.
				code = null;
			}

			if (mine === generation) {
				found.value = code ? {key: at, code} : null;
			}
		};

		const schedule = (delay: number) => {
			clearTimeout(timer);
			timer = setTimeout(() => void observe(), delay);
		};

		watch(
			() =>
				[
					eligible.value,
					key.value,
					props.channel.messages.length,
					props.channel.messages[props.channel.messages.length - 1]?.id,
				] as const,
			([ok], previous) => {
				if (!ok) {
					clearTimeout(timer);
					generation++;
					found.value = null;
					return;
				}

				// A new conversation on screen is looked at at once; lines
				// arriving in it wait for the burst to settle.
				schedule(previous && previous[1] === key.value && previous[0] ? SETTLE_MS : 0);
			},
			{immediate: true}
		);

		onBeforeUnmount(() => {
			clearTimeout(timer);
			generation++;
		});

		const shown = computed(
			() => eligible.value && found.value !== null && found.value.key === key.value
		);
		const lead = computed(() => {
			if (!found.value) {
				return "";
			}

			const reading = readingLanguage();

			return t("translate.discover.lead", {
				language: languageName(found.value.code, reading),
				reading: languageName(reading, reading),
			});
		});

		// Turning translation on is the whole setup, as in the sheet: what
		// is on screen is read (reader.ts `resumeReading`).
		const accept = () => {
			found.value = null;
			void store.dispatch("settings/update", {
				name: "translationEnabled",
				value: true,
				sync: true,
			});
		};
		const decline = () => {
			declineDiscovery(props.network.uuid, props.channel.name);
			found.value = null;
		};

		return {t, shown, lead, accept, decline};
	},
});
</script>
