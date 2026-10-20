import re
import struct
from dataclasses import dataclass

MAGIC = b"RLY1"
VERSION = 1
HEADER = struct.Struct("!4sBBBBIII")
MAX_NODE_ID_BYTES = 64
MAX_PAYLOAD_BYTES = 65536

HELLO = 1
OPEN_TCP = 2
TCP_OPENED = 3
TCP_DATA = 4
CLOSE = 5
ERROR = 6
PING = 7
PONG = 8
VALID_TYPES = {HELLO, OPEN_TCP, TCP_OPENED, TCP_DATA, CLOSE, ERROR, PING, PONG}
NODE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9._-]{1,64}$")


@dataclass(frozen=True)
class Frame:
    frame_type: int
    flags: int
    node_id: str
    stream_id: int
    sequence: int
    payload: bytes


def encode_frame(frame_type: int, node_id: str, stream_id: int = 0,
                 sequence: int = 0, payload: bytes = b"", flags: int = 0) -> bytes:
    node = node_id.encode("ascii")
    if not NODE_ID_PATTERN.fullmatch(node_id) or len(node) > MAX_NODE_ID_BYTES:
        raise ValueError("invalid_node_id")
    if frame_type not in VALID_TYPES:
        raise ValueError("invalid_frame_type")
    if not 0 <= stream_id <= 0xFFFFFFFF:
        raise ValueError("invalid_stream_id")
    if not 0 <= sequence <= 0xFFFFFFFF:
        raise ValueError("invalid_sequence")
    if not 0 <= flags <= 0xFF:
        raise ValueError("invalid_flags")
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise ValueError("payload_too_large")
    return HEADER.pack(MAGIC, VERSION, frame_type, flags, len(node),
                       stream_id, sequence, len(payload)) + node + payload


def decode_frame(data: bytes) -> Frame:
    if len(data) < HEADER.size:
        raise ValueError("frame_header_truncated")
    magic, version, frame_type, flags, node_len, stream_id, sequence, payload_len = HEADER.unpack_from(data)
    if magic != MAGIC:
        raise ValueError("bad_magic")
    if version != VERSION:
        raise ValueError("unsupported_version")
    if frame_type not in VALID_TYPES:
        raise ValueError("unknown_frame_type")
    if not 1 <= node_len <= MAX_NODE_ID_BYTES:
        raise ValueError("invalid_node_id_length")
    if payload_len > MAX_PAYLOAD_BYTES:
        raise ValueError("payload_too_large")
    if len(data) != HEADER.size + node_len + payload_len:
        raise ValueError("frame_length_mismatch")
    try:
        node_id = data[HEADER.size:HEADER.size + node_len].decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("invalid_node_id") from error
    if not NODE_ID_PATTERN.fullmatch(node_id):
        raise ValueError("invalid_node_id")
    payload = data[HEADER.size + node_len:]
    return Frame(frame_type, flags, node_id, stream_id, sequence, payload)
