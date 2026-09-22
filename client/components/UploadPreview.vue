<template>
	<div
		id="upload-preview-overlay"
		:class="{opened: request !== null}"
		:data-escape-close="request !== null ? '' : null"
		@transitionend.self="onOverlayShown"
	>
		<div
			v-if="request !== null"
			id="upload-preview"
			role="dialog"
			aria-modal="true"
			aria-labelledby="upload-preview-title"
		>
			<div class="confirm-text">
				<div id="upload-preview-title" class="confirm-text-title">{{ title }}</div>
				<p class="upload-preview-hint">
					Check that this is what you meant to share, then upload. Anyone who can open the
					link will be able to see it.
				</p>
				<ul class="upload-preview-list">
					<li
						v-for="item in items"
						:key="item.key"
						:class="['upload-preview-item', 'kind-' + item.kind]"
					>
						<div class="upload-preview-media">
							<img
								v-if="item.kind === 'image' && item.url"
								:src="item.url"
								alt=""
								decoding="async"
								@load="onImageLoad(item, $event)"
								@error="item.kind = 'file'"
							/>
							<video
								v-else-if="item.kind === 'video' && item.url"
								:src="item.url"
								muted
								controls
								playsinline
								preload="metadata"
								@error="item.kind = 'file'"
							></video>
							<audio
								v-else-if="item.kind === 'audio' && item.url"
								:src="item.url"
								controls
								preload="metadata"
								@error="item.kind = 'file'"
							></audio>
							<span v-else class="upload-preview-badge" aria-hidden="true">
								{{ extensionOf(item.file) }}
							</span>
						</div>
						<div class="upload-preview-meta">
							<span class="upload-preview-name" :title="item.file.name">
								{{ item.file.name }}
							</span>
							<span class="upload-preview-details">{{ details(item) }}</span>
							<span
								v-if="noteFor(item)"
								:class="['upload-preview-note', 'plan-' + item.plan]"
							>
								{{ noteFor(item) }}
							</span>
						</div>
						<button
							type="button"
							class="upload-preview-remove"
							:aria-label="`Don't upload ${item.file.name}`"
							title="Don't upload this file"
							@click="remove(item)"
						>
							✕
						</button>
					</li>
				</ul>
			</div>
			<div class="confirm-buttons">
				<button type="button" class="btn btn-cancel" @click="close(false)">Cancel</button>
				<button
					id="upload-preview-confirm"
					ref="confirmButton"
					type="button"
					class="btn"
					@click="close(true)"
				>
					{{ items.length > 1 ? `Upload ${items.length} files` : "Upload" }}
				</button>
			</div>
		</div>
	</div>
</template>

<style>
#upload-preview {
	background: var(--body-bg-color);
	color: #fff;
	margin: 10px;
	border-radius: 5px;
	width: min(640px, calc(100vw - 20px));
	max-height: calc(100vh - 20px);
	display: flex;
	flex-direction: column;
}

#upload-preview .confirm-text {
	padding: 15px;
	user-select: text;
	overflow-y: auto;
	min-height: 0;
}

#upload-preview .confirm-text-title {
	font-size: 1.25rem;
	font-weight: 700;
	margin-bottom: 6px;
}

#upload-preview .upload-preview-hint {
	margin: 0 0 12px;
	opacity: 0.75;
	font-size: 0.875rem;
}

#upload-preview .upload-preview-list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

#upload-preview .upload-preview-item {
	display: grid;
	grid-template-columns: minmax(96px, 200px) minmax(0, 1fr) auto;
	gap: 12px;
	align-items: center;
	padding: 8px;
	border-radius: 4px;
	background: rgb(0 0 0 / 20%);
}

#upload-preview .upload-preview-media {
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 64px;
	max-height: 240px;
	border-radius: 3px;
	overflow: hidden;
	background: rgb(0 0 0 / 30%);
}

#upload-preview .upload-preview-media img,
#upload-preview .upload-preview-media video {
	display: block;
	max-width: 100%;
	max-height: 240px;
	object-fit: contain;
}

#upload-preview .upload-preview-media audio {
	width: 100%;
	max-width: 200px;
}

#upload-preview .upload-preview-badge {
	font-weight: 700;
	font-size: 1rem;
	letter-spacing: 1px;
	padding: 20px 8px;
	opacity: 0.8;
}

#upload-preview .upload-preview-meta {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}

#upload-preview .upload-preview-name {
	font-weight: 700;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

#upload-preview .upload-preview-details {
	font-size: 0.875rem;
	opacity: 0.75;
}

#upload-preview .upload-preview-note {
	font-size: 0.8125rem;
	opacity: 0.85;
}

#upload-preview .upload-preview-note.plan-strip {
	color: var(--button-color);
}

#upload-preview .upload-preview-remove {
	width: 28px;
	height: 28px;
	padding: 0;
	border: 0;
	border-radius: 3px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 1rem;
	line-height: 28px;
	opacity: 0.7;
	cursor: pointer;
}

#upload-preview .upload-preview-remove:hover,
#upload-preview .upload-preview-remove:focus-visible {
	background: rgb(255 255 255 / 12%);
	opacity: 1;
	outline: 0;
}

#upload-preview .confirm-buttons {
	display: flex;
	justify-content: flex-end;
	padding: 15px;
	background: rgb(0 0 0 / 30%);
	flex: 0 0 auto;
}

#upload-preview .confirm-buttons .btn {
	margin-bottom: 0;
	margin-left: 10px;
}

#upload-preview .confirm-buttons .btn-cancel {
	border-color: transparent;
}

@media (max-width: 480px) {
	#upload-preview .upload-preview-item {
		grid-template-columns: minmax(0, 1fr) auto;
	}

	#upload-preview .upload-preview-media {
		grid-column: 1 / -1;
		max-height: 200px;
	}
}
</style>

<script lang="ts">
import {defineComponent, nextTick, onMounted, onUnmounted, ref} from "vue";
import eventbus from "../js/eventbus";
import {useStore} from "../js/store";
import friendlysize from "../js/helpers/friendlysize";
import {hasVirtualKeyboard} from "../js/helpers/device";
import {MetadataPlan, UploadConfirmRequest, metadataPlan} from "../js/upload";

// The "is this really the file you meant?" step of a file upload. Every way
// of starting one (a drop, a paste, the paperclip) goes through
// `Uploader.triggerUpload`, whose host emits `upload:confirm` with the files
// that passed the size and type checks; this dialog shows them — an image
// straight from an object URL (so an animated one animates), a muted video,
// an audio control, or a badge with the extension — lets the user drop any of
// them, and answers with the ones to send. An empty answer cancels the lot.
//
// The note under an image says what the "remove metadata" setting will do to
// it, so the user knows a photo's EXIF goes and an animation stays whole.

type PreviewKind = "image" | "video" | "audio" | "file";

interface PreviewItem {
	key: number;
	file: File;
	kind: PreviewKind;
	/** Object URL for the media element; `null` for a plain file. */
	url: string | null;
	width: number;
	height: number;
	/** Filled in asynchronously; `null` until known. */
	plan: MetadataPlan | null;
}

const NOTES: Record<MetadataPlan, string> = {
	strip: "Metadata (EXIF) will be removed before upload",
	off: "Sent as it is, metadata included",
	animated: "Animated — sent as it is, so the animation is kept",
	unsupported: "Sent as it is",
	"not-image": "",
};

function kindOf(file: File): PreviewKind {
	const type = file.type.toLowerCase();

	if (type.startsWith("image/")) {
		return "image";
	}

	if (type.startsWith("video/")) {
		return "video";
	}

	if (type.startsWith("audio/")) {
		return "audio";
	}

	return "file";
}

export default defineComponent({
	name: "UploadPreview",
	setup() {
		const store = useStore();
		const request = ref<UploadConfirmRequest | null>(null);
		const items = ref<PreviewItem[]>([]);
		const title = ref("Upload this file?");
		const confirmButton = ref<HTMLButtonElement>();
		let nextKey = 1;

		const revoke = (item: PreviewItem) => {
			if (item.url) {
				URL.revokeObjectURL(item.url);
				item.url = null;
			}
		};

		const close = (confirmed: boolean) => {
			const current = request.value;

			if (!current) {
				return;
			}

			const files = confirmed ? items.value.map((item) => item.file) : [];

			items.value.forEach(revoke);
			items.value = [];
			request.value = null;

			current.resolve(files);

			// Back to the message input, where the URL is about to land —
			// unless that would pop a touch device's on-screen keyboard.
			if (!hasVirtualKeyboard()) {
				document.getElementById("input")?.focus();
			}
		};

		/**
		 * Focus the Upload button so Enter confirms. The overlay fades in with
		 * a `visibility` transition, and a hidden element cannot take focus,
		 * so this runs both right after the render (browsers without the
		 * transition) and when the fade has ended.
		 */
		const focusConfirm = () => {
			if (request.value) {
				confirmButton.value?.focus();
			}
		};

		const onOverlayShown = (event: TransitionEvent) => {
			if (event.propertyName === "opacity") {
				focusConfirm();
			}
		};

		const open = (incoming: UploadConfirmRequest) => {
			// The uploader serialises requests, so a second one cannot arrive
			// while this is open; if it ever did, answering the first with
			// nothing is the safe outcome.
			if (request.value) {
				close(false);
			}

			incoming.claimed = true;
			request.value = incoming;
			title.value = incoming.files.length > 1 ? "Upload these files?" : "Upload this file?";

			items.value = incoming.files.map((file) => {
				const kind = kindOf(file);

				return {
					key: nextKey++,
					file,
					kind,
					url: kind === "file" ? null : URL.createObjectURL(file),
					width: 0,
					height: 0,
					plan: null,
				};
			});

			// Through the reactive array, not the objects above: a write to a
			// raw object never re-renders, and the plan lands after the fact.
			for (const item of items.value) {
				void metadataPlan(item.file, store.state.settings.uploadCanvas).then((plan) => {
					item.plan = plan;
				});
			}

			void nextTick(focusConfirm);
		};

		const remove = (item: PreviewItem) => {
			revoke(item);
			items.value = items.value.filter((other) => other !== item);

			if (items.value.length === 0) {
				close(false);
			}
		};

		const onImageLoad = (item: PreviewItem, event: Event) => {
			const img = event.target as HTMLImageElement;
			item.width = img.naturalWidth;
			item.height = img.naturalHeight;
		};

		const extensionOf = (file: File) => {
			const dot = file.name.lastIndexOf(".");
			const extension = dot > 0 ? file.name.slice(dot + 1) : "";

			return (extension || file.type.split("/")[1] || "file").toUpperCase().slice(0, 6);
		};

		const details = (item: PreviewItem) => {
			const parts = [friendlysize(item.file.size)];

			if (item.width && item.height) {
				parts.push(`${item.width}×${item.height}`);
			}

			if (item.file.type) {
				parts.push(item.file.type);
			}

			return parts.join(" · ");
		};

		const noteFor = (item: PreviewItem) => (item.plan ? NOTES[item.plan] : "");

		const onEscape = () => close(false);

		onMounted(() => {
			eventbus.on("upload:confirm", open);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("upload:confirm", open);
			eventbus.off("escapekey", onEscape);
			close(false);
		});

		return {
			request,
			items,
			title,
			confirmButton,
			close,
			remove,
			onOverlayShown,
			onImageLoad,
			extensionOf,
			details,
			noteFor,
		};
	},
});
</script>
