// A PNG made on the spot, for scenarios that serve their own pictures, and
// read back: the 8-bit RGB and RGBA files Chromium's screenshots are, for the
// gallery's hashes and its compare (tools/gallery-compare.mjs).
//
//   import {png, decodePng} from "./lib/png.mjs";
//   png(64, 64, (x, y) => (x > y ? [214, 120, 40] : [40, 110, 200]));
//   const {width, height, rgba} = decodePng(readFileSync("shot.png"));

import {crc32, deflateSync, inflateSync} from "node:zlib";

function chunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}

/** A `width`×`height` RGB PNG; `pixel(x, y)` gives each pixel's [r, g, b]. */
export function png(width, height, pixel) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const rows = [];

	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(1 + width * 3);

		for (let x = 0; x < width; x++) {
			row.set(pixel(x, y), 1 + x * 3);
		}

		rows.push(row);
	}

	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const paeth = (a, b, c) => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** An 8-bit, non-interlaced RGB or RGBA PNG as `{width, height, rgba}`, four bytes a pixel. */
export function decodePng(buf) {
	let off = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat = [];

	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString("ascii", off + 4, off + 8);
		const data = buf.subarray(off + 8, off + 8 + len);

		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const colourType = data[9];

			if (data[8] !== 8 || data[12] !== 0 || (colourType !== 2 && colourType !== 6)) {
				throw new Error(`unsupported PNG (depth ${data[8]}, colour ${colourType})`);
			}

			channels = colourType === 6 ? 4 : 3;
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}

		off += 12 + len;
	}

	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;

	if (channels === 0 || raw.length !== height * (stride + 1)) {
		throw new Error("malformed PNG (no header, or the pixels are not the size it gives)");
	}
	const rgba = Buffer.alloc(width * height * 4, 255);
	let prev = Buffer.alloc(stride);

	for (let y = 0; y < height; y++) {
		const at = y * (stride + 1);
		const filter = raw[at];

		if (filter > 4) throw new Error(`malformed PNG (filter ${filter})`);
		const row = Buffer.from(raw.subarray(at + 1, at + 1 + stride));

		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? row[i - channels] : 0;
			const b = prev[i];
			const c = i >= channels ? prev[i - channels] : 0;
			const add =
				filter === 1
					? a
					: filter === 2
					? b
					: filter === 3
					? (a + b) >> 1
					: filter === 4
					? paeth(a, b, c)
					: 0;
			row[i] = (row[i] + add) & 0xff;
		}

		for (let x = 0; x < width; x++) {
			row.copy(rgba, (y * width + x) * 4, x * channels, x * channels + channels);
		}

		prev = row;
	}

	return {width, height, rgba};
}
