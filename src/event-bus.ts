import type { IncomingMessage, ServerResponse } from "node:http";
import { readEvents, type HivemindEvent } from "./events.js";
import { readTaskOutput, type TaskOutputRecord } from "./output-stream.js";

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
      connection: "keep-alive",
      ...readOnlyCorsHeaders(request)
    });
    response.write(": hivemind event stream\n\n");

    const history = await readEvents(repoRoot);
    if (!history.ok) {
      this.writeMessage(response, { kind: "error", reason: history.reason });
      response.end();
      return;
    }

    for (const [index, event] of history.value.entries()) {
      this.writeMessage(response, { kind: "event", source: "history", seq: index + 1, event });
    }

    const subscriber: Subscriber = (message) => this.writeMessage(response, message);
    this.subscribers.add(subscriber);
    request.on("close", () => {
      this.subscribers.delete(subscriber);
    });
  }

  async streamTaskOutput(repoRoot: string, taskId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...readOnlyCorsHeaders(request)
    });
    response.write(": hivemind task output stream\n\n");

    const history = await readTaskOutput(repoRoot, taskId);
    if (!history.ok) {
      this.writeMessage(response, { kind: "error", reason: history.reason });
      response.end();
      return;
    }

    for (const [index, record] of history.value.entries()) {
      this.writeMessage(response, { kind: "output", source: "history", seq: index + 1, record });
    }

    const subscriber: OutputSubscriber = (message) => this.writeMessage(response, message);
    let subscribers = this.outputSubscribers.get(taskId);
    if (subscribers === undefined) {
      subscribers = new Set<OutputSubscriber>();
      this.outputSubscribers.set(taskId, subscribers);
    }
    subscribers.add(subscriber);
    request.on("close", () => {
      subscribers?.delete(subscriber);
      if (subscribers?.size === 0) {
        this.outputSubscribers.delete(taskId);
      }
    });
  }

  publishEvent(event: HivemindEvent): void {
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

  private writeMessage(response: ServerResponse, message: EventBusMessage | TaskOutputBusMessage | EventBusErrorMessage): void {
    response.write(`data: ${JSON.stringify(message)}\n\n`);
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
  if (!isAllowedReadOnlyOrigin(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    vary: "origin"
  };
}

function isAllowedReadOnlyOrigin(origin: string): boolean {
  return (
    origin === "http://localhost:1420" ||
    origin === "http://127.0.0.1:1420" ||
    origin === "http://tauri.localhost" ||
    origin === "https://tauri.localhost" ||
    origin === "tauri://localhost"
  );
}
