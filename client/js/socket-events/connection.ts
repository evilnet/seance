import {store} from "../store";
import socket from "../socket";

// Socket.IO connect/disconnect/reconnect handling used to live here. The
// bus has no transport yet, so only the two contract-level events remain.
// Real connection state will arrive with the IRC transport in a later phase.

socket.on("connecting", function () {
	// Dialling is not an error: the chat header spins a small icon off
	// `network.status.connecting`, and the sidebar shows it per network.
	// Only the splash screen, which has no header yet, says it in words.
	updateLoadingMessage("Connecting…");
});

socket.on("error", function (data) {
	const message = String(data?.message || data);

	store.commit("isConnected", false);
	store.commit("currentUserVisibleError", `Connection error: ${message}`);
	updateLoadingMessage(store.state.currentUserVisibleError);
});

function updateLoadingMessage(text: string | null) {
	const loading = document.getElementById("loading-page-message");

	if (loading) {
		loading.textContent = text;
	}
}
