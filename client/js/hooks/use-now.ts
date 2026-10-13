import {onUnmounted, ref, type Ref} from "vue";

/**
 * The current time, refreshed every 30 seconds: what relative times ("in
 * 3h", "5m ago") in the oper tools render against. One shared timer for
 * every component that uses it, stopped when the last one unmounts.
 */
const now = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

export default function useNow(): Ref<number> {
	users++;

	if (timer === undefined) {
		now.value = Date.now();
		timer = setInterval(() => (now.value = Date.now()), 30_000);
	}

	onUnmounted(() => {
		users--;

		if (users === 0 && timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	return now;
}
