<template>
	<div :class="['oper-report', 'oper-report-' + report.kind, {'has-error': !!report.error}]">
		<div class="oper-report-head">
			<span class="oper-report-title">{{ report.title }}</span>
			<span v-if="report.subtitle" class="oper-report-subtitle">{{ report.subtitle }}</span>
			<span class="oper-report-actions">
				<button
					v-if="rerun"
					type="button"
					class="oper-report-btn oper-report-refresh"
					:aria-label="`Run ${report.command} again`"
					:title="`Run again: ${report.command}`"
					@click="refresh"
				/>
				<button
					type="button"
					:class="['oper-report-btn', 'oper-report-raw-toggle', {active: showRaw}]"
					:aria-pressed="showRaw"
					aria-label="Show the raw reply"
					title="Raw reply"
					@click="showRaw = !showRaw"
				/>
				<button
					type="button"
					:class="['oper-report-btn', 'oper-report-copy', {done: copied}]"
					:aria-label="copied ? 'Copied' : 'Copy as text'"
					:title="copied ? 'Copied' : 'Copy as text'"
					@click="copy"
				/>
				<button
					v-if="hasBody"
					type="button"
					:class="['oper-report-btn', 'oper-report-collapse', {collapsed}]"
					:aria-expanded="!collapsed"
					:aria-label="collapsed ? 'Expand' : 'Collapse'"
					@click="collapsed = !collapsed"
				/>
			</span>
		</div>
		<p v-if="report.error" class="oper-report-error">{{ report.error }}</p>
		<template v-if="!collapsed">
			<pre v-if="showRaw" class="oper-report-raw">{{ report.raw.join("\n") }}</pre>
			<template v-else>
				<section
					v-for="(section, s) in report.sections"
					:key="s"
					class="oper-report-section"
				>
					<h4 v-if="section.title" class="oper-report-section-title">
						{{ section.title }}
					</h4>
					<dl v-if="section.entries" class="oper-report-entries">
						<div v-for="(entry, e) in section.entries" :key="e">
							<dt>{{ entry.label }}</dt>
							<dd>
								<ReportValue :value="entry.value" :network="network" :chan="chan" />
							</dd>
						</div>
					</dl>
					<div v-if="section.table" class="oper-report-table-scroll">
						<table class="oper-report-table">
							<thead>
								<tr>
									<th
										v-for="col in section.table.columns"
										:key="col.key"
										:class="{right: col.align === 'right'}"
									>
										{{ col.label }}
									</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="(row, r) in visibleRows(s, section.table.rows)" :key="r">
									<td
										v-for="col in section.table.columns"
										:key="col.key"
										:class="{right: col.align === 'right'}"
									>
										<ReportValue
											v-if="row[col.key]"
											:value="row[col.key]"
											:network="network"
											:chan="chan"
										/>
										<span v-else class="oper-muted">—</span>
									</td>
								</tr>
							</tbody>
						</table>
						<button
							v-if="section.table.rows.length > ROW_LIMIT && !expanded[s]"
							type="button"
							class="oper-report-more"
							@click="expanded[s] = true"
						>
							Show all {{ section.table.rows.length }} rows
						</button>
					</div>
					<pre v-if="section.lines" class="oper-report-lines">{{
						section.lines.join("\n")
					}}</pre>
				</section>
				<ul v-if="report.notes && report.notes.length" class="oper-report-notes">
					<li v-for="(note, n) in report.notes" :key="n">{{ note }}</li>
				</ul>
			</template>
		</template>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType, reactive, ref} from "vue";
import type {OperReport, ReportTable} from "../../../shared/types/oper";
import type {ClientNetwork} from "../../js/types";
import {reportText} from "../../js/helpers/operFormat";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import ReportValue from "./ReportValue.vue";

/** Rows shown before "Show all": a G-line list can run to hundreds. */
const ROW_LIMIT = 25;

/** Commands a report can be run again with (typed, so it lands where it was asked). */
const RERUNNABLE = new Set(["STATS", "CHECK", "PRIVS"]);

export default defineComponent({
	name: "ReportView",
	components: {ReportValue},
	props: {
		report: {type: Object as PropType<OperReport>, required: true},
		network: {type: Object as PropType<ClientNetwork>, required: true},
		chan: {type: Number, required: false},
	},
	setup(props) {
		const store = useStore();
		const showRaw = ref(false);
		const collapsed = ref(false);
		const copied = ref(false);
		const expanded = reactive<Record<number, boolean>>({});

		const hasBody = computed(
			() => props.report.sections.length > 0 || (props.report.notes?.length ?? 0) > 0
		);
		const rerun = computed(() => RERUNNABLE.has(props.report.command.split(" ")[0]));

		const visibleRows = (s: number, rows: ReportTable["rows"]) =>
			expanded[s] ? rows : rows.slice(0, ROW_LIMIT);

		const refresh = () => {
			const target =
				props.chan ?? store.state.activeChannel?.channel.id ?? props.network.channels[0].id;
			const [command, ...rest] = props.report.command.split(" ");
			socket.emit("input", {
				target,
				text: `/${command.toLowerCase()} ${rest.join(" ")}`.trim(),
			});
		};

		const copy = () => {
			void navigator.clipboard
				?.writeText(showRaw.value ? props.report.raw.join("\n") : reportText(props.report))
				.then(() => {
					copied.value = true;
					setTimeout(() => (copied.value = false), 1500);
				})
				.catch(() => undefined);
		};

		return {
			showRaw,
			collapsed,
			copied,
			expanded,
			hasBody,
			rerun,
			visibleRows,
			refresh,
			copy,
			ROW_LIMIT,
		};
	},
});
</script>
