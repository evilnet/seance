<template>
	<div
		id="oper-investigate-overlay"
		v-backdrop="close"
		class="screen-overlay"
		:class="{opened: !!top}"
		:data-escape-close="top ? 'oper-investigate' : null"
	>
		<div
			v-if="top && network && model"
			ref="dialog"
			class="settings-modal oper-investigate"
			:class="{'oper-investigate-compare': !!compareModel}"
			tabindex="-1"
			role="dialog"
			aria-modal="true"
			:aria-label="title"
		>
			<div class="settings-modal-header oper-card-head">
				<!-- Compare: the head names the two value columns, and stays put
				     while the facts scroll under it. -->
				<template v-if="compareModel">
					<span class="oper-cmp-kicker">Compare</span>
					<div v-for="p in comparePeople" :key="p.target" class="oper-cmp-who">
						<span :class="['oper-avatar', p.side]" aria-hidden="true">{{
							p.initials
						}}</span>
						<div class="oper-cmp-name">
							<h1>{{ p.target }}</h1>
							<span class="oper-ident-sub">{{ p.status }}</span>
						</div>
					</div>
				</template>
				<template v-else>
					<span
						:class="[
							'oper-avatar',
							model.kind === 'channel'
								? 'oper-avatar-channel'
								: ['user', avatarColor],
						]"
						aria-hidden="true"
						>{{ model.kind === "channel" ? "" : initials }}</span
					>
					<div class="oper-ident">
						<h1>
							{{ top.request.target }}
							<span
								v-if="presence"
								:class="['oper-tag', presence === 'online' ? 'ok' : 'warn']"
								>{{ presence }}</span
							>
						</h1>
						<div class="oper-ident-sub">
							<span v-if="identLine" class="oper-mono">{{ identLine }}</span>
							<span v-if="identLine"> · </span>{{ network.name
							}}<template v-if="stack.length > 1">
								· from {{ stack[stack.length - 2].request.target }}</template
							>
						</div>
					</div>
				</template>
				<div class="oper-card-tools">
					<button
						type="button"
						class="oper-icon-btn oper-icon-refresh"
						title="Refresh"
						aria-label="Refresh"
						@click="refresh"
					></button>
					<button
						v-if="!compareModel"
						type="button"
						class="oper-icon-btn oper-icon-raw"
						title="Raw replies"
						aria-label="Raw replies"
						:aria-pressed="showRaw"
						@click="showRaw = !showRaw"
					></button>
					<button
						class="settings-modal-close oper-icon-btn oper-icon-close"
						type="button"
						:aria-label="
							stack.length > 1 ? 'Back to the card before' : 'Close the card'
						"
						:title="stack.length > 1 ? 'Back' : 'Close (Esc)'"
						@click="close"
					></button>
				</div>
			</div>

			<div class="settings-modal-body">
				<div class="container oper-investigate-body">
					<div v-if="note && !editingNote" class="oper-note">
						<span class="oper-note-text">{{ note }}</span>
						<button
							type="button"
							class="oper-btn oper-btn-ghost oper-note-edit"
							@click="editNote"
						>
							Edit
						</button>
					</div>

					<!-- ------------------------------------------------ channel -->
					<template v-if="model.kind === 'channel'">
						<dl class="oper-report-entries oper-facts oper-props">
							<div>
								<dt>Created</dt>
								<dd>
									<time
										v-if="model.createdAt !== undefined"
										:title="absolute(model.createdAt)"
										:data-abs="absolute(model.createdAt)"
										>{{ since(model.createdAt) }}</time
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
							<div class="wide">
								<dt>Topic</dt>
								<dd class="oper-prop-flow">
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
							<div
								:class="[
									'oper-verdict',
									common && common.facts.length ? 'tone-match' : 'tone-weak',
								]"
							>
								<span class="oper-verdict-mark" aria-hidden="true"></span>
								<p class="oper-verdict-head">
									<span class="oper-verdict-kicker">What most share</span>
									<span
										v-if="common && common.facts.length"
										class="oper-verdict-lead"
										>{{ commonCount }} of {{ common.total }} users look
										alike</span
									>
									<span v-else class="oper-verdict-lead oper-muted">{{
										model.users.length < 3
											? "Too few users to compare."
											: sources.who === "asking" || sources.check === "asking"
											? "asking…"
											: "Nothing that most of them share."
									}}</span>
								</p>
								<p
									v-if="common && common.facts.length"
									class="oper-verdict-evidence oper-common-facts"
								>
									<span
										v-for="fact in common.facts"
										:key="fact.key"
										class="oper-tag warn oper-common-chip"
										:title="`${fact.count} of ${common.total} users`"
										>{{ fact.label
										}}<template v-if="fact.count !== commonCount">
											· {{ fact.count }}</template
										></span
									>
								</p>
								<div class="oper-common-actions">
									<button
										type="button"
										class="oper-btn oper-btn-secondary oper-icon-alert"
										:disabled="!common || !common.facts.length"
										@click="alertOnThis"
									>
										Alert on this…
									</button>
									<button
										v-if="hasLookups"
										type="button"
										class="oper-btn oper-btn-ghost"
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
							</div>
						</section>

						<section class="oper-users oper-card-section">
							<div class="oper-users-head oper-section-head">
								<h3 class="oper-report-section-title">Users</h3>
								<span class="oper-count">{{ model.users.length }}</span>
								<span class="oper-spacer"></span>
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
										<span v-if="u.op" class="oper-tag plain">op</span>
										<span v-if="u.voice" class="oper-tag plain">voice</span>
										<span v-if="u.oper" class="oper-tag plain">oper</span>
										<span
											v-if="u.authed"
											:class="[
												'oper-tag',
												'plain',
												{same: shares(u.nick, 'authed')},
											]"
											>authed</span
										>
										<span v-if="u.away" class="oper-tag plain">away</span>
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
										<template v-else-if="u.lookup === 'failed'">
											·
											<span class="oper-muted">the lookup failed</span>
											<button
												type="button"
												class="oper-btn oper-btn-ghost oper-lookup"
												@click="lookup(u.nick)"
											>
												Try again
											</button></template
										>
										<button
											v-else-if="u.lookup === 'pending'"
											type="button"
											class="oper-btn oper-btn-ghost oper-lookup"
											@click="lookup(u.nick)"
										>
											Look up
										</button>
									</div>
								</li>
							</ul>
						</section>

						<section v-if="showRecent" class="oper-recent oper-card-section">
							<div class="oper-section-head">
								<h3 class="oper-report-section-title">Last hour here</h3>
							</div>
							<p v-if="model.snoopMissing" class="oper-muted oper-activity-missing">
								Not in {{ model.snoopMissing }}: joins and parts aren't kept.
							</p>
							<ul v-else-if="model.recent.length" class="oper-recent-list oper-rows">
								<li v-for="(e, i) in model.recent" :key="i">
									<span class="oper-row-time">{{ clock(e.time) }}</span>
									<span class="oper-row-main">{{ e.text }}</span>
								</li>
							</ul>
							<p v-else class="oper-empty oper-muted">Nothing in the last hour.</p>
						</section>
					</template>

					<!-- --------------------------------------------------- user -->
					<template v-else>
						<InvestigateUser
							v-if="!compareModel"
							:model="model"
							:sources="sources"
							:notes="notes"
							:network="network"
							@sent="sentTo"
						/>
						<!-- Compare: two users, one table (the kit's CompareCard). -->
						<div v-else class="oper-compare">
							<div class="oper-cmp-sum">
								<span :class="['oper-tag', compareSum.tone]">{{
									compareSum.lead
								}}</span>
								<span class="oper-cmp-score"
									><em>{{ compareSum.same.length }}</em> of
									{{ compareSum.known }} match</span
								>
								<span v-if="compareSum.same.length" class="oper-muted">{{
									compareSum.same.join(" · ")
								}}</span>
								<span class="oper-spacer"></span>
								<div class="oper-seg" role="group" aria-label="Show">
									<button
										type="button"
										:aria-pressed="!differences"
										@click="differences = false"
									>
										All
									</button>
									<button
										type="button"
										:aria-pressed="differences"
										@click="differences = true"
									>
										Differences
									</button>
								</div>
							</div>
							<InvestigateFacts
								:sides="[
									{model, sources},
									{model: compareModel, sources: compareSources},
								]"
								:network="network"
								:differences="differences"
								@sent="sentTo"
							/>
							<section class="oper-card-section">
								<div class="oper-section-head">
									<h3 class="oper-report-section-title">Seen before</h3>
									<span v-if="compareSeen.length" class="oper-count">{{
										compareSeen.length
									}}</span>
									<span class="oper-spacer"></span>
									<span class="oper-cmp-legend">
										<i :class="['oper-cmp-dot', 'oper-cmp-a']"></i
										>{{ model.target }}
										<i :class="['oper-cmp-dot', 'oper-cmp-b']"></i
										>{{ compareModel.target }}
									</span>
								</div>
								<ul v-if="compareSeen.length" class="oper-seen oper-rows">
									<li
										v-for="s in compareSeen"
										:key="s.entry.nick"
										class="oper-cmp-seen"
									>
										<span class="oper-row-time">{{ when(s.entry.time) }}</span>
										<span class="oper-row-main">
											<Username
												:user="{nick: s.entry.nick, mode: ''}"
												:network="network"
											/>
											<template v-if="s.entry.ip || s.entry.host">
												<span class="oper-muted"> from </span>
												<code class="oper-mono oper-value">{{
													s.entry.ip ?? s.entry.host
												}}</code>
											</template>
											<span
												v-if="s.entry.fate"
												class="oper-row-fate oper-muted"
												>{{ s.entry.fate }}</span
											>
										</span>
										<span class="oper-cmp-whose" :title="whoseText(s)"
											><span class="sr-only">{{ whoseText(s) }}</span
											><i
												:class="['oper-cmp-dot', 'oper-cmp-a', {off: !s.a}]"
											></i
											><i
												:class="['oper-cmp-dot', 'oper-cmp-b', {off: !s.b}]"
											></i
										></span>
									</li>
								</ul>
								<p v-else class="oper-empty oper-muted">
									Nothing in the kept feed is like either of them.
								</p>
							</section>
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
								class="oper-btn oper-btn-primary"
								:disabled="!compareWith.trim()"
							>
								Compare
							</button>
							<button
								type="button"
								class="oper-btn oper-btn-ghost"
								@click="asking = false"
							>
								Cancel
							</button>
						</form>
					</template>

					<pre v-if="showRaw" class="oper-report-raw oper-investigate-raw">{{
						raw.join("\n") || "(nothing yet)"
					}}</pre>
				</div>
			</div>

			<div class="settings-modal-footer oper-investigate-footer">
				<div class="oper-investigate-actions">
					<template v-if="model.kind === 'channel'">
						<span class="oper-spacer"></span>
						<button
							type="button"
							class="oper-btn oper-btn-secondary oper-icon-watch"
							@click="joinAndWatch"
						>
							<span class="oper-btn-label">{{
								inChannel ? "Watch" : "Join & watch"
							}}</span>
						</button>
					</template>
					<template v-else-if="compareModel">
						<button
							type="button"
							class="oper-btn oper-btn-secondary oper-compare-end"
							@click="endCompare"
						>
							End compare
						</button>
					</template>
					<template v-else>
						<button
							v-if="canKill"
							type="button"
							class="oper-btn oper-btn-danger oper-icon-kill"
							@click="killUser"
						>
							Kill…
						</button>
						<button
							v-if="canBan"
							type="button"
							class="oper-btn oper-btn-danger oper-icon-ban"
							@click="banUser"
						>
							G-line…
						</button>
						<span class="oper-spacer"></span>
						<button
							v-if="!compareModel && !asking"
							type="button"
							class="oper-btn oper-btn-secondary oper-icon-compare oper-compare-offer"
							title="Compare side by side"
							@click="askCompare"
						>
							<span class="oper-btn-label">Compare</span>
						</button>
						<button
							type="button"
							class="oper-btn oper-btn-secondary oper-icon-alert"
							title="Alert on this"
							@click="alertOnThis"
						>
							<span class="oper-btn-label">Alert on this…</span>
						</button>
					</template>
					<button
						v-if="!compareModel"
						type="button"
						class="oper-btn oper-btn-secondary oper-icon-note"
						title="Note"
						@click="editNote"
					>
						<span class="oper-btn-label">Note…</span>
					</button>
				</div>
				<span v-if="toast" class="oper-toast" role="status"
					>{{ toast
					}}<button
						v-if="resultsIn !== undefined"
						type="button"
						class="oper-btn oper-btn-ghost oper-toast-go"
						@click="showResults"
					>
						Show
					</button></span
				>
			</div>
		</div>
	</div>

	<!-- The note is its own small dialog over the card, like Kill…: on a
	     phone the card's body is a short band once the keyboard is up, and
	     an editor inside it lost its Save under the card's action bar. -->
	<div
		id="oper-note-overlay"
		v-backdrop="closeNote"
		class="screen-overlay"
		:class="{opened: editingNote}"
	>
		<form
			v-if="editingNote"
			id="oper-note-dialog"
			role="dialog"
			aria-modal="true"
			:aria-label="`Note on ${noteKey}`"
			@submit.prevent="saveNote"
		>
			<div class="oper-note-dialog-body">
				<label class="oper-note-dialog-title" for="oper-note-field"
					>Note on {{ noteKey }}</label
				>
				<textarea
					id="oper-note-field"
					ref="noteField"
					v-model="noteDraft"
					class="input"
					rows="3"
					placeholder="Kept on this device only"
					@keydown.esc.stop="closeNote"
				></textarea>
			</div>
			<div class="oper-note-dialog-buttons">
				<button type="button" class="oper-btn oper-btn-ghost" @click="cancelNote">
					Cancel
				</button>
				<button type="submit" class="oper-btn oper-btn-primary">Save</button>
			</div>
		</form>
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
	watch,
} from "vue";
import eventbus from "../../js/eventbus";
import {navigate} from "../../js/router";
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
import {setNote} from "../../js/irc/operprefs";
import {servicesProfileFor} from "../../js/irc/services/index";
import {
	canBan as canBanOn,
	hasPriv,
	type InvestigateRequest,
	openOperAction,
	openOperTargetMenu,
	operChanFor,
} from "../../js/helpers/operMenu";
import type {FactKey} from "../../js/helpers/commonality";
import type {AlertBuilderRequest} from "../../js/helpers/alertBuilder";
import {formatDuration, sinceTime} from "../../js/helpers/operFormat";
import localetime from "../../js/helpers/localetime";
import useNow from "../../js/hooks/use-now";
import {ChanState} from "../../../shared/types/chan";
import ParsedMessage from "../ParsedMessage.vue";
import InvestigateFacts from "./InvestigateFacts.vue";
import InvestigateUser from "./InvestigateUser.vue";
import colorClass from "../../js/helpers/colorClass";
import {compareSummary, mergeSeen, type SharedSighting} from "../../js/helpers/operCompare";
import {whenText} from "../../js/helpers/verdict";
import Username from "../Username.vue";

interface Card {
	request: InvestigateRequest;
	investigation: Investigation;
	/** The second user card Compare opened beside this one. */
	compare?: Investigation;
}

const TOAST_MS = 2500;
/** Long enough to reach the toast's Show. */
const RESULTS_TOAST_MS = 8000;

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
	components: {InvestigateFacts, InvestigateUser, ParsedMessage, Username},
	setup() {
		const store = useStore();
		const now = useNow();
		const stack = shallowRef<Card[]>([]);
		const tick = ref(0);
		const sortBy = ref<"joined" | "nick" | "host">("joined");
		const showRaw = ref(false);
		const toast = ref("");
		/** The window a chip's Check or Who answers in, while the toast offers it. */
		const resultsIn = ref<number | undefined>();
		const note = ref("");
		const editingNote = ref(false);
		const noteDraft = ref("");
		const noteField = ref<HTMLTextAreaElement | null>(null);
		const asking = ref(false);
		const compareWith = ref("");
		const compareField = ref<HTMLInputElement | null>(null);
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

		/** Compare's Differences: only the rows whose values differ. Every
		 * card and every comparison starts on All. */
		const differences = ref(false);
		watch(
			() => [top.value, top.value?.compare],
			() => {
				differences.value = false;
			}
		);
		const initialsOf = (nick: string) =>
			nick
				.replace(/[^\p{L}\p{N}]/gu, "")
				.slice(0, 2)
				.toLowerCase();
		/** The two users the Compare head names, in column order. */
		const comparePeople = computed(() => {
			const b = compareModel.value;
			const a = model.value;

			if (!b || a?.kind !== "user") {
				return [];
			}

			return [a, b].map((m, i) => {
				const u = m.user;
				const status =
					u.connectedAt === undefined
						? "asking…"
						: `${u.away ? "away" : "online"} · ${sinceTime(u.connectedAt, now.value)}`;
				return {
					target: m.target,
					initials: initialsOf(m.target),
					side: i === 0 ? "oper-cmp-a" : "oper-cmp-b",
					status,
				};
			});
		});
		const compareSum = computed(() => {
			const a = model.value;
			const b = compareModel.value;
			return a?.kind === "user" && b
				? compareSummary(a, b)
				: {known: 0, same: [], tone: "plain" as const, lead: ""};
		});
		const compareSeen = computed<SharedSighting[]>(() => {
			const a = model.value;
			const b = compareModel.value;
			return a?.kind === "user" && b ? mergeSeen(a, b) : [];
		});
		const whoseText = (s: SharedSighting) =>
			s.a && s.b
				? "like both"
				: `like ${s.a ? model.value?.target ?? "" : compareModel.value?.target ?? ""}`;

		/** The user card's header: initials, a nick colour, `ident@host`, online. */
		const userModel = computed(() => (model.value?.kind === "user" ? model.value : undefined));
		const initials = computed(() =>
			(top.value?.request.target ?? "")
				.replace(/[^\p{L}\p{N}]/gu, "")
				.slice(0, 2)
				.toLowerCase()
		);
		const avatarColor = computed(() => colorClass(top.value?.request.target ?? ""));
		const identLine = computed(() => {
			const u = userModel.value?.user;
			return u?.host ? `${u.ident ?? "?"}@${u.host}` : "";
		});
		/** Online once the server gave a connect time; away when they said so. */
		const presence = computed(() => {
			const u = userModel.value?.user;

			if (u?.connectedAt === undefined) {
				return undefined;
			}

			return u.away ? "away" : "online";
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
		// The key the note dialog writes to, fixed when it opens: the key the
		// note shown came from (no orphan under the nick once the IP lands),
		// and a label that does not change under the oper's typing.
		const editingKey = ref("");
		watch(editingNote, (open) => {
			if (!open) {
				editingKey.value = ""; // closed by any way (Escape, a card stacked over it)
			}
		});
		const noteKey = computed(
			() => editingKey.value || (tick.value, top.value?.investigation.noteSource) || ""
		);

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
			note.value = top.value?.investigation.note ?? "";
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
			investigation.start();
			readNote();
		};

		/** Every card closed, and its lookups stopped. */
		const closeAll = () => {
			for (const card of stack.value) {
				card.investigation.stop();
				card.compare?.stop();
			}

			stack.value = [];
			editingNote.value = false;
			asking.value = false;
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

		const say = (text: string, ms = TOAST_MS) => {
			toast.value = text;
			resultsIn.value = undefined;
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => {
				toast.value = "";
				resultsIn.value = undefined;
			}, ms);
		};

		// A chip's Check or Who answers in chat, behind the card: say where,
		// and offer to go there (the cards close, as Watch closes them).
		const sentTo = (chan: number) => {
			const name = store.getters.findChannel(chan)?.channel.name;
			say(
				name ? `Sent · the answer shows in ${name}` : "Sent · the answer shows in chat",
				RESULTS_TOAST_MS
			);
			resultsIn.value = chan;
		};

		const showResults = () => {
			const chan = resultsIn.value;

			if (chan === undefined) {
				return;
			}

			closeAll();
			void navigate("RoutedChat", {id: chan});
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

			const target = card.request.target;
			const joined = network.value?.channels.find(
				(c) => c.name.toLowerCase() === target.toLowerCase()
			);

			// Watch: the channel itself, the cards out of the way. Join & watch:
			// the join, from the lobby, where a refusal (+i, +k, banned) says so —
			// a joined channel opens by itself. No JOIN for a channel we are in.
			// Read before the cards close: inChannel follows the top card.
			const watching = inChannel.value && joined;
			closeAll();

			if (watching) {
				void navigate("RoutedChat", {id: joined.id});
				return;
			}

			void navigate("RoutedChat", {id: lobby});
			socket.emit("input", {target: lobby, text: `/join ${target}`});
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
			network.value ? operChanFor(network.value, store.state.activeChannel) : 0;

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

		// A note being written is kept, not lost, when the editor closes any
		// way but Save or Cancel — Escape, Android's Back, the card closing or
		// another stacked over it — and comes back when the editor next opens
		// on the same card, if it was changed. One draft at a time; Cancel
		// throws it away. Kept by card (network, kind, target), not by note
		// key: a user card's key moves from the nick to the IP or the account
		// as the lookups answer, and the note under the new key may differ
		// from the one the editor opened on — an untouched draft is not kept.
		let draftFor: string | undefined;
		let draftFrom = "";

		const cardKey = (request: InvestigateRequest) =>
			`${request.network} ${request.kind} ${request.target}`;

		const editNote = () => {
			if (!top.value) {
				return;
			}

			const card = cardKey(top.value.request);

			if (draftFor !== card || noteDraft.value === draftFrom) {
				noteDraft.value = draftFrom = note.value;
				draftFor = card;
			}

			editingKey.value = top.value.investigation.noteSource;
			editingNote.value = true;
			void nextTick(() => noteField.value?.focus());
		};

		const saveNote = () => {
			if (top.value) {
				setNote(top.value.request.network, noteKey.value, noteDraft.value);
			}

			draftFor = undefined;
			editingNote.value = false;
			editingKey.value = "";
			readNote();
		};

		/** The backdrop: closes like Escape, keeping the draft. */
		const closeNote = () => {
			editingNote.value = false;
			editingKey.value = "";
		};

		const cancelNote = () => {
			draftFor = undefined;
			editingNote.value = false;
			editingKey.value = "";
		};

		const askCompare = () => {
			asking.value = true;
			compareWith.value = "";
			void nextTick(() => {
				compareField.value?.focus();
				// The field sits at the bottom of the card's scrolling body: on a
				// phone the keyboard would come up over it.
				compareField.value?.scrollIntoView({block: "nearest"});
			});
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

			// Another user: comparing them with themselves tints every row and
			// reads as a match, and a channel is no user.
			if (client.namesEqual(nick, card.request.target) || /^[#&]/.test(nick)) {
				say(
					/^[#&]/.test(nick)
						? "Compare takes a nick, not a channel."
						: `That is ${card.request.target}: compare with someone else.`
				);
				return;
			}

			card.compare?.stop();
			const investigation = markRaw(new Investigation(client, "user", nick));
			investigation.onChange = bump;
			card.compare = investigation;
			asking.value = false;
			investigation.start();
			bump();
		};

		const endCompare = () => {
			const card = top.value;

			if (card?.compare) {
				card.compare.stop();
				delete card.compare;
				bump();
			}
		};

		const openMenu = (event: MouseEvent, kind: "ip" | "host" | "mask", value: string) => {
			if (network.value) {
				openOperTargetMenu(event, network.value, activeChan(), kind, value, sentTo);
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

		// The card's own Kill… or G-line… went through: what it says about the
		// user is out of date, so it asks again.
		const onActed = (data: {network: string; nick?: string}) => {
			const card = top.value;
			const client = card && clientForNetwork(card.request.network);

			if (
				card &&
				client &&
				data.nick &&
				card.request.network === data.network &&
				card.request.kind === "user" &&
				client.namesEqual(card.request.target, data.nick)
			) {
				refresh();
			}
		};

		// Focus goes into the card when one opens (a screen reader reads it,
		// Tab starts inside it) and back to what opened it when the last one
		// closes; the note dialog does the same over the card.
		const dialog = ref<HTMLElement | null>(null);
		let opener: HTMLElement | null = null;
		let noteOpener: HTMLElement | null = null;

		const giveBack = (el: HTMLElement | null) => {
			if (el?.isConnected) {
				el.focus({preventScroll: true});
			}
		};

		watch(
			() => stack.value.length,
			(count, before) => {
				if (
					count > 0 &&
					(before ?? 0) === 0 &&
					document.activeElement instanceof HTMLElement
				) {
					opener = document.activeElement;
				}

				if (count > 0) {
					void nextTick(() => dialog.value?.focus({preventScroll: true}));
				} else {
					giveBack(opener);
					opener = null;
				}
			}
		);

		watch(editingNote, (open) => {
			if (open) {
				noteOpener =
					document.activeElement instanceof HTMLElement ? document.activeElement : null;
			} else {
				const back = noteOpener ?? dialog.value;
				noteOpener = null;
				void nextTick(() => giveBack(back));
			}
		});

		// The card's network was deleted under it: nothing left to show.
		watch(
			() => !!top.value && !network.value,
			(gone) => {
				if (gone) {
					closeAll();
				}
			}
		);

		onMounted(() => {
			eventbus.on("oper:acted", onActed);
			eventbus.on("oper:investigate", openCard);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("oper:acted", onActed);
			eventbus.off("oper:investigate", openCard);
			eventbus.off("escapekey", onEscape);
			clearTimeout(toastTimer);

			for (const card of stack.value) {
				card.investigation.stop();
				card.compare?.stop();
			}
		});

		return {
			dialog,
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
			comparePeople,
			compareSum,
			compareSeen,
			differences,
			whoseText,
			when: (ms: number) => whenText(ms, now.value),
			title,
			initials,
			avatarColor,
			identLine,
			presence,
			common,
			commonCount,
			hasLookups,
			inChannel,
			showRecent,
			sortBy,
			sortedUsers,
			showRaw,
			toast,
			resultsIn,
			sentTo,
			showResults,
			note,
			noteKey,
			editingNote,
			noteDraft,
			noteField,
			asking,
			compareWith,
			compareField,
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
			cancelNote,
			closeNote,
			askCompare,
			startCompare,
			endCompare,
			openMenu,
			clock,
			absolute: (ms: number) => localetime(new Date(ms)),
			since: (ms: number) => sinceTime(ms, now.value),
			duration: (ms: number) => formatDuration(Math.max(0, ms) / 1000),
		};
	},
});
</script>
