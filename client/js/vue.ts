import {isPhoneLayout} from "./helpers/device";

import "../css/style.css";
import {createApp} from "vue";
import {store, CallableGetters, key} from "./store";
import App from "../components/App.vue";
import storage from "./localStorage";
import {router} from "./router";
import "./socket-events"; // this sets up all socket event listeners, do not remove
import eventbus from "./eventbus";
import {boot} from "./boot";

import "./webpush";
import "./pwa";
import "./keybinds";
import {setAppBadge} from "./helpers/appBadge";

const favicon = document.getElementById("favicon");
const faviconNormal = favicon?.getAttribute("href") || "";
const faviconAlerted = favicon?.dataset.other || "";

export const VueApp = createApp(App);

VueApp.use(router);
VueApp.use(store, key);

VueApp.mount("#app");

void boot();

store.watch(
	(state) => state.sidebarOpen,
	(sidebarOpen) => {
		if (!isPhoneLayout()) {
			storage.set("thelounge.state.sidebar", sidebarOpen.toString());
			eventbus.emit("resize");
		}
	}
);

store.watch(
	(state) => state.userlistOpen,
	(userlistOpen) => {
		storage.set("thelounge.state.userlist", userlistOpen.toString());
		eventbus.emit("resize");
	}
);

store.watch(
	(_, getters: CallableGetters) => getters.title,
	(title) => {
		document.title = title;
	}
);

// Toggles the favicon to red when there are unread notifications
store.watch(
	(_, getters: CallableGetters) => getters.highlightCount,
	(highlightCount) => {
		favicon?.setAttribute("href", highlightCount > 0 ? faviconAlerted : faviconNormal);
		setAppBadge(highlightCount);
	}
);

VueApp.config.errorHandler = function (e) {
	if (e instanceof Error) {
		store.commit("currentUserVisibleError", `Vue error: ${e.message}`);
	} else {
		store.commit("currentUserVisibleError", `Vue error: ${String(e)}`);
	}

	// eslint-disable-next-line no-console
	console.error(e);
};
