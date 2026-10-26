/** Web-standard UTF-8 and canonical unpadded base64url. TextEncoder replaces
 * unpaired UTF-16 surrogates with U+FFFD, matching the former Node UTF-8 writer.
 * A fatal decoder rejects invalid byte sequences; ignoreBOM preserves a leading
 * U+FEFF as content, matching UTF-8 Buffer decoding rather than stripping it.
 */
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    text += alphabet[first >>> 2]! + alphabet[((first & 3) << 4) | ((second ?? 0) >>> 4)]!;
    if (second !== undefined) text += alphabet[((second & 15) << 2) | ((third ?? 0) >>> 6)]!;
    if (third !== undefined) text += alphabet[third & 63]!;
  }
  return text;
}

export const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength;
export const encodeUtf8Base64Url = (value: string): string => encodeBytes(encoder.encode(value));

/** Reject whitespace, padding, alternate alphabets, unused nonzero tail bits,
 * truncated UTF-8 and replacement-decoding variants instead of normalizing them.
 */
export function decodeCanonicalUtf8Base64Url(token: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(token) || token.length % 4 === 1) throw new Error("Invalid base64url UTF-8");
  const bytes = new Uint8Array(Math.floor(token.length * 6 / 8));
  let accumulator = 0, bits = 0, offset = 0;
  for (const symbol of token) {
    accumulator = (accumulator << 6) | alphabet.indexOf(symbol);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >>> bits) & 255;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (accumulator !== 0 || encodeBytes(bytes) !== token) throw new Error("Invalid base64url UTF-8");
  return decoder.decode(bytes);
}
