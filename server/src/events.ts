export type LiveEvent =
  | { type: "graph:refresh" }
  | {
      type: "bump:accepted";
      connection: {
        id: string;
        sourceId: string;
        targetId: string;
        occurredAt: string;
      };
    };

type Subscriber = (event: LiveEvent) => void;
const subscribers = new Set<Subscriber>();

export function publish(event: LiveEvent) {
  for (const subscriber of subscribers) subscriber(event);
}

export function subscribe(subscriber: Subscriber) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}
