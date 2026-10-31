export interface ClosableTcpSocket {
  close(): Promise<void>;
}

export interface ReleasableStreamLock {
  releaseLock(): void;
}

/**
 * Force-close a Cloudflare TCP socket before releasing its stream locks.
 *
 * Socket.close() closes both the readable and writable sides. Calling
 * writer.close() first can wait for a graceful half-close while the peer keeps
 * its readable side open, preventing the relay from reaching socket.close().
 */
export async function closeTcpResources(
  socket: ClosableTcpSocket,
  writer?: ReleasableStreamLock,
  reader?: ReleasableStreamLock,
): Promise<void> {
  try {
    await socket.close();
  } catch {
    // The peer or runtime may already have closed the socket.
  }
  try {
    writer?.releaseLock();
  } catch {
    // A pending operation may still own the writer lock.
  }
  try {
    reader?.releaseLock();
  } catch {
    // A pending read may still own the reader lock.
  }
}
