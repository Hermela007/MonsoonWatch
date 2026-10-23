import { env } from "./env";
import { buildServer } from "./server";

const app = buildServer();

app.listen({ port: env.port, host: "0.0.0.0" }).then(() => {
  app.log.info(`MonsoonWatch API on :${env.port} (mock=${env.mock})`);
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
