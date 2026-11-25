import {expect} from "chai";
import {
	buildMediaPreviews,
	classifyMediaUrl,
	MAX_PREVIEWS_PER_MESSAGE,
} from "../../client/js/helpers/mediaPreview";
import type {LinkPreview} from "../../shared/types/msg";

const on = {media: true};

describe("helpers/mediaPreview", function () {
	describe("classifyMediaUrl", function () {
		it("recognises every supported image extension", function () {
			for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]) {
				const match = classifyMediaUrl(`https://example.com/pic.${ext}`);
				expect(match, ext).to.not.equal(null);
				expect(match?.type, ext).to.equal("image");
				expect(match?.mediaType, ext).to.match(/^image\//);
			}
		});

		it("recognises every supported video extension", function () {
			for (const ext of ["mp4", "webm", "mov"]) {
				const match = classifyMediaUrl(`https://example.com/clip.${ext}`);
				expect(match?.type, ext).to.equal("video");
				expect(match?.mediaType, ext).to.match(/^video\//);
			}
		});

		it("recognises every supported audio extension", function () {
			for (const ext of ["mp3", "ogg", "oga", "opus", "wav", "flac", "m4a", "aac", "weba"]) {
				const match = classifyMediaUrl(`https://example.com/track.${ext}`);
				expect(match?.type, ext).to.equal("audio");
				expect(match?.mediaType, ext).to.match(/^audio\//);
			}
		});

		it("is case-insensitive on the extension", function () {
			expect(classifyMediaUrl("https://example.com/PIC.PNG")?.type).to.equal("image");
			expect(classifyMediaUrl("https://example.com/Clip.Mp4")?.type).to.equal("video");
			expect(classifyMediaUrl("https://example.com/a.FLAC")?.type).to.equal("audio");
		});

		it("ignores query strings and fragments", function () {
			expect(classifyMediaUrl("https://example.com/a.png?width=200&x=y.html")?.type).to.equal(
				"image"
			);
			expect(classifyMediaUrl("https://example.com/a.mp4#t=10")?.type).to.equal("video");
			// The extension must be on the path, not in the query
			expect(classifyMediaUrl("https://example.com/download?file=a.png")).to.equal(null);
		});

		it("rejects http:// unless explicitly allowed", function () {
			expect(classifyMediaUrl("http://example.com/a.png")).to.equal(null);
			expect(classifyMediaUrl("http://example.com/a.png", true)?.type).to.equal("image");
		});

		it("rejects other schemes even when http is allowed", function () {
			expect(classifyMediaUrl("ftp://example.com/a.png", true)).to.equal(null);
			expect(classifyMediaUrl("irc://example.com/a.png", true)).to.equal(null);
			expect(classifyMediaUrl("file:///tmp/a.png", true)).to.equal(null);
		});

		it("rejects non-media, extension-less and malformed URLs", function () {
			expect(classifyMediaUrl("https://example.com/page.html")).to.equal(null);
			expect(classifyMediaUrl("https://example.com/archive.zip")).to.equal(null);
			expect(classifyMediaUrl("https://example.com/")).to.equal(null);
			expect(classifyMediaUrl("https://example.com/noext")).to.equal(null);
			expect(classifyMediaUrl("https://example.com/dir.png/")).to.equal(null);
			expect(classifyMediaUrl("https://example.com/.png")).to.equal(null);
			expect(classifyMediaUrl("not a url")).to.equal(null);
		});
	});

	describe("buildMediaPreviews", function () {
		it("builds an image preview with the fields LinkPreview.vue needs", function () {
			const previews = buildMediaPreviews("look https://example.com/a.png", on);

			expect(previews).to.have.length(1);
			expect(previews[0]).to.include({
				type: "image",
				link: "https://example.com/a.png",
				thumb: "https://example.com/a.png",
				mediaType: "image/png",
				shown: true,
				sourceLoaded: false,
			});
			expect(previews[0].media).to.equal(undefined);
		});

		it("builds video and audio previews with media/mediaType and no thumb", function () {
			const previews = buildMediaPreviews(
				"https://example.com/a.webm and https://example.com/b.opus",
				on
			);

			expect(previews.map((p) => p.type)).to.deep.equal(["video", "audio"]);
			expect(previews[0]).to.include({
				media: "https://example.com/a.webm",
				mediaType: "video/webm",
				thumb: "",
			});
			expect(previews[1]).to.include({
				media: "https://example.com/b.opus",
				mediaType: "audio/ogg",
				thumb: "",
			});
		});

		it("ignores non-media links", function () {
			const previews = buildMediaPreviews(
				"see https://example.com/ and https://example.com/page.html or example.com/a.png",
				on
			);

			// the schemeless "example.com/a.png" is not considered either
			expect(previews).to.deep.equal([]);
		});

		it("returns nothing when the media setting is off", function () {
			expect(buildMediaPreviews("https://example.com/a.png", {media: false})).to.deep.equal(
				[]
			);
		});

		it("returns nothing for empty text", function () {
			expect(buildMediaPreviews("", on)).to.deep.equal([]);
		});

		it("only allows http:// when allowHttp is set", function () {
			const text = "http://example.com/a.png https://example.com/b.png";

			expect(buildMediaPreviews(text, on).map((p) => p.link)).to.deep.equal([
				"https://example.com/b.png",
			]);
			expect(
				buildMediaPreviews(text, {media: true, allowHttp: true}).map((p) => p.link)
			).to.deep.equal(["http://example.com/a.png", "https://example.com/b.png"]);
		});

		it("deduplicates repeated links", function () {
			const previews = buildMediaPreviews(
				"https://example.com/a.png https://example.com/a.png https://example.com/a.png?x=1",
				on
			);

			expect(previews.map((p) => p.link)).to.deep.equal([
				"https://example.com/a.png",
				"https://example.com/a.png?x=1",
			]);
		});

		it("caps the number of previews per message", function () {
			const links: string[] = [];

			for (let i = 0; i < MAX_PREVIEWS_PER_MESSAGE + 3; i++) {
				links.push(`https://example.com/${i}.png`);
			}

			const previews = buildMediaPreviews(links.join(" "), on);

			expect(MAX_PREVIEWS_PER_MESSAGE).to.equal(5);
			expect(previews).to.have.length(MAX_PREVIEWS_PER_MESSAGE);
			expect(previews.map((p) => p.link)).to.deep.equal(links.slice(0, 5));

			expect(
				buildMediaPreviews(links.join(" "), {media: true, maxPreviews: 2})
			).to.have.length(2);
		});

		it("strips IRC formatting before finding links", function () {
			const previews = buildMediaPreviews("\x02https://example.com/a.png\x0f", on);

			expect(previews.map((p) => p.link)).to.deep.equal(["https://example.com/a.png"]);
		});

		it("consults the external resolver hook for non-media https links only", function () {
			const asked: string[] = [];

			const external = (link: string): LinkPreview | null => {
				asked.push(link);

				if (link.endsWith("skip")) {
					return null;
				}

				return {
					type: "link",
					head: "Title",
					body: "Body",
					thumb: "",
					size: -1,
					link,
					shown: true,
				};
			};

			const previews = buildMediaPreviews(
				"https://example.com/page https://example.com/a.png http://example.com/x https://example.com/skip",
				{media: true, allowHttp: true, external}
			);

			expect(asked).to.deep.equal(["https://example.com/page", "https://example.com/skip"]);
			expect(previews.map((p) => [p.type, p.link])).to.deep.equal([
				["link", "https://example.com/page"],
				["image", "https://example.com/a.png"],
			]);
		});
	});
});
