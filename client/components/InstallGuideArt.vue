<template>
	<svg
		class="install-art"
		:data-art="kind"
		:viewBox="viewBox"
		preserveAspectRatio="xMidYMid meet"
		aria-hidden="true"
		focusable="false"
	>
		<!-- Introduction: the app in a window of its own. -->
		<template v-if="kind === 'intro'">
			<rect class="art-frame" x="60" y="28" width="200" height="144" rx="10" />
			<circle class="art-dot" cx="76" cy="42" r="3.5" />
			<circle class="art-dot" cx="88" cy="42" r="3.5" />
			<circle class="art-dot" cx="100" cy="42" r="3.5" />
			<line class="art-rule" x1="60" y1="54" x2="260" y2="54" />
			<circle class="art-halo" cx="160" cy="108" r="42" />
			<image :href="icon" x="128" y="76" width="64" height="64" />
			<text class="art-text art-text-strong" x="160" y="162" text-anchor="middle">
				{{ appName }}
			</text>
		</template>

		<!-- iPhone Safari: the Share button in the bottom toolbar. -->
		<template v-else-if="kind === 'ios-share-bottom'">
			<g>
				<rect class="art-frame" x="100" y="6" width="120" height="188" rx="16" />
				<rect class="art-line" x="112" y="26" width="72" height="5" rx="2.5" />
				<rect class="art-line" x="112" y="38" width="96" height="5" rx="2.5" />
				<rect class="art-line" x="112" y="50" width="84" height="5" rx="2.5" />
				<rect class="art-line" x="112" y="62" width="90" height="5" rx="2.5" />
				<rect class="art-line" x="112" y="74" width="60" height="5" rx="2.5" />
				<rect class="art-pill" x="110" y="146" width="100" height="16" rx="8" />
				<text class="art-text art-text-muted" x="160" y="157.5" text-anchor="middle">
					{{ host }}
				</text>
				<g class="art-glyph">
					<path d="M116 178 l-5 5 l5 5" />
					<path d="M136 178 l5 5 l-5 5" />
					<path d="M177 177 h10 v12 h-10 z M182 177 v12" />
					<rect x="200" y="177" width="9" height="11" rx="1.5" />
				</g>
				<g class="art-accent">
					<circle class="art-ring" cx="160" cy="182" r="12" />
					<path class="art-glyph-accent" d="M160 172 v13 M155 177 l5 -5 l5 5" />
					<path class="art-glyph-accent" d="M154 180 h-1 v11 h14 v-11 h-1" />
				</g>
			</g>
		</template>

		<!-- iPad, and Chrome for iOS: the Share button at the right of the address bar. -->
		<template v-else-if="kind === 'ios-share-top'">
			<rect class="art-frame" x="100" y="6" width="120" height="188" rx="16" />
			<rect class="art-pill" x="110" y="20" width="100" height="16" rx="8" />
			<text class="art-text art-text-muted" x="150" y="31.5" text-anchor="middle">
				{{ host }}
			</text>
			<g class="art-accent">
				<circle class="art-ring" cx="200" cy="28" r="11" />
				<path class="art-glyph-accent" d="M200 19 v11 M196 23 l4 -4 l4 4" />
				<path class="art-glyph-accent" d="M195 26 h-1 v10 h12 v-10 h-1" />
			</g>
			<rect class="art-line" x="112" y="56" width="72" height="5" rx="2.5" />
			<rect class="art-line" x="112" y="68" width="96" height="5" rx="2.5" />
			<rect class="art-line" x="112" y="80" width="84" height="5" rx="2.5" />
			<rect class="art-line" x="112" y="92" width="90" height="5" rx="2.5" />
			<rect class="art-line" x="112" y="104" width="60" height="5" rx="2.5" />
		</template>

		<!-- The iOS share sheet with Add to Home Screen. -->
		<template v-else-if="kind === 'share-sheet'">
			<rect class="art-frame" x="100" y="6" width="120" height="188" rx="16" />
			<rect class="art-line" x="112" y="26" width="72" height="5" rx="2.5" />
			<rect class="art-line" x="112" y="38" width="96" height="5" rx="2.5" />
			<rect class="art-sheet" x="100" y="58" width="120" height="136" rx="14" />
			<rect class="art-grip" x="152" y="64" width="16" height="3" rx="1.5" />
			<circle class="art-line" cx="120" cy="86" r="9" />
			<circle class="art-line" cx="146" cy="86" r="9" />
			<circle class="art-line" cx="172" cy="86" r="9" />
			<circle class="art-line" cx="198" cy="86" r="9" />
			<rect class="art-row" x="108" y="104" width="104" height="17" rx="4" />
			<rect class="art-line" x="116" y="110" width="40" height="5" rx="2.5" />
			<rect class="art-row" x="108" y="123" width="104" height="17" rx="4" />
			<rect class="art-line" x="116" y="129" width="56" height="5" rx="2.5" />
			<g class="art-accent">
				<rect class="art-row-accent" x="108" y="142" width="104" height="19" rx="4" />
				<text class="art-text art-text-accent art-text-small" x="114" y="155">
					Add to Home Screen
				</text>
				<rect class="art-glyph-accent" x="199" y="147" width="9" height="9" rx="2" />
				<path class="art-glyph-accent" d="M203.5 149.5 v4 M201.5 151.5 h4" />
			</g>
			<rect class="art-row" x="108" y="163" width="104" height="17" rx="4" />
			<rect class="art-line" x="116" y="169" width="48" height="5" rx="2.5" />
		</template>

		<!-- The Add to Home Screen confirmation. -->
		<template v-else-if="kind === 'ios-add'">
			<rect class="art-frame" x="100" y="6" width="120" height="188" rx="16" />
			<rect class="art-sheet" x="100" y="40" width="120" height="154" rx="14" />
			<text class="art-text art-text-strong art-text-small" x="108" y="58">
				Add to Home Screen
			</text>
			<g class="art-accent">
				<rect class="art-row-accent" x="190" y="47" width="24" height="16" rx="4" />
				<text class="art-text art-text-accent" x="202" y="58" text-anchor="middle">
					Add
				</text>
			</g>
			<rect class="art-row" x="108" y="74" width="104" height="30" rx="6" />
			<image :href="icon" x="114" y="79" width="20" height="20" />
			<text class="art-text art-text-strong" x="140" y="87">{{ appName }}</text>
			<text class="art-text art-text-muted" x="140" y="98">{{ host }}</text>
			<rect class="art-line" x="112" y="118" width="96" height="5" rx="2.5" />
			<rect class="art-line" x="112" y="130" width="72" height="5" rx="2.5" />
		</template>

		<!-- Android: the browser menu with Install app. -->
		<template v-else-if="kind === 'android-menu'">
			<rect class="art-frame" x="100" y="6" width="120" height="188" rx="12" />
			<rect class="art-pill" x="108" y="16" width="86" height="16" rx="8" />
			<text class="art-text art-text-muted" x="151" y="27.5" text-anchor="middle">
				{{ host }}
			</text>
			<g class="art-accent">
				<circle class="art-ring" cx="206" cy="24" r="9" />
				<circle class="art-glyph-fill" cx="206" cy="19" r="1.6" />
				<circle class="art-glyph-fill" cx="206" cy="24" r="1.6" />
				<circle class="art-glyph-fill" cx="206" cy="29" r="1.6" />
			</g>
			<rect class="art-line" x="108" y="46" width="72" height="5" rx="2.5" />
			<rect class="art-line" x="108" y="58" width="60" height="5" rx="2.5" />
			<rect class="art-sheet" x="128" y="38" width="86" height="118" rx="6" />
			<rect class="art-line" x="136" y="48" width="44" height="5" rx="2.5" />
			<rect class="art-line" x="136" y="64" width="36" height="5" rx="2.5" />
			<rect class="art-line" x="136" y="80" width="52" height="5" rx="2.5" />
			<rect class="art-line" x="136" y="96" width="40" height="5" rx="2.5" />
			<g class="art-accent">
				<rect class="art-row-accent" x="132" y="106" width="78" height="19" rx="4" />
				<path class="art-glyph-accent" d="M141 111 v7 M138 115 l3 3 l3 -3 M137 121 h8" />
				<text class="art-text art-text-accent" x="150" y="119">Install app</text>
			</g>
			<rect class="art-line" x="136" y="134" width="44" height="5" rx="2.5" />
			<rect class="art-line" x="136" y="146" width="30" height="5" rx="2.5" />
		</template>

		<!-- Android: the install confirmation sheet. -->
		<template v-else-if="kind === 'android-confirm'">
			<rect class="art-frame" x="100" y="6" width="120" height="188" rx="12" />
			<rect class="art-line" x="108" y="26" width="72" height="5" rx="2.5" />
			<rect class="art-line" x="108" y="38" width="96" height="5" rx="2.5" />
			<rect class="art-line" x="108" y="50" width="84" height="5" rx="2.5" />
			<rect class="art-sheet" x="100" y="108" width="120" height="86" rx="12" />
			<text class="art-text art-text-strong" x="110" y="126">Install app</text>
			<image :href="icon" x="110" y="136" width="22" height="22" />
			<text class="art-text art-text-strong" x="138" y="145">{{ appName }}</text>
			<text class="art-text art-text-muted" x="138" y="156">{{ host }}</text>
			<text class="art-text art-text-muted" x="152" y="182" text-anchor="middle">Cancel</text>
			<g class="art-accent">
				<rect class="art-button-accent" x="172" y="170" width="40" height="17" rx="8.5" />
				<text class="art-text art-text-on-accent" x="192" y="181.5" text-anchor="middle">
					Install
				</text>
			</g>
		</template>

		<!-- Desktop Chrome and Edge: the install icon at the end of the address bar. -->
		<template v-else-if="kind === 'desktop-omnibox' || kind === 'desktop-confirm'">
			<rect class="art-frame" x="8" y="18" width="304" height="164" rx="8" />
			<rect class="art-tab" x="18" y="24" width="72" height="16" rx="5" />
			<rect class="art-line" x="26" y="29.5" width="36" height="5" rx="2.5" />
			<line class="art-rule" x1="8" y1="40" x2="312" y2="40" />
			<g class="art-glyph">
				<path d="M22 50 l-4 4 l4 4" />
				<path d="M36 50 l4 4 l-4 4" />
				<path d="M54 50 a4.5 4.5 0 1 1 -2 -4" />
			</g>
			<rect class="art-pill" x="68" y="46" width="230" height="16" rx="8" />
			<text class="art-text art-text-muted" x="80" y="57.5">{{ host }}</text>
			<path
				class="art-glyph"
				d="M266 50 l1.8 3.8 l4.2 0.5 l-3 2.9 l0.8 4.1 l-3.8 -2 l-3.8 2 l0.8 -4.1 l-3 -2.9 l4.2 -0.5 z"
			/>
			<g class="art-accent">
				<circle class="art-ring" cx="286" cy="54" r="9" />
				<rect class="art-glyph-accent" x="280" y="49" width="12" height="8" rx="1.5" />
				<path class="art-glyph-accent" d="M283 60 h6 M286 51 v4 M284 53.5 l2 2 l2 -2" />
			</g>
			<line class="art-rule" x1="8" y1="68" x2="312" y2="68" />
			<rect class="art-line" x="24" y="84" width="140" height="5" rx="2.5" />
			<rect class="art-line" x="24" y="98" width="200" height="5" rx="2.5" />
			<rect class="art-line" x="24" y="112" width="170" height="5" rx="2.5" />
			<rect class="art-line" x="24" y="126" width="190" height="5" rx="2.5" />
			<rect class="art-line" x="24" y="140" width="120" height="5" rx="2.5" />
			<template v-if="kind === 'desktop-confirm'">
				<rect class="art-sheet" x="168" y="70" width="138" height="78" rx="6" />
				<text class="art-text art-text-strong" x="178" y="86">Install app?</text>
				<image :href="icon" x="178" y="94" width="20" height="20" />
				<text class="art-text art-text-strong" x="204" y="103">{{ appName }}</text>
				<text class="art-text art-text-muted" x="204" y="113">{{ host }}</text>
				<text class="art-text art-text-muted" x="208" y="137" text-anchor="middle">
					Cancel
				</text>
				<g class="art-accent">
					<rect class="art-button-accent" x="240" y="125" width="56" height="17" rx="4" />
					<text
						class="art-text art-text-on-accent"
						x="268"
						y="136.5"
						text-anchor="middle"
					>
						Install
					</text>
				</g>
			</template>
		</template>

		<!-- macOS Safari: File → Add to Dock. -->
		<template v-else-if="kind === 'mac-dock'">
			<rect class="art-frame" x="8" y="18" width="304" height="164" rx="8" />
			<rect class="art-menubar" x="8" y="18" width="304" height="14" rx="8" />
			<rect class="art-menubar" x="8" y="25" width="304" height="7" />
			<text class="art-text art-text-strong" x="20" y="28.5">Safari</text>
			<rect class="art-row-accent" x="50" y="19" width="20" height="12" rx="3" />
			<text class="art-text art-text-accent" x="60" y="28.5" text-anchor="middle">File</text>
			<text class="art-text art-text-muted" x="78" y="28.5">Edit</text>
			<text class="art-text art-text-muted" x="100" y="28.5">View</text>
			<text class="art-text art-text-muted" x="126" y="28.5">History</text>
			<rect class="art-line" x="24" y="50" width="140" height="5" rx="2.5" />
			<rect class="art-line" x="24" y="64" width="200" height="5" rx="2.5" />
			<rect class="art-line" x="24" y="78" width="170" height="5" rx="2.5" />
			<rect class="art-sheet" x="50" y="34" width="110" height="92" rx="6" />
			<rect class="art-line" x="58" y="42" width="44" height="5" rx="2.5" />
			<rect class="art-line" x="58" y="56" width="60" height="5" rx="2.5" />
			<line class="art-rule" x1="54" y1="68" x2="156" y2="68" />
			<g class="art-accent">
				<rect class="art-row-accent" x="54" y="72" width="102" height="19" rx="4" />
				<text class="art-text art-text-accent" x="62" y="85">Add to Dock…</text>
			</g>
			<rect class="art-line" x="58" y="100" width="52" height="5" rx="2.5" />
			<rect class="art-line" x="58" y="112" width="36" height="5" rx="2.5" />
			<rect class="art-dock" x="100" y="156" width="120" height="20" rx="6" />
			<rect class="art-line" x="108" y="160" width="12" height="12" rx="3" />
			<rect class="art-line" x="126" y="160" width="12" height="12" rx="3" />
			<rect class="art-line" x="144" y="160" width="12" height="12" rx="3" />
			<image :href="icon" x="162" y="160" width="12" height="12" />
			<rect class="art-line" x="180" y="160" width="12" height="12" rx="3" />
			<rect class="art-line" x="198" y="160" width="12" height="12" rx="3" />
		</template>

		<!-- The finished result: the app among the others. -->
		<template v-else>
			<rect class="art-frame" x="100" y="6" width="120" height="188" rx="16" />
			<template v-for="(cell, i) in homeCells" :key="i">
				<rect
					v-if="!cell.app"
					class="art-line"
					:x="cell.x"
					:y="cell.y"
					width="18"
					height="18"
					rx="4"
				/>
			</template>
			<g class="art-accent">
				<circle class="art-halo" cx="160" cy="105" r="22" />
				<image :href="icon" x="149" y="94" width="22" height="22" />
			</g>
			<text class="art-text art-text-strong" x="160" y="130" text-anchor="middle">
				{{ appName }}
			</text>
			<rect class="art-dock" x="108" y="164" width="104" height="22" rx="8" />
			<rect class="art-line" x="118" y="169" width="12" height="12" rx="3" />
			<rect class="art-line" x="140" y="169" width="12" height="12" rx="3" />
			<rect class="art-line" x="168" y="169" width="12" height="12" rx="3" />
			<rect class="art-line" x="190" y="169" width="12" height="12" rx="3" />
		</template>
	</svg>
</template>

<style>
/* Every drawing takes its colours from the theme: the frames are the window
 * colour, the placeholder lines a muted body colour, and the one control the
 * step is about wears the accent. Nothing here is a screenshot on purpose:
 * a schematic reads the same in every theme and every OS version. */
.install-art {
	display: block;
	width: 100%;
	height: 100%;
	font-family: inherit;
}

.install-art .art-frame {
	fill: var(--window-bg-color);
	stroke: var(--body-color-muted);
	stroke-opacity: 0.55;
	stroke-width: 1.5;
}

.install-art .art-sheet {
	fill: var(--window-bg-color);
	stroke: var(--body-color-muted);
	stroke-opacity: 0.4;
	stroke-width: 1;
	filter: drop-shadow(0 2px 6px rgb(0 0 0 / 22%));
}

.install-art .art-line,
.install-art .art-dot {
	fill: var(--body-color-muted);
	fill-opacity: 0.35;
}

.install-art .art-grip {
	fill: var(--body-color-muted);
	fill-opacity: 0.6;
}

.install-art .art-pill,
.install-art .art-tab,
.install-art .art-row,
.install-art .art-dock,
.install-art .art-menubar {
	fill: var(--body-color-muted);
	fill-opacity: 0.14;
}

.install-art .art-rule {
	stroke: var(--body-color-muted);
	stroke-opacity: 0.35;
	stroke-width: 1;
}

.install-art .art-glyph {
	fill: none;
	stroke: var(--body-color-muted);
	stroke-width: 1.6;
	stroke-linecap: round;
	stroke-linejoin: round;
}

.install-art path.art-glyph {
	fill: none;
}

.install-art .art-glyph-accent {
	fill: none;
	stroke: var(--button-color);
	stroke-width: 1.8;
	stroke-linecap: round;
	stroke-linejoin: round;
}

.install-art .art-glyph-fill {
	fill: var(--button-color);
}

.install-art .art-ring {
	fill: var(--button-color);
	fill-opacity: 0.16;
	stroke: var(--button-color);
	stroke-width: 1.8;
}

.install-art .art-halo {
	fill: var(--button-color);
	fill-opacity: 0.14;
}

.install-art .art-row-accent {
	fill: var(--button-color);
	fill-opacity: 0.18;
}

.install-art .art-button-accent {
	fill: var(--button-color);
}

.install-art .art-text {
	fill: var(--body-color);
	font-size: 9px;
	font-weight: 500;
}

.install-art .art-text-strong {
	font-weight: 700;
}

.install-art .art-text-small {
	font-size: 8px;
}

.install-art .art-text-muted {
	fill: var(--body-color-muted);
	font-size: 8px;
}

.install-art .art-text-accent {
	fill: var(--button-color);
	font-weight: 700;
}

.install-art .art-text-on-accent {
	fill: var(--button-text-color-hover, #fff);
	font-weight: 700;
}
</style>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import type {InstallArt} from "../js/helpers/installGuide";

const PHONE_ART = new Set<InstallArt>([
	"ios-share-bottom",
	"ios-share-top",
	"share-sheet",
	"ios-add",
	"android-menu",
	"android-confirm",
	"home-screen",
]);

/**
 * The install guide's illustrations: one schematic per step, drawn inline
 * so they follow the theme. The app's own icon stands in wherever the
 * platform would show it (the confirmation, the home screen).
 */
export default defineComponent({
	name: "InstallGuideArt",
	props: {
		kind: {type: String as PropType<InstallArt>, required: true},
		appName: {type: String, required: true},
	},
	setup(props) {
		// Relative, like every asset the page loads: a deploy under a path
		// keeps working.
		const icon = "img/icon-192.png";

		const host = computed(() => {
			if (typeof location === "undefined" || !location.hostname) {
				return "irc.example.org";
			}

			return location.hostname.length > 22
				? location.hostname.slice(0, 20) + "…"
				: location.hostname;
		});

		// Four columns of home-screen icons; the app takes the centre.
		const homeCells = computed(() => {
			const cells: Array<{x: number; y: number; app: boolean}> = [];
			const xs = [114, 138, 162, 186];
			const ys = [28, 56, 84, 112];

			for (const y of ys) {
				for (const x of xs) {
					cells.push({x, y, app: (y === 84 || y === 112) && (x === 138 || x === 162)});
				}
			}

			return cells;
		});

		// A phone drawing is cropped to the phone, so it fills the panel's
		// height instead of sitting small in the middle of a wide canvas.
		const viewBox = computed(() =>
			PHONE_ART.has(props.kind) ? "92 0 136 200" : "0 0 320 200"
		);

		return {icon, host, homeCells, viewBox};
	},
});
</script>
