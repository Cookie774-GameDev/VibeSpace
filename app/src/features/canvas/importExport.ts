/**
 * Deterministic, side-effect-free canvas file import/export.
 *
 * This boundary returns byte artifacts that can be passed directly to Blob,
 * filesystem, or share APIs. It never executes imported markup/diagram code,
 * dereferences URLs, decompresses archives, or claims browser/native side
 * effects. Raster/PDF writers emit complete file structures without relying on
 * browser canvas state, which keeps tests and exports reproducible.
 */

import {
  CANVAS_MAX_TEXT_LENGTH,
  createCanvasBlock,
  createCanvasDocument,
  parseCanvasDocument,
  resolveEdgelessLayout,
  withBlockAdded,
  type CanvasBlock,
  type CanvasBlockContent,
  type CanvasDocument,
} from './contracts';
import {
  CANVAS_PACKAGE_MAX_TEXT_LENGTH,
  decodeCanvasPackage,
  encodeCanvasPackage,
} from './packageFormat';
import {
  CANVAS_MAX_ASSET_BYTES,
  CANVAS_MAX_ASSET_DIMENSION,
  assertSafeCanvasAsset,
  sanitizeCanvasCodeBlock,
  sanitizeCanvasPlainText,
} from './security';
import { Unzlib, zlibSync } from 'fflate';

export const CANVAS_IMPORT_MAX_BYTES = CANVAS_PACKAGE_MAX_TEXT_LENGTH;
export const CANVAS_IMPORT_MAX_COMPRESSION_RATIO = 100;
export const CANVAS_IMPORT_MAX_PDF_PAGES = 1_000;
export const CANVAS_EXPORT_MAX_PIXELS = 16_777_216;
export const CANVAS_IMPORT_MAX_DECODED_IMAGE_BYTES = CANVAS_EXPORT_MAX_PIXELS * 4;

export type CanvasImportExportErrorCode =
  | 'invalid-input'
  | 'unsupported-type'
  | 'extension-mismatch'
  | 'oversized'
  | 'invalid-dimension'
  | 'signature-mismatch'
  | 'malformed-file'
  | 'compression-limit'
  | 'missing-identity'
  | 'invalid-scope';

export class CanvasImportExportError extends Error {
  readonly code: CanvasImportExportErrorCode;
  readonly path: string;

  constructor(code: CanvasImportExportErrorCode, path: string, message: string) {
    super(`Canvas import/export failed (${code}) at ${path}: ${message}`);
    this.name = 'CanvasImportExportError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: CanvasImportExportErrorCode, path: string, message: string): never {
  throw new CanvasImportExportError(code, path, message);
}

export interface CanvasImportFile {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly data: string | Uint8Array | ArrayBuffer | Blob;
  readonly width?: number;
  readonly height?: number;
}

export interface CanvasImportIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly now: number;
}

export interface CanvasImportOptions {
  readonly maxBytes?: number;
  readonly maxCompressionRatio?: number;
  readonly maxPdfPages?: number;
  readonly identity?: CanvasImportIdentity;
}

export type CanvasImportResult =
  | {
      readonly kind: 'document';
      readonly document: CanvasDocument;
      readonly sourceFormat: 'package' | 'json' | 'markdown';
    }
  | {
      readonly kind: 'asset';
      readonly name: string;
      readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: 'pdf';
      readonly name: string;
      readonly mimeType: 'application/pdf';
      readonly bytes: Uint8Array;
      readonly pageCount: number;
    }
  | {
      readonly kind: 'diagram';
      readonly name: string;
      readonly mimeType: 'text/x-mermaid' | 'text/vnd.graphviz';
      readonly syntax: 'mermaid' | 'graphviz';
      readonly source: string;
    };

export type CanvasExportFormat =
  'png' | 'svg' | 'pdf' | 'markdown' | 'json' | 'package' | 'presentation-pdf';

export type CanvasExportScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'objects'; readonly blockIds: readonly string[] }
  | { readonly kind: 'frame'; readonly blockIds: readonly string[] }
  | { readonly kind: 'presentation' };

export interface CanvasExportOptions {
  readonly format: CanvasExportFormat;
  readonly scope?: CanvasExportScope;
  readonly width?: number;
  readonly height?: number;
  readonly scale?: number;
  readonly background?: string;
  readonly filename?: string;
}

export interface CanvasExportArtifact {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly text?: string;
  readonly width?: number;
  readonly height?: number;
  readonly background?: string;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const SAFE_NAME_PATTERN = /[^A-Za-z0-9._-]+/g;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MIME_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '.json': Object.freeze(['application/json', 'application/vnd.vibespace.canvas+json']),
  '.md': Object.freeze(['text/markdown', 'text/plain']),
  '.markdown': Object.freeze(['text/markdown', 'text/plain']),
  '.png': Object.freeze(['image/png']),
  '.jpg': Object.freeze(['image/jpeg']),
  '.jpeg': Object.freeze(['image/jpeg']),
  '.gif': Object.freeze(['image/gif']),
  '.webp': Object.freeze(['image/webp']),
  '.pdf': Object.freeze(['application/pdf']),
  '.mmd': Object.freeze(['text/x-mermaid', 'text/plain']),
  '.mermaid': Object.freeze(['text/x-mermaid', 'text/plain']),
  '.dot': Object.freeze(['text/vnd.graphviz', 'text/plain']),
});

function freeze<T>(value: T): T {
  // ECMAScript engines reject Object.freeze on non-empty typed-array views.
  // The containing descriptor is frozen and byte arrays are defensive copies.
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return Object.freeze(value);
}

function immutableBytes<T extends object>(
  value: T,
  bytes: Uint8Array,
): T & { readonly bytes: Uint8Array } {
  const stored = bytes.slice();
  Object.defineProperty(value, 'bytes', {
    enumerable: true,
    configurable: false,
    get: () => stored.slice(),
  });
  return value as T & { readonly bytes: Uint8Array };
}

function assertSafeIntegerOption(
  value: number | undefined,
  fallback: number,
  path: string,
  minimum = 1,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    fail('invalid-input', path, `expected a safe integer >= ${minimum}`);
  }
  return resolved;
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.vibespace.json')) return '.json';
  const position = lower.lastIndexOf('.');
  return position < 0 ? '' : lower.slice(position);
}

function validateFileMetadata(file: CanvasImportFile, maxBytes: number): string {
  if (typeof file.name !== 'string' || file.name.length === 0 || file.name.length > 255) {
    fail('invalid-input', 'file.name', 'expected a filename of 1-255 characters');
  }
  if (CONTROL_PATTERN.test(file.name) || /[\\/]/u.test(file.name) || file.name.startsWith('.')) {
    fail('invalid-input', 'file.name', 'filename is unsafe');
  }
  if (typeof file.mimeType !== 'string') {
    fail('invalid-input', 'file.mimeType', 'expected a MIME type');
  }
  const mimeType = file.mimeType.trim().toLowerCase();
  const extension = extensionOf(file.name);
  const allowedMime = MIME_BY_EXTENSION[extension];
  if (!allowedMime) fail('unsupported-type', 'file.name', 'unsupported import extension');
  if (!allowedMime.includes(mimeType)) {
    fail('extension-mismatch', 'file.mimeType', 'MIME type does not match filename extension');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    fail('invalid-input', 'file.size', 'expected a non-negative safe integer');
  }
  if (file.size > maxBytes) fail('oversized', 'file.size', `file exceeds ${maxBytes} bytes`);
  return mimeType;
}

async function fileBytes(data: CanvasImportFile['data']): Promise<Uint8Array> {
  if (typeof data === 'string') return TEXT_ENCODER.encode(data);
  // Vitest/browser callers can supply views from another JavaScript realm, so
  // avoid realm-sensitive instanceof checks for binary data.
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
    return new Uint8Array((data as ArrayBuffer).slice(0));
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  fail('invalid-input', 'file.data', 'expected string, bytes, ArrayBuffer, or Blob');
}

function decodeText(bytes: Uint8Array, path = 'file.data'): string {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    fail('malformed-file', path, 'text is not valid UTF-8');
  }
}

function startsWith(bytes: Uint8Array, signature: ArrayLike<number>): boolean {
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  );
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function inflateStoredZlib(bytes: Uint8Array, expectedLength: number): Uint8Array | null {
  if (
    bytes.length < 11 ||
    (bytes[0] & 0x0f) !== 8 ||
    ((bytes[0] << 8) | bytes[1]) % 31 !== 0 ||
    (bytes[1] & 0x20) !== 0
  ) {
    return null;
  }
  let offset = 2;
  let final = false;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (!final) {
    if (offset + 5 > bytes.length - 4) return null;
    const header = bytes[offset++];
    final = (header & 1) === 1;
    if ((header & 0xfe) !== 0) return null;
    const blockLength = readUint16LittleEndian(bytes, offset);
    const inverseLength = readUint16LittleEndian(bytes, offset + 2);
    offset += 4;
    if (
      ((blockLength ^ inverseLength) & 0xffff) !== 0xffff ||
      offset + blockLength > bytes.length - 4
    ) {
      return null;
    }
    length += blockLength;
    if (length > expectedLength) {
      fail('compression-limit', 'file.data', 'decoded image exceeds its declared dimensions');
    }
    chunks.push(bytes.slice(offset, offset + blockLength));
    offset += blockLength;
  }
  if (offset + 4 !== bytes.length) return null;
  const result = concat(...chunks);
  if (result.length !== expectedLength || readUint32(bytes, offset) !== adler32(result)) {
    fail('malformed-file', 'file.data', 'image checksum or decoded length is invalid');
  }
  return result;
}

async function inflateBounded(bytes: Uint8Array, expectedLength: number): Promise<Uint8Array> {
  if (
    expectedLength <= 0 ||
    !Number.isSafeInteger(expectedLength) ||
    expectedLength > CANVAS_IMPORT_MAX_DECODED_IMAGE_BYTES
  ) {
    fail('compression-limit', 'file.data', 'decoded image size exceeds the safe pixel budget');
  }
  const stored = inflateStoredZlib(bytes, expectedLength);
  if (stored !== null) return stored;
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finalSeen = false;
  try {
    const decoder = new Unzlib((chunk, final) => {
      length += chunk.length;
      if (length > expectedLength) {
        fail('compression-limit', 'file.data', 'decoded image exceeds its declared dimensions');
      }
      chunks.push(chunk.slice());
      finalSeen = final;
    });
    decoder.push(bytes, true);
  } catch (error) {
    if (error instanceof CanvasImportExportError) throw error;
    fail('malformed-file', 'file.data', 'image compression stream is malformed');
  }
  if (!finalSeen || length !== expectedLength) {
    fail('malformed-file', 'file.data', 'decoded image length does not match its header');
  }
  return concat(...chunks);
}

async function validatePng(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  if (!startsWith(bytes, PNG_SIGNATURE) || bytes.length < 45) {
    fail('signature-mismatch', 'file.data', 'invalid PNG signature or truncated file');
  }
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawPalette = false;
  let sawData = false;
  let sawEnd = false;
  let dataEnded = false;
  const compressed: Uint8Array[] = [];
  const supportedCritical = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      fail('malformed-file', 'file.data', 'PNG chunk header is truncated');
    }
    const length = readUint32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      fail('malformed-file', 'file.data', 'PNG chunk type is invalid');
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(dataEnd) || chunkEnd > bytes.length) {
      fail('malformed-file', 'file.data', `PNG ${type} chunk is truncated`);
    }
    const expectedCrc = readUint32(bytes, dataEnd);
    const actualCrc = crc32(bytes.slice(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) {
      fail('malformed-file', 'file.data', `PNG ${type} checksum is invalid`);
    }
    if (type[0] === type[0].toUpperCase() && !supportedCritical.has(type)) {
      fail('malformed-file', 'file.data', `unsupported critical PNG chunk ${type}`);
    }
    if (!sawHeader && type !== 'IHDR') {
      fail('malformed-file', 'file.data', 'PNG IHDR must be the first chunk');
    }
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) {
        fail('malformed-file', 'file.data', 'PNG must contain one 13-byte IHDR');
      }
      width = readUint32(bytes, dataStart);
      height = readUint32(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      const allowedDepths: Readonly<Record<number, readonly number[]>> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !allowedDepths[colorType]?.includes(bitDepth) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        fail('malformed-file', 'file.data', 'PNG uses unsupported image encoding');
      }
      sawHeader = true;
    } else if (type === 'PLTE') {
      if (
        sawPalette ||
        sawData ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0 ||
        colorType === 0 ||
        colorType === 4
      ) {
        fail('malformed-file', 'file.data', 'PNG palette chunk is invalid');
      }
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (colorType === 3 && !sawPalette) {
        fail('malformed-file', 'file.data', 'indexed PNG is missing its palette');
      }
      if (dataEnded || length === 0) {
        fail('malformed-file', 'file.data', 'PNG IDAT chunks must be non-empty and contiguous');
      }
      sawData = true;
      compressed.push(bytes.slice(dataStart, dataEnd));
    } else {
      if (sawData) dataEnded = true;
      if (type === 'IEND') {
        if (length !== 0 || sawEnd || chunkEnd !== bytes.length) {
          fail('malformed-file', 'file.data', 'PNG IEND must be empty and final');
        }
        sawEnd = true;
      }
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawData || !sawEnd) {
    fail('malformed-file', 'file.data', 'PNG is missing required chunks');
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as const)[colorType as 0 | 2 | 3 | 4 | 6];
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const decoded = await inflateBounded(concat(...compressed), (rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * (rowBytes + 1)] > 4) {
      fail('malformed-file', 'file.data', 'PNG row uses an invalid filter');
    }
  }
  return { width, height };
}

function validateGif(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 14 ||
    (!startsWith(bytes, [71, 73, 70, 56, 55, 97]) && !startsWith(bytes, [71, 73, 70, 56, 57, 97]))
  ) {
    fail('signature-mismatch', 'file.data', 'invalid GIF signature or truncated file');
  }
  const width = readUint16LittleEndian(bytes, 6);
  const height = readUint16LittleEndian(bytes, 8);
  let offset = 13;
  if ((bytes[10] & 0x80) !== 0) offset += 3 * 2 ** ((bytes[10] & 0x07) + 1);
  let sawImage = false;
  let sawTrailer = false;
  const skipSubBlocks = (): void => {
    while (true) {
      if (offset >= bytes.length) fail('malformed-file', 'file.data', 'GIF data is truncated');
      const length = bytes[offset++];
      if (length === 0) return;
      if (offset + length > bytes.length) {
        fail('malformed-file', 'file.data', 'GIF sub-block is truncated');
      }
      offset += length;
    }
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      sawTrailer = true;
      if (offset !== bytes.length) fail('malformed-file', 'file.data', 'GIF has trailing bytes');
      break;
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) fail('malformed-file', 'file.data', 'GIF extension is truncated');
      offset += 1;
      skipSubBlocks();
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) {
      fail('malformed-file', 'file.data', 'GIF block structure is invalid');
    }
    const packed = bytes[offset + 8];
    offset += 9;
    if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
    if (offset >= bytes.length) fail('malformed-file', 'file.data', 'GIF image data is truncated');
    const minimumCodeSize = bytes[offset++];
    if (minimumCodeSize < 2 || minimumCodeSize > 8) {
      fail('malformed-file', 'file.data', 'GIF LZW code size is invalid');
    }
    skipSubBlocks();
    sawImage = true;
  }
  if (!sawImage || !sawTrailer) {
    fail('malformed-file', 'file.data', 'GIF is missing image data or trailer');
  }
  return { width, height };
}

function validateJpeg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    fail('signature-mismatch', 'file.data', 'invalid JPEG signature or truncated file');
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  let sawEnd = false;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) fail('malformed-file', 'file.data', 'JPEG marker is missing');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail('malformed-file', 'file.data', 'JPEG marker is truncated');
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      sawEnd = true;
      if (offset !== bytes.length) fail('malformed-file', 'file.data', 'JPEG has trailing bytes');
      break;
    }
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      fail('malformed-file', 'file.data', 'JPEG marker appears outside scan data');
    }
    if (offset + 2 > bytes.length) fail('malformed-file', 'file.data', 'JPEG segment is truncated');
    const length = readUint16BigEndian(bytes, offset);
    if (length < 2 || offset + length > bytes.length) {
      fail('malformed-file', 'file.data', 'JPEG segment length is invalid');
    }
    if (startOfFrame.has(marker)) {
      if (length < 8) fail('malformed-file', 'file.data', 'JPEG frame header is truncated');
      height = readUint16BigEndian(bytes, offset + 3);
      width = readUint16BigEndian(bytes, offset + 5);
    }
    offset += length;
    if (marker === 0xda) {
      sawScan = true;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) continue;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) fail('malformed-file', 'file.data', 'JPEG scan is truncated');
        const next = bytes[offset];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 1;
          continue;
        }
        offset -= 1;
        break;
      }
    }
  }
  if (!sawScan || !sawEnd || width <= 0 || height <= 0) {
    fail('malformed-file', 'file.data', 'JPEG is missing a frame, scan, or end marker');
  }
  return { width, height };
}

function validateWebp(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 20 ||
    !startsWith(bytes, [82, 73, 70, 70]) ||
    ascii(bytes, 8, 4) !== 'WEBP' ||
    readUint32LittleEndian(bytes, 4) + 8 !== bytes.length
  ) {
    fail('signature-mismatch', 'file.data', 'invalid WebP RIFF envelope');
  }
  let offset = 12;
  let width = 0;
  let height = 0;
  let sawImage = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('malformed-file', 'file.data', 'WebP chunk is truncated');
    const type = ascii(bytes, offset, 4);
    const length =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);
    const dataStart = offset + 8;
    const dataEnd = dataStart + (length >>> 0);
    if (dataEnd > bytes.length || dataEnd + (length & 1) > bytes.length) {
      fail('malformed-file', 'file.data', `WebP ${type} chunk is truncated`);
    }
    if (type === 'VP8X') {
      if (length !== 10) fail('malformed-file', 'file.data', 'WebP VP8X header is invalid');
      width = readUint24LittleEndian(bytes, dataStart + 4) + 1;
      height = readUint24LittleEndian(bytes, dataStart + 7) + 1;
    } else if (type === 'VP8 ') {
      if (
        length < 10 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        fail('malformed-file', 'file.data', 'WebP VP8 frame header is invalid');
      }
      width = readUint16LittleEndian(bytes, dataStart + 6) & 0x3fff;
      height = readUint16LittleEndian(bytes, dataStart + 8) & 0x3fff;
      sawImage = true;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[dataStart] !== 0x2f) {
        fail('malformed-file', 'file.data', 'WebP VP8L frame header is invalid');
      }
      const bits =
        bytes[dataStart + 1] |
        (bytes[dataStart + 2] << 8) |
        (bytes[dataStart + 3] << 16) |
        (bytes[dataStart + 4] << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      sawImage = true;
    }
    offset = dataEnd + (length & 1);
  }
  if (offset !== bytes.length || !sawImage || width <= 0 || height <= 0) {
    fail('malformed-file', 'file.data', 'WebP is missing complete image data');
  }
  return { width, height };
}

async function imageDimensions(
  mimeType: string,
  bytes: Uint8Array,
  suppliedWidth?: number,
  suppliedHeight?: number,
): Promise<{ width: number; height: number }> {
  let width = suppliedWidth;
  let height = suppliedHeight;
  if (mimeType === 'image/png') {
    ({ width, height } = await validatePng(bytes));
  } else if (mimeType === 'image/gif') {
    ({ width, height } = validateGif(bytes));
  } else if (mimeType === 'image/webp') {
    ({ width, height } = validateWebp(bytes));
  } else if (mimeType === 'image/jpeg') {
    ({ width, height } = validateJpeg(bytes));
  }
  if (
    (suppliedWidth !== undefined && suppliedWidth !== width) ||
    (suppliedHeight !== undefined && suppliedHeight !== height)
  ) {
    fail('invalid-dimension', 'file', 'supplied image dimensions do not match file content');
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    (width as number) > CANVAS_MAX_ASSET_DIMENSION ||
    (height as number) > CANVAS_MAX_ASSET_DIMENSION
  ) {
    fail('invalid-dimension', 'file', 'missing or out-of-range image dimensions');
  }
  return { width: width as number, height: height as number };
}

function compressionMetadata(
  text: string,
): { compressedSize: number; uncompressedSize: number } | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.compressedSize === 'number' &&
      Number.isSafeInteger(record.compressedSize) &&
      typeof record.uncompressedSize === 'number' &&
      Number.isSafeInteger(record.uncompressedSize)
    ) {
      return {
        compressedSize: record.compressedSize,
        uncompressedSize: record.uncompressedSize,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail('malformed-file', 'file.data', 'JSON file is malformed');
  }
}

function importMarkdown(text: string, identity: CanvasImportIdentity | undefined): CanvasDocument {
  if (!identity) {
    fail('missing-identity', 'options.identity', 'Markdown import requires document identity');
  }
  const clean = sanitizeCanvasCodeBlock(text, 'file.data');
  const chunks = clean
    .split(/\n{2,}/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const title =
    chunks
      .find((chunk) => /^#\s+/u.test(chunk))
      ?.replace(/^#\s+/u, '')
      .trim() ?? 'Imported Markdown';
  let document = createCanvasDocument({ ...identity, title });
  let index = 0;
  for (const chunk of chunks) {
    let content: CanvasBlockContent;
    const heading = /^(#{1,6})\s+([\s\S]*)$/u.exec(chunk);
    const code = /^```([A-Za-z0-9+#.-]{0,32})\n([\s\S]*?)\n?```$/u.exec(chunk);
    if (heading) {
      content = {
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: sanitizeCanvasPlainText(heading[2], `markdown.blocks[${index}]`),
      };
    } else if (code) {
      content = {
        kind: 'code',
        language: code[1] || 'plaintext',
        text: sanitizeCanvasCodeBlock(code[2], `markdown.blocks[${index}]`),
      };
    } else {
      content = {
        kind: 'text',
        text: sanitizeCanvasPlainText(chunk, `markdown.blocks[${index}]`),
      };
    }
    document = withBlockAdded(
      document,
      createCanvasBlock({
        id: `import-${index + 1}`,
        content,
        now: identity.now + index + 1,
      }),
      identity.now + index + 1,
    );
    index += 1;
  }
  return document;
}

function sanitizeDiagram(text: string): string {
  const source = sanitizeCanvasCodeBlock(text, 'file.data');
  return source
    .split('\n')
    .filter((line) => !/\b(?:javascript|vbscript|data)\s*:/iu.test(line))
    .filter((line) => !/^\s*click\b/iu.test(line))
    .join('\n');
}

function validatePdf(bytes: Uint8Array, maxPages: number): number {
  const text = new TextDecoder('latin1').decode(bytes);
  if (!/^%PDF-1\.[0-7](?:\r\n|\n)/u.test(text)) {
    fail('signature-mismatch', 'file.data', 'invalid or unsupported PDF header');
  }
  const footer = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(text);
  if (!footer) fail('malformed-file', 'file.data', 'PDF footer or startxref is missing');
  const xrefOffset = Number(footer[1]);
  if (
    !Number.isSafeInteger(xrefOffset) ||
    xrefOffset <= 0 ||
    xrefOffset >= footer.index ||
    !text.startsWith('xref', xrefOffset)
  ) {
    fail('malformed-file', 'file.data', 'PDF startxref does not reference a classic xref table');
  }
  const xrefText = text.slice(xrefOffset, footer.index);
  const header = /^xref\r?\n0\s+(\d+)\r?\n/u.exec(xrefText);
  if (!header) fail('malformed-file', 'file.data', 'PDF xref table is malformed');
  const entryCount = Number(header[1]);
  if (!Number.isSafeInteger(entryCount) || entryCount < 2 || entryCount > 100_000) {
    fail('malformed-file', 'file.data', 'PDF xref entry count is invalid');
  }
  const linesStart = header[0].length;
  const lines = xrefText.slice(linesStart).split(/\r?\n/u);
  const entries = lines.slice(0, entryCount);
  if (
    entries.length !== entryCount ||
    entries.some((line) => !/^\d{10}\s+\d{5}\s+[fn]\s?$/u.test(line))
  ) {
    fail('malformed-file', 'file.data', 'PDF xref entries are malformed or truncated');
  }
  const trailerText = lines.slice(entryCount).join('\n');
  const trailer = /^trailer\s*<<([\s\S]*?)>>/u.exec(trailerText.trimStart());
  if (!trailer) fail('malformed-file', 'file.data', 'PDF trailer dictionary is missing');
  const size = /\/Size\s+(\d+)\b/u.exec(trailer[1]);
  const root = /\/Root\s+(\d+)\s+0\s+R\b/u.exec(trailer[1]);
  if (!size || Number(size[1]) !== entryCount || !root) {
    fail('malformed-file', 'file.data', 'PDF trailer size or root reference is invalid');
  }

  const objectPattern = /(?:^|\r?\n)(\d+)\s+0\s+obj\r?\n([\s\S]*?)\r?\nendobj(?=\r?\n|$)/gu;
  const objects = new Map<number, { offset: number; body: string }>();
  for (const match of text.slice(0, xrefOffset).matchAll(objectPattern)) {
    const id = Number(match[1]);
    const relative = match.index ?? 0;
    const declarationOffset = relative + (match[0].startsWith('\n') ? 1 : 0);
    if (!Number.isSafeInteger(id) || id <= 0 || id >= entryCount || objects.has(id)) {
      fail('malformed-file', 'file.data', 'PDF object identifiers are invalid or duplicated');
    }
    objects.set(id, { offset: declarationOffset, body: match[2] });
  }
  if (objects.size !== entryCount - 1) {
    fail('malformed-file', 'file.data', 'PDF object count does not match the xref table');
  }
  for (let id = 1; id < entryCount; id += 1) {
    const entry = /^(\d{10})\s+\d{5}\s+n\s?$/u.exec(entries[id]);
    const object = objects.get(id);
    if (!entry || !object || Number(entry[1]) !== object.offset) {
      fail('malformed-file', 'file.data', `PDF xref entry ${id} does not match its object`);
    }
    const stream = /\b\/Length\s+(\d+)\b[\s\S]*?>>\r?\nstream\r?\n([\s\S]*?)\r?\nendstream/u.exec(
      object.body,
    );
    if (stream && TEXT_ENCODER.encode(stream[2]).length !== Number(stream[1])) {
      fail('malformed-file', 'file.data', `PDF stream ${id} length is invalid`);
    }
  }

  const rootId = Number(root[1]);
  const rootObject = objects.get(rootId)?.body;
  const pagesReference =
    rootObject && /\/Type\s*\/Catalog\b[\s\S]*?\/Pages\s+(\d+)\s+0\s+R\b/u.exec(rootObject);
  if (!pagesReference)
    fail('malformed-file', 'file.data', 'PDF catalog or pages reference is invalid');
  const pagesId = Number(pagesReference[1]);
  const pagesObject = objects.get(pagesId)?.body;
  const count = pagesObject && /\/Type\s*\/Pages\b[\s\S]*?\/Count\s+(\d+)\b/u.exec(pagesObject);
  const kids = pagesObject && /\/Kids\s*\[([^\]]*)\]/u.exec(pagesObject);
  if (!count || !kids) fail('malformed-file', 'file.data', 'PDF page tree is invalid');
  const pageCount = Number(count[1]);
  const childIds = [...kids[1].matchAll(/(\d+)\s+0\s+R\b/gu)].map((match) => Number(match[1]));
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    childIds.length !== pageCount ||
    new Set(childIds).size !== childIds.length
  ) {
    fail('malformed-file', 'file.data', 'PDF page count does not match its page tree');
  }
  if (pageCount > maxPages) {
    fail('oversized', 'file.data', `PDF exceeds ${maxPages} pages`);
  }
  for (const childId of childIds) {
    const page = objects.get(childId)?.body;
    if (
      !page ||
      !/\/Type\s*\/Page\b/u.test(page) ||
      !new RegExp(`/Parent\\s+${pagesId}\\s+0\\s+R\\b`, 'u').test(page)
    ) {
      fail('malformed-file', 'file.data', 'PDF page tree contains an invalid page object');
    }
  }
  return pageCount;
}

export async function importCanvas(
  file: CanvasImportFile,
  options: CanvasImportOptions = {},
): Promise<CanvasImportResult> {
  if (typeof file !== 'object' || file === null) {
    fail('invalid-input', 'file', 'expected a file descriptor');
  }
  const maxBytes = assertSafeIntegerOption(
    options.maxBytes,
    CANVAS_IMPORT_MAX_BYTES,
    'options.maxBytes',
  );
  const maxCompressionRatio = assertSafeIntegerOption(
    options.maxCompressionRatio,
    CANVAS_IMPORT_MAX_COMPRESSION_RATIO,
    'options.maxCompressionRatio',
  );
  const maxPdfPages = assertSafeIntegerOption(
    options.maxPdfPages,
    CANVAS_IMPORT_MAX_PDF_PAGES,
    'options.maxPdfPages',
  );
  const mimeType = validateFileMetadata(file, maxBytes);
  const bytes = await fileBytes(file.data);
  if (bytes.length !== file.size) {
    fail('invalid-input', 'file.size', 'declared size does not match supplied bytes');
  }
  if (bytes.length > maxBytes) fail('oversized', 'file.data', `file exceeds ${maxBytes} bytes`);

  if (mimeType === 'application/json' || mimeType === 'application/vnd.vibespace.canvas+json') {
    const text = decodeText(bytes);
    const compression = compressionMetadata(text);
    if (
      compression &&
      (compression.compressedSize <= 0 ||
        compression.uncompressedSize < 0 ||
        compression.uncompressedSize / compression.compressedSize > maxCompressionRatio ||
        compression.uncompressedSize > maxBytes)
    ) {
      fail('compression-limit', 'file.data', 'declared package expansion exceeds limits');
    }
    const parsed = parseJson(text);
    if (
      mimeType === 'application/vnd.vibespace.canvas+json' ||
      (typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>).kind === 'vibespace.canvas.package')
    ) {
      return freeze({
        kind: 'document',
        document: decodeCanvasPackage(text, { maxTextLength: maxBytes }).document,
        sourceFormat: 'package',
      });
    }
    return freeze({
      kind: 'document',
      document: parseCanvasDocument(parsed),
      sourceFormat: 'json',
    });
  }

  if (
    mimeType === 'text/markdown' ||
    (mimeType === 'text/plain' && /\.markdown?$/.test(file.name))
  ) {
    const text = decodeText(bytes);
    if (text.length > CANVAS_MAX_TEXT_LENGTH) {
      fail('oversized', 'file.data', 'Markdown exceeds the canvas text limit');
    }
    return freeze({
      kind: 'document',
      document: importMarkdown(text, options.identity),
      sourceFormat: 'markdown',
    });
  }

  if (mimeType.startsWith('image/')) {
    const dimensions = await imageDimensions(mimeType, bytes, file.width, file.height);
    if (dimensions.width * dimensions.height > CANVAS_EXPORT_MAX_PIXELS) {
      fail('invalid-dimension', 'file', 'image pixel count exceeds the safe decode budget');
    }
    assertSafeCanvasAsset({
      size: bytes.length,
      mimeType,
      width: dimensions.width,
      height: dimensions.height,
    });
    return freeze(
      immutableBytes(
        {
          kind: 'asset' as const,
          name: file.name,
          mimeType: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          ...dimensions,
        },
        bytes,
      ),
    );
  }

  if (mimeType === 'application/pdf') {
    if (bytes.length > CANVAS_MAX_ASSET_BYTES) {
      fail('oversized', 'file.data', 'PDF exceeds the asset byte limit');
    }
    const pages = validatePdf(bytes, maxPdfPages);
    return freeze(
      immutableBytes(
        {
          kind: 'pdf' as const,
          name: file.name,
          mimeType: 'application/pdf' as const,
          pageCount: pages,
        },
        bytes,
      ),
    );
  }

  const syntax = extensionOf(file.name) === '.dot' ? 'graphviz' : 'mermaid';
  return freeze({
    kind: 'diagram',
    name: file.name,
    mimeType: syntax === 'graphviz' ? 'text/vnd.graphviz' : 'text/x-mermaid',
    syntax,
    source: sanitizeDiagram(decodeText(bytes)),
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function scopedDocument(
  document: CanvasDocument,
  scope: CanvasExportScope | undefined,
): CanvasDocument {
  if (!scope || scope.kind === 'all') return document;
  const ids = scope.kind === 'presentation' ? [...document.presentationOrder] : [...scope.blockIds];
  const unique = new Set(ids);
  if (
    unique.size !== ids.length ||
    ids.some((id) => !document.blocks.some((block) => block.id === id))
  ) {
    fail('invalid-scope', 'options.scope', 'scope contains duplicate or unknown block ids');
  }
  const orderedIds = document.pageOrder.filter((id) => unique.has(id));
  const blocks = orderedIds.map(
    (id) => document.blocks.find((block) => block.id === id) as CanvasBlock,
  );
  return parseCanvasDocument({
    ...document,
    blocks,
    pageOrder: orderedIds,
    placements: document.placements.filter((placement) => unique.has(placement.blockId)),
    presentationOrder: document.presentationOrder.filter((id) => unique.has(id)),
    presentationNotes: document.presentationNotes.filter((entry) => unique.has(entry.frameId)),
  });
}

function blockText(block: CanvasBlock): string {
  switch (block.content.kind) {
    case 'heading':
    case 'text':
    case 'note':
    case 'code':
      return block.content.text;
    case 'mind-map':
      return JSON.stringify(block.content.map);
    case 'shape':
      return block.content.shape.text ?? block.content.shape.kind;
    case 'stroke':
      return `${block.content.tool} stroke`;
    case 'image':
      return `${block.content.altText || block.content.name} (image)`;
  }
}

function markdown(document: CanvasDocument): string {
  return document.pageOrder
    .map((id) => document.blocks.find((block) => block.id === id) as CanvasBlock)
    .map((block) => {
      switch (block.content.kind) {
        case 'heading':
          return `${'#'.repeat(block.content.level)} ${block.content.text}`;
        case 'code':
          return `\`\`\`${block.content.language}\n${block.content.text}\n\`\`\``;
        case 'note':
          return `> ${block.content.text.replace(/\n/gu, '\n> ')}`;
        case 'mind-map':
          return `\`\`\`json\n${stableJson(block.content.map)}\n\`\`\``;
        case 'shape':
          return `[Shape: ${block.content.shape.kind}] ${block.content.shape.text ?? ''}`.trimEnd();
        case 'stroke':
          return `[${block.content.tool === 'pencil' ? 'Pencil' : 'Marker'} stroke]`;
        case 'image':
          return `[Image: ${block.content.name}] ${block.content.altText}`.trimEnd();
        default:
          return block.content.text;
      }
    })
    .join('\n\n');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function svgShapeMarkup(block: CanvasBlock, y: number): readonly string[] {
  if (block.content.kind !== 'shape') return [];
  const shape = block.content.shape;
  const x = 24;
  const top = y - 20;
  const width = 180;
  const height = 48;
  const fill = shape.fill?.color ?? shape.gradient?.stops[0]?.color ?? 'none';
  const stroke = shape.borderColor ?? 'none';
  const strokeWidth = shape.borderWidth;
  const dash =
    shape.dash === 'dashed'
      ? ' stroke-dasharray="8 6"'
      : shape.dash === 'dotted'
        ? ' stroke-dasharray="2 5"'
        : '';
  const shared = `data-shape-kind="${shape.kind}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${shape.opacity}"${dash}`;
  let element: string;
  switch (shape.kind) {
    case 'ellipse':
    case 'actor':
      element = `<ellipse cx="${x + width / 2}" cy="${top + height / 2}" rx="${width / 2}" ry="${height / 2}" ${shared}/>`;
      break;
    case 'diamond':
      element = `<polygon points="${x + width / 2},${top} ${x + width},${top + height / 2} ${x + width / 2},${top + height} ${x},${top + height / 2}" ${shared}/>`;
      break;
    case 'triangle':
      element = `<polygon points="${x + width / 2},${top} ${x + width},${top + height} ${x},${top + height}" ${shared}/>`;
      break;
    case 'hexagon':
      element = `<polygon points="${x + width * 0.25},${top} ${x + width * 0.75},${top} ${x + width},${top + height / 2} ${x + width * 0.75},${top + height} ${x + width * 0.25},${top + height} ${x},${top + height / 2}" ${shared}/>`;
      break;
    default:
      element = `<rect x="${x}" y="${top}" width="${width}" height="${height}" rx="${Math.min(shape.cornerRadius, height / 2)}" ${shared}/>`;
      break;
  }
  return [
    element,
    `<text x="${x + width / 2}" y="${top + height / 2 + 5}" text-anchor="middle" fill="#111111" font-family="sans-serif" font-size="14">${escapeXml(shape.text ?? 'Unlabeled shape')}</text>`,
  ];
}

function svgDocument(
  document: CanvasDocument,
  width: number,
  height: number,
  background: string,
): string {
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="${background}"/>`,
    `<title>${escapeXml(document.title)}</title>`,
  ];
  let y = 36;
  for (const id of document.pageOrder) {
    const block = document.blocks.find((candidate) => candidate.id === id) as CanvasBlock;
    if (block.content.kind === 'shape') {
      lines.push(...svgShapeMarkup(block, y));
      y += 64;
      continue;
    }
    if (block.content.kind === 'stroke') {
      const path = block.content.points.map((point) => `${point.x + 24},${point.y + y}`).join(' ');
      lines.push(
        `<polyline points="${path}" fill="none" stroke="${block.content.color}" stroke-width="${block.content.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
      y += 64;
      continue;
    }
    if (block.content.kind === 'image') {
      lines.push(
        `<image x="24" y="${y}" width="${Math.min(block.content.width, 180)}" height="${Math.min(block.content.height, 120)}" href="${block.content.dataUrl}"/>`,
      );
      y += Math.min(block.content.height, 120) + 16;
      continue;
    }
    lines.push(
      `<text x="24" y="${y}" fill="#111111" font-family="sans-serif" font-size="16">${escapeXml(blockText(block))}</text>`,
    );
    y += 28;
  }
  lines.push('</svg>');
  return lines.join('');
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = TEXT_ENCODER.encode(type);
  return concat(uint32(data.length), typeBytes, data, uint32(crc32(concat(typeBytes, data))));
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function parseColor(color: string): [number, number, number, number] {
  if (!COLOR_PATTERN.test(color)) fail('invalid-input', 'options.background', 'expected #rrggbb');
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    255,
  ];
}

const FONT_5X7: Readonly<Record<string, readonly number[]>> = Object.freeze({
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [31, 4, 4, 4, 4, 4, 31],
  J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 16, 30, 1, 1, 30],
  '6': [14, 16, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 1, 14],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  ':': [0, 12, 12, 0, 12, 12, 0],
  '/': [1, 2, 2, 4, 8, 8, 16],
  '?': [14, 17, 1, 2, 4, 0, 4],
});

function png(width: number, height: number, color: string, document: CanvasDocument): Uint8Array {
  const background = parseColor(color);
  const rowSize = 1 + width * 4;
  const pixels = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * rowSize;
    pixels[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      pixels.set(background, offset + 1 + x * 4);
    }
  }

  const setPixel = (x: number, y: number, rgba: readonly number[]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    pixels.set(rgba, y * rowSize + 1 + x * 4);
  };
  const fillRect = (
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number,
    rgba: readonly number[],
  ): void => {
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(width, Math.ceil(x + rectWidth));
    const bottom = Math.min(height, Math.ceil(y + rectHeight));
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) setPixel(column, row, rgba);
    }
  };
  const strokeRect = (
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number,
    rgba: readonly number[],
  ): void => {
    fillRect(x, y, rectWidth, 1, rgba);
    fillRect(x, y + rectHeight - 1, rectWidth, 1, rgba);
    fillRect(x, y, 1, rectHeight, rgba);
    fillRect(x + rectWidth - 1, y, 1, rectHeight, rgba);
  };
  const drawText = (
    value: string,
    x: number,
    y: number,
    rgba: readonly number[],
    maximumWidth: number,
    maximumHeight: number,
    requestedScale = 1,
  ): void => {
    const glyphScale = Math.max(1, Math.min(4, Math.floor(requestedScale)));
    const advance = 6 * glyphScale;
    const lineHeight = 9 * glyphScale;
    const maxCharacters = Math.max(1, Math.floor(maximumWidth / advance));
    const maxLines = Math.max(0, Math.floor(maximumHeight / lineHeight));
    if (maxLines === 0) return;

    const lines: string[] = [];
    for (const sourceLine of value.normalize('NFKD').split(/\r?\n/u)) {
      const normalized = sourceLine.replace(/[^\x20-\x7e]/gu, '?').toUpperCase();
      let line = '';
      for (const word of normalized.split(/\s+/u)) {
        if (!word) continue;
        if (line && line.length + word.length + 1 <= maxCharacters) {
          line += ` ${word}`;
          continue;
        }
        if (line) lines.push(line);
        line = '';
        for (let offset = 0; offset < word.length; offset += maxCharacters) {
          const fragment = word.slice(offset, offset + maxCharacters);
          if (fragment.length === maxCharacters) lines.push(fragment);
          else line = fragment;
        }
      }
      if (line) lines.push(line);
      if (sourceLine.length === 0) lines.push('');
    }

    lines.slice(0, maxLines).forEach((line, lineIndex) => {
      const lineY = y + lineIndex * lineHeight;
      [...line].forEach((character, characterIndex) => {
        const glyph = FONT_5X7[character] ?? FONT_5X7['?'];
        glyph.forEach((bits, row) => {
          for (let column = 0; column < 5; column += 1) {
            if ((bits & (1 << (4 - column))) !== 0) {
              fillRect(
                x + characterIndex * advance + column * glyphScale,
                lineY + row * glyphScale,
                glyphScale,
                glyphScale,
                rgba,
              );
            }
          }
        });
      });
    });
  };

  const luminance = background[0] * 0.299 + background[1] * 0.587 + background[2] * 0.114;
  const ink = luminance >= 128 ? ([24, 24, 27, 255] as const) : ([245, 245, 245, 255] as const);
  const card = luminance >= 128 ? ([255, 255, 255, 255] as const) : ([39, 39, 42, 255] as const);
  const border =
    luminance >= 128 ? ([113, 113, 122, 255] as const) : ([161, 161, 170, 255] as const);
  const accent = [59, 130, 246, 255] as const;
  const orderedBlocks = document.pageOrder.map(
    (id) => document.blocks.find((block) => block.id === id) as CanvasBlock,
  );
  const placementById = resolveEdgelessLayout(document);
  const placedBlocks = orderedBlocks.flatMap((block, index) => {
    const placement = placementById.get(block.id);
    return placement && !placement.hidden ? [{ block, placement, index }] : [];
  });
  const bounds = placedBlocks.map(({ placement }) => {
    const radians = (placement.rotation * Math.PI) / 180;
    const halfWidth = Math.abs(Math.cos(radians)) * placement.width * 0.5;
    const halfHeight = Math.abs(Math.sin(radians)) * placement.width * 0.5;
    const rotatedHalfWidth = halfWidth + Math.abs(Math.sin(radians)) * placement.height * 0.5;
    const rotatedHalfHeight = halfHeight + Math.abs(Math.cos(radians)) * placement.height * 0.5;
    const centerX = placement.x + placement.width * 0.5;
    const centerY = placement.y + placement.height * 0.5;
    return {
      left: centerX - rotatedHalfWidth,
      top: centerY - rotatedHalfHeight,
      right: centerX + rotatedHalfWidth,
      bottom: centerY + rotatedHalfHeight,
    };
  });
  const minX = bounds.length ? Math.min(...bounds.map(({ left }) => left)) : 0;
  const minY = bounds.length ? Math.min(...bounds.map(({ top }) => top)) : 0;
  const maxX = bounds.length ? Math.max(...bounds.map(({ right }) => right)) : 1;
  const maxY = bounds.length ? Math.max(...bounds.map(({ bottom }) => bottom)) : 1;
  const minimumDimension = Math.min(width, height);
  const margin = Math.max(1, Math.min(48, Math.floor(minimumDimension * 0.06)));
  const titleHeight = height >= 80 ? Math.min(60, Math.max(30, Math.round(height * 0.1))) : 0;
  const safeWidth = Math.max(1, width - margin * 2);
  const safeHeight = Math.max(1, height - titleHeight - margin * 2);
  const layoutScale = Math.min(
    safeWidth / Math.max(1, maxX - minX),
    safeHeight / Math.max(1, maxY - minY),
  );
  const fontScale = Math.max(1, Math.min(4, Math.floor(layoutScale)));
  const titleY = Math.max(1, Math.floor(margin * 0.5));
  if (titleHeight > 0) {
    drawText(
      document.title,
      margin,
      titleY,
      ink,
      safeWidth,
      titleHeight - titleY,
      Math.max(1, Math.min(3, fontScale)),
    );
  }

  placedBlocks
    .sort((left, right) => left.placement.z - right.placement.z || left.index - right.index)
    .forEach(({ block, placement }) => {
      const x = margin + (placement.x - minX) * layoutScale;
      const y = titleHeight + margin + (placement.y - minY) * layoutScale;
      const currentWidth = placement.width * layoutScale;
      const currentHeight = placement.height * layoutScale;
      fillRect(x, y, currentWidth, currentHeight, card);
      if (currentWidth >= 2 && currentHeight >= 2) {
        strokeRect(x, y, currentWidth, currentHeight, border);
        if (block.content.kind === 'heading') {
          fillRect(x, y, Math.max(2, fontScale), currentHeight, accent);
        }
      }
      const padding = Math.max(2, Math.min(18, fontScale * 4));
      if (currentWidth > padding * 2 && currentHeight > padding * 2) {
        drawText(
          blockText(block),
          x + padding,
          y + padding,
          ink,
          currentWidth - padding * 2,
          currentHeight - padding * 2,
          fontScale,
        );
      }
    });

  const description = [document.title, ...orderedBlocks.map(blockText)]
    .join('\n')
    .replace(/\u0000/gu, '')
    .slice(0, 4096);
  const ihdr = concat(uint32(width), uint32(height), new Uint8Array([8, 6, 0, 0, 0]));
  return concat(
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', TEXT_ENCODER.encode(`Description\u0000${description}`)),
    pngChunk('IDAT', zlibSync(pixels, { level: 6 })),
    pngChunk('IEND', new Uint8Array()),
  );
}

function pdfString(value: string): string {
  return value.replace(/[^\x20-\x7e]/gu, '?').replace(/([\\()])/gu, '\\$1');
}

const PDF_BODY_LINES_PER_PAGE = 30;
const PDF_MAX_LINE_LENGTH = 96;

function wrapPdfLine(value: string): string[] {
  const normalized = value.replace(/[^\x20-\x7e]/gu, '?');
  const wrapped: string[] = [];
  for (const paragraph of normalized.split(/\r?\n/u)) {
    if (!paragraph) {
      wrapped.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/u)) {
      if (!word) continue;
      if (word.length > PDF_MAX_LINE_LENGTH) {
        if (line) wrapped.push(line);
        line = '';
        for (let offset = 0; offset < word.length; offset += PDF_MAX_LINE_LENGTH) {
          const fragment = word.slice(offset, offset + PDF_MAX_LINE_LENGTH);
          if (fragment.length === PDF_MAX_LINE_LENGTH) wrapped.push(fragment);
          else line = fragment;
        }
      } else if (!line) {
        line = word;
      } else if (line.length + word.length + 1 <= PDF_MAX_LINE_LENGTH) {
        line += ` ${word}`;
      } else {
        wrapped.push(line);
        line = word;
      }
    }
    if (line) wrapped.push(line);
  }
  return wrapped;
}

function pdf(pages: readonly { title: string; lines: readonly string[] }[]): Uint8Array {
  const normalizedPages =
    pages.length === 0 ? [{ title: 'Untitled', lines: [] as readonly string[] }] : pages;
  const printablePages = normalizedPages.flatMap((page) => {
    const lines = page.lines.flatMap(wrapPdfLine);
    const pageCount = Math.max(1, Math.ceil(lines.length / PDF_BODY_LINES_PER_PAGE));
    return Array.from({ length: pageCount }, (_, pageIndex) => ({
      title: pageIndex === 0 ? page.title : `${page.title} (continued)`,
      lines: lines.slice(
        pageIndex * PDF_BODY_LINES_PER_PAGE,
        (pageIndex + 1) * PDF_BODY_LINES_PER_PAGE,
      ),
    }));
  });
  const pageCount = printablePages.length;
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = Array.from({ length: pageCount }, (_, index) => `${4 + index * 2} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  printablePages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const commands = [
      'BT',
      '/F1 18 Tf',
      `72 740 Td (${pdfString(page.title)}) Tj`,
      '/F1 11 Tf',
      ...page.lines.flatMap((line) => ['0 -22 Td', `(${pdfString(line)}) Tj`]),
      'ET',
    ].join('\n');
    objects[contentId] =
      `<< /Length ${TEXT_ENCODER.encode(commands).length} >>\nstream\n${commands}\nendstream`;
  });
  let output = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = TEXT_ENCODER.encode(output).length;
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = TEXT_ENCODER.encode(output).length;
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    output += `${offsets[id].toString().padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return TEXT_ENCODER.encode(output);
}

function exportDimensions(options: CanvasExportOptions): {
  width: number;
  height: number;
  scale: number;
} {
  const width = assertSafeIntegerOption(options.width, 1280, 'options.width');
  const height = assertSafeIntegerOption(options.height, 720, 'options.height');
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    fail('invalid-dimension', 'options.scale', 'expected a finite scale in (0, 8]');
  }
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  if (
    scaledWidth <= 0 ||
    scaledHeight <= 0 ||
    scaledWidth > CANVAS_MAX_ASSET_DIMENSION ||
    scaledHeight > CANVAS_MAX_ASSET_DIMENSION ||
    scaledWidth * scaledHeight > CANVAS_EXPORT_MAX_PIXELS
  ) {
    fail('invalid-dimension', 'options', 'scaled export dimensions exceed limits');
  }
  return { width: scaledWidth, height: scaledHeight, scale };
}

function filename(document: CanvasDocument, extension: string, requested?: string): string {
  const base = requested ?? document.title;
  const safe = base
    .replace(SAFE_NAME_PATTERN, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120);
  return `${safe || 'canvas'}.${extension}`;
}

function artifact(
  document: CanvasDocument,
  extension: string,
  mimeType: string,
  bytes: Uint8Array,
  requested?: string,
  extra: Omit<CanvasExportArtifact, 'filename' | 'mimeType' | 'bytes'> = {},
): CanvasExportArtifact {
  return freeze(
    immutableBytes(
      {
        filename: filename(document, extension, requested),
        mimeType,
        ...extra,
      },
      bytes,
    ),
  );
}

export function exportCanvas(
  source: CanvasDocument,
  options: CanvasExportOptions,
): CanvasExportArtifact {
  const document = scopedDocument(parseCanvasDocument(source), options.scope);
  const background = options.background ?? document.background.color;
  parseColor(background);

  switch (options.format) {
    case 'package': {
      const text = encodeCanvasPackage(document);
      return artifact(
        document,
        'vibespace.json',
        'application/vnd.vibespace.canvas+json',
        TEXT_ENCODER.encode(text),
        options.filename,
        { text },
      );
    }
    case 'json': {
      const text = stableJson(document);
      return artifact(
        document,
        'json',
        'application/json',
        TEXT_ENCODER.encode(text),
        options.filename,
        { text },
      );
    }
    case 'markdown': {
      const text = markdown(document);
      return artifact(
        document,
        'md',
        'text/markdown',
        TEXT_ENCODER.encode(text),
        options.filename,
        { text },
      );
    }
    case 'svg': {
      const { width, height } = exportDimensions(options);
      const text = svgDocument(document, width, height, background);
      return artifact(
        document,
        'svg',
        'image/svg+xml',
        TEXT_ENCODER.encode(text),
        options.filename,
        { text, width, height, background },
      );
    }
    case 'png': {
      const { width, height } = exportDimensions(options);
      return artifact(
        document,
        'png',
        'image/png',
        png(width, height, background, document),
        options.filename,
        { width, height, background },
      );
    }
    case 'presentation-pdf': {
      const pages = document.presentationOrder.map((id) => {
        const block = document.blocks.find((candidate) => candidate.id === id) as CanvasBlock;
        return { title: blockText(block), lines: [document.title] };
      });
      return artifact(document, 'pdf', 'application/pdf', pdf(pages), options.filename, {
        background,
      });
    }
    case 'pdf': {
      return artifact(
        document,
        'pdf',
        'application/pdf',
        pdf([
          {
            title: document.title,
            lines: document.pageOrder.map((id) =>
              blockText(document.blocks.find((block) => block.id === id) as CanvasBlock),
            ),
          },
        ]),
        options.filename,
        { background },
      );
    }
    default:
      fail('unsupported-type', 'options.format', 'unsupported export format');
  }
}
