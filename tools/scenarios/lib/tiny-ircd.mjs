// A WebSocket "ircd" just able to register a client: CAP LS with nothing,
// 001/005/422 once NICK and USER are in, JOIN echoed with a NAMES reply,
// PING answered. For scenarios about what the page does around a connection
// (the sidebar, routing), not about the protocol; anything else it is sent
// goes unanswered. One IRC line per text frame, `text.ircv3.net`.

import crypto from "node:crypto";
import net from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text) {
	const payload = Buffer.from(text, "utf8");
	const len = payload.length;
	let head;

	if (len < 126) {
		head = Buffer.from([0x81, len]);
	} else if (len < 65536) {
		head = Buffer.alloc(4);
		head.writeUInt8(0x81, 0);
		head.writeUInt8(126, 1);
		head.writeUInt16BE(len, 2);
	} else {
		head = Buffer.alloc(10);
		head.writeUInt8(0x81, 0);
		head.writeUInt8(127, 1);
		head.writeBigUInt64BE(BigInt(len), 2);
	}

	return Buffer.concat([head, payload]);
}

/** Every complete client frame in `buf`: [{opcode, text}], and what is left over. */
function readFrames(buf) {
	const out = [];
	let off = 0;

	while (buf.length - off >= 2) {
		const opcode = buf[off] & 0x0f;
		let len = buf[off + 1] & 0x7f;
		let pos = off + 2;

		if (len === 126) {
			if (buf.length - pos < 2) break;
			len = buf.readUInt16BE(pos);
			pos += 2;
		} else if (len === 127) {
			if (buf.length - pos < 8) break;
			len = Number(buf.readBigUInt64BE(pos));
			pos += 8;
		}

		if (buf.length - pos < 4 + len) break;
		const mask = buf.subarray(pos, pos + 4);
		const data = Buffer.from(buf.subarray(pos + 4, pos + 4 + len));

		for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];

		out.push({opcode, text: data.toString("utf8")});
		off = pos + 4 + len;
	}

	return {frames: out, rest: buf.subarray(off)};
}

export function startTinyIrcd({port, host = "127.0.0.1", name = "tiny.test"}) {
	const server = net.createServer((socket) => {
		let buf = Buffer.alloc(0);
		let upgraded = false;
		let nick = "";
		let user = false;
		let welcomed = false;
		const send = (line) => socket.write(frame(line));

		const welcome = () => {
			if (welcomed || !nick || !user) return;
			welcomed = true;
			send(`:${name} 001 ${nick} :Welcome to the tiny network ${nick}`);
			send(`:${name} 005 ${nick} NETWORK=Tiny CHANTYPES=# PREFIX=(ov)@+ :are supported`);
			send(`:${name} 422 ${nick} :MOTD File is missing`);
		};

		const onLine = (line) => {
			const [cmd, ...args] = line.split(" ");

			switch (cmd.toUpperCase()) {
				case "CAP":
					if (args[0] === "LS") send(`:${name} CAP * LS :`);
					break;
				case "NICK":
					nick = args[0];
					welcome();
					break;
				case "USER":
					user = true;
					welcome();
					break;
				case "PING":
					send(`:${name} PONG ${name} ${args.join(" ")}`);
					break;
				case "JOIN":
					for (const chan of (args[0] || "").split(",").filter(Boolean)) {
						send(`:${nick}!u@tiny JOIN ${chan}`);
						send(`:${name} 353 ${nick} = ${chan} :${nick}`);
						send(`:${name} 366 ${nick} ${chan} :End of /NAMES list.`);
					}

					break;
				case "QUIT":
					socket.end();
					break;
			}
		};

		socket.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);

			if (!upgraded) {
				const end = buf.indexOf("\r\n\r\n");
				if (end === -1) return;
				const head = buf.subarray(0, end).toString("latin1");
				buf = buf.subarray(end + 4);
				const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
				const accept = crypto
					.createHash("sha1")
					.update(key + GUID)
					.digest("base64");
				socket.write(
					"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
						`Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: text.ircv3.net\r\n\r\n`
				);
				upgraded = true;
			}

			const {frames, rest} = readFrames(buf);
			buf = rest;

			for (const f of frames) {
				if (f.opcode === 0x8) {
					socket.end();
					return;
				}

				if (f.opcode === 0x1) {
					for (const line of f.text.split(/\r?\n/).filter(Boolean)) onLine(line);
				}
			}
		});
		socket.on("error", () => socket.destroy());
	});

	server.listen(port, host);
	return {close: () => new Promise((resolve) => server.close(resolve))};
}
