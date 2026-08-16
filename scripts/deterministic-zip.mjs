import { readFileSync, writeFileSync } from 'node:fs';

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const UNIX_MADE_BY_VERSION = (3 << 8) | ZIP_VERSION;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const UNIX_FILE_MODE = (0o100644 << 16) >>> 0;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const END_RECORD_BYTES = 22;
const MAX_END_SEARCH_BYTES = END_RECORD_BYTES + UINT16_MAX;

export class DeterministicZipError extends Error {
  constructor(code, label = 'deterministic ZIP') {
    super(`${code}: ${label}`);
    this.name = 'DeterministicZipError';
    this.code = code;
    this.label = label;
  }
}

export function writeDeterministicZip(zipPath, inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0 || inventory.length > UINT16_MAX) {
    throw new DeterministicZipError('zip_inventory_invalid');
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let previousPath = null;

  for (const entry of inventory) {
    const relativePath = entry?.relativePath;
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new DeterministicZipError('zip_entry_path_invalid', String(relativePath));
    }
    if (!Buffer.isBuffer(entry?.bytes) && !(entry?.bytes instanceof Uint8Array)) {
      throw new DeterministicZipError('zip_entry_bytes_invalid', relativePath);
    }
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes);
    if (previousPath !== null && bytewiseCompare(previousPath, relativePath) >= 0) {
      throw new DeterministicZipError('zip_inventory_order_invalid', relativePath);
    }
    previousPath = relativePath;

    const name = Buffer.from(relativePath, 'utf8');
    if (name.length === 0 || name.length > UINT16_MAX || bytes.length > UINT32_MAX) {
      throw new DeterministicZipError('zip_entry_size_invalid', relativePath);
    }
    const crc = crc32(bytes);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(bytes.length, 18);
    localHeader.writeUInt32LE(bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralHeader.writeUInt16LE(UNIX_MADE_BY_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(bytes.length, 20);
    centralHeader.writeUInt32LE(bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(UNIX_FILE_MODE, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    localParts.push(localHeader, name, bytes);
    centralParts.push(centralHeader, name);
    localOffset = checkedUint32(localOffset + localHeader.length + name.length + bytes.length, 'zip_archive_too_large');
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralOffset = localOffset;
  checkedUint32(centralDirectory.length, 'zip_archive_too_large');
  checkedUint32(centralOffset + centralDirectory.length, 'zip_archive_too_large');

  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(inventory.length, 8);
  end.writeUInt16LE(inventory.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(zipPath, Buffer.concat([...localParts, centralDirectory, end]), {
    flag: 'wx',
    mode: 0o600,
  });
}

export function readDeterministicZip(zipPath) {
  const archive = readFileSync(zipPath);
  const endOffset = findEndRecord(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (
    diskNumber !== 0
    || centralDisk !== 0
    || diskEntries !== entryCount
    || endOffset + END_RECORD_BYTES + commentLength !== archive.length
    || centralOffset + centralSize !== endOffset
  ) throw new DeterministicZipError('zip_end_record_invalid');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(archive, cursor, 46, 'zip_central_directory_invalid');
    if (archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new DeterministicZipError('zip_central_directory_invalid');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    requireRange(archive, cursor, recordLength, 'zip_central_directory_invalid');
    if (
      flags !== UTF8_FLAG
      || method !== 0
      || compressedSize !== uncompressedSize
      || diskStart !== 0
      || nameLength === 0
    ) throw new DeterministicZipError('zip_entry_contract_invalid');
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const relativePath = decodeUtf8(nameBytes);
    entries.push({
      relativePath,
      crc,
      size: uncompressedSize,
      localOffset,
      bytes: null,
    });
    cursor += recordLength;
  }
  if (cursor !== endOffset) throw new DeterministicZipError('zip_central_directory_invalid');

  const byOffset = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  let expectedOffset = 0;
  for (const entry of byOffset) {
    if (entry.localOffset !== expectedOffset) throw new DeterministicZipError('zip_local_layout_invalid');
    const offset = entry.localOffset;
    requireRange(archive, offset, 30, 'zip_local_header_invalid');
    if (archive.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
      throw new DeterministicZipError('zip_local_header_invalid');
    }
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const crc = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const dataEnd = dataOffset + compressedSize;
    requireRange(archive, offset, dataEnd - offset, 'zip_local_header_invalid');
    const localName = decodeUtf8(archive.subarray(offset + 30, offset + 30 + nameLength));
    if (
      flags !== UTF8_FLAG
      || method !== 0
      || compressedSize !== uncompressedSize
      || compressedSize !== entry.size
      || crc !== entry.crc
      || localName !== entry.relativePath
      || dataEnd > centralOffset
    ) throw new DeterministicZipError('zip_local_entry_mismatch', entry.relativePath);
    const bytes = archive.subarray(dataOffset, dataEnd);
    if (crc32(bytes) !== entry.crc) throw new DeterministicZipError('zip_entry_crc_mismatch', entry.relativePath);
    entry.bytes = bytes;
    expectedOffset = dataEnd;
  }
  if (expectedOffset !== centralOffset) throw new DeterministicZipError('zip_local_layout_invalid');

  return Object.freeze(entries.map(({ relativePath, bytes }) => Object.freeze({ relativePath, bytes })));
}

function findEndRecord(archive) {
  if (archive.length < END_RECORD_BYTES) throw new DeterministicZipError('zip_end_record_missing');
  const minimum = Math.max(0, archive.length - MAX_END_SEARCH_BYTES);
  for (let offset = archive.length - END_RECORD_BYTES; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  throw new DeterministicZipError('zip_end_record_missing');
}

function requireRange(buffer, offset, length, code) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new DeterministicZipError(code);
  }
}

function decodeUtf8(bytes) {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) throw new DeterministicZipError('zip_entry_name_invalid_utf8');
  return value;
}

function checkedUint32(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) throw new DeterministicZipError(code);
  return value;
}

const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  }
  return current >>> 0;
}));

function crc32(bytes) {
  let value = UINT32_MAX;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ UINT32_MAX) >>> 0;
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
