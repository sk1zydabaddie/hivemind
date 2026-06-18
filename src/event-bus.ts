import type { IncomingMessage, ServerResponse } from "node:http";
import { readEvents, type HivemindEvent } from "./events.js";

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

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();
  private readonly publishedEventKeys = new Set<string>();

  async stream(repoRoot: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
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

  publishEvent(event: HivemindEvent): void {
    this.publishedEventKeys.add(eventKey(event));
    this.publish({ kind: "event", source: "live", event });
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

  private writeMessage(response: ServerResponse, message: EventBusMessage | EventBusErrorMessage): void {
    response.write(`data: ${JSON.stringify(message)}\n\n`);
  }
}

function eventKey(event: HivemindEvent): string {
  return JSON.stringify(event);
}
