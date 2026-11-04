/**
 * A change sent a moment after the last edit, then a settle period while the
 * server answers, after which the control reads the server's value again.
 * The Alerts tab's raw snomask uses it (`Oper/OperAlerts.vue`): edits go out
 * together `delayMs` after the last one, and `settleMs` after a send the
 * switches stop holding the draft.
 *
 * Both timers are kept: an edit cancels a settle still pending, so the
 * server's old value can never overwrite an edit made after the previous
 * send (a toggle 1.1–1.5 s after the last one used to be put back just before
 * it went out). Vue-free for test/helpers/settleDebounce.ts.
 */

export interface SettleDebounce {
	/** An edit: (re)start the send delay, and call off any pending settle. */
	schedule(): void;
	/** Send now if a send is waiting (an unmount); no settle follows. */
	flush(): void;
	/** Drop both timers without sending. */
	cancel(): void;
	/** Whether a send is waiting. */
	readonly waiting: boolean;
}

export function settleDebounce(opts: {
	delayMs: number;
	settleMs: number;
	send: () => void;
	settle: () => void;
}): SettleDebounce {
	let sendTimer: ReturnType<typeof setTimeout> | undefined;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	const stopSettle = () => {
		clearTimeout(settleTimer);
		settleTimer = undefined;
	};

	const fire = () => {
		sendTimer = undefined;
		opts.send();
		stopSettle();
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			opts.settle();
		}, opts.settleMs);
	};

	return {
		schedule() {
			stopSettle();
			clearTimeout(sendTimer);
			sendTimer = setTimeout(fire, opts.delayMs);
		},
		flush() {
			if (sendTimer !== undefined) {
				clearTimeout(sendTimer);
				sendTimer = undefined;
				opts.send();
			}

			stopSettle();
		},
		cancel() {
			clearTimeout(sendTimer);
			sendTimer = undefined;
			stopSettle();
		},
		get waiting() {
			return sendTimer !== undefined;
		},
	};
}
