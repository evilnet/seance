import {expect} from "chai";
import {
	CHAT_FRAME_TOKENS,
	fitToWindow,
	promptBound,
	requestTokens,
	tokenBound,
} from "../../client/js/translate/budget";
import {
	emptyContext,
	type ContextLine,
	type TranslateRequest,
} from "../../client/js/translate/engine";
import {QWEN3_1_7B_ID, QWEN3_4B_ID} from "../../client/js/translate/models";
import {promptProfileFor} from "../../client/js/translate/prompts";

// The real Qwen3 tokenizer's counts (onnx-community/Qwen3-1.7B-ONNX's
// tokenizer.json through @huggingface/transformers' AutoTokenizer, no
// special tokens) for each text repeated three times, measured 2026-10-28.
// `tokenBound` must never be below the count on these: they are the scripts
// the app translates and the shapes chat lines take.
const CALIBRATED: Record<string, [string, number]> = {
	en: [
		"Has anyone tried the new build on an older phone? Mine keeps reconnecting every few minutes and the logs say the socket was closed by the server, which makes no sense because the desktop client is fine. lol yeah that happened to me too, I ended up rewriting the whole config from scratch and now it works.",
		187,
	],
	de: [
		"Hat jemand den neuen Build auf einem älteren Handy ausprobiert? Meins verbindet sich alle paar Minuten neu, und laut Log hat der Server den Socket geschlossen, obwohl der Desktop-Client einwandfrei läuft. Überprüf mal die Zeitüberschreitung!",
		186,
	],
	fr: [
		"Quelqu'un a essayé la nouvelle version sur un vieux téléphone ? Le mien se reconnecte toutes les quelques minutes et les journaux disent que le serveur a fermé la connexion, ce qui n'a aucun sens parce que le client de bureau fonctionne très bien.",
		175,
	],
	pl: [
		"Czy ktoś próbował nowej wersji na starszym telefonie? Mój łączy się ponownie co kilka minut, a w logach jest napisane, że serwer zamknął gniazdo, co nie ma sensu, bo klient na komputerze działa bez zarzutu.",
		208,
	],
	tr: [
		"Yeni sürümü eski bir telefonda deneyen oldu mu? Benimki birkaç dakikada bir yeniden bağlanıyor ve günlüklerde sunucunun soketi kapattığı yazıyor, masaüstü istemcisi sorunsuz çalıştığı için bu hiç mantıklı değil.",
		190,
	],
	vi: [
		"Có ai thử bản dựng mới trên điện thoại cũ chưa? Máy của tôi cứ vài phút lại kết nối lại và nhật ký nói rằng máy chủ đã đóng kết nối, thật vô lý vì bản máy tính vẫn chạy bình thường.",
		139,
	],
	ru: [
		"Кто-нибудь пробовал новую сборку на старом телефоне? Мой переподключается каждые несколько минут, а в логах написано, что сервер закрыл сокет, хотя на компьютере всё работает нормально.",
		168,
	],
	uk: [
		"Хтось пробував нову збірку на старому телефоні? Мій перепідключається кожні кілька хвилин, а в журналах написано, що сервер закрив сокет, хоча на комп'ютері все працює добре. Ґанок, їжак, єнот, іній.",
		297,
	],
	ar: [
		"هل جرّب أحد الإصدار الجديد على هاتف قديم؟ هاتفي يعيد الاتصال كل بضع دقائق والسجلات تقول إن الخادم أغلق المقبس، وهذا غير منطقي لأن نسخة سطح المكتب تعمل بشكل جيد.",
		192,
	],
	ja: [
		"新しいビルドを古いスマホで試した人いますか？私のは数分おきに再接続して、ログにはサーバーがソケットを閉じたと書いてあるけど、デスクトップ版は問題ないので意味が分かりません。",
		162,
	],
	zh: [
		"有人在旧手机上试过新版本吗？我的每隔几分钟就重新连接一次，日志里说服务器关闭了套接字，这说不通，因为桌面客户端一切正常。",
		120,
	],
	ko: [
		"새 빌드를 오래된 휴대폰에서 써 본 사람 있어요? 제 건 몇 분마다 다시 연결되고 로그에는 서버가 소켓을 닫았다고 나오는데, 데스크톱 클라이언트는 멀쩡해서 이해가 안 돼요.",
		204,
	],
	th: [
		"มีใครลองบิลด์ใหม่บนมือถือรุ่นเก่าบ้างไหม ของผมเชื่อมต่อใหม่ทุกสองสามนาที และบันทึกบอกว่าเซิร์ฟเวอร์ปิดซ็อกเก็ต ซึ่งไม่สมเหตุสมผลเลยเพราะเวอร์ชันเดสก์ท็อปใช้ได้ปกติ",
		303,
	],
	hi: [
		"क्या किसी ने नया बिल्ड पुराने फ़ोन पर आज़माया है? मेरा हर कुछ मिनट में फिर से जुड़ता है और लॉग कहता है कि सर्वर ने सॉकेट बंद कर दिया।",
		372,
	],
	urls: [
		"see https://github.com/evilnet/nefarious2/pull/101/files?diff=split and https://example.com/a/b?c=1&d=2#frag",
		120,
	],
	hex: [
		"commit a3f9c2e1b7d04f6a9e8c1b2d3f4a5e6c7b8d9e0f1a2b3c4d5e6f708192a3b4c5 and 346a1c0, fceb160",
		240,
	],
	digits: [
		"0123456789 9876543210 3141592653 2718281828 port 6697 at 12:34:56 on 2026-10-28",
		213,
	],
	emoji: ["😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩 👍🏽 👨‍👩‍👧‍👦 🏳️‍🌈 ❤️ lol", 120],
	code: [
		'ok so `git rebase -i HEAD~3` then :wq and push --force-with-lease, ¯\\_(ツ)_/¯ {"a": [1, 2]} <=> !== &&',
		132,
	],
	zalgo: ["Z̴̢̛a̷̧l̸̨g̵̢o̶̡ ̷̛t̴̕e̸͘x̵̛t̶̕ h̷e̵ c̶o̴m̸e̷s̵", 219],
	marks: ["⟦1⟧ said ⟦2⟧ → ⟦3⟧ “quoted” «guillemets» … — –", 75],
	spaces: ["a  b   c    d\n\nnew\tline   end", 36],
};

// Text the bound under-counts, measured the same way: a long run of random
// letters, rare ideographs, archaic Cyrillic. Rare in chat; WebLLM's own
// overflow error is the backstop for them (engines/webllm.ts).
const UNDER: Record<string, [string, number]> = {
	random: ["xKqWzPvTnRbMjLhGfDsAyUeIoQ ZXCVBNMLKJHGFDSAPOIUYTREWQ", 114],
	rareCjk: ["龘靐齉爩鱻麤龗灪籲饢驫鸞癵讟钃", 87],
	oldCyrillic: ["ѣѳѵѢѲѴ", 21],
};

const name = (code: string) => ({en: "English", de: "German", ja: "Japanese"}[code] ?? code);

function line(i: number, text = `line ${i}: ${"word ".repeat(40)}`): ContextLine {
	return {nick: `nick${i}`, text, translated: `translation ${i}: ${"mot ".repeat(40)}`};
}

function request(overrides: Partial<TranslateRequest> = {}): TranslateRequest {
	const context = emptyContext();

	context.recent = Array.from({length: 10}, (_, i) => line(i));
	context.terms = Array.from({length: 20}, (_, i) => [`term${i}`, `Begriff${i}`]);
	context.names = Array.from({length: 20}, (_, i) => `nick${i}`);
	context.voice = Array.from({length: 5}, (_, i) => `my earlier line ${i}`);
	context.topic = "the topic ".repeat(20);
	context.replyTo = {nick: "bob", text: "what bob said"};

	return {
		id: 1,
		model: QWEN3_1_7B_ID,
		text: "a line to translate",
		from: "en",
		to: "de",
		purpose: "write",
		context,
		...overrides,
	};
}

const profile = promptProfileFor(QWEN3_1_7B_ID);

describe("translate/budget", () => {
	describe("tokenBound", () => {
		for (const [key, [text, tokens]] of Object.entries(CALIBRATED)) {
			it(`is at least Qwen3's own count for ${key}`, () => {
				expect(tokenBound(text.repeat(3))).to.be.at.least(tokens);
			});
		}

		it("over-counts ordinary prose by less than double, so the window is not wasted", () => {
			for (const key of ["en", "de", "fr", "ru", "ar", "ja", "zh", "ko"]) {
				const [text, tokens] = CALIBRATED[key];

				expect(tokenBound(text.repeat(3)), key).to.be.below(tokens * 1.8);
			}
		});

		it("under-counts only the rare shapes the backstop is for", () => {
			for (const [key, [text, tokens]] of Object.entries(UNDER)) {
				expect(tokenBound(text.repeat(3)), key).to.be.below(tokens);
			}
		});

		it("counts nothing for nothing, and the frame on top of a prompt's messages", () => {
			expect(tokenBound("")).to.equal(0);
			expect(
				promptBound([
					{role: "system", content: ""},
					{role: "user", content: ""},
				])
			).to.equal(CHAT_FRAME_TOKENS);
		});
	});

	describe("fitToWindow", () => {
		it("hands back the request itself when it fits", () => {
			const req = request();

			expect(fitToWindow(req, 8192, profile, name)).to.equal(req);
		});

		it("drops the oldest earlier lines first, then nothing else, when that is enough", () => {
			const req = request();
			const full = requestTokens(req, profile, name);
			const fitted = fitToWindow(req, full - 50, profile, name)!;

			expect(fitted).not.to.equal(req);
			expect(fitted.context.recent.length).to.be.within(1, 9);
			// The newest are kept: what goes is the front of the list.
			expect(fitted.context.recent.at(-1)).to.deep.equal(req.context.recent.at(-1));
			expect(fitted.context.terms).to.have.length(20);
			expect(fitted.context.names).to.have.length(20);
			expect(fitted.context.topic).to.equal(req.context.topic);
			expect(requestTokens(fitted, profile, name)).to.be.at.most(full - 50);
			// The caller's request is untouched.
			expect(req.context.recent).to.have.length(10);
		});

		it("then the terms, oldest first, then the names, before the topic and the reply", () => {
			const req = request();
			const noLines = {...req, context: {...req.context, recent: []}};
			const target = requestTokens(noLines, profile, name) - 20;
			const fitted = fitToWindow(req, target, profile, name)!;

			expect(fitted.context.recent).to.deep.equal([]);
			expect(fitted.context.terms.length).to.be.within(1, 19);
			expect(fitted.context.terms.at(-1)).to.deep.equal(["term19", "Begriff19"]);
			expect(fitted.context.names).to.have.length(20);
			expect(fitted.context.topic).to.equal(req.context.topic);
			expect(fitted.context.replyTo).to.deep.equal(req.context.replyTo);
		});

		it("goes down to the bare line, the formality kept, before giving up", () => {
			const req = request();
			const bare = {
				...req,
				context: {...emptyContext(), formality: req.context.formality},
			};
			const fitted = fitToWindow(req, requestTokens(bare, profile, name), profile, name)!;

			expect(fitted.context).to.deep.equal(bare.context);
		});

		it("refuses what does not fit even bare: a batch, or a line too long for the window", () => {
			const lines = Array.from({length: 6}, (_, i) => `line ${i} ${"word ".repeat(200)}`);

			expect(fitToWindow(request({text: "", lines}), 1024, profile, name)).to.equal(null);
			expect(
				fitToWindow(request({text: "word ".repeat(2000)}), 2048, profile, name)
			).to.equal(null);
		});

		it("drops each batched line's reply note before the channel's topic", () => {
			const lines = ["one", "two"];
			const req = request({
				text: "",
				lines,
				lineContexts: [{replyTo: {nick: "a", text: "x ".repeat(100)}}, {}],
			});
			const stripped = {
				...req,
				context: {
					...emptyContext(),
					formality: req.context.formality,
					topic: req.context.topic,
					replyTo: req.context.replyTo,
				},
				lineContexts: [{}, {}],
			};
			const fitted = fitToWindow(req, requestTokens(stripped, profile, name), profile, name)!;

			expect(fitted.lineContexts).to.deep.equal([{}, {}]);
			expect(fitted.context.topic).to.equal(req.context.topic);
			// The caller's notes are untouched.
			expect(req.lineContexts![0].replyTo).to.not.equal(undefined);
		});

		it("reserves the reply's own budget: a prompt that fits alone can still be over", () => {
			const req = request();
			const prompt = promptBound(profile.buildMessages(req, name));

			expect(fitToWindow(req, prompt, profile, name)).not.to.equal(req);
		});

		it("fits the 4B's prompt with the 4B's profile", () => {
			const profile4b = promptProfileFor(QWEN3_4B_ID);
			const req = request({model: QWEN3_4B_ID});
			const fitted = fitToWindow(req, 1200, profile4b, name)!;

			expect(requestTokens(fitted, profile4b, name)).to.be.at.most(1200);
		});
	});
});
