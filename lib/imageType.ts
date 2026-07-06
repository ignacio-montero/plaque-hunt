// Real image-format detection by magic bytes, used to harden the upload path in
// /api/capture. We deliberately do NOT trust the client-supplied Content-Type /
// File.type — a malicious client can label anything "image/jpeg". Instead we
// sniff the leading bytes for the formats we actually accept (the same set OCR
// and the uploads route can serve): JPEG, PNG, WEBP, HEIC/HEIF.

/**
 * Return true if `bytes` begins with the signature of an image format we accept.
 * Formats:
 *   JPEG    : FF D8 FF
 *   PNG     : 89 50 4E 47 0D 0A 1A 0A
 *   WEBP    : "RIFF" .... "WEBP"          (RIFF container, WEBP fourCC)
 *   HEIC/HEIF: "....ftyp" box with a heic/heif/mif1 brand
 */
export function isAcceptedImage(bytes: Buffer): boolean {
  // JPEG (3-byte signature)
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return true;
  }

  // PNG (8-byte signature)
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return true;
  }

  // The container formats below need at least the 12-byte header.
  if (bytes.length < 12) return false;

  // WEBP: "RIFF" ???? "WEBP"
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return true;
  }

  // HEIC/HEIF: an ISO-BMFF "ftyp" box (bytes 4..8) whose major/compatible brand
  // is one of heic/heif/mif1. The major brand sits at bytes 8..12; some HEIC
  // files carry the brand only in the compatible-brands list, so scan the box.
  if (bytes.toString("ascii", 4, 8) === "ftyp") {
    // Box size is a big-endian u32 at bytes 0..4; clamp to what we have.
    const declared = bytes.readUInt32BE(0);
    const end = Math.min(bytes.length, declared > 0 ? declared : bytes.length);
    const brandRegion = bytes.toString("ascii", 8, end);
    if (/heic|heif|mif1|hevc|heix|hevx/.test(brandRegion)) return true;
  }

  return false;
}
