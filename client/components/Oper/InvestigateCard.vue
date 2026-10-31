<template>
	<div
		id="oper-investigate-overlay"
		class="screen-overlay"
		v-backdrop="close"
		:class="{opened: !!top}"
		:data-escape-close="top ? 'oper-investigate' : null"
	>
		<div
			v-if="top && network && model"
			class="settings-modal oper-investigate"
			:class="{'oper-investigate-compare': !!compareModel}"
			role="dialog"
			aria-modal="true"
			:aria-label="title"
		>
			<div class="settings-modal-header">
				<h1>
					<span v-if="stack.length > 1" class="oper-muted oper-investigate-back"
						>{{ stack[stack.length - 2].request.target }} ›
					</span>
					{{ top.request.target
					}}<span class="oper-modal-network"> · {{ network.name }}</span>
				</h1>
				<button
					class="settings-modal-close"
					type="button"
					aria-label="Close the card"
					@click="close"
				>
					✕
				</button>
			</div>

			<div class="settings-modal-body">
				<div class="container oper-investigate-body">
					<div v-if="note && !editingNote" class="oper-note">
						<span class="oper-note-text">{{ note }}</span>
						<button type="button" class="btn btn-small" @click="editNote">Edit</button>
					</div>
					<div v-if="editingNote" class="oper-note oper-note-edit">
						<textarea
							ref="noteField"
							v-model="noteDraft"
							class="input"
							rows="2"
							:placeholder="`A note about ${noteKey}, kept on this device`"
							@keydown.esc.stop="editingNote = false"
						></textarea>
						<div class="oper-note-buttons">
							<button type="button" class="btn btn-small" @click="saveNote">
								Save
							</button>
							<button
								type="button"
								class="btn btn-small btn-cancel"
								@click="editingNote = false"
							>
								Cancel
							</button>
						</div>
					</div>

					<!-- ------------------------------------------------ channel -->
					<template v-if="model.kind === 'channel'">
						<dl class="oper-report-entries oper-facts">
							<div>
								<dt>Created</dt>
								<dd>
									<time
										v-if="model.createdAt !== undefined"
										:title="absolute(model.createdAt)"
										>{{ relative(model.createdAt) }}</time
									>
									<span v-else class="oper-muted">{{
										pending("check", "chaninfo")
									}}</span>
								</dd>
							</div>
							<div>
								<dt>Modes</dt>
								<dd>
									<code v-if="model.modes" class="oper-mono">{{
										model.modes
									}}</code>
									<span v-else class="oper-muted">{{
										sources.check === "asking" || sources.chaninfo === "asking"
											? "asking…"
											: "(none)"
									}}</span>
								</dd>
							</div>
							<div>
								<dt>Topic</dt>
								<dd>
									<template v-if="model.topic"
										><ParsedMessage
											:network="network"
											:text="model.topic"
										/><span v-if="model.topicBy" class="oper-muted">
											· set by {{ model.topicBy }}</span
										></template
									>
									<span v-else class="oper-muted">{{
										sources.check === "asking" || sources.chaninfo === "asking"
											? "asking…"
											: "(none)"
									}}</span>
								</dd>
							</div>
							<div>
								<dt>Registered</dt>
								<dd>
									<template v-if="model.registered"
										>Yes<span v-if="model.registeredSince" class="oper-muted">
											· {{ model.registeredSince }} ago</span
										><span v-if="model.owner" class="oper-muted">
											· owner {{ model.owner }}</span
										></template
									>
									<span v-else-if="model.registered === false" class="oper-muted"
										>No</span
									>
									<span v-else class="oper-muted">{{
										sources.registration === "asking" ? "asking…" : "—"
									}}</span>
								</dd>
							</div>
							<div>
								<dt>Bans</dt>
								<dd>
									<template
										v-if="sources.check !== 'asking' || model.bans.length"
										>{{ model.bans.length }}</template
									>
									<span v-else class="oper-muted">asking…</span>
								</dd>
							</div>
						</dl>

						<section class="oper-common">
							<h3 class="oper-report-section-title">
								What most users have in common
							</h3>
							<p v-if="common && common.facts.length" class="oper-common-facts">
								<span class="oper-common-lead"
									>{{ commonCount }} of {{ common.total }} users:</span
								>
								<span
									v-for="fact in common.facts"
									:key="fact.key"
									class="oper-chip-static oper-common-chip"
									:title="`${fact.count} of ${common.total} users`"
									>{{ fact.label
									}}<span v-if="fact.count !== commonCount" class="oper-muted">
										· {{ fact.count }}</span
									></span
								>
							</p>
							<p v-else class="oper-muted">
								{{
									model.users.length < 3
										? "Too few users to compare."
										: sources.who === "asking" || sources.check === "asking"
										? "asking…"
										: "Nothing that most of them share."
								}}
							</p>
							<div class="oper-common-actions">
								<button
									type="button"
									class="btn btn-small"
									:disabled="!common || !common.facts.length"
									@click="alertOnThis"
								>
									Alert on this…
								</button>
								<button
									v-if="hasLookups"
									type="button"
									class="btn btn-small"
									:disabled="
										!common ||
										!common.facts.length ||
										model.traceCount?.state === 'asking'
									"
									@click="traceCount"
								>
									Trace count
								</button>
								<span v-if="model.traceCount" class="oper-trace-count">
									<template v-if="model.traceCount.state === 'asking'"
										>asking…</template
									>
									<template v-else-if="model.traceCount.state === 'done'"
										>{{ model.traceCount.count }} users match right
										now</template
									>
									<template v-else>O3 could not count them</template>
								</span>
							</div>
						</section>

						<section class="oper-users">
							<div class="oper-users-head">
								<h3 class="oper-report-section-title">
									Users · {{ model.users.length }}
								</h3>
								<label class="oper-users-sort">
									sort
									<select v-model="sortBy" class="input">
										<option value="joined">joined</option>
										<option value="nick">nick</option>
										<option value="host">host</option>
									</select>
								</label>
							</div>
							<p v-if="!model.users.length" class="oper-muted">
								{{
									sources.who === "asking" || sources.check === "asking"
										? "asking…"
										: notes.who ?? notes.check ?? "nobody"
								}}
							</p>
							<ul v-else class="oper-user-list">
								<li
									v-for="u in sortedUsers"
									:key="u.nick"
									:class="[
										'oper-user-block',
										{'same-all': sharesAll(u.nick), odd: sharesNone(u.nick)},
									]"
								>
									<div class="oper-user-line">
										<button
											type="button"
											class="oper-user-nick"
											:title="`Investigate ${u.nick}`"
											@click="openUser(u.nick)"
										>
											{{ u.nick }}
										</button>
										<span v-if="u.op" class="oper-chip-static">op</span>
										<span v-if="u.voice" class="oper-chip-static">voice</span>
										<span v-if="u.oper" class="oper-chip-static">oper</span>
										<span
											v-if="u.authed"
											:class="[
												'oper-chip-static',
												{same: shares(u.nick, 'authed')},
											]"
											>authed</span
										>
										<span v-if="u.away" class="oper-chip-static">away</span>
										<span class="oper-muted oper-user-timing">
											<template v-if="u.joinedAt !== undefined"
												>joined {{ clock(u.joinedAt) }}</template
											>
											<template
												v-if="
													u.joinedAt !== undefined &&
													u.connectedAt !== undefined
												"
											>
												·
											</template>
											<span
												v-if="u.connectedAt !== undefined"
												:class="{same: shares(u.nick, 'connectAge')}"
												>online {{ duration(now - u.connectedAt) }}</span
											>
										</span>
									</div>
									<div class="oper-user-line oper-mono">
										<span :class="{same: shares(u.nick, 'identShape')}">{{
											u.ident ?? "?"
										}}</span
										>@<button
											v-if="u.host && u.host !== u.ip"
											type="button"
											class="oper-chip oper-chip-host"
											title="Oper actions"
											@click.stop="openMenu($event, 'host', u.host)"
										>
											{{ u.host }}</button
										><button
											v-else-if="u.ip"
											type="button"
											:class="[
												'oper-chip',
												'oper-chip-ip',
												{same: shares(u.nick, 'ipRange')},
											]"
											title="Oper actions"
											@click.stop="openMenu($event, 'ip', u.ip)"
										>
											{{ u.ip }}</button
										><span v-else class="oper-muted">?</span>
										<template v-if="u.ip && u.host && u.ip !== u.host">
											·
											<button
												type="button"
												:class="[
													'oper-chip',
													'oper-chip-ip',
													{same: shares(u.nick, 'ipRange')},
												]"
												title="Oper actions"
												@click.stop="openMenu($event, 'ip', u.ip)"
											>
												{{ u.ip }}
											</button>
										</template>
									</div>
									<div class="oper-user-line oper-user-detail">
										<span
											v-if="u.realname !== undefined"
											:class="{same: shares(u.nick, 'realname')}"
											>{{ u.realname || "(no realname)" }}</span
										>
										<span v-else class="oper-muted">{{
											pending("check", "who")
										}}</span>
										<template v-if="u.account">
											·
											<span :class="{same: shares(u.nick, 'authed')}">{{
												u.account
											}}</span></template
										>
										<span
											v-else-if="u.authed === false"
											:class="[
												'oper-muted',
												{same: shares(u.nick, 'authed')},
											]"
										>
											· not authed</span
										>
										<template v-if="u.server">
											·
											<span
												:class="[
													'oper-server',
													{same: shares(u.nick, 'server')},
												]"
												>{{ u.server }}</span
											></template
										>
										<template v-if="u.country"> · {{ u.country }}</template>
										<template v-if="u.version">
											·
											<span :class="{same: shares(u.nick, 'version')}">{{
												u.version
											}}</span></template
										>
										<template v-if="u.channels && u.channels.length">
											· <span class="oper-muted">{{ elsewhere(u) }}</span>
										</template>
										<template v-else-if="u.lookup === 'asking'">
											· <span class="oper-muted">asking…</span></template
										>
										<button
											v-else-if="u.lookup === 'pending'"
											type="button"
											class="btn btn-small oper-lookup"
											@click="lookup(u.nick)"
										>
											Look up
										</button>
									</div>
								</li>
							</ul>
						</section>

						<section v-if="showRecent" class="oper-recent">
							<h3 class="oper-report-section-title">Last hour here</h3>
							<p v-if="model.snoopMissing" class="oper-muted oper-activity-missing">
								Not in {{ model.snoopMissing }}: joins and parts aren't kept.
							</p>
							<ul v-else-if="model.recent.length" class="oper-recent-list">
								<li v-for="(e, i) in model.recent" :key="i">
									<span class="oper-muted">{{ clock(e.time) }}</span> {{ e.text }}
								</li>
							</ul>
							<p v-else class="oper-muted">Nothing in the last hour.</p>
						</section>
					</template>

					<!-- --------------------------------------------------- user -->
					<template v-else>
						<div class="oper-compare" :data-tab="compareTab">
							<div
								v-if="compareModel"
								class="oper-compare-tabs oper-seg"
								role="tablist"
							>
								<button
									type="button"
									:aria-pressed="compareTab === 'a'"
									@click="compareTab = 'a'"
								>
									{{ model.target }}
								</button>
								<button
									type="button"
									:aria-pressed="compareTab === 'b'"
									@click="compareTab = 'b'"
								>
									{{ compareModel.target }}
								</button>
							</div>
							<div class="oper-compare-col oper-compare-a">
								<h2 v-if="compareModel" class="oper-compare-title">
									{{ model.target }}
								</h2>
								<InvestigateUser
									:model="model"
									:sources="sources"
									:notes="notes"
									:network="network"
									:other="compareModel"
								/>
							</div>
							<div v-if="compareModel" class="oper-compare-col oper-compare-b">
								<div class="oper-compare-head">
									<h2 class="oper-compare-title">{{ compareModel.target }}</h2>
									<button
										type="button"
										class="btn btn-small btn-cancel"
										@click="endCompare"
									>
										✕
									</button>
								</div>
								<InvestigateUser
									:model="compareModel"
									:sources="compareSources"
									:notes="compareNotes"
									:network="network"
									:other="model"
								/>
							</div>
						</div>
						<form v-if="asking" class="oper-compare-ask" @submit.prevent="startCompare">
							<input
								ref="compareField"
								v-model="compareWith"
								class="input"
								type="text"
								placeholder="nick to compare with"
								spellcheck="false"
								autocomplete="off"
							/>
							<button
								type="submit"
								class="btn btn-small"
								:disabled="!compareWith.trim()"
							>
								Compare
							</button>
							<button
								type="button"
								class="btn btn-small btn-cancel"
								@click="asking = false"
							>
								Cancel
							</button>
						</form>
						<p v-else-if="!compareModel" class="oper-compare-offer">
							<button type="button" class="btn btn-small" @click="askCompare">
								Compare side by side…
							</button>
						</p>
					</template>

					<pre v-if="showRaw" class="oper-report-raw oper-investigate-raw">{{
						raw.join("\n") || "(nothing yet)"
					}}</pre>
				</div>
			</div>

			<div class="settings-modal-footer oper-investigate-footer">
				<div class="oper-investigate-actions">
					<template v-if="model.kind === 'channel'">
						<button type="button" class="btn btn-small" @click="joinAndWatch">
							{{ inChannel ? "Watch" : "Join & watch" }}
						</button>
					</template>
					<template v-else>
						<button v-if="canBan" type="button" class="btn btn-small" @click="banUser">
							G-line…
						</button>
						<button
							v-if="canKill"
							type="button"
							class="btn btn-small"
							@click="killUser"
						>
							Kill…
						</button>
						<button type="button" class="btn btn-small" @click="alertOnThis">
							Alert on this…
						</button>
					</template>
					<button type="button" class="btn btn-small" @click="editNote">Note…</button>
					<button type="button" class="btn btn-small" @click="refresh">Refresh</button>
					<button
						type="button"
						:class="['btn', 'btn-small', {active: showRaw}]"
						:aria-pressed="showRaw"
						@click="showRaw = !showRaw"
					>
						Raw replies
					</button>
				</div>
				<span v-if="toast" class="oper-toast" role="status">{{ toast }}</span>
			</div>
		</div>
	</div>
</template>

<script lang="ts">
import {
	computed,
	defineComponent,
	markRaw,
	nextTick,
	onMounted,
	onUnmounted,
	ref,
	shallowRef,
} from "vue";
import eventbus from "../../js/eventbus";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import {clientForNetwork} from "../../js/irc/manager";
import {
	type ChannelModel,
	type InvestigatedUser,
	Investigation,
	type InvestigationModel,
	type SourceId,
	type UserModel,
} from "../../js/irc/investigate";
import {getNote, setNote} from "../../js/irc/operprefs";
import {servicesProfileFor} from "../../js/irc/services/index";
import {
	canBan as canBanOn,
	hasPriv,
	type InvestigateRequest,
	openOperAction,
	openOperTargetMenu,
} from "../../js/helpers/operMenu";
import type {FactKey} from "../../js/helpers/commonality";
import type {AlertBuilderRequest} from "../../js/helpers/alertBuilder";
import {formatDuration, relativeTime} from "../../js/helpers/operFormat";
import localetime from "../../js/helpers/localetime";
import useNow from "../../js/hooks/use-now";
import {ChanState} from "../../../shared/types/chan";
import ParsedMessage from "../ParsedMessage.vue";
import InvestigateUser from "./InvestigateUser.vue";

interface Card {
	request: InvestigateRequest;
	investigation: Investigation;
	/** The second user card Compare opened beside this one. */
	compare?: Investigation;
}

const TOAST_MS = 2500;

/**
 * The investigation cards (docs/projects/oper-tools.md, "The channel
 * card", "The user card"): an overlay over the whole app, opened by the
 * `oper:investigate` eventbus event from a nick's or a channel's menu or
 * `/investigate`, closed by ✕, Escape or the backdrop. Cards stack: a
 * nick tapped in the channel card opens the user card on top, and closing
 * it returns to the channel card. The data is one `Investigation` per
 * card (irc/investigate.ts), which fills its model as the answers come;
 * every change bumps `tick`, and the component re-reads the model.
 */
export default defineComponent({
	name: "InvestigateCard",
	components: {InvestigateUser, ParsedMessage},
	setup() {
		const store = useStore();
		const now = useNow();
		const stack = shallowRef<Card[]>([]);
		const tick = ref(0);
		const sortBy = ref<"joined" | "nick" | "host">("joined");
		const showRaw = ref(false);
		const toast = ref("");
		const note = ref("");
		const editingNote = ref(false);
		const noteDraft = ref("");
		const noteField = ref<HTMLTextAreaElement | null>(null);
		const asking = ref(false);
		const compareWith = ref("");
		const compareField = ref<HTMLInputElement | null>(null);
		const compareTab = ref<"a" | "b">("a");
		let toastTimer: ReturnType<typeof setTimeout> | undefined;

		const top = computed(() => stack.value[stack.value.length - 1]);
		const network = computed(() =>
			top.value ? store.getters.findNetwork(top.value.request.network) : undefined
		);

		/** A fresh copy on every tick, so the template re-reads everything. */
		const model = computed<InvestigationModel | undefined>(() => {
			void tick.value;
			return top.value ? {...top.value.investigation.model} : undefined;
		});
		const sources = computed(() => {
			void tick.value;
			return {...(top.value?.investigation.sources ?? {})};
		});
		const notes = computed(() => {
			void tick.value;
			return {...(top.value?.investigation.notes ?? {})};
		});
		const raw = computed(() => {
			void tick.value;
			return [...(top.value?.investigation.raw ?? [])];
		});
		const compareModel = computed<UserModel | undefined>(() => {
			void tick.value;
			const c = top.value?.compare;
			return c && c.model.kind === "user" ? {...c.model} : undefined;
		});
		const compareSources = computed(() => {
			void tick.value;
			return {...(top.value?.compare?.sources ?? {})};
		});
		const compareNotes = computed(() => {
			void tick.value;
			return {...(top.value?.compare?.notes ?? {})};
		});

		const title = computed(() =>
			top.value
				? `${top.value.request.kind === "channel" ? "Channel" : "User"} ${
						top.value.request.target
				  }`
				: ""
		);
		const common = computed(() =>
			model.value?.kind === "channel" ? model.value.commonality : undefined
		);
		/** The smallest count among the common facts: "8 of 9 users". */
		const commonCount = computed(() =>
			common.value?.facts.length ? Math.min(...common.value.facts.map((f) => f.count)) : 0
		);
		const hasLookups = computed(() => !!servicesProfileFor(network.value?.services)?.lookups);
		const inChannel = computed(() => {
			const client = top.value && clientForNetwork(top.value.request.network);
			return client?.findChannel(top.value!.request.target)?.state === ChanState.JOINED;
		});
		const showRecent = computed(() => {
			const m = model.value;
			return m?.kind === "channel" && (!!network.value?.services || m.recent.length > 0);
		});
		const noteKey = computed(() => top.value?.investigation.noteKey ?? "");

		const canBan = computed(() => !!network.value && canBanOn(network.value, "gline"));
		const canKill = computed(
			() => !!network.value && hasPriv(network.value, "KILL", "LOCAL_KILL")
		);

		const sortedUsers = computed<InvestigatedUser[]>(() => {
			const m = model.value;

			if (m?.kind !== "channel") {
				return [];
			}

			const users = [...m.users];
			const by = sortBy.value;

			if (by === "nick") {
				users.sort((a, b) =>
					a.nick.localeCompare(b.nick, undefined, {sensitivity: "base"})
				);
			} else if (by === "host") {
				users.sort((a, b) => (a.ip ?? a.host ?? "").localeCompare(b.ip ?? b.host ?? ""));
			} else {
				// Newest join first; unknown joins keep the server's order, after.
				users.sort((a, b) => (b.joinedAt ?? -1) - (a.joinedAt ?? -1));
			}

			return users;
		});

		const readNote = () => {
			note.value = top.value ? getNote(top.value.request.network, noteKey.value) : "";
		};

		const bump = () => {
			tick.value++;
			readNote();
		};

		const openCard = (request: InvestigateRequest): void => {
			const client = clientForNetwork(request.network);

			if (!client) {
				return;
			}

			const investigation = markRaw(new Investigation(client, request.kind, request.target));
			investigation.onChange = bump;
			stack.value = [...stack.value, {request, investigation}];
			showRaw.value = false;
			editingNote.value = false;
			asking.value = false;
			compareTab.value = "a";
			investigation.start();
			readNote();
		};

		const close = () => {
			const card = top.value;

			if (!card) {
				return;
			}

			card.investigation.stop();
			card.compare?.stop();
			stack.value = stack.value.slice(0, -1);
			editingNote.value = false;
			asking.value = false;
			readNote();
		};

		const refresh = () => {
			top.value?.investigation.refresh();
			top.value?.compare?.refresh();
			bump();
		};

		const say = (text: string) => {
			toast.value = text;
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => (toast.value = ""), TOAST_MS);
		};

		const openUser = (nick: string) => {
			if (top.value) {
				openCard({network: top.value.request.network, kind: "user", target: nick});
			}
		};

		const lookup = (nick: string) => {
			top.value?.investigation.lookup(nick);
		};

		const traceCount = () => {
			top.value?.investigation.traceCount();
		};

		const shares = (nick: string, key: FactKey) =>
			!!common.value?.facts.find((f) => f.key === key)?.nicks.includes(nick);
		const sharesAll = (nick: string) => !!common.value?.sharingAll.includes(nick);
		const sharesNone = (nick: string) => !!common.value?.sharingNone.includes(nick);

		const elsewhere = (u: InvestigatedUser) => {
			const here = top.value?.request.target.toLowerCase();
			const others = (u.channels ?? [])
				.map((c) => c.replace(/^[@%+!<~]+/, ""))
				.filter((c) => c.toLowerCase() !== here);
			return others.length ? `also in ${others.join(", ")}` : "only here";
		};

		/** `asking…` while any of these sources is still out, else a dash. */
		const pending = (...ids: SourceId[]) =>
			ids.some((id) => sources.value[id] === "asking") ? "asking…" : "—";

		const lobbyId = () => network.value?.channels[0]?.id;

		const joinAndWatch = () => {
			const card = top.value;
			const lobby = lobbyId();

			if (!card || lobby === undefined) {
				return;
			}

			socket.emit("input", {target: lobby, text: `/join ${card.request.target}`});
			say(
				inChannel.value
					? `Watching ${card.request.target}`
					: `Joining ${card.request.target}…`
			);
		};

		/** A user's own facts in the channel card's terms, for the alert builder. */
		const userFacts = (m: UserModel) => {
			const u = m.user;
			const out: {key: FactKey; value: string; label: string}[] = [];

			if (u.authed !== undefined) {
				out.push({
					key: "authed",
					value: u.authed ? "yes" : "no",
					label: u.authed ? "authed" : "not authed",
				});
			}

			if (u.realname) {
				out.push({key: "realname", value: u.realname, label: `realname '${u.realname}'`});
			}

			if (u.ident) {
				out.push({key: "identShape", value: u.ident, label: `ident ${u.ident}`});
			}

			if (u.ip) {
				out.push({key: "ipRange", value: u.ip, label: u.ip});
			}

			if (u.server) {
				out.push({key: "server", value: u.server, label: `server ${u.server}`});
			}

			if (u.version) {
				out.push({key: "version", value: u.version, label: `version '${u.version}'`});
			}

			return out;
		};

		const alertOnThis = () => {
			const card = top.value;
			const m = model.value;

			if (!card || !m) {
				return;
			}

			const facts =
				m.kind === "channel"
					? (m.commonality?.facts ?? []).map((f) => ({
							key: f.key,
							value: f.value,
							label: f.label,
					  }))
					: userFacts(m);
			// The builder (AlertBuilder.vue) makes rows of the facts; the
			// criteria in the package's words are for anyone else listening.
			const payload: AlertBuilderRequest & {criteria: string[]} = {
				network: card.request.network,
				facts,
				criteria: card.investigation.criteria(),
			};

			if (m.kind === "channel") {
				payload.channel = m.target;
			} else {
				payload.nick = m.target;
			}

			eventbus.emit("oper:alert-builder", payload);
		};

		const activeChan = () =>
			store.state.activeChannel?.channel.id ?? network.value?.channels[0]?.id ?? 0;

		const banUser = () => {
			const m = model.value;

			if (!top.value || m?.kind !== "user") {
				return;
			}

			openOperAction({
				network: top.value.request.network,
				chan: activeChan(),
				action: "gline",
				nick: m.user.nick,
				...(m.user.ip ? {mask: `*@${m.user.ip}`} : {}),
			});
		};

		const killUser = () => {
			const m = model.value;

			if (!top.value || m?.kind !== "user") {
				return;
			}

			openOperAction({
				network: top.value.request.network,
				chan: activeChan(),
				action: "kill",
				nick: m.user.nick,
			});
		};

		const editNote = () => {
			noteDraft.value = note.value;
			editingNote.value = true;
			void nextTick(() => noteField.value?.focus());
		};

		const saveNote = () => {
			if (top.value) {
				setNote(top.value.request.network, noteKey.value, noteDraft.value);
			}

			editingNote.value = false;
			readNote();
		};

		const askCompare = () => {
			asking.value = true;
			compareWith.value = "";
			void nextTick(() => compareField.value?.focus());
		};

		const startCompare = () => {
			const card = top.value;
			const nick = compareWith.value.trim();

			if (!card || !nick) {
				return;
			}

			const client = clientForNetwork(card.request.network);

			if (!client) {
				return;
			}

			card.compare?.stop();
			const investigation = markRaw(new Investigation(client, "user", nick));
			investigation.onChange = bump;
			card.compare = investigation;
			asking.value = false;
			compareTab.value = "b";
			investigation.start();
			bump();
		};

		const endCompare = () => {
			const card = top.value;

			if (card?.compare) {
				card.compare.stop();
				delete card.compare;
				compareTab.value = "a";
				bump();
			}
		};

		const openMenu = (event: MouseEvent, kind: "ip" | "host" | "mask", value: string) => {
			if (network.value) {
				openOperTargetMenu(event, network.value, activeChan(), kind, value);
			}
		};

		const onEscape = (layer: string | null) => {
			if (layer === "oper-investigate") {
				if (editingNote.value) {
					editingNote.value = false;
				} else if (asking.value) {
					asking.value = false;
				} else {
					close();
				}
			}
		};

		const clock = (ms: number) => {
			const d = new Date(ms);
			return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
				2,
				"0"
			)}`;
		};

		onMounted(() => {
			eventbus.on("oper:investigate", openCard);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("oper:investigate", openCard);
			eventbus.off("escapekey", onEscape);
			clearTimeout(toastTimer);

			for (const card of stack.value) {
				card.investigation.stop();
				card.compare?.stop();
			}
		});

		return {
			stack,
			top,
			network,
			model,
			sources,
			notes,
			raw,
			compareModel,
			compareSources,
			compareNotes,
			title,
			common,
			commonCount,
			hasLookups,
			inChannel,
			showRecent,
			sortBy,
			sortedUsers,
			showRaw,
			toast,
			note,
			noteKey,
			editingNote,
			noteDraft,
			noteField,
			asking,
			compareWith,
			compareField,
			compareTab,
			canBan,
			canKill,
			now,
			close,
			refresh,
			openUser,
			lookup,
			traceCount,
			shares,
			sharesAll,
			sharesNone,
			elsewhere,
			pending,
			joinAndWatch,
			alertOnThis,
			banUser,
			killUser,
			editNote,
			saveNote,
			askCompare,
			startCompare,
			endCompare,
			openMenu,
			clock,
			absolute: (ms: number) => localetime(new Date(ms)),
			relative: (ms: number) => relativeTime(ms, now.value),
			duration: (ms: number) => formatDuration(Math.max(0, ms) / 1000),
		};
	},
});
</script>
