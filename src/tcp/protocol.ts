import { Buffer } from "node:buffer";

export const HEADER_SIZE = 12;
export const RESPONSE_HEADER_SIZE = 5;

export enum Op {
  GET = 1,
  SET = 2,
  DEL = 3,
  MGET = 4,
}

export enum Status {
  OK = 0,
  NOT_FOUND = 1,
  ERROR = 2,
}

export interface Request {
  op: Op;
  flags: number;
  key: Buffer;
  value: Buffer;
  ttlMs: number;
}

export interface Response {
  status: Status;
  value: Buffer;
}

export function encodeRequest(
  op: Op,
  key: string,
  value = "",
  ttlMs = 0,
): Buffer {
  const keyBuffer = Buffer.from(key, "utf8");
  const valueBuffer = Buffer.from(value, "utf8");

  if (keyBuffer.length > 65535) {
    throw new Error("Key too large");
  }

  if (valueBuffer.length > 16 * 1024 * 1024) {
    throw new Error("Value too large");
  }

  if (!Number.isInteger(ttlMs) || ttlMs < 0 || ttlMs > 0xffffffff) {
    throw new Error("Invalid TTL");
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(op, 0);
  header.writeUInt8(0, 1);
  header.writeUInt16BE(keyBuffer.length, 2);
  header.writeUInt32BE(valueBuffer.length, 4);
  header.writeUInt32BE(ttlMs, 8);

  return Buffer.concat([header, keyBuffer, valueBuffer]);
}

export function decodeRequests(buffer: Buffer): {
  requests: Request[];
  remaining: Buffer;
} {
  const requests: Request[] = [];
  let offset = 0;

  while (buffer.length - offset >= HEADER_SIZE) {
    const op = buffer.readUInt8(offset);
    const flags = buffer.readUInt8(offset + 1);
    const keyLength = buffer.readUInt16BE(offset + 2);
    const valueLength = buffer.readUInt32BE(offset + 4);
    const ttlMs = buffer.readUInt32BE(offset + 8);

    if (
      valueLength > 16 * 1024 * 1024 ||
      keyLength + valueLength > 16 * 1024 * 1024
    ) {
      throw new Error("Frame too large");
    }

    const frameLength = HEADER_SIZE + keyLength + valueLength;

    if (buffer.length - offset < frameLength) break;

    const keyStart = offset + HEADER_SIZE;
    const valueStart = keyStart + keyLength;

    requests.push({
      op,
      flags,
      ttlMs,
      key: buffer.subarray(keyStart, valueStart),
      value: buffer.subarray(valueStart, offset + frameLength),
    });

    offset += frameLength;
  }
  return {
    requests,
    remaining: buffer.subarray(offset),
  };
}

export function encodeResponse(
  status: Status,
  value: string | Buffer = "",
): Buffer {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");

  const header = Buffer.alloc(RESPONSE_HEADER_SIZE);
  header.writeUInt8(status, 0);
  header.writeUInt32BE(payload.length, 1);

  return Buffer.concat([header, payload]);
}

export function decodeResponses(buffer: Buffer): {
  responses: Response[];
  remaining: Buffer;
} {
  const responses: Response[] = [];
  let offset = 0;

  while (buffer.length - offset >= RESPONSE_HEADER_SIZE) {
    const status = buffer.readUInt8(offset);
    const valueLength = buffer.readUInt32BE(offset + 1);

    if (valueLength > 16 * 1024 * 1024) {
      throw new Error("Response too large");
    }

    const frameLength = RESPONSE_HEADER_SIZE + valueLength;
    if (buffer.length - offset < frameLength) break;

    responses.push({
      status,
      value: buffer.subarray(
        offset + RESPONSE_HEADER_SIZE,
        offset + frameLength,
      ),
    });

    offset += frameLength;
  }

  return {
    responses,
    remaining: buffer.subarray(offset),
  };
}

export function encodeMgetRequest(keys: string[]): Buffer {
  if (keys.length > 65535) {
    throw new Error("Too many keys");
  }
  const parts: Buffer[] = [];
  const count = Buffer.alloc(2);
  count.writeUInt16BE(keys.length, 0);
  parts.push(count);

  for (const key of keys) {
    const keyBuffer = Buffer.from(key, "utf8");

    if (keyBuffer.length > 65535) {
      throw new Error("Key too large");
    }

    const length = Buffer.alloc(2);
    length.writeUInt16BE(keyBuffer.length, 0);

    parts.push(length, keyBuffer);
  }

  const payload = Buffer.concat(parts);

  if (payload.length > 65535) {
    throw new Error("MGET payload too large");
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(Op.MGET, 0);
  header.writeUInt8(0, 1);
  header.writeUInt16BE(payload.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(0, 8);

  return Buffer.concat([header, payload]);
}

export function decodeMgetKeys(payload: Buffer): string[] {
  if (payload.length < 2) {
    throw new Error("Invalid MGET payload");
  }

  const count = payload.readUInt16BE(0);
  const keys: string[] = [];
  let offset = 2;

  for (let i = 0; i < count; i++) {
    if (payload.length - offset < 2) {
      throw new Error("Incomplete MGET key length");
    }

    const keyLength = payload.readUInt16BE(offset);
    offset += 2;

    if (payload.length - offset < keyLength) {
      throw new Error("Incomplete MGET key");
    }

    keys.push(payload.subarray(offset, offset + keyLength).toString("utf8"));

    offset += keyLength;
  }

  if (offset !== payload.length) {
    throw new Error("Unexpected trailing MGET data");
  }
  return keys;
}
