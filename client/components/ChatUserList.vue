<template>
	<aside ref="userlist" class="userlist" :aria-label="listTitle" @mouseleave="removeHoverUser">
		<div class="count">
			<input
				ref="input"
				dir="auto"
				:value="userSearchInput"
				:placeholder="countPlaceholder"
				type="search"
				class="search"
				:aria-label="searchLabel"
				tabindex="-1"
				@input="setUserSearchInput"
				@keydown.up="navigateUserList($event, -1)"
				@keydown.down="navigateUserList($event, 1)"
				@keydown.page-up="navigateUserList($event, -10)"
				@keydown.page-down="navigateUserList($event, 10)"
				@keydown.enter="selectUser"
			/>
		</div>
		<div class="names">
			<div
				v-for="(users, mode) in groupedUsers"
				:key="mode"
				:class="['user-mode', getModeClass(String(mode))]"
				:data-label="modeLabel(String(mode))"
			>
				<template v-if="userSearchInput.length > 0">
					<!-- eslint-disable vue/no-v-text-v-html-on-component -->
					<Username
						v-for="user in users"
						:key="user.original.nick + '-search'"
						:on-hover="hoverUser"
						:active="user.original === activeUser"
						:user="user.original"
						v-html="user.string"
					/>
					<!-- eslint-enable -->
				</template>
				<template v-else>
					<Username
						v-for="user in users"
						:key="user.nick"
						:on-hover="hoverUser"
						:active="user === activeUser"
						:user="user"
					/>
				</template>
			</div>
		</div>
	</aside>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, PropType, ref} from "vue";
import type {UserInMessage} from "../../shared/types/msg";
import type {ClientChan, ClientUser} from "../js/types";
import {fuzzyHtml} from "../js/helpers/fuzzyHtml";
import Username from "./Username.vue";
import {useI18n} from "../js/i18n";

const modes = {
	"~": "owner",
	"&": "admin",
	"!": "admin",
	"@": "op",
	"%": "half-op",
	"+": "voice",
	"": "normal",
};

export default defineComponent({
	name: "ChatUserList",
	components: {
		Username,
	},
	props: {
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const {t, tCount} = useI18n();
		const userSearchInput = ref("");
		const activeUser = ref<UserInMessage | null>();
		const userlist = ref<HTMLDivElement>();

		// Panel label and the member-count placeholder of its search field.
		const listTitle = computed(() => t("userlist.title", {name: props.channel.name}));
		const searchLabel = computed(() => t("userlist.searchLabel"));
		const countPlaceholder = computed(() =>
			tCount("userlist.count", props.channel.users.length)
		);
		const filteredUsers = computed(() => {
			if (!userSearchInput.value) {
				return;
			}

			return fuzzyHtml(userSearchInput.value, props.channel.users, (u) => u.nick);
		});

		const groupedUsers = computed(() => {
			const groups = {};

			if (userSearchInput.value && filteredUsers.value) {
				const result = filteredUsers.value;

				for (const user of result) {
					const mode: string = user.original.modes[0] || "";

					if (!groups[mode]) {
						groups[mode] = [];
					}

					// Prepend user mode to search result
					user.string = mode + user.string;

					groups[mode].push(user);
				}
			} else {
				for (const user of props.channel.users) {
					const mode = user.modes[0] || "";

					if (!groups[mode]) {
						groups[mode] = [user];
					} else {
						groups[mode].push(user);
					}
				}
			}

			return groups as {
				[mode: string]: (ClientUser & {
					original: UserInMessage;
					string: string;
				})[];
			};
		});

		const setUserSearchInput = (e: Event) => {
			userSearchInput.value = (e.target as HTMLInputElement).value;
		};

		const getModeClass = (mode: string) => {
			return modes[mode] as typeof modes;
		};

		// The group's heading, drawn by CSS from this attribute
		// (`#chat .user-mode[data-label]::before`): a mode the map does not
		// know gets no heading, as before.
		const modeLabels = computed<Record<string, string>>(() => ({
			owner: t("userlist.mode.owners"),
			admin: t("userlist.mode.admins"),
			op: t("userlist.mode.operators"),
			"half-op": t("userlist.mode.halfOperators"),
			voice: t("userlist.mode.voiced"),
			normal: t("userlist.mode.users"),
		}));
		const modeLabel = (mode: string): string | undefined =>
			modeLabels.value[getModeClass(mode) as unknown as string];

		const selectUser = () => {
			// Simulate a click on the active user to open the context menu.
			// Coordinates are provided to position the menu correctly.
			if (!activeUser.value || !userlist.value) {
				return;
			}

			const el = userlist.value.querySelector(".active");

			if (!el) {
				return;
			}

			const rect = el.getBoundingClientRect();
			const ev = new MouseEvent("click", {
				view: window,
				bubbles: true,
				cancelable: true,
				clientX: rect.left,
				clientY: rect.top + rect.height,
			});
			el.dispatchEvent(ev);
		};

		const hoverUser = (user: UserInMessage) => {
			activeUser.value = user;
		};

		const removeHoverUser = () => {
			activeUser.value = null;
		};

		const scrollToActiveUser = () => {
			// Scroll the list if needed after the active class is applied
			void nextTick(() => {
				const el = userlist.value?.querySelector(".active");
				el?.scrollIntoView({block: "nearest", inline: "nearest"});
			});
		};

		const navigateUserList = (event: Event, direction: number) => {
			// Prevent propagation to stop global keybind handler from capturing pagedown/pageup
			// and redirecting it to the message list container for scrolling
			event.stopImmediatePropagation();
			event.preventDefault();

			let users = props.channel.users;

			// Only using filteredUsers when we have to avoids filtering when it's not needed
			if (userSearchInput.value && filteredUsers.value) {
				users = filteredUsers.value.map((result) => result.original);
			}

			// Bail out if there's no users to select
			if (!users.length) {
				activeUser.value = null;
				return;
			}

			const abort = () => {
				activeUser.value = direction ? users[0] : users[users.length - 1];
				scrollToActiveUser();
			};

			// If there's no active user select the first or last one depending on direction
			if (!activeUser.value) {
				abort();
				return;
			}

			let currentIndex = users.indexOf(activeUser.value as ClientUser);

			if (currentIndex === -1) {
				abort();
				return;
			}

			currentIndex += direction;

			// Wrap around the list if necessary. Normaly each loop iterates once at most,
			// but might iterate more often if pgup or pgdown are used in a very short user list
			while (currentIndex < 0) {
				currentIndex += users.length;
			}

			while (currentIndex > users.length - 1) {
				currentIndex -= users.length;
			}

			activeUser.value = users[currentIndex];
			scrollToActiveUser();
		};

		return {
			filteredUsers,
			groupedUsers,
			userSearchInput,
			activeUser,
			userlist,
			listTitle,
			searchLabel,
			countPlaceholder,

			setUserSearchInput,
			getModeClass,
			modeLabel,
			selectUser,
			hoverUser,
			removeHoverUser,
			navigateUserList,
		};
	},
});
</script>
