/**
 * NSLogger TCP wire protocol decoder (pure, no I/O).
 *
 * Unlike the .nslogger FILE format (NSKeyedArchive bplist, see nslogger-file.ts),
 * the network protocol is a custom length-prefixed binary frame format:
 *
 *   message:  [uint32 BE totalLength][uint16 BE partCount][part]*
 *             totalLength covers everything AFTER the 4 length bytes
 *             (i.e. the 2-byte partCount + all parts).
 *   part:     [uint8 partKey][uint8 partType][data]
 *
 * Part data encoding by partType:
 *   STRING / BINARY / IMAGE → [uint32 BE size][size bytes]
 *   INT16 → 2 bytes BE, INT32 → 4 bytes BE, INT64 → 8 bytes BE
 *
 * Keeping this module socket-free makes the framing + decoding unit-testable
 * by feeding synthetic Buffers (see test-tcp.ts).
 */

export const PART_TYPE = {
  STRING: 0,
  BINARY: 1,
  INT16:  2,
  INT32:  3,
  INT64:  4,
  IMAGE:  5,
} as const;

export const PART_KEY = {
  MESSAGE_TYPE:   0,
  TIMESTAMP_S:    1,
  TIMESTAMP_MS:   2,
  TIMESTAMP_US:   3,
  THREAD_ID:      4,
  TAG:            5,
  LEVEL:          6,
  MESSAGE:        7,
  IMAGE_WIDTH:    8,
  IMAGE_HEIGHT:   9,
  MESSAGE_SEQ:    10,
  FILENAME:       11,
  LINENUMBER:     12,
  FUNCTIONNAME:   13,
  // client info parts (LOGMSG_TYPE_CLIENTINFO)
  CLIENT_NAME:    20,
  CLIENT_VERSION: 21,
  OS_NAME:        22,
  OS_VERSION:     23,
  CLIENT_MODEL:   24,
  UNIQUEID:       25,
} as const;

export const LOGMSG_TYPE = {
  LOG:        0,
  BLOCKSTART: 1,
  BLOCKEND:   2,
  CLIENTINFO: 3,
  DISCONNECT: 4,
  MARK:       5,
} as const;

/** Reject corrupt/oversized frames (cannot resync a lying length safely). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // 16 MiB

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** A fully decoded wire message, before mapping to LogEntry / SessionInfo. */
export interface NSLoggerMessage {
  type: number;            // MESSAGE_TYPE part value, defaults to LOG
  seq?: number;
  timestampS?: number;
  timestampMs?: number;    // sub-second ms part (mutually exclusive with us)
  timestampUs?: number;    // sub-second us part
  threadId?: string;       // always coerced to string
  tag?: string;
  level?: number;
  message?: string;        // present only for string messages
  filename?: string;
  lineNumber?: number;
  functionName?: string;
  // client info (CLIENTINFO)
  clientName?: string;
  clientVersion?: string;
  osName?: string;
  osVersion?: string;
  model?: string;
  uniqueId?: string;
  // diagnostics for non-text messages
  isImage?: boolean;
  isBinary?: boolean;
}

/**
 * Pull all complete messages out of `buf`, returning the decoded messages plus
 * the leftover bytes (a partial frame) to carry into the next chunk.
 * Throws ProtocolError on a corrupt/oversized length (caller should close socket).
 */
export function extractMessages(buf: Buffer): { messages: NSLoggerMessage[]; rest: Buffer } {
  const messages: NSLoggerMessage[] = [];
  let off = 0;

  while (buf.length - off >= 4) {
    const len = buf.readUInt32BE(off);
    if (len < 2 || len > MAX_MESSAGE_BYTES) {
      throw new ProtocolError(`invalid message length ${len} at offset ${off}`);
    }
    if (buf.length - off < 4 + len) break; // need more bytes for a full frame

    const body = buf.subarray(off + 4, off + 4 + len);
    messages.push(decodeMessageBody(body));
    off += 4 + len;
  }

  // Copy the leftover so a small partial frame doesn't pin a large incoming chunk.
  const rest = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0);
  return { messages, rest };
}

/** Decode one framed message body: [uint16 BE partCount][part]*. */
export function decodeMessageBody(body: Buffer): NSLoggerMessage {
  if (body.length < 2) throw new ProtocolError('message body too short for part count');

  const partCount = body.readUInt16BE(0);
  let off = 2;

  const msg: NSLoggerMessage = { type: LOGMSG_TYPE.LOG };

  const need = (n: number) => {
    if (off + n > body.length) throw new ProtocolError('part data exceeds message body');
  };

  for (let i = 0; i < partCount; i++) {
    need(2);
    const partKey  = body[off++];
    const partType = body[off++];

    // Read the payload purely from partType so we always stay byte-aligned,
    // even for unknown partKeys (we just skip the mapping below).
    let value: number | bigint | string | Buffer;
    switch (partType) {
      case PART_TYPE.INT16: {
        need(2);
        value = body.readUInt16BE(off);
        off += 2;
        break;
      }
      case PART_TYPE.INT32: {
        need(4);
        value = body.readUInt32BE(off);
        off += 4;
        break;
      }
      case PART_TYPE.INT64: {
        need(8);
        value = body.readBigUInt64BE(off);
        off += 8;
        break;
      }
      case PART_TYPE.STRING:
      case PART_TYPE.BINARY:
      case PART_TYPE.IMAGE: {
        need(4);
        const size = body.readUInt32BE(off);
        off += 4;
        need(size);
        const data = body.subarray(off, off + size);
        off += size;
        value = partType === PART_TYPE.STRING ? data.toString('utf8') : data;
        break;
      }
      default:
        throw new ProtocolError(`unknown part type ${partType}`);
    }

    assignPart(msg, partKey, partType, value);
  }

  return msg;
}

function toNumber(v: number | bigint | string | Buffer): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v);
  return NaN;
}

function toStr(v: number | bigint | string | Buffer): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  return v.toString('utf8');
}

function assignPart(
  msg: NSLoggerMessage,
  key: number,
  type: number,
  value: number | bigint | string | Buffer,
): void {
  switch (key) {
    case PART_KEY.MESSAGE_TYPE: msg.type = toNumber(value); break;
    case PART_KEY.TIMESTAMP_S:  msg.timestampS = toNumber(value); break;
    case PART_KEY.TIMESTAMP_MS: msg.timestampMs = toNumber(value); break;
    case PART_KEY.TIMESTAMP_US: msg.timestampUs = toNumber(value); break;
    case PART_KEY.THREAD_ID:    msg.threadId = toStr(value); break;
    case PART_KEY.TAG:          msg.tag = toStr(value); break;
    case PART_KEY.LEVEL:        msg.level = toNumber(value); break;
    case PART_KEY.MESSAGE:
      if (type === PART_TYPE.STRING)      msg.message = toStr(value);
      else if (type === PART_TYPE.IMAGE)  msg.isImage = true;
      else                                msg.isBinary = true;
      break;
    case PART_KEY.MESSAGE_SEQ:   msg.seq = toNumber(value); break;
    case PART_KEY.FILENAME:      msg.filename = toStr(value); break;
    case PART_KEY.LINENUMBER:    msg.lineNumber = toNumber(value); break;
    case PART_KEY.FUNCTIONNAME:  msg.functionName = toStr(value); break;
    case PART_KEY.CLIENT_NAME:    msg.clientName = toStr(value); break;
    case PART_KEY.CLIENT_VERSION: msg.clientVersion = toStr(value); break;
    case PART_KEY.OS_NAME:        msg.osName = toStr(value); break;
    case PART_KEY.OS_VERSION:     msg.osVersion = toStr(value); break;
    case PART_KEY.CLIENT_MODEL:   msg.model = toStr(value); break;
    case PART_KEY.UNIQUEID:       msg.uniqueId = toStr(value); break;
    // IMAGE_WIDTH / IMAGE_HEIGHT and any user-defined keys: ignored, already advanced.
    default: break;
  }
}
