// The composer's glue (spec § Composer), the mirror of reader.ts and the
// other module allowed to import the store: the channel's write target,
// one draft's translation into store.state.outgoingTranslations (which
// ChatInput.vue renders as the strip), the round trip, and what a sent
// pair leaves behind (the user's voice for later prompts, a term for the
// channel's memory). The reading queue cannot serve a write and is held
// while one runs; the request goes to the service directly.

import {getBranding} from "../branding";
import {BUILD} from "../build";
import socket from "../socket";
import {store, type OutgoingTranslation, type TranslationEntry} from "../store";
import type {ClientChan, ClientNetwork} from "../types";
import {ChanType} from "../../../shared/types/chan";
import {
	type Formality,
	channelKey,
	effectiveFormality,
	getChannelTranslation,
	rememberTerm,
	termsFor,
} from "./channelStore";
import {buildContext} from "./context";
import {type Detection, detectLanguage} from "./detect";
import {plainTextOf} from "./eligibility";
import {namesFor} from "./names";
import {type EngineName, type PromptContext, emptyContext} from "./engine";
import {translateService} from "./index";
import {
	ABORTED,
	BARE_RETRY_ERRORS,
	type OutgoingDeps,
	type OutgoingRequest,
	type TranslateCapture,
	WRITE_DETECT_MIN_GAP,
	answerError,
	bareRetry,
	tidyAnswer,
	echoingSoFar,
	hasNoLetters,
	isUnchanged,
	reverseTarget,
	sourceHintFor,
	termPair,
	translateDraft,
	writeSource,
	UNCHANGED,
	keepQuestionMark,
	stripPolishLabel,
} from "./outgoing";
import {
	channelTranslation,
	holdReading,
	readingLanguage,
	releaseReading,
	setChannelOptions,
} from "./reader";
import type {Route} from "./router";
import {sentReadBacks} from "./sentReadBack";
import {LLM_MARKERS, type MarkerForm, stripCopiedNickPrefix} from "./spans";

/** An id no message has: buildContext then takes the whole scrollback as "before" the draft. */
const DRAFT_ID = Number.MAX_SAFE_INTEGER;

/**
 * A development build's record of the composer's requests, for the offline
 * runner (`tools/translate-llm.ts --capture`): a translation that reads
 * wrongly cannot be diagnosed from the answer alone, and the request the
 * page built -- its context, its source, its marker form -- is the one
 * thing a report about it cannot otherwise carry. `seanceTranslateLast` is
 * the newest attempt, `seanceTranslateLog` the newest CAPTURE_KEEP of them.
 * Neither is defined in a production build.
 */
declare global {
	// eslint-disable-next-line no-var
	var seanceTranslateLog: TranslateCapture[] | undefined;
	// eslint-disable-next-line no-var
	var seanceTranslateLast: TranslateCapture | undefined;
}

const CAPTURE_KEEP = 10;

/** The context as it went out, detached from the store's objects it quotes. */
function cloneContext(context: PromptContext): PromptContext {
	return JSON.parse(JSON.stringify(context)) as PromptContext;
}

function capture(entry: TranslateCapture): void {
	if (BUILD !== "dev") {
		return;
	}

	const log = (window.seanceTranslateLog ??= []);

	log.push(entry);

	// Trimmed in place rather than replaced, so a console that holds a
	// reference to the array keeps seeing the newest entries.
	if (log.length > CAPTURE_KEEP) {
		log.splice(0, log.length - CAPTURE_KEEP);
	}

	window.seanceTranslateLast = entry;
}

/**
 * The marker form a route's engine reads (spans.ts): the LLM is the one
 * that takes an instruction about the marks and the one that cannot handle
 * placeholders around words it must translate, so it gets `LLM_MARKERS`;
 * every seq2seq candidate keeps the numbered pairs.
 */
function markersFor(candidate: string | undefined): MarkerForm {
	return candidate === "llm" ? LLM_MARKERS : "placeholder";
}

/**
 * Which of the two engines a route runs on (`models.ts` `Candidate` names
 * the model, `engine.ts` `EngineName` the engine behind it): the strip's
 * title says GPU or CPU off this, so a user looking at a translation can
 * see which one they got.
 */
function engineFor(route: Route | null): EngineName | null {
	if (!route) {
		return null;
	}

	return route.candidate === "llm" ? "llm" : "seq2seq";
}

/** In-flight translation and check per channel id. */
const sessions = new Map<number, AbortController>();
const checks = new Map<number, AbortController>();
/** The user's sent translations per channel, for the prompt's voice line (session only). */
const voices = new Map<number, {to: string; lines: string[]}>();
/**
 * How many sent translations a channel remembers for one target (a send to
 * a different target replaces the lot); buildContext quotes the newest
 * VOICE_LINES of them, so the surplus is only margin.
 */
const VOICE_KEEP = 10;

const deps: OutgoingDeps = {
	translate: (req, signal) => translateService().translate(req, signal),
	setTimeout: (fn, ms) => window.setTimeout(fn, ms),
	clearTimeout: (handle) => window.clearTimeout(handle as number),
	loadTicks: () => translateService().loadTicks(),
};

/** The channel's register, or the global one where it says "auto" (channelStore.ts). */
function formalityOf(channel: Formality): Formality {
	return effectiveFormality(channel, store.state.settings.translateFormality);
}

/**
 * The channel's write target, synchronously, for a component to render off.
 * It does not wait for the device probe — the panel is the only writer of
 * `write`, and a placeholder that says "sent in German" a moment before the
 * probe answers is better than a draft that goes out untranslated because
 * the capability was not known yet. translateOutgoing awaits the probe and
 * judges availability there.
 */
export function writeTarget(network: ClientNetwork, channel: ClientChan): string | null {
	return translateService().enabled ? channelTranslation(network, channel).write : null;
}

/**
 * The composer's translate button: the draft into `to`, this once, whether
 * or not the channel has a write target -- the strip comes up as it does
 * for a write target, and the next Enter sends what it holds. The choice
 * is kept with the channel's record (channelStore.ts `once`, so it
 * survives a reload and travels in the settings backup) for the button's
 * next pick (`lastOnceTarget`).
 */
export function translateOnce(
	network: ClientNetwork,
	channel: ClientChan,
	draft: string,
	to: string,
	from: string | null = null
): Promise<"strip" | "plain"> {
	if (channelTranslation(network, channel).once !== to) {
		setChannelOptions(network, channel, {once: to});
	}

	return translateOutgoing(network, channel, draft, {to, from});
}

/** A one-off request: its target, and its source when the dialog named one. */
export interface OnceRequest {
	to: string;
	/** Null: detect the draft's language, as a write target does. */
	from: string | null;
}

/** The picker's preselection: the channel's last one-off target, else its write target. */
export function lastOnceTarget(network: ClientNetwork, channel: ClientChan): string {
	const settings = channelTranslation(network, channel);

	return settings.once ?? settings.write ?? "";
}

export function outgoingTranslation(channel: ClientChan): OutgoingTranslation | undefined {
	return store.state.outgoingTranslations[channel.id];
}

function voiceFor(channel: ClientChan, to: string): string[] {
	const voice = voices.get(channel.id);

	return voice && voice.to === to ? voice.lines : [];
}

/** Still the strip for this draft? A cancel or a newer draft replaces it. */
function current(channel: ClientChan, draft: string, controller: AbortController): boolean {
	return (
		!controller.signal.aborted && store.state.outgoingTranslations[channel.id]?.draft === draft
	);
}

/**
 * The first Enter: translate the draft into the channel's write target.
 * Resolves "plain" when the draft needs no translation — there is no write
 * target, the device cannot translate, or the detector already places the
 * draft in the target — so the caller sends it as typed. Resolves "strip"
 * when the strip is up (the second Enter sends it, or sends the draft as
 * written after a failure) and when a strip was dropped mid-flight (a newer
 * draft, a cancel, the panel's target moved): nothing is sent, the draft
 * stays in the input.
 */
export async function translateOutgoing(
	network: ClientNetwork,
	channel: ClientChan,
	draft: string,
	once?: OnceRequest
): Promise<"strip" | "plain"> {
	// A one-off (the composer's translate button, `once`) names its own
	// target and needs no write target on the channel; the panel's target
	// moving mid-flight cannot invalidate it either.
	const to = once?.to ?? writeTarget(network, channel);

	if (!to) {
		return "plain";
	}

	cancelOutgoing(channel);

	const controller = new AbortController();

	sessions.set(channel.id, controller);
	store.commit("outgoingTranslationSet", {
		chanId: channel.id,
		value: {
			status: "pending",
			draft,
			text: "",
			from: null,
			requestFrom: null,
			retried: false,
			to,
			engine: null,
			model: null,
			error: null,
			check: {status: "idle", text: "", to: null},
		},
	});

	try {
		// The probe before the verdict: on a cold page the service is
		// created by this very call and its tier is not known yet, so
		// judging availability first would send every first draft
		// untranslated. The awaited value is the verdict — reading it back
		// out of the store would depend on index.ts chaining its commit onto
		// this same promise first. The probe is memoised, so this is free
		// once it has answered.
		const capability = await translateService().capabilities();

		if (!current(channel, draft, controller)) {
			return "strip";
		}

		if (!translateService().enabled || capability.tier === "none") {
			cancelOutgoing(channel);
			return "plain";
		}

		// Every name the draft may carry (names.ts `namesFor`): the user
		// list, the user's own nick, a query's other party and whoever has
		// spoken here lately. The same set is fenced, listed and stripped.
		const nicks = namesFor({
			users: channel.users,
			sender: network.nick,
			target: channel.name,
			messages: channel.messages,
		});
		// No channel prior and no declared languages: both describe what
		// others write here, and this is the user's own line.
		// A source the one-off dialog named is the verdict, no detection run.
		const detection: Detection = once?.from
			? {lang: once.from, confidence: 1, candidates: []}
			: await detectLanguage(plainTextOf(draft, nicks), null, []);

		if (!current(channel, draft, controller)) {
			return "strip";
		}

		// The panel may have changed while the detector loaded. The strip
		// this draft was started for is gone, so nothing is sent: the draft
		// stays in the input for the user's next Enter, which translates it
		// into the new target.
		const settings = channelTranslation(network, channel);

		if (!once && settings.write !== to) {
			cancelOutgoing(channel);
			return "strip";
		}

		// A draft already in the target. Corrected in place -- a polish
		// (purpose "polish": the LLM as a copy editor, router.ts routes a
		// same-language request to it alone), an echo of which is "nothing
		// to correct" rather than a failure -- when someone asked for that
		// language: a one-off, or a write target set to the user's own
		// language, which can only mean "send my lines corrected". Sent as
		// typed when a foreign write target finds the draft already in it:
		// that target asked for nothing.
		const ownLanguage = to === readingLanguage();
		const inTarget = detection.lang === to && detection.confidence >= WRITE_DETECT_MIN_GAP;

		if (inTarget && !once && !ownLanguage) {
			cancelOutgoing(channel);
			return "plain";
		}

		// Under an own-language write target a draft the detector cannot
		// place is the user's own language by every odd (`writeSource` has
		// no other fallback there), so it is corrected rather than sent to
		// the engine to guess at; a one-off with "detect" and no verdict is
		// left to the engine, since the line may well be a foreign one
		// pasted in to be translated.
		const guessed = once?.from ?? writeSource(detection, readingLanguage(), to);
		const polish =
			inTarget || (ownLanguage && !once && guessed === null) || (!!once && once.from === to);
		const from = polish ? to : guessed;
		// The detector's verdict, however weak, rides along as the routing
		// hint: a seq2seq route takes it as its source, so a draft whose
		// source is left to the LLM can still reach NLLB (router.ts). It is
		// not the prompt's `sourceHint`: the LLM is not told a guess the
		// code judged too weak to trust.
		const hint = sourceHintFor(detection, from, to);
		const route = await translateService().route(from, to, hint);
		// Nothing of the channel travels with a polish (the prompt profiles
		// say why): the register is all it keeps.
		const polishContext = emptyContext();

		polishContext.formality = formalityOf(settings.formality);

		if (settings.variant) {
			polishContext.variant = settings.variant;
		}

		const context = polish
			? polishContext
			: buildContext(
					channel,
					{
						id: DRAFT_ID,
						type: "message",
						text: draft,
						from: {nick: network.nick},
						replyTo: channel.replyTo?.msgid,
					},
					{
						translated(id) {
							const entry = store.state.translations[id];

							return entry && entry.status === "done" ? entry.text : undefined;
						},
						terms: termsFor(settings.terms, from, to),
						glossary: getBranding().translation?.glossary ?? [],
						formality: formalityOf(settings.formality),
						variant: settings.variant,
						sourceHint: from,
						nicks,
						voice: voiceFor(channel, to),
					}
			  );

		if (current(channel, draft, controller)) {
			store.commit("outgoingTranslationPatch", {
				chanId: channel.id,
				patch: {
					from,
					requestFrom: from,
					engine: engineFor(route),
					device: route?.device,
					model: route?.ref.id ?? null,
				},
			});
		}

		const request: OutgoingRequest = {
			text: draft,
			from,
			hint,
			to,
			purpose: polish ? "polish" : "write",
			context,
			batches: route?.candidate === "llm",
			device: route?.device,
			engine: engineFor(route),
			markers: markersFor(route?.candidate),
			nicks,
		};

		/**
		 * One generation of this draft, streamed into the strip: the answer
		 * restored, a copied nick prefix off it, and — on a development
		 * build — the request and what it produced recorded. Both tries go
		 * through here, so they are the same request in everything but what
		 * the prompt says about the draft.
		 */
		const attempt = async (req: OutgoingRequest, retry: boolean): Promise<string> => {
			const record = (text: string, error: string | null) =>
				capture({
					kind: "write",
					at: new Date().toISOString(),
					draft,
					from: req.from,
					to: req.to,
					model: route?.ref.id ?? null,
					engine: engineFor(route),
					markers: req.markers ?? "placeholder",
					retry,
					context: cloneContext(req.context),
					text,
					error,
				});

			let answer: string;

			try {
				answer = await translateDraft(deps, req, controller.signal, (partial) => {
					if (current(channel, draft, controller)) {
						store.commit("outgoingTranslationPatch", {
							chanId: channel.id,
							// Nothing but the draft coming back yet: show the caret, not
							// an echo the bare retry may be about to replace.
							patch: {text: echoingSoFar(draft, partial) ? "" : partial},
						});
					}
				});
			} catch (e) {
				record("", e instanceof Error ? e.message : String(e));
				throw e;
			}

			// The prompt shows the earlier lines as `nick: text`, so a model
			// can copy a name in that shape in front of its answer. Only the
			// finished text is cleaned: a stream's prefix is not one until
			// the line after it has arrived — and a draft that opened with
			// `nick: ` keeps it, since then the prefix is the user's own.
			// The copied name, then the model's packaging (a preamble about the
			// translation, a wrapper round the whole answer): outgoing.ts tidyAnswer.
			const tidied = tidyAnswer(
				draft,
				polish
					? stripPolishLabel(stripCopiedNickPrefix(answer, draft, nicks))
					: stripCopiedNickPrefix(answer, draft, nicks)
			);
			// A cleanup that lost its question's mark gets it back, so the
			// slip is not judged an answer (outgoing.ts keepQuestionMark).
			const text = polish ? keepQuestionMark(draft, tidied) : tidied;

			record(text, answerError(draft, text, to));

			return text;
		};

		holdReading();

		let text: string;

		try {
			text = await attempt(request, false);

			if (!current(channel, draft, controller)) {
				return "strip";
			}

			// `answerError` (outgoing.ts) judges an answer: nothing in it a
			// language could be is a failure rather than a message (a "done"
			// of "" would be sent as an empty line, which the IRC layer drops
			// in silence, taking the draft with it), and the draft back again
			// is not a translation either.
			let error = answerError(draft, text, to);

			// A polish handed back as it was had nothing to correct: the
			// strip shows the line, and Enter sends it. There is no second
			// try to make -- a polish already goes out in the bare shape a
			// retry would ask in.
			if (polish && error === UNCHANGED) {
				error = null;
			}

			// An echo gets one more try, and a bare one: the same draft with
			// the source left to the model and no context but the register.
			// The two things that make a model hand a line back — a source
			// that is wrong for the draft, and a context that confounds it —
			// are exactly what that removes, and it costs a second generation
			// only where the first produced nothing usable. The strip stays
			// pending and streams the retry; its chip keeps the draft's
			// language, and the title drops to `auto` and says a retry ran,
			// because that is the request now in flight. Exactly one retry:
			// a model that echoes a bare request is declining. An answer that
			// narrates the request instead ("okay, let's see. The user wants
			// …") gets the same second try: the same model looking at the same
			// confounding request, and the bare one translates. So does one
			// stuck repeating a word ("Höfðu ekki ekki ekki …"), and one that
			// answered the draft's question instead of translating it.
			if (error !== null && BARE_RETRY_ERRORS.has(error)) {
				store.commit("outgoingTranslationPatch", {
					chanId: channel.id,
					patch: {requestFrom: null, retried: true},
				});

				text = await attempt(bareRetry(request), true);

				if (!current(channel, draft, controller)) {
					return "strip";
				}

				error = answerError(draft, text, to);

				// Echoed twice, bare as well: nothing to correct. The strip
				// shows the line, and Enter sends it.
				if (polish && error === UNCHANGED) {
					error = null;
				}
			}

			// Either failure offers the same thing, and it is the right one
			// for a line with nothing to translate ("ok, brb") as much as for
			// a model that would not touch it: the second Enter sends the
			// draft as written.
			if (error) {
				store.commit("outgoingTranslationPatch", {
					chanId: channel.id,
					patch: {status: "failed", error},
				});

				return "strip";
			}
		} finally {
			releaseReading();
		}

		store.commit("outgoingTranslationPatch", {
			chanId: channel.id,
			patch: {status: "done", text},
		});

		void checkOutgoing(network, channel);

		return "strip";
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);

		if (message !== ABORTED && current(channel, draft, controller)) {
			store.commit("outgoingTranslationPatch", {
				chanId: channel.id,
				patch: {status: "failed", error: message},
			});
		}

		return "strip";
	} finally {
		if (sessions.get(channel.id) === controller) {
			sessions.delete(channel.id);
		}
	}
}

/** Escape, the strip's Edit, a changed draft, a send: the strip and its requests go. */
export function cancelOutgoing(channel: ClientChan): void {
	sessions.get(channel.id)?.abort();
	sessions.delete(channel.id);
	checks.get(channel.id)?.abort();
	checks.delete(channel.id);

	if (store.state.outgoingTranslations[channel.id]) {
		store.commit("outgoingTranslationRemove", channel.id);
	}
}

/** The round trip: the translation read back into the user's language, under the strip. */
export async function checkOutgoing(network: ClientNetwork, channel: ClientChan): Promise<void> {
	const entry = store.state.outgoingTranslations[channel.id];

	if (!entry || entry.status !== "done" || entry.check.status === "pending") {
		return;
	}

	const target = reverseTarget(readingLanguage(), entry.to);

	if (!target) {
		return;
	}

	checks.get(channel.id)?.abort();

	const controller = new AbortController();
	const draft = entry.draft;

	checks.set(channel.id, controller);
	store.commit("outgoingTranslationPatch", {
		chanId: channel.id,
		patch: {check: {status: "pending", text: "", to: target}},
	});

	try {
		const route = await translateService().route(entry.to, target, entry.to);
		const settings = channelTranslation(network, channel);
		const nicks = namesFor({
			users: channel.users,
			sender: network.nick,
			target: channel.name,
			messages: channel.messages,
		});
		// The context a reader of this channel would give the model for the
		// line the user is about to post, built the way reader.ts builds one
		// for a line arriving here: recent lines with the translations the
		// reader already has, names, topic, the draft's reply target, the
		// channel's register and the terms for this pair. No voice — that is
		// the writer's. A read-back given the line cold reads it differently
		// from how the channel will, which is what it is there to show.
		const context = buildContext(
			channel,
			{
				id: DRAFT_ID,
				type: "message",
				text: entry.text,
				from: {nick: network.nick},
				replyTo: channel.replyTo?.msgid,
			},
			{
				translated(id) {
					const done = store.state.translations[id];

					return done && done.status === "done" ? done.text : undefined;
				},
				terms: termsFor(settings.terms, entry.to, target),
				glossary: getBranding().translation?.glossary ?? [],
				formality: formalityOf(settings.formality),
				variant: settings.variant,
				sourceHint: entry.to,
				nicks,
			}
		);

		const request: OutgoingRequest = {
			text: entry.text,
			from: entry.to,
			to: target,
			purpose: "read",
			context,
			batches: route?.candidate === "llm",
			device: route?.device,
			engine: engineFor(route),
			markers: markersFor(route?.candidate),
			nicks,
		};

		/**
		 * One read-back, streamed into the second row. Read back *from* the
		 * translation, so that is the source the prefix rule is judged
		 * against — and the source an answer is compared with.
		 */
		const attempt = async (req: OutgoingRequest, retry: boolean): Promise<string> => {
			const record = (text: string, error: string | null) =>
				capture({
					kind: "check",
					at: new Date().toISOString(),
					draft: entry.text,
					from: req.from,
					to: req.to,
					model: route?.ref.id ?? null,
					engine: engineFor(route),
					markers: req.markers ?? "placeholder",
					retry,
					context: cloneContext(req.context),
					text,
					error,
				});

			let answer: string;

			try {
				answer = await translateDraft(deps, req, controller.signal, (partial) => {
					if (current(channel, draft, controller)) {
						store.commit("outgoingTranslationPatch", {
							chanId: channel.id,
							patch: {
								check: {
									status: "pending",
									text: echoingSoFar(entry.text, partial) ? "" : partial,
									to: target,
								},
							},
						});
					}
				});
			} catch (e) {
				record("", e instanceof Error ? e.message : String(e));
				throw e;
			}

			const text = tidyAnswer(entry.text, stripCopiedNickPrefix(answer, entry.text, nicks));

			record(text, answerError(entry.text, text, target));

			return text;
		};

		// Held like the translation itself: Send waits for this check, so it
		// must not queue behind the channel's incoming traffic either.
		holdReading();

		let read: string;

		try {
			read = await attempt(request, false);

			if (!current(channel, draft, controller)) {
				return;
			}

			// A read-back equal to the translation is the translation over
			// again, which says nothing about what it means — so it gets the
			// same bare second try the translation itself gets: no
			// `sourceHint`, the source left to the model (the routing hint
			// stays, for a seq2seq route).
			const first = answerError(entry.text, read, target);

			if (first !== null && BARE_RETRY_ERRORS.has(first)) {
				read = await attempt(bareRetry(request), true);

				if (!current(channel, draft, controller)) {
					return;
				}
			}

			// Still the translation over again, or nothing a language could
			// be (the row would otherwise offer `⟹ ` as what the translation
			// says): the check's own failed state ("couldn't check") is what a
			// thrown error gives, so that is the path either takes.
			const error = answerError(entry.text, read, target);

			if (error) {
				throw new Error(error);
			}
		} finally {
			releaseReading();
		}

		store.commit("outgoingTranslationPatch", {
			chanId: channel.id,
			patch: {check: {status: "done", text: read, to: target, engine: engineFor(route)}},
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);

		if (message !== ABORTED && current(channel, draft, controller)) {
			store.commit("outgoingTranslationPatch", {
				chanId: channel.id,
				patch: {check: {status: "failed", text: message, to: target}},
			});
		}
	} finally {
		if (checks.get(channel.id) === controller) {
			checks.delete(channel.id);
		}
	}
}

/**
 * The strip's translation is about to be sent: when its round trip
 * finished, the read-back is recorded against the text that goes out, and
 * the line takes it as its translation when it reaches the store (the
 * `msg` listener in initWriter). Called before the send, since the IRC
 * layer dispatches the line inside the send's emit. A send without a
 * finished read-back records nothing.
 */
export function recordSentReadBack(channel: ClientChan, entry: OutgoingTranslation): void {
	const check = entry.check;

	if (entry.status !== "done" || check.status !== "done" || !check.to || !check.text) {
		return;
	}

	sentReadBacks.record(
		channel.id,
		entry.text,
		{text: check.text, from: entry.to, to: check.to, engine: check.engine ?? null},
		Date.now()
	);
}

/**
 * A translation went out: it joins the voice quoted to the model next
 * time, and a term-sized pair joins the channel's memory with the languages
 * it was written from and into (`from` is the strip's source, null when the
 * model was left to place it). The store's copy of the record is refreshed,
 * like setChannelOptions does.
 */
export function noteOutgoingSent(
	network: ClientNetwork,
	channel: ClientChan,
	draft: string,
	translation: string,
	to: string,
	from: string | null
): void {
	// The line the model handed back, and one with nothing in it a language
	// could be, are not the user's voice: a voice line in the wrong language
	// is quoted into every later prompt, which teaches the model to answer
	// in it. termPair refuses the same pairs.
	if (!isUnchanged(draft, translation) && !hasNoLetters(translation)) {
		const voice = voices.get(channel.id);

		if (voice && voice.to === to) {
			voice.lines = [...voice.lines, translation].slice(-VOICE_KEEP);
		} else {
			voices.set(channel.id, {to, lines: [translation]});
		}
	}

	// A term is a whole short line the user sent: in a query it is what was
	// said in private, kept only while private conversations are kept on
	// the device (the query log's setting, which clears these too).
	const privateUnkept =
		channel.type === ChanType.QUERY && store.state.settings.keepPrivateConversations === false;
	const pair = privateUnkept ? null : termPair(draft, translation);

	if (pair) {
		rememberTerm(network.uuid, channel.name, {source: pair[0], target: pair[1], from, to});
		store.commit("translateChannelSet", {
			key: channelKey(network.uuid, channel.name),
			value: getChannelTranslation(network.uuid, channel.name),
		});
	}
}

export function initWriter(): void {
	// After socket-events/msg.ts put the line in the store (import order in
	// socket-events/index.ts), so `data.msg.id` is the store id. An own line
	// the composer recorded a read-back for takes it as its translation:
	// the pending copy first, then the echo that replaces it (the copy's
	// entry goes with the copy), or the one line without `echo-message`.
	// No request is made: the reader leaves such a line alone whichever
	// listener runs first (sentReadBack.ts `takesReadBack`).
	socket.on("msg", (data) => {
		if (!data.msg.self || data.replay || typeof data.msg.text !== "string") {
			return;
		}

		const match = sentReadBacks.match(data.chan, data.msg.text, data.msg, Date.now());

		if (!match) {
			return;
		}

		const entry: TranslationEntry = {
			status: "done",
			text: match.value.text,
			from: match.value.from,
			to: match.value.to,
			candidates: [],
			engine: match.value.engine,
			error: null,
			hidden: false,
		};

		store.commit("translationEntry", {id: data.msg.id, entry});

		if (match.replacesCopy !== undefined) {
			store.commit("translationRemove", match.replacesCopy);
		}
	});

	// A pending copy that is taken down (its echo, a rejection, a timeout)
	// takes the read-back it held with it.
	socket.on("msg:settled", (data) => {
		if (store.state.translations[data.id]) {
			store.commit("translationRemove", data.id);
		}
	});

	// Registered before socket-events/part.ts / quit.ts (import order), like
	// the reader's: a channel that goes takes its strip and requests with it.
	socket.on("part", (data) => {
		const target = store.getters.findChannel(data.chan);

		if (target) {
			cancelOutgoing(target.channel);
			voices.delete(target.channel.id);
			sentReadBacks.forget(target.channel.id);
		}
	});

	socket.on("quit", (data) => {
		const network = store.state.networks.find((n) => n.uuid === data.network);

		for (const channel of network?.channels ?? []) {
			cancelOutgoing(channel);
			voices.delete(channel.id);
			sentReadBacks.forget(channel.id);
		}
	});
}
