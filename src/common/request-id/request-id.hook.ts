import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const requestIds = new WeakMap<object, string>();

/**
 * Assigns a fresh UUID to every request and returns it in X-Request-Id.
 * An incoming X-Request-Id header is never trusted or echoed.
 */
export function registerRequestIdHook(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    const id = randomUUID();
    requestIds.set(request.raw, id);
    void reply.header(REQUEST_ID_HEADER, id);
    done();
  });
}

export function getRequestId(request: FastifyRequest): string {
  return requestIds.get(request.raw) ?? randomUUID();
}
