/**
 * When #status-bar-tint goes under the page (style.css,
 * `html[data-status-bar-read]`). iOS takes the status bar's colour from the
 * strip once, at launch, and the strip then has to stop showing: a theme
 * that changes --canvas-bg-color afterwards (the ps scene's sky, written
 * inline on <html>) would otherwise leave an 8px band of the new colour
 * under a status bar of the old.
 *
 * The first inline write of --canvas-bg-color is the moment the strip would
 * start to differ from the status bar, so it goes under then, before that
 * frame paints (a MutationObserver runs as a microtask). Three seconds is
 * the backstop for every theme that never writes it. On the user's iPhone
 * the status bar came out in ps's fallback colour, the one before the
 * scene's first write: iOS had read the strip by then.
 */
export function lowerStatusBarTintAfterLaunch(): void {
	const html = document.documentElement;
	const observer = new MutationObserver(() => {
		if (html.style.getPropertyValue("--canvas-bg-color") !== "") {
			lower();
		}
	});
	const timer = window.setTimeout(lower, 3000);

	function lower() {
		observer.disconnect();
		window.clearTimeout(timer);
		html.setAttribute("data-status-bar-read", "");
	}

	observer.observe(html, {attributes: true, attributeFilter: ["style"]});
}
