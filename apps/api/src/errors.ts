// Every non-2xx response uses the shared ApiError shape (§1.6 decision 8).
// Throw `new HttpError(404, "not_found", "Region kelantan2 not found")` from any route.
import type { FastifyInstance } from "fastify";
import type { ApiError, ApiErrorCode } from "@monsoonwatch/shared";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function codeFor(status: number): ApiErrorCode {
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 503) return "unavailable";
  if (status >= 400 && status < 500) return "bad_request";
  return "internal";
}

export function registerErrorHandlers(app: FastifyInstance) {
  app.setNotFoundHandler((req, reply) => {
    const body: ApiError = { error: { code: "not_found", message: `No route ${req.method} ${req.url}` } };
    reply.status(404).send(body);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    const code = err instanceof HttpError ? err.code : codeFor(status);
    if (status >= 500) req.log.error(err);
    const body: ApiError = { error: { code, message: status >= 500 ? "Internal server error" : err.message } };
    reply.status(status).send(body);
  });
}
