<template>
	<div
		id="push-prompt-overlay"
		:class="{opened: webpush.pushPrompt.visible}"
		:data-escape-close="webpush.pushPrompt.visible ? '' : null"
	>
		<div
			v-if="webpush.pushPrompt.visible"
			id="push-prompt"
			:class="webpush.pushPrompt.kind"
			role="dialog"
			aria-modal="true"
		>
			<div v-if="webpush.pushPrompt.kind === 'renew'" class="confirm-text">
				<div class="confirm-text-title">Renew push notifications?</div>
				<p class="push-prompt-target">
					<strong>{{ target.name }}</strong>
					<span v-if="target.server"> · {{ target.server }}</span>
					<span v-if="target.account"> · {{ target.account }}</span>
				</p>
				<p>
					This server's push key changed, so this device's push subscription for it no
					longer works. Subscribe again to keep being notified while the app is closed.
					You can also do this later from this network's settings.
				</p>
			</div>
			<div v-else class="confirm-text">
				<div class="confirm-text-title">Enable push notifications?</div>
				<p class="push-prompt-target">
					<strong>{{ target.name }}</strong>
					<span v-if="target.server"> · {{ target.server }}</span>
					<span v-if="target.account"> · {{ target.account }}</span>
				</p>
				<p>
					This server can wake this app when it has messages for you while it is closed.
					You can change this per network, in each network's settings.
				</p>
			</div>
			<div class="confirm-buttons">
				<button id="pushPromptNever" type="button" class="btn" @click.prevent="never">
					Never
				</button>
				<button id="pushPromptNo" type="button" class="btn btn-cancel" @click.prevent="no">
					No
				</button>
				<button id="pushPromptYes" type="button" class="btn" @click.prevent="yes">
					Yes
				</button>
			</div>
		</div>
	</div>
</template>

<style>
#push-prompt {
	background: var(--body-bg-color);
	color: #fff;
	margin: 10px;
	border-radius: 5px;
	max-width: 500px;
}

#push-prompt .confirm-text {
	padding: 15px;
	user-select: text;
}

#push-prompt .confirm-text-title {
	font-size: 1.25rem;
	font-weight: 700;
	margin-bottom: 10px;
}

#push-prompt .push-prompt-target {
	opacity: 0.85;
	margin-bottom: 10px;
}

#push-prompt .confirm-buttons {
	display: flex;
	justify-content: flex-end;
	padding: 15px;
	background: rgba(0, 0, 0, 0.3);
}

#push-prompt .confirm-buttons .btn {
	margin-bottom: 0;
	margin-left: 10px;
}

#push-prompt .confirm-buttons .btn-cancel {
	border-color: transparent;
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted} from "vue";
import eventbus from "../js/eventbus";
import {useStore} from "../js/store";
import webpush from "../js/webpush";
import * as saved from "../js/irc/saved-networks";

/**
 * The connect-time push prompt (yes / no / never), in two variants:
 * "enable push notifications?" when nothing is subscribed, and "renew?"
 * when the stored subscription was made against a VAPID key the server no
 * longer announces (a rotation — the browser refuses to re-subscribe until
 * the old subscription is dropped, and doing that silently would leave a
 * device that stopped receiving pushes without a word). webpush.ts decides
 * when to show which — once per connection that logged in with SASL on a
 * push-capable network, unless this device answered "never" to that
 * question. "Yes" runs the subscribe flow, so the button click doubles as
 * the permission user gesture. Both variants name the network that asked
 * (display name, server, account): a deploy may span several networks, and
 * a renewal concerns one server's key.
 */
export default defineComponent({
	name: "PushPrompt",
	setup() {
		const store = useStore();

		// The network whose connect opened the prompt: its live name (ISUPPORT
		// NETWORK when the entry has none), the server it dials, the account
		// the push registration belongs to.
		const target = computed(() => {
			const uuid = webpush.pushPrompt.network;
			const entry = uuid ? saved.get(uuid) : undefined;
			const live = uuid ? store.getters.findNetwork(uuid) : null;

			return {
				name: live?.name || entry?.name || entry?.host || "this network",
				server: entry ? `${entry.host}:${entry.port}` : "",
				account: entry?.saslAccount ?? "",
			};
		});

		const no = () => webpush.declinePrompt();
		const never = () => webpush.neverPrompt();
		const yes = () => webpush.acceptPrompt();

		const onEscape = () => {
			if (webpush.pushPrompt.visible) {
				no();
			}
		};

		onMounted(() => {
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("escapekey", onEscape);
		});

		return {
			webpush,
			target,
			no,
			never,
			yes,
		};
	},
});
</script>
