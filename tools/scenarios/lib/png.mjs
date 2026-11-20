// A PNG made on the spot, for scenarios that serve their own pictures.
//
//   import {png} from "./lib/png.mjs";
//   png(64, 64, (x, y) => (x > y ? [214, 120, 40] : [40, 110, 200]));

import {crc32, deflateSync} from "node:zlib";

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
