import asyncio
import os

HOST = "127.0.0.1"
PORT = int(os.environ.get("ECHO_PORT", "9000"))


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(16384):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def main() -> None:
    server = await asyncio.start_server(handle, HOST, PORT)
    print(f"Echo server listening on {HOST}:{PORT}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
