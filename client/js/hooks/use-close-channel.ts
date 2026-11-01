import eventbus from "../eventbus";
import {useI18n} from "../i18n";
import socket from "../socket";
import {ClientChan} from "../types";
import {ChanType} from "../../../shared/types/chan";

export default function useCloseChannel(channel: ClientChan) {
	const {t} = useI18n();

	return () => {
		if (channel.type === ChanType.LOBBY) {
			eventbus.emit(
				"confirm-dialog",
				{
					title: t("lobby.removeTitle"),
					text: t("lobby.removeText", {name: channel.name}),
					button: t("lobby.removeButton"),
				},
				(result: boolean) => {
					if (!result) {
						return;
					}

					channel.closed = true;
					socket.emit("input", {
						target: Number(channel.id),
						text: "/quit",
					});
				}
			);

			return;
		}

		channel.closed = true;

		socket.emit("input", {
			target: Number(channel.id),
			text: "/close",
		});
	};
}
