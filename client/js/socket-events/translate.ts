// The reading pipeline's listeners (client/js/translate/reader.ts): a
// second `msg` listener that runs after ./msg pushed the message and a
// second `more` listener that runs after ./more prepended a history page,
// plus `part`/`quit` cleanup that runs before ./part and ./quit remove the
// channel or network.
import {initReader} from "../translate/reader";
import {initWriter} from "../translate/writer";

initReader();
initWriter();
