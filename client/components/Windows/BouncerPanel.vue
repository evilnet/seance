<template>
	<div
		id="bouncer"
		v-backdrop="close"
		class="window screen-overlay"
		role="dialog"
		aria-modal="true"
		:aria-label="`Bouncer networks on ${networkName}`"
	>
		<div class="settings-modal">
			<div class="settings-modal-header">
				<h1>
					Bouncer<span class="bouncer-modal-network"> · {{ networkName }}</span>
				</h1>
				<button
					class="settings-modal-close"
					type="button"
					aria-label="Close the bouncer panel"
					@click="close"
				>
					✕
				</button>
			</div>
			<div class="settings-modal-body">
				<div class="container">
					<p v-if="!network?.bouncer" class="bouncer-empty">
						{{ networkName }} is not a bouncer, or has not said so yet.
					</p>
					<template v-else>
						<ul class="bouncer-list">
							<li v-for="net in network.bouncer" :key="net.netid" class="bouncer-row">
								<span
									:class="['bouncer-state', net.attrs.state ?? 'disconnected']"
									:title="net.attrs.state ?? 'disconnected'"
								/>
								<span class="bouncer-name">
									<strong>{{ net.attrs.name || net.netid }}</strong>
									<span class="bouncer-host">{{ endpoint(net.attrs) }}</span>
									<span v-if="net.attrs.error" class="bouncer-error">{{
										net.attrs.error
									}}</span>
								</span>
								<template v-if="confirming === net.netid">
									<button
										class="btn btn-small"
										type="button"
										:disabled="busy"
										@click="remove(net.netid)"
									>
										Delete
									</button>
									<button
										class="btn btn-small"
										type="button"
										@click="confirming = null"
									>
										Keep
									</button>
								</template>
								<template v-else>
									<button
										class="btn btn-small"
										type="button"
										:disabled="busy"
										@click="edit(net)"
									>
										Edit
									</button>
									<button
										class="btn btn-small"
										type="button"
										:disabled="busy"
										@click="confirming = net.netid"
									>
										Delete…
									</button>
								</template>
							</li>
							<li v-if="network.bouncer.length === 0" class="bouncer-empty">
								No networks yet.
							</li>
						</ul>

						<form v-if="form" class="bouncer-form" @submit.prevent="submit">
							<h2>
								{{
									form.netid
										? `Edit ${form.original.name || form.netid}`
										: "Add a network"
								}}
							</h2>
							<div v-for="field in FIELDS" :key="field.key" class="connect-row">
								<template v-if="field.key === 'tls'">
									<label></label>
									<div class="input-wrap">
										<label class="tls">
											<input
												id="bouncer:tls"
												v-model="form.tls"
												v-switch
												type="checkbox"
											/>
											The bouncer connects with TLS
										</label>
									</div>
								</template>
								<label v-if="field.key !== 'tls'" :for="`bouncer:${field.key}`">{{
									field.label
								}}</label>
								<input
									v-if="field.key !== 'tls'"
									:id="`bouncer:${field.key}`"
									v-model="form.values[field.key]"
									class="input"
									:type="field.key === 'pass' ? 'password' : 'text'"
									:inputmode="field.key === 'port' ? 'numeric' : undefined"
									:placeholder="field.placeholder"
									:required="field.key === 'host'"
								/>
							</div>
							<p v-if="error" class="bouncer-error" role="alert">{{ error }}</p>
							<div class="bouncer-form-actions">
								<button class="btn" type="submit" :disabled="busy">
									{{ form.netid ? "Save" : "Add network" }}
								</button>
								<button class="btn" type="button" @click="form = null">
									Cancel
								</button>
							</div>
						</form>
						<template v-else>
							<p v-if="error" class="bouncer-error" role="alert">{{ error }}</p>
							<button class="btn" type="button" @click="add">Add a network…</button>
						</template>
					</template>
				</div>
			</div>
			<div class="settings-modal-footer">
				<span class="settings-modal-note"
					>The bouncer keeps these; each appears here as a network of its own.</span
				>
				<button class="btn settings-modal-done" type="button" @click="close">Done</button>
			</div>
		</div>
	</div>
</template>

<style>
#bouncer .bouncer-modal-network,
#bouncer .bouncer-host,
#bouncer .bouncer-empty {
	color: var(--body-color-muted);
	font-weight: normal;
}

#bouncer .bouncer-list {
	list-style: none;
	margin: 0 0 1rem;
	padding: 0;
}

#bouncer .bouncer-row {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.5rem 0;
	box-shadow: inset 0 -1px 0 rgb(128 128 128 / 20%);
}

#bouncer .bouncer-row .btn {
	margin: 0;
	flex-shrink: 0;
}

#bouncer .bouncer-name {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-width: 0;
	overflow-wrap: anywhere;
}

#bouncer .bouncer-state {
	flex-shrink: 0;
	width: 0.625rem;
	height: 0.625rem;
	border-radius: 50%;
	background: var(--body-color-muted);
}

#bouncer .bouncer-state.connected {
	background: #2ecc40;
}

#bouncer .bouncer-state.connecting {
	background: #f39c12;
}

#bouncer .bouncer-error {
	color: #e74c3c;
}

#bouncer .bouncer-form h2 {
	font-size: 1.125em;
}

#bouncer .bouncer-form-actions {
	display: flex;
	gap: 0.5rem;
	margin-top: 0.75rem;
}
</style>

<script lang="ts">
import {computed, defineComponent, onBeforeUnmount, ref} from "vue";
import {useRoute} from "vue-router";
import {useStore} from "../../js/store";
import {leavePage} from "../../js/router";
import socket from "../../js/socket";
import type {SharedBouncerNetwork} from "../../../shared/types/network";

/** The spec's standard attributes the form edits; `state` and `error` are read-only. */
const FIELDS = [
	{key: "name", label: "Name", placeholder: "Libera.Chat"},
	{key: "host", label: "Server", placeholder: "irc.libera.chat"},
	{key: "port", label: "Port", placeholder: "6697 with TLS, 6667 without"},
	{key: "tls", label: "TLS", placeholder: ""},
	{key: "nickname", label: "Nick", placeholder: "the bouncer's default"},
	{key: "username", label: "Username", placeholder: ""},
	{key: "realname", label: "Real name", placeholder: ""},
	{key: "pass", label: "Server password", placeholder: ""},
] as const;

const TEXT_KEYS = FIELDS.map((f) => f.key).filter((k) => k !== "tls");

type Form = {
	netid?: string;
	original: Record<string, string>;
	values: Record<string, string>;
	tls: boolean;
};

let requestIds = 0;

/**
 * The bouncer panel (irc/bouncer.ts): soju's networks as the bouncer
 * connection lists them, with add / edit / delete through
 * `BOUNCER ADDNETWORK|CHANGENETWORK|DELNETWORK`. The list is live
 * (`-notify`); each network is a network of its own in the sidebar, made by
 * the manager. A modal like Settings at `/bouncer/<network>`, opened from
 * the server button in that network's header.
 */
export default defineComponent({
	name: "BouncerPanel",
	setup() {
		const store = useStore();
		const route = useRoute();

		const uuid = computed(() => String(route.params.uuid));
		const network = computed(() => store.getters.findNetwork(uuid.value));
		const networkName = computed(() => network.value?.name ?? "");

		const form = ref<Form | null>(null);
		const busy = ref(false);
		const error = ref("");
		const confirming = ref<string | null>(null);
		let pending = "";

		const onReplied = (data: {id: string; ok: boolean; error?: string}) => {
			if (data.id !== pending) {
				return;
			}

			pending = "";
			busy.value = false;
			error.value = data.ok ? "" : data.error ?? "The bouncer refused.";

			if (data.ok) {
				form.value = null;
				confirming.value = null;
			}
		};

		socket.on("bouncer:replied", onReplied);
		onBeforeUnmount(() => socket.off("bouncer:replied", onReplied));

		const ask = (
			subcommand: "ADDNETWORK" | "CHANGENETWORK" | "DELNETWORK",
			netid?: string,
			attrs?: Record<string, string>
		) => {
			pending = `bouncer-${++requestIds}`;
			busy.value = true;
			error.value = "";
			socket.emit("bouncer:request", {
				network: uuid.value,
				id: pending,
				subcommand,
				netid,
				attrs,
			});
		};

		const add = () => {
			error.value = "";
			form.value = {original: {}, values: {}, tls: true};
		};

		const edit = (net: SharedBouncerNetwork) => {
			error.value = "";
			form.value = {
				netid: net.netid,
				original: {...net.attrs},
				values: {...net.attrs},
				tls: net.attrs.tls !== "0",
			};
		};

		const submit = () => {
			const f = form.value;

			if (!f) {
				return;
			}

			const attrs: Record<string, string> = {};

			for (const key of TEXT_KEYS) {
				const value = (f.values[key] ?? "").trim();

				// New: only what was typed (soju fills the rest in). Edit: only
				// what changed, an emptied field as a bare key (cleared).
				if (f.netid ? value !== (f.original[key] ?? "") : value !== "") {
					attrs[key] = value;
				}
			}

			const tls = f.tls ? "1" : "0";

			if (f.netid ? tls !== (f.original.tls ?? "1") : !f.tls) {
				attrs.tls = tls;
			}

			if (!f.netid) {
				ask("ADDNETWORK", undefined, attrs);
			} else if (Object.keys(attrs).length > 0) {
				ask("CHANGENETWORK", f.netid, attrs);
			} else {
				form.value = null;
			}
		};

		const remove = (netid: string) => {
			ask("DELNETWORK", netid);
		};

		const endpoint = (attrs: Record<string, string>) => {
			if (!attrs.host) {
				return "";
			}

			return `${attrs.host}${attrs.port ? `:${attrs.port}` : ""}${
				attrs.tls === "0" ? "" : " (TLS)"
			}`;
		};

		const close = () => {
			leavePage();
		};

		return {
			FIELDS,
			network,
			networkName,
			form,
			busy,
			error,
			confirming,
			add,
			edit,
			submit,
			remove,
			endpoint,
			close,
		};
	},
});
</script>
