// Every message-type component in this directory, keyed `message-<file>`:
// a map the bundler builds statically from the glob.
const views = import.meta.glob<{default: any}>("./*.vue", {eager: true});

export default Object.entries(views).reduce((acc: Record<string, any>, [path, view]) => {
	acc["message-" + path.substring(2, path.length - 4)] = view.default;

	return acc;
}, {});
