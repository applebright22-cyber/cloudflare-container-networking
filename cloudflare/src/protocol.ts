export const FrameType = {
  HELLO: 1,
  OPEN_TCP: 2,
  TCP_OPENED: 3,
  TCP_DATA: 4,
  CLOSE: 5,
  ERROR: 6,
  PING: 7,
  PONG: 8,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];
export interface Frame {
  type: FrameTypeValue;
  flags: number;
  nodeId: string;
  streamId: number;
  sequence: number;
  payload: Uint8Array;
}

const MAGIC = "RLY1";
const VERSION = 1;
const HEADER_BYTES = 20;
export const MAX_NODE_ID_BYTES = 64;
export const MAX_PAYLOAD_BYTES = 65536;
const VALID_TYPES = new Set<number>(Object.values(FrameType));

export function encodeFrame(frame: Frame): Uint8Array {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(frame.nodeId)) throw new Error("invalid_node_id");
  if (!VALID_TYPES.has(frame.type)) throw new Error("invalid_frame_type");
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > 0xffffffff) throw new Error("invalid_stream_id");
  if (!Number.isInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffffffff) throw new Error("invalid_sequence");
  if (frame.payload.byteLength > MAX_PAYLOAD_BYTES) throw new Error("payload_too_large");

  const node = new TextEncoder().encode(frame.nodeId);
  if (node.byteLength > MAX_NODE_ID_BYTES) throw new Error("node_id_too_large");
  const output = new Uint8Array(HEADER_BYTES + node.byteLength + frame.payload.byteLength);
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, frame.type);
  view.setUint8(6, frame.flags & 0xff);
  view.setUint8(7, node.byteLength);
  view.setUint32(8, frame.streamId, false);
  view.setUint32(12, frame.sequence, false);
  view.setUint32(16, frame.payload.byteLength, false);
  output.set(node, HEADER_BYTES);
  output.set(frame.payload, HEADER_BYTES + node.byteLength);
  return output;
}

export function decodeFrame(input: ArrayBuffer | ArrayBufferView): Frame {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < HEADER_BYTES) throw new Error("frame_header_truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  const version = view.getUint8(4);
  const type = view.getUint8(5);
  const flags = view.getUint8(6);
  const nodeLength = view.getUint8(7);
  const streamId = view.getUint32(8, false);
  const sequence = view.getUint32(12, false);
  const payloadLength = view.getUint32(16, false);
  if (magic !== MAGIC) throw new Error("bad_magic");
  if (version !== VERSION) throw new Error("unsupported_version");
  if (!VALID_TYPES.has(type)) throw new Error("unknown_frame_type");
  if (nodeLength < 1 || nodeLength > MAX_NODE_ID_BYTES) throw new Error("invalid_node_id_length");
  if (payloadLength > MAX_PAYLOAD_BYTES) throw new Error("payload_too_large");
  if (bytes.byteLength !== HEADER_BYTES + nodeLength + payloadLength) throw new Error("frame_length_mismatch");
  const nodeId = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + nodeLength));
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) throw new Error("invalid_node_id");
  return {
    type: type as FrameTypeValue,
    flags,
    nodeId,
    streamId,
    sequence,
    payload: bytes.slice(HEADER_BYTES + nodeLength),
  };
}
