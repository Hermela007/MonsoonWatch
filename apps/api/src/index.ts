import { closeDb } from "./db/client";
import { env } from "./env";
import { forceCloseChangeStream, startChangeStreams, stopChangeStreams } from "./events/change-streams";
import { buildServer } from "./server";
import { COLLECTIONS } from "@monsoonwatch/shared";

const app = buildServer();

app.listen({ port: env.port, host: "0.0.0.0" }).then(() => {
  app.log.info(`MonsoonWatch API on :${env.port} (mock=${env.mock})`);
  // Real mode: MongoDB change streams feed /api/stream. Mock mode opens none.
  if (!env.mock) startChangeStreams(app.log).catch((err) => app.log.warn({ err }, "change streams failed to start"));
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Resume test: `kill -USR2 <pid>` closes the reading_events cursor; it should reopen with its resume token.
process.on("SIGUSR2", () => {
  app.log.warn("SIGUSR2: force-closing the reading_events change stream (resume test)");
  void forceCloseChangeStream(COLLECTIONS.readingEvents);
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal}: closing change streams, server and MongoDB`);
    const force = setTimeout(() => process.exit(1), 5_000).unref();
    try {
      await stopChangeStreams();
      await app.close();
      await closeDb();
    } catch (err) {
      app.log.error(err);
    }
    clearTimeout(force);
    process.exit(0);
  });
}
