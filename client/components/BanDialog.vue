<template>
	<div
		id="ban-overlay"
		v-backdrop="dismiss"
		class="screen-overlay"
		:class="{opened: !!request}"
		:data-escape-close="request ? 'ban-dialog' : null"
	>
		<form
			v-if="request && network"
			id="ban-dialog"
			role="dialog"
			aria-modal="true"
			:aria-label="title"
			@submit.prevent="submit"
		>
			<div class="oper-action-body">
				<div class="oper-action-title">{{ title }}</div>
				<p v-if="request.edit" class="oper-action-hint">{{ setBy }}</p>

				<label class="oper-action-label" for="ban-mask">{{ t("ban.mask") }}</label>
				<input
					id="ban-mask"
					ref="firstField"
					v-model="mask"
					class="input oper-action-mask"
					type="text"
					dir="ltr"
					spellcheck="false"
					autocapitalize="off"
					autocomplete="off"
					:placeholder="t('ban.maskPlaceholder')"
				/>
				<div v-if="suggestions.length" class="oper-action-suggestions">
					<button
						v-for="s in suggestions"
						:key="s.mask"
						type="button"
						:class="['oper-chip', {active: s.mask === mask}]"
						:title="s.label"
						:aria-label="`${s.label}: ${s.mask}`"
						@click="mask = s.mask"
					>
						{{ s.mask }}
					</button>
				</div>
				<p v-else-if="looking" class="oper-action-hint">{{ t("ban.lookingUp") }}</p>

				<p v-if="maskError" class="oper-action-error">{{ maskError }}</p>
				<template v-else>
					<p
						v-if="preview"
						:class="['oper-action-preview', {wide: preview.wide}]"
						role="status"
					>
						{{ preview.text }}
					</p>
					<p v-if="catchesSelf" class="oper-action-preview wide">{{ t("ban.you") }}</p>
					<p v-if="covering" class="oper-action-preview">
						{{ coveringText }}
						<button type="button" class="ban-dialog-link" @click="editCovering">
							{{ t("ban.editThat") }}
						</button>
					</p>
					<p v-if="replaces > 0" class="oper-action-preview wide">
						{{ tCount("ban.replaces", replaces) }}
					</p>
				</template>

				<template v-if="!request.edit && kickable.length > 0">
					<template v-if="kickable.length <= KICK_LIMIT">
						<label class="oper-action-check">
							<input
								v-model="kick"
								v-switch
								type="checkbox"
								@change="kickTouched = true"
							/>
							{{ t("ban.kick") }}
						</label>
						<template v-if="kick">
							<label class="oper-action-label" for="ban-reason">{{
								t("ban.reason")
							}}</label>
							<input
								id="ban-reason"
								v-model="reason"
								class="input"
								type="text"
								maxlength="250"
								:placeholder="t('ban.reasonPlaceholder')"
							/>
						</template>
					</template>
					<p v-else class="oper-action-hint">
						{{ tCount("ban.kickTooMany", KICK_LIMIT) }}
					</p>
				</template>

				<p v-if="problem" class="oper-action-error" role="alert">{{ problem }}</p>
				<p v-if="result" class="oper-action-result" role="status">{{ result }}</p>
			</div>
			<div class="oper-action-buttons">
				<button
					v-if="request.edit"
					type="button"
					class="oper-btn oper-btn-danger ban-dialog-remove"
					:disabled="busy || !!result"
					@click="remove"
				>
					{{ t("ban.remove") }}
				</button>
				<button
					type="button"
					class="oper-btn oper-btn-ghost oper-cancel"
					:disabled="busy"
					@click="dismiss"
				>
					{{ t("ban.cancel") }}
				</button>
				<button
					type="submit"
					:class="[
						'oper-btn',
						request.edit ? 'oper-btn-primary' : 'oper-btn-danger solid',
						'ban-dialog-submit',
					]"
					:disabled="!canSubmit || busy"
				>
					{{ busy ? t("ban.sending") : submitLabel }}
				</button>
			</div>
		</form>
	</div>
</template>

<style>
#ban-dialog .ban-dialog-link {
	padding: 0;
	border: 0;
	background: none;
	color: var(--link-color);
	font: inherit;
	text-decoration: underline;
	cursor: pointer;
}

#ban-dialog .ban-dialog-remove {
	margin-inline-end: auto;
}
</style>

<script lang="ts">
import {computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch} from "vue";
import eventbus from "../js/eventbus";
import {
	accountBanPrefix,
	BAN_WHO_FIELDS,
	banCovers,
	banMatches,
	banSuggestions,
	type BanTarget,
	checkBanMask,
	KICK_LIMIT,
	normaliseBanMask,
	parseAddress,
	parseMembers,
	sameBan,
} from "../js/helpers/channelBans";
import {banSetText, type BanDialogRequest, changeChannelBans} from "../js/helpers/banMenu";
import {hasVirtualKeyboard} from "../js/helpers/device";
import {lineBudget, lineTooLongText} from "../js/helpers/operLine";
import {userhostItem} from "../js/helpers/operMenu";
import {operRequest} from "../js/helpers/operRequest";
import {useI18n} from "../js/i18n";
import {BANS_STALE_AFTER_MS, banModeLines, kickLine} from "../js/irc/banList";
import {clientForNetwork} from "../js/irc/manager";
import {formatLine} from "../js/irc/message";
import socket from "../js/socket";
import {banListKey, useStore} from "../js/store";
import type {BanChange, BanEntry} from "../../shared/types/ban-list";

/** How many nicks the preview names before saying how many more. */
const NAMED = 8;

let whoTokens = 0;

/**
 * Add, change or remove a channel ban: from Ban… on a nick or an address, or
 * a row of the Bans window (helpers/banMenu.ts). Built like the G-line dialog
 * (Oper/ActionDialog.vue, whose styles it shares). A WHO says who the mask
 * catches here as it is typed, and the channel's list says what the server
 * would do with it: nefarious2 ignores a ban an existing one covers without a
 * word, and takes narrower ones off when a wider one goes on. A channel ban
 * has no reason and no duration; the reason here goes with the kick.
 */
export default defineComponent({
	name: "BanDialog",
	setup() {
		const store = useStore();
		const {t, tCount} = useI18n();
		const request = ref<BanDialogRequest | null>(null);
		const firstField = ref<HTMLInputElement | null>(null);
		const mask = ref("");
		const reason = ref("");
		const kick = ref(false);
		const kickTouched = ref(false);
		const looking = ref(false);
		const busy = ref(false);
		const sendProblem = ref("");
		const result = ref("");
		/** Whoever the dialog is about, as far as it is known. */
		const target = ref<BanTarget | null>(null);
		/** The channel's people; undefined until the WHO is in. */
		const members = ref<BanTarget[] | undefined>();
		const accountPrefix = ref("");
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		/** Bumped on every open and close: an answer to an earlier dialog finds it moved on. */
		let generation = 0;

		const network = computed(() =>
			request.value ? store.getters.findNetwork(request.value.network) : undefined
		);
		const channel = computed(() => request.value?.channel ?? "");
		const client = computed(() =>
			network.value ? clientForNetwork(network.value.uuid) : undefined
		);
		const list = computed(() =>
			network.value
				? store.state.banLists[banListKey(network.value.uuid, channel.value)]
				: undefined
		);
		/** The bans other than the one being edited. */
		const others = computed<BanEntry[]>(() => {
			const editing = request.value?.edit?.mask;
			const rows = list.value?.rows ?? [];
			return editing ? rows.filter((row) => row.mask !== editing) : rows;
		});

		const title = computed(() => {
			const r = request.value;

			if (r?.edit) {
				return t("ban.titleEdit", {channel: channel.value});
			}

			return r?.nick
				? t("ban.titleNick", {nick: r.nick, channel: channel.value})
				: t("ban.titleAdd", {channel: channel.value});
		});
		const setBy = computed(() => (request.value?.edit ? banSetText(request.value.edit) : ""));
		const suggestions = computed(() =>
			target.value && !request.value?.edit
				? banSuggestions(target.value, accountPrefix.value)
				: []
		);
		const maskError = computed(() => (mask.value ? checkBanMask(mask.value) : undefined));
		const usable = computed(() => mask.value.trim() !== "" && !maskError.value);

		/** Who the mask catches here; undefined when that cannot be told. */
		const matched = computed<BanTarget[] | undefined>(() => {
			if (!members.value || !usable.value) {
				return undefined;
			}

			const hits = members.value.map((member) => banMatches(mask.value, member));
			return hits.includes(undefined)
				? undefined
				: members.value.filter((_, index) => hits[index]);
		});
		const isMe = (member: BanTarget) =>
			!!member.nick &&
			(client.value?.isSelf(member.nick) ?? member.nick === network.value?.nick);
		const catchesSelf = computed(() => matched.value?.some(isMe) ?? false);
		const kickable = computed(() => (matched.value ?? []).filter((m) => !isMe(m)));
		const kicking = computed(
			() =>
				!request.value?.edit &&
				kick.value &&
				kickable.value.length > 0 &&
				kickable.value.length <= KICK_LIMIT
		);

		const preview = computed(() => {
			const hits = matched.value;

			if (!hits) {
				return null;
			}

			if (hits.length === 0) {
				return {text: t("ban.preview.none"), wide: false};
			}

			const nicks = hits.map((hit) => hit.nick ?? "");
			const named = nicks.slice(0, NAMED).join(t("oper.list.separator"));
			const more = nicks.length - NAMED;
			return {
				text:
					more > 0
						? tCount("ban.preview.more", nicks.length, {nicks: named, more})
						: tCount("ban.preview.some", nicks.length, {nicks: named}),
				wide: nicks.length >= 5,
			};
		});

		/** A ban the server would take this one as covered by: it would do nothing. */
		const redundant = computed(() =>
			usable.value
				? others.value.find((row) => sameBan(row.mask, mask.value)) ??
				  others.value.find((row) => banCovers(row.mask, mask.value))
				: undefined
		);
		/** That, or any ban already holding the person this dialog is about. */
		const covering = computed(() => {
			const who = target.value;
			return (
				redundant.value ??
				(who && !request.value?.edit
					? others.value.find((row) => banMatches(row.mask, who) === true)
					: undefined)
			);
		});
		const coveringText = computed(() => {
			const row = covering.value;

			if (!row) {
				return "";
			}

			return sameBan(row.mask, mask.value)
				? t("ban.alreadySet")
				: t("ban.covered", {mask: row.mask});
		});
		const replaces = computed(() =>
			usable.value
				? others.value.filter(
						(row) => !sameBan(row.mask, mask.value) && banCovers(mask.value, row.mask)
				  ).length
				: 0
		);

		const submitLabel = computed(() => {
			if (request.value?.edit) {
				return t("ban.save");
			}

			return redundant.value && kicking.value ? t("ban.submitKick") : t("ban.submit");
		});

		const budget = computed(() => {
			const lines = banModeLines(channel.value, ["x"], [normaliseBanMask(mask.value)], 6);
			const longest = kickable.value.reduce(
				(a, b) => ((b.nick ?? "").length > a.length ? b.nick ?? "" : a),
				""
			);

			if (kicking.value) {
				lines.push(kickLine(channel.value, longest, reason.value.trim()));
			}

			const budgets = lines.map(lineBudget);
			return budgets.reduce((a, b) => (b.over > a.over ? b : a), {bytes: 0, over: 0});
		});
		const problem = computed(() => sendProblem.value || lineTooLongText(budget.value));

		const canSubmit = computed(() => {
			const r = request.value;

			if (!r || result.value || !usable.value || budget.value.over > 0) {
				return false;
			}

			if (r.edit) {
				return !sameBan(mask.value, r.edit.mask);
			}

			return !redundant.value || kicking.value;
		});

		// The switch follows who matches until it is touched.
		watch(kickable, (now) => {
			if (!kickTouched.value) {
				kick.value = now.length > 0 && now.length <= KICK_LIMIT;
			}
		});

		const reset = (incoming: BanDialogRequest) => {
			mask.value = incoming.edit?.mask ?? "";
			reason.value = "";
			kick.value = false;
			kickTouched.value = false;
			looking.value = false;
			busy.value = false;
			sendProblem.value = "";
			result.value = "";
			target.value = incoming.edit ? null : {nick: incoming.nick};
			members.value = undefined;
		};

		/** The likeliest mask, unless something is already in the field. */
		const suggest = () => {
			if (!mask.value && suggestions.value.length > 0) {
				mask.value = suggestions.value[0].mask;
			}
		};

		/** Who is in the channel, whom the dialog is about, and the channel's bans. */
		const lookUp = async (r: BanDialogRequest) => {
			const c = clientForNetwork(r.network);
			const asked = generation;
			const held = store.state.banLists[banListKey(r.network, r.channel)];

			if (!held || Date.now() - held.at > BANS_STALE_AFTER_MS) {
				socket.emit("channel:bans:ask", {network: r.network, channel: r.channel});
			}

			const token = String((whoTokens = (whoTokens % 999) + 1));
			const params = c?.isupport.has("WHOX")
				? [r.channel, `%${BAN_WHO_FIELDS},${token}`]
				: [r.channel];
			const fromLine = parseAddress(r.address);
			looking.value = true;
			accountPrefix.value = accountBanPrefix(
				c?.isupport.get("EXTBANS") ?? c?.isupport.get("EXTBAN")
			);

			if (fromLine.host) {
				target.value = {nick: r.nick, ...fromLine};
				suggest();
			}

			const who = await operRequest(r.network, formatLine({command: "WHO", params}), {
				end: ["315"],
			});

			if (asked !== generation) {
				return;
			}

			const people = parseMembers(who.lines, token);
			const same = c ? (a: string, b: string) => c.namesEqual(a, b) : undefined;
			const nick = r.nick;
			const seen = nick
				? people.find((p) => (same ? same(p.nick ?? "", nick) : p.nick === nick))
				: undefined;
			members.value = who.outcome === "closed" ? undefined : people;

			if (r.edit) {
				looking.value = false;
				return;
			}

			// The same person when the line's address is theirs: an account or
			// a real IP to offer. Someone else on the nick is not who was clicked.
			if (seen && (!fromLine.host || seen.host === fromLine.host)) {
				target.value = seen;
			} else if (nick && !fromLine.host) {
				const reply = await operRequest(r.network, `USERHOST ${nick}`, {
					untagged: ["302"],
				});

				if (asked !== generation) {
					return;
				}

				const item = userhostItem(reply.lines, "302", nick, same);
				target.value = {nick, ident: item?.user, host: item?.host};
			}

			looking.value = false;
			suggest();
		};

		// What was typed survives a dismiss and comes back when the same dialog
		// opens again, as in the G-line dialog; a success forgets it.
		const drafts = new Map<string, {mask: string; reason: string; kick: boolean}>();
		const MAX_DRAFTS = 8;
		const keyOf = (r: BanDialogRequest) =>
			[r.network, r.channel, r.nick, r.address, r.edit?.mask].join(" ");

		const open = (incoming: BanDialogRequest) => {
			clearTimeout(closeTimer);
			generation++;
			request.value = incoming;
			reset(incoming);
			const draft = drafts.get(keyOf(incoming));

			if (draft) {
				mask.value = draft.mask;
				reason.value = draft.reason;
				kick.value = draft.kick;
				kickTouched.value = true;
			}

			void lookUp(incoming);

			// Not on a touch phone: the keyboard would come up over the buttons.
			if (!hasVirtualKeyboard()) {
				void nextTick(() => firstField.value?.focus());
			}
		};

		const close = () => {
			generation++;
			request.value = null;
			clearTimeout(closeTimer);
		};

		/** Cancel, the backdrop, Escape: not while a line is out (it cannot be called back). */
		const dismiss = () => {
			if (busy.value) {
				return;
			}

			const r = request.value;

			if (r && !result.value) {
				drafts.delete(keyOf(r)); // re-inserted last: the newest
				drafts.set(keyOf(r), {
					mask: mask.value,
					reason: reason.value,
					kick: kick.value,
				});

				if (drafts.size > MAX_DRAFTS) {
					drafts.delete(drafts.keys().next().value as string);
				}
			}

			close();
		};

		const send = async (change: BanChange, done: string) => {
			const r = request.value;

			if (!r || busy.value) {
				return;
			}

			busy.value = true;
			sendProblem.value = "";
			const asked = generation;
			const reply = await changeChannelBans(r.network, change);

			if (asked !== generation) {
				return;
			}

			busy.value = false;

			switch (reply.outcome) {
				case "ok":
					result.value = done;
					drafts.delete(keyOf(r));
					clearTimeout(closeTimer);
					closeTimer = setTimeout(close, 900);
					break;
				case "unchanged":
					sendProblem.value = t("ban.unchanged");
					break;
				case "refused":
					sendProblem.value = reply.text ?? t("ban.unchanged");
					break;
				case "timeout":
					sendProblem.value = t("ban.silent");
					break;
				default:
					sendProblem.value = t("ban.notConnected");
			}
		};

		const submit = () => {
			const r = request.value;

			if (!r || !canSubmit.value) {
				return;
			}

			const value = normaliseBanMask(mask.value);

			if (r.edit) {
				void send(
					{channel: r.channel, remove: [r.edit.mask], add: [value]},
					t("ban.saved")
				);
				return;
			}

			const nicks = kickable.value.map((m) => m.nick ?? "").filter(Boolean);
			void send(
				{
					channel: r.channel,
					remove: [],
					add: redundant.value ? [] : [value],
					kick: kicking.value ? {nicks, reason: reason.value.trim()} : undefined,
				},
				redundant.value ? t("ban.kicked") : t("ban.banned")
			);
		};

		const remove = () => {
			const r = request.value;

			if (r?.edit) {
				void send({channel: r.channel, remove: [r.edit.mask], add: []}, t("ban.removed"));
			}
		};

		const editCovering = () => {
			const r = request.value;
			const row = covering.value;

			if (r && row) {
				open({network: r.network, channel: r.channel, edit: row});
			}
		};

		const onEscape = (layer: string | null) => {
			if (layer === "ban-dialog") {
				dismiss();
			}
		};

		onMounted(() => {
			eventbus.on("ban:dialog", open);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("ban:dialog", open);
			eventbus.off("escapekey", onEscape);
			clearTimeout(closeTimer);
		});

		return {
			KICK_LIMIT,
			t,
			tCount,
			request,
			network,
			firstField,
			mask,
			reason,
			kick,
			kickTouched,
			looking,
			busy,
			problem,
			result,
			title,
			setBy,
			suggestions,
			maskError,
			preview,
			catchesSelf,
			kickable,
			covering,
			coveringText,
			replaces,
			submitLabel,
			canSubmit,
			dismiss,
			submit,
			remove,
			editCovering,
		};
	},
});
</script>
