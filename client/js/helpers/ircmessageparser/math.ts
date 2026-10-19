// KaTeX for `$`…`$` and `$$…$$` spans, lazily loaded: the renderer is a chunk
// (like Prism for code) and its stylesheet and fonts are static files next to
// the app that the first span links. Nothing here imports Vue, the store or
// the DOM for rendering — `MathSpan.vue` owns the element — so mocha loads
// this module directly (`test/helpers/math.ts`).

type Katex = {
	version: string;
	renderToString(tex: string, options?: {displayMode?: boolean; throwOnError?: boolean}): string;
};

let katexPromise: Promise<Katex | undefined> | undefined;

function load(): Promise<Katex | undefined> {
	katexPromise ??= import(/* webpackChunkName: "katex" */ "katex")
		.then((mod: unknown) => {
			// The UMD build reaches an ESM import as its `default`
			const katex = mod as {default?: Katex} & Katex;

			return katex.default ?? katex;
		})
		.catch(() => undefined);

	return katexPromise;
}

// The stylesheet ships as a static file (webpack.config.ts copies it and the
// fonts next to the app). The first span that renders links it — before that
// nothing is fetched, and offline the TeX simply stays text.
let cssRequested = false;

function ensureCss() {
	if (cssRequested || typeof document === "undefined") {
		return;
	}

	cssRequested = true;
	const link = document.createElement("link");

	link.rel = "stylesheet";
	link.href = new URL("css/katex.min.css", document.baseURI).href;
	document.head.appendChild(link);
}

// TeX sets its own lengths (`\rule`, `\raisebox`, `\kern`) and anyone in a
// channel can type them: `\rule{1em}{5000em}` made one row 80,000px tall.
// Inline TeX that asks for a length past this stays text; display TeX has
// its own box, clipped in style.css. KaTeX's `maxSize` caps only `\rule`.
const MAX_INLINE_EM = 10;

function oversized(html: string): boolean {
	for (const [style] of html.matchAll(/style="[^"]*"/g)) {
		for (const [, n] of style.matchAll(/([\d.]+)em/g)) {
			if (parseFloat(n) > MAX_INLINE_EM) {
				return true;
			}
		}
	}

	return false;
}

// Renders `tex` to the HTML KaTeX stands behind — safe to set as innerHTML,
// because KaTeX escapes everything it is given and emits only its own markup.
// `throwOnError: false` renders a broken TeX as red error text instead of
// throwing; undefined comes back when the chunk failed (offline), the TeX is
// empty, or inline TeX is oversized.
export async function renderMath(tex: string, display: boolean): Promise<string | undefined> {
	if (tex.trim() === "") {
		return undefined;
	}

	const katex = await load();

	if (!katex) {
		return undefined;
	}

	try {
		ensureCss();

		const html = katex.renderToString(tex, {displayMode: display, throwOnError: false});

		return !display && oversized(html) ? undefined : html;
	} catch {
		return undefined;
	}
}
