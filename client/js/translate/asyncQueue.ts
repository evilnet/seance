// A push-side / pull-side queue: the protocol client pushes chunks as they
// arrive from the worker, the caller consumes them with `for await`.
// `onReturn` fires when the consumer leaves early (break, return, throw),
// which is how a cancel reaches the worker.

export class AsyncQueue<T> implements AsyncIterable<T> {
	onReturn: (() => void) | null = null;
	private items: T[] = [];
	private waiters: {resolve: (r: IteratorResult<T>) => void; reject: (e: Error) => void}[] = [];
	private closed = false;
	private error: Error | null = null;

	push(item: T): void {
		const waiter = this.waiters.shift();

		if (waiter) {
			waiter.resolve({value: item, done: false});
		} else {
			this.items.push(item);
		}
	}

	close(): void {
		this.closed = true;

		for (const waiter of this.waiters.splice(0)) {
			waiter.resolve({value: undefined as never, done: true});
		}
	}

	fail(error: Error): void {
		if (this.closed) {
			return;
		}

		this.error = error;

		for (const waiter of this.waiters.splice(0)) {
			waiter.reject(error);
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> => {
				if (this.items.length > 0) {
					return Promise.resolve({value: this.items.shift() as T, done: false});
				}

				if (this.error) {
					return Promise.reject(this.error);
				}

				if (this.closed) {
					return Promise.resolve({value: undefined as never, done: true});
				}

				return new Promise((resolve, reject) => this.waiters.push({resolve, reject}));
			},
			return: (): Promise<IteratorResult<T>> => {
				if (!this.closed) {
					this.onReturn?.();
				}

				this.close();
				return Promise.resolve({value: undefined as never, done: true});
			},
		};
	}
}
