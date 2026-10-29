// A channel's topic is read like its lines -- detected, and translated
// into the reading language when it is not already in it -- and its
// translation lives in the same store slice as a message's
// (`state.translations`), under an id no message can have: message ids
// count up from 1 and history ids down from -1, so a billion below zero is
// a space of its own. The reader (reader.ts `readTopic`) queues the topic
// under that id and the header (Chat.vue) reads the entry back by it.

/** Below every history id the allocator could reach. */
export const TOPIC_ENTRY_BASE = -1_000_000_000;

/** The `state.translations` id of a channel's topic translation. */
export function topicEntryId(chanId: number): number {
	return TOPIC_ENTRY_BASE - chanId;
}

/** Whether a translations id is a topic's rather than a message's. */
export function isTopicEntryId(id: number): boolean {
	return id <= TOPIC_ENTRY_BASE;
}
