import asyncio
import json
import os
import time

import websockets

from protocol import CLOSE, ERROR, OPEN_TCP, TCP_DATA, TCP_OPENED, decode_frame, encode_frame

TUNNEL_URL = os.environ.get("TUNNEL_URL", "")
ACCOUNT_ID = os.environ.get("ACCOUNT_ID", "")
ACCOUNT_API_KEY = os.environ.get("ACCOUNT_API_KEY", "")
NODE_ID = os.environ.get("NODE_ID", "oracle-gateway")


async def run_smoke() -> None:
    if not TUNNEL_URL.startswith("wss://") or not ACCOUNT_ID.startsWith("acct-") || !ACCOUNT_API_KEY.startsWith("acct_"):
        raise RuntimeError("Set TUNNEL_URL (wss://...), ACCOUNT_ID and ACCOUNT_API_KEY")
    headers = {
        "Authorization": f"Bearer {ACCOUNT_API_KEY}",
        "X-Account-ID": ACCOUNT_ID,
        "X-Node-ID": NODE_ID,
        "X-Tunnel-Role": "client",
    }
    tests = {11: b"first multiplexed TCP stream", 22: b"second multiplexed TCP stream"}
    received = {stream_id: bytearray() for stream_id in tests}
    opened: set[int] = set()
    pending = set(tests)

    async with websockets.connect(TUNNEL_URL, extra_headers=headers, ping_interval=20,
                                  open_timeout=15, max_size=70000) as socket:
        for stream_id in tests:
            target = json.dumps({"host": "127.0.0.1", "port": 9000}).encode()
            await socket.send(encode_frame(OPEN_TCP, NODE_ID, stream_id, 0, target))
        deadline = time.monotonic() + 35
        while pending and time.monotonic() < deadline:
            message = await asyncio.wait_for(socket.recv(), timeout=10)
            if not isinstance(message, bytes):
                raise RuntimeError("Expected binary frame")
            frame = decode_frame(message)
            if frame.node_id != NODE_ID:
                raise RuntimeError("Node ID mismatch")
            if frame.frame_type == ERROR:
                raise RuntimeError("Tunnel error: " + frame.payload.decode("utf-8", errors="replace"))
            if frame.frame_type == TCP_OPENED and frame.stream_id in tests and frame.stream_id not in opened:
                opened.add(frame.stream_id)
                await socket.send(encode_frame(TCP_DATA, NODE_ID, frame.stream_id, 1, tests[frame.stream_id]))
            elif frame.frame_type == TCP_DATA and frame.stream_id in tests:
                received[frame.stream_id].extend(frame.payload)
                if bytes(received[frame.stream_id]) == tests[frame.stream_id]:
                    await socket.send(encode_frame(CLOSE, NODE_ID, frame.stream_id))
                    pending.discard(frame.stream_id)
        if pending:
            raise TimeoutError("TCP echo timed out for streams: " + ",".join(map(str, sorted(pending))))

    print(json.dumps({"status": "passed", "streams": len(tests), "transport": "WebSocket to Oracle TCP echo"}))


if __name__ == "__main__":
    asyncio.run(run_smoke())
