/**
 * Turning a picture the user chose into an avatar: a square crop, drawn at
 * {@link AVATAR_SIZE}², encoded as WebP (JPEG where the browser cannot
 * encode WebP, Safari) at the best quality under {@link AVATAR_MAX_BYTES}.
 * The crop math is pure; the drawing needs a canvas (AvatarCrop.vue).
 */

/** Pixels per side of an uploaded avatar. */
export const AVATAR_SIZE = 256;
/** Bytes an uploaded avatar may take. */
export const AVATAR_MAX_BYTES = 64 * 1024;
/** The shorter side a picture needs, in pixels. */
export const AVATAR_MIN_SOURCE = 128;
/** A file larger than this is not even decoded. */
export const AVATAR_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** How far the crop zooms in. */
export const ZOOM_MAX = 4;

export type Crop = {
	/** The crop's centre, in source pixels. */
	cx: number;
	cy: number;
	/** 1 = the shorter side fills the crop. */
	zoom: number;
};

/** The crop's side in source pixels. */
export function cropSide(width: number, height: number, zoom: number): number {
	return Math.min(width, height) / Math.min(Math.max(zoom, 1), ZOOM_MAX);
}

/** The crop moved back inside the picture, zoom within 1..{@link ZOOM_MAX}. */
export function clampCrop(width: number, height: number, crop: Crop): Crop {
	const zoom = Math.min(Math.max(crop.zoom, 1), ZOOM_MAX);
	const half = cropSide(width, height, zoom) / 2;
	return {
		zoom,
		cx: Math.min(Math.max(crop.cx, half), width - half),
		cy: Math.min(Math.max(crop.cy, half), height - half),
	};
}

/** The crop a picture starts with: centred, zoomed out. */
export function initialCrop(width: number, height: number): Crop {
	return {cx: width / 2, cy: height / 2, zoom: 1};
}

/** Why a chosen file cannot become an avatar, or null when it can (so far as its header tells). */
export type SourceProblem = "notImage" | "tooLarge" | "tooSmall" | "unreadable";

export function sourceProblem(file: {type: string; size: number}): SourceProblem | null {
	if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(file.type)) {
		return "notImage";
	}

	return file.size > AVATAR_MAX_SOURCE_BYTES ? "tooLarge" : null;
}

/** Draw `crop` of `source` onto `canvas` at its size. */
export function drawCrop(
	canvas: HTMLCanvasElement,
	source: CanvasImageSource,
	width: number,
	height: number,
	crop: Crop
): void {
	const ctx = canvas.getContext("2d");

	if (!ctx) {
		return;
	}

	const side = cropSide(width, height, crop.zoom);
	ctx.imageSmoothingQuality = "high";
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(
		source,
		crop.cx - side / 2,
		crop.cy - side / 2,
		side,
		side,
		0,
		0,
		canvas.width,
		canvas.height
	);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Encode the avatar: WebP, else JPEG, at falling quality until it fits
 * {@link AVATAR_MAX_BYTES}. Null when nothing fits (a canvas that cannot
 * encode at all).
 */
export async function encodeAvatar(
	source: CanvasImageSource,
	width: number,
	height: number,
	crop: Crop
): Promise<Blob | null> {
	const canvas = document.createElement("canvas");
	canvas.width = AVATAR_SIZE;
	canvas.height = AVATAR_SIZE;
	drawCrop(canvas, source, width, height, crop);

	for (const type of ["image/webp", "image/jpeg"]) {
		for (const quality of [0.9, 0.8, 0.7, 0.55, 0.4]) {
			const blob = await toBlob(canvas, type, quality);

			// A browser that cannot encode the type hands back a PNG instead.
			if (!blob || blob.type !== type) {
				break;
			}

			if (blob.size <= AVATAR_MAX_BYTES) {
				return blob;
			}
		}
	}

	return null;
}
