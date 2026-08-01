/** Client-side scan image prep — no dependencies. */

export const SCAN_MAX_BYTES = 8 * 1024 * 1024;
export const SCAN_MAX_LONG_SIDE = 1600;
export const SCAN_MIN_LONG_SIDE_IF_LARGER = 1200;
export const SCAN_JPEG_QUALITY = 0.82;

export class ScanImageTooLargeError extends Error {
  constructor(message = "Image is too large. Please retake a clearer photo.") {
    super(message);
    this.name = "ScanImageTooLargeError";
  }
}

/**
 * Scale longest side to at most 1600px. If the original is larger than 1200px,
 * never downscale below 1200px. Re-encode as JPEG ~0.82. Reject >8MB results.
 */
export async function preprocessScanImage(blob: Blob): Promise<Blob> {
  if (blob.size > SCAN_MAX_BYTES) {
    throw new ScanImageTooLargeError();
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    let targetLong = longest;
    if (longest > SCAN_MAX_LONG_SIDE) {
      targetLong = SCAN_MAX_LONG_SIDE;
    } else if (longest > SCAN_MIN_LONG_SIDE_IF_LARGER) {
      // Keep native resolution between 1200 and 1600.
      targetLong = longest;
    }
    // If original is larger than 1200, never go below 1200 (only matters if max were <1200).
    if (longest > SCAN_MIN_LONG_SIDE_IF_LARGER) {
      targetLong = Math.max(targetLong, SCAN_MIN_LONG_SIDE_IF_LARGER);
      targetLong = Math.min(targetLong, SCAN_MAX_LONG_SIDE);
    }

    const scale = targetLong / longest;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not prepare document image");
    ctx.drawImage(bitmap, 0, 0, width, height);

    const out = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", SCAN_JPEG_QUALITY);
    });
    if (!out) throw new Error("Could not encode document image");
    if (out.size > SCAN_MAX_BYTES) {
      throw new ScanImageTooLargeError();
    }
    return out;
  } finally {
    bitmap.close();
  }
}
