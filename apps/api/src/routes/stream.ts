// GET /api/stream — Server-Sent Events. Event names and payloads: @monsoonwatch/shared/events.
import type { FastifyInstance } from "fastify";
import { subscribe } from "../events/bus";

const HEARTBEAT_MS = 15_000;

export async function streamRoutes(app: FastifyInstance) {
  app.get("/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const unsubscribe = subscribe((name, data) => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    });

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
