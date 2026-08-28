import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, type Writable } from "node:stream";
import { readEvents, type HivemindEvent } from "./events.js";
import { readTaskOutput, type TaskOutputRecord } from "./output-stream.js";
import { isAllowedDaemonOrigin } from "./daemon-auth.js";

export interface EventBusMessage {
  kind: "event";
  source: "history" | "live";
  seq?: number;
  event: HivemindEvent;
}

export interface EventBusErrorMessage {
  kind: "error";
  reason: string;
}

type Subscriber = (message: EventBusMessage) => void;
type OutputSubscriber = (message: TaskOutputBusMessage) => void;
const ssePadding = " ".repeat(1024);

export interface TaskOutputBusMessage {
  kind: "output";
  source: "history" | "live";
  seq?: number;
  record: TaskOutputRecord;
}

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();
  private readonly outputSubscribers = new Map<string, Set<OutputSubscriber>>();
  private readonly publishedEventKeys = new Set<string>();

  async stream(repoRoot: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      ...readOnlyCorsHeaders(request)
    });
    const body = new PassThrough();
    body.pipe(response);
    const history = await readEvents(repoRoot);
    if (!history.ok) {
      this.writeBody(body, `: hivemind event stream ${ssePadding}\r\n\r\n`);
      this.writeMessage(body, { kind: "error", reason: history.reason });
      body.end();
      return;
    }

    this.writeBody(
      body,
      [
        `: hivemind event stream ${ssePadding}`,
        ...history.value.map((event, index) => this.formatMessage({ kind: "event", source: "history", seq: index + 1, event }))
      ].join("\r\n\r\n") + "\r\n\r\n"
    );

    const subscriber: Subscriber = (message) => this.writeMessage(body, message);
    this.subscribers.add(subscriber);
    const closed = new Promise<void>((resolve) => {
      request.on("aborted", () => {
        this.subscribers.delete(subscriber);
        body.destroy();
        resolve();
      });
    });

    const catchUp = await readEvents(repoRoot);
    if (catchUp.ok) {
      for (const [index, event] of catchUp.value.slice(history.value.length).entries()) {
        const key = eventKey(event);
        if (this.publishedEventKeys.has(key)) {
          continue;
        }
        this.publishedEventKeys.add(key);
        this.writeMessage(body, { kind: "event", source: "live", seq: history.value.length + index + 1, event });
      }
    }
    await closed;
  }

  async streamTaskOutput(repoRoot: string, taskId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      ...readOnlyCorsHeaders(request)
    });
    const body = new PassThrough();
    body.pipe(response);
    const history = await readTaskOutput(repoRoot, taskId);
    if (!history.ok) {
      this.writeBody(body, `: hivemind task output stream ${ssePadding}\r\n\r\n`);
      this.writeMessage(body, { kind: "error", reason: history.reason });
      body.end();
      return;
    }

    this.writeBody(
      body,
      [
        `: hivemind task output stream ${ssePadding}`,
        ...history.value.map((record, index) => this.formatMessage({ kind: "output", source: "history", seq: index + 1, record }))
      ].join("\r\n\r\n") + "\r\n\r\n"
    );

    const subscriber: OutputSubscriber = (message) => this.writeMessage(body, message);
    let subscribers = this.outputSubscribers.get(taskId);
    if (subscribers === undefined) {
      subscribers = new Set<OutputSubscriber>();
      this.outputSubscribers.set(taskId, subscribers);
    }
    subscribers.add(subscriber);
    const closed = new Promise<void>((resolve) => {
      request.on("aborted", () => {
        subscribers?.delete(subscriber);
        if (subscribers?.size === 0) {
          this.outputSubscribers.delete(taskId);
        }
        body.destroy();
        resolve();
      });
    });

    const catchUp = await readTaskOutput(repoRoot, taskId);
    if (catchUp.ok) {
      for (const [index, record] of catchUp.value.slice(history.value.length).entries()) {
        this.writeMessage(body, { kind: "output", source: "live", seq: history.value.length + index + 1, record });
      }
    }
    await closed;
  }

  publishEvent(event: HivemindEvent): void {
    if (this.subscribers.size === 0) {
      return;
    }
    this.publishedEventKeys.add(eventKey(event));
    this.publish({ kind: "event", source: "live", event });
  }

  publishTaskOutput(record: TaskOutputRecord): void {
    const subscribers = this.outputSubscribers.get(record.task_id);
    if (subscribers === undefined) {
      return;
    }
    const message: TaskOutputBusMessage = { kind: "output", source: "live", record };
    for (const subscriber of subscribers) {
      subscriber(message);
    }
  }

  async publishNewDurableEvents(repoRoot: string, previousCount: number): Promise<void> {
    if (this.subscribers.size === 0) {
      return;
    }
    const events = await readEvents(repoRoot);
    if (!events.ok) {
      return;
    }

    for (const event of events.value.slice(previousCount)) {
      const key = eventKey(event);
      if (this.publishedEventKeys.has(key)) {
        continue;
      }
      this.publishedEventKeys.add(key);
      this.publish({ kind: "event", source: "live", event });
    }
  }

  private publish(message: EventBusMessage): void {
    for (const subscriber of this.subscribers) {
      subscriber(message);
    }
  }

  private writeMessage(body: Writable, message: EventBusMessage | TaskOutputBusMessage | EventBusErrorMessage): void {
    this.writeBody(body, `${this.formatMessage(message)}\r\n\r\n`);
  }

  private formatMessage(message: EventBusMessage | TaskOutputBusMessage | EventBusErrorMessage): string {
    return `data: ${JSON.stringify(message)}\r\n: ${ssePadding}`;
  }

  private writeBody(target: Writable, body: string): void {
    if (!target.destroyed && !target.writableEnded) {
      target.write(body);
    }
  }
}

function eventKey(event: HivemindEvent): string {
  return JSON.stringify(event);
}

function readOnlyCorsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return {};
  }
  if (!isAllowedDaemonOrigin(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    vary: "origin"
  };
}
