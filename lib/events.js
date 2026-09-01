/**
 * Telling every open page what just happened.
 *
 * Both devices talk to one server, so the server is the only thing that knows
 * a switch was made. Server-sent events push that out as it happens rather
 * than leaving each page to poll and lag behind.
 *
 * Events only ever travel outwards. Writes still go through the ordinary POST
 * routes, which keeps a single path for changing anything.
 */

/** Long enough to be quiet, short enough that no proxy calls the link dead. */
const HEARTBEAT_MS = 25_000;

export function createBroadcaster({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Set();

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      // A comment line: ignored by EventSource, but it keeps the pipe warm.
      client.write(': still here\n\n');
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    /** Attach a response as a listener. It stays open until the client goes. */
    add(res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Ask any proxy in the way not to sit on the stream.
        'x-accel-buffering': 'no',
      });
      // The stream is meant to be idle for long stretches; do not time it out.
      res.socket?.setTimeout(0);
      res.socket?.setNoDelay(true);
      res.write(': connected\n\n');

      clients.add(res);
      const forget = () => clients.delete(res);
      res.on('close', forget);
      res.on('error', forget);
    },

    /** Send one event to everyone listening. */
    broadcast(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) {
        try {
          client.write(payload);
        } catch {
          clients.delete(client);
        }
      }
    },

    count() {
      return clients.size;
    },

    /** Let every listener go, so the process can shut down. */
    closeAll() {
      clearInterval(heartbeat);
      for (const client of clients) {
        try {
          client.end();
        } catch {
          /* already gone */
        }
      }
      clients.clear();
    },
  };
}
