import {input as collapse} from "./collapse";
import {input as expand} from "./expand";
import {input as join} from "./join";
import {input as search} from "./search";

export const commands = {
	collapse: collapse,
	expand: expand,
	join: join,
	// `/j` is `/join`: both layers have to know, or `/j #listed` would go to
	// the server instead of switching to the window already open.
	j: join,
	search: search,
};
