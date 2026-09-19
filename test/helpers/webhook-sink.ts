import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A webhook receiver for tests: listens on 127.0.0.1 on an ephemeral port,
 * records every request, and answers with queued statuses (then 204).
 */
export class WebhookSink {
  readonly requests: ReceivedRequest[] = [];
  private readonly statuses: number[] = [];
  private server: Server | undefined;
  private port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}/webhook`;
  }

  /** Responses for the next requests, in order. */
  respondWith(...statuses: number[]): void {
    this.statuses.push(...statuses);
  }

  async listen(): Promise<this> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.requests.push({
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.statusCode = this.statuses.shift() ?? 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === undefined) {
        resolve();
        return;
      }
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}
