import socket from "../socket";
import {addMentions, dropMentionOf, markMentionsRead} from "../mentions";

// Unread mentions, live or caught up (docs/projects/inbox.md). A muted
// conversation's are kept too, and hidden (store.ts visibleMentions), so
// unmuting it shows what is still unread.
socket.on("inbox:add", function (data) {
	addMentions(data.entries);
});

// A conversation was read up to a point, here or on another session.
socket.on("inbox:read", function (data) {
	markMentionsRead(data.network, data.target, new Date(data.time));
});

// A message deleted, or replaced by its author's edit, loaded or not.
socket.on("inbox:drop", function (data) {
	dropMentionOf(data.network, data.target, data.msgid, data.by);
});
