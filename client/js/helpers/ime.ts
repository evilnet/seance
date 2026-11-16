/**
 * Whether a keydown belongs to an IME composition (Japanese, Chinese,
 * Korean input, a phone's dictation or autocorrect bar): above all the
 * Return that commits a candidate, which is the composition's and not a
 * Return the field should act on. Chrome and Firefox mark it `isComposing`;
 * Safari ends the composition before the keydown and leaves only keyCode
 * 229. A keyup cannot tell: Chrome's ends the composition first too, with
 * keyCode 13, so act on Return at keydown. Vue-free.
 */
export function isImeComposing(event: KeyboardEvent): boolean {
	return event.isComposing || event.keyCode === 229;
}
