import asyncio
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from typing import Optional

import websockets

from protocol import CLOSE, ERROR, OPEN_TCP, PING, PONG, TCP_DATA, TCP_OPENED, Frame, decode_frame, encode_frame

TUNNEL_URL = os.environ.get("TUNNEL_URL", "")
TUNNEL_TOKEN = os.environ.get("TUNNEL_TOKEN", "")
NODE_ID = os.environ.get("NODE_ID", "oracle-gateway")
HEARTBEAT_SECONDS = 25
MAX_STREAMS = 32
MAX_TCP_CHUNK = 16384


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"ts": time.time(), "component": "gateway-client", "event": event, **fields}, separators=(",", ":")), flush=True)


def tcp_allowlist() -> set[tuple[str, int]]:
    raw = os.environ.get("TCP_ALLOWLIST", "127.0.0.1:9000")
    allowed: set[tuple[str, int]] = set()
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        host, separator, port_text = item.rpartition(":")
        if not separator or not host or not port_text.isdigit():
            raise ValueError("TCP_ALLOWLIST must contain comma-separated host:port entries")
        port = int(port_text)
        if not 1 <= port <= 65535:
            raise ValueError("TCP_ALLOWLIST port out of range")
        allowed.add((host, port))
    return allowed


@dataclass
class Stream:
    writer: asyncio.StreamWriter
    reader_task: Optional[asyncio.Task] = None
    sequence: int = 0


async def send_frame(socket, lock: asyncio.Lock, frame_type: int, stream_id: int,
                     payload: bytes = b"", sequence: int = 0) -> None:
    wire = encode_frame(frame_type, NODE_ID, stream_id, sequence, payload)
    async with lock:
        await socket.send(wire)


async def send_error(socket, lock: asyncio.Lock, stream_id: int, code: str) -> None:
    await send_frame(socket, lock, ERROR, stream_id, json.dumps({"code": code}).encode())


async def close_stream(streams: dict[int, Stream], stream_id: int) -> None:
    stream = streams.pop(stream_id, None)
    if stream is None:
        return
    current = asyncio.current_task()
    if stream.reader_task is not None and stream.reader_task is not current:
        stream.reader_task.cancel()
        try:
            await stream.reader_task
        except (asyncio.CancelledError, Exception):
            pass
    stream.writer.close()
    try:
        await stream.writer.wait_closed()
    except Exception:
        pass


async def relay_tcp_reader(socket, lock: asyncio.Lock, streams: dict[int, Stream],
                           stream_id: int, stream: Stream, reader: asyncio.StreamReader) -> None:
    try:
        while True:
            data = await reader.read(MAX_TCP_CHUNK)
            if not data:
                break
            stream.sequence = (stream.sequence + 1) & 0xFFFFFFFF
            await send_frame(socket, lock, TCP_DATA, stream_id, data, stream.sequence)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        emit("tcp_read_failed", stream_id=stream_id, error_type=type(error).__name__)
    finally:
        if streams.get(stream_id) is stream:
            streams.pop(stream_id, None)
            stream.writer.close()
            try:
                await stream.writer.wait_closed()
            except Exception:
                pass
            try:
                await send_frame(socket, lock, CLOSE, stream_id)
            except Exception:
                pass


async def open_tcp(socket, lock: asyncio.Lock, streams: dict[int, Stream], frame: Frame,
                   allowed: set[tuple[str, int]]) -> None:
    if frame.stream_id == 0 or frame.stream_id in streams:
        await send_error(socket, lock, frame.stream_id, "invalid_or_duplicate_stream")
        return
    if len(streams) >= MAX_STREAMS:
        await send_error(socket, lock, frame.stream_id, "stream_limit")
        return
    try:
        request = json.loads(frame.payload.decode("utf-8"))
        host = request.get("host")
        port = request.get("port")
        if not isinstance(host, str) or not isinstance(port, int) or isinstance(port, bool):
            raise ValueError("invalid_target")
        if not 1 <= port <= 65535 or (host, port) not in allowed:
            await send_error(socket, lock, frame.stream_id, "destination_not_allowlisted")
            return
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=8)
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, ValueError):
        await send_error(socket, lock, frame.stream_id, "invalid_target")
        return
    except Exception as error:
        await send_error(socket, lock, frame.stream_id, "connect_failed")
        emit("tcp_connect_failed", stream_id=frame.stream_id, error_type=type(error).__name__)
        return

    stream = Stream(writer=writer)
    streams[frame.stream_id] = stream
    await send_frame(socket, lock, TCP_OPENED, frame.stream_id,
                     json.dumps({"host": host, "port": port}).encode())
    stream.reader_task = asyncio.create_task(
        relay_tcp_reader(socket, lock, streams, frame.stream_id, stream, reader)
    )
    emit("tcp_stream_opened", stream_id=frame.stream_id, destination=f"{host}:{port}")


async def handle_frame(socket, lock: asyncio.Lock, streams: dict[int, Stream],
                       frame: Frame, allowed: set[tuple[str, int]]) -> None:
    if frame.frame_type == OPEN_TCP:
        await open_tcp(socket, lock, streams, frame, allowed)
        return
    if frame.frame_type == TCP_DATA:
        stream = streams.get(frame.stream_id)
        if stream is None:
            await send_error(socket, lock, frame.stream_id, "unknown_stream")
            return
        try:
            stream.writer.write(frame.payload)
            await asyncio.wait_for(stream.writer.drain(), timeout=15)
        except Exception as error:
            emit("tcp_write_failed", stream_id=frame.stream_id, error_type=type(error).__name__)
            await close_stream(streams, frame.stream_id)
            await send_error(socket, lock, frame.stream_id, "write_failed")
        return
    if frame.frame_type == CLOSE:
        await close_stream(streams, frame.stream_id)
        return
    if frame.frame_type in (PING, PONG):
        return
    await send_error(socket, lock, frame.stream_id, "unsupported_gateway_frame")


async def heartbeat(socket, lock: asyncio.Lock) -> None:
    while True:
        await send_frame(socket, lock, PING, 0, str(time.time()).encode())
        await asyncio.sleep(HEARTBEAT_SECONDS)


async def run_connection(allowed: set[tuple[str, int]]) -> None:
    headers = {
        "Authorization": f"Bearer {TUNNEL_TOKEN}",
        "X-Node-ID": NODE_ID,
        "X-Tunnel-Role": "gateway",
    }
    async with websockets.connect(
        TUNNEL_URL,
        extra_headers=headers,
        ping_interval=20,
        open_timeout=15,
        close_timeout=5,
        max_size=70000,
    ) as socket:
        emit("connected", node_id=NODE_ID)
        send_lock = asyncio.Lock()
        streams: dict[int, Stream] = {}
        ping_task = asyncio.create_task(heartbeat(socket, send_lock))
        try:
            async for message in socket:
                if not isinstance(message, bytes):
                    emit("unexpected_text_message")
                    continue
                try:
                    frame = decode_frame(message)
                    if frame.node_id != NODE_ID:
                        emit("node_id_mismatch")
                        continue
                    await handle_frame(socket, send_lock, streams, frame, allowed)
                except ValueError as error:
                    emit("invalid_frame", reason=str(error))
        finally:
            ping_task.cancel()
            try:
                await ping_task
            except asyncio.CancelledError:
                pass
            for stream_id in list(streams):
                await close_stream(streams, stream_id)
        emit("disconnected", node_id=NODE_ID)


async def main() -> None:
    if not TUNNEL_URL.startswith("wss://") or not TUNNEL_TOKEN:
        emit("configuration_error", required=["TUNNEL_URL (wss://...)", "TUNNEL_TOKEN"])
        raise SystemExit(2)
    try:
        allowed = tcp_allowlist()
    except ValueError as error:
        emit("configuration_error", reason=str(error))
        raise SystemExit(2) from error
    delay = 1.0
    while True:
        try:
            await run_connection(allowed)
            delay = 1.0
        except asyncio.CancelledError:
            raise
        except Exception as error:
            emit("connection_failed", node_id=NODE_ID, error_type=type(error).__name__)
        wait = min(30.0, delay) * random.uniform(0.8, 1.2)
        emit("reconnecting", delay_seconds=round(wait, 2))
        await asyncio.sleep(wait)
        delay = min(30.0, delay * 2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
