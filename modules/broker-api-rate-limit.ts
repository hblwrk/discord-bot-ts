type BrokerApiOperation<T> = () => Promise<T>;
type BrokerApiRateLimiterTimer = ReturnType<typeof setTimeout>;
type BrokerApiRateLimiterDependencies = {
  clearTimeout?: (timer: BrokerApiRateLimiterTimer) => void;
  maxQueueSize?: number;
  minIntervalMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => BrokerApiRateLimiterTimer;
};
type BrokerApiQueueItem<T> = {
  operation: BrokerApiOperation<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

const defaultMinIntervalMs = 10_000;
const defaultMaxQueueSize = 4;

export class BrokerApiRateLimitError extends Error {
  public constructor(message = "Option data requests are busy. Please retry shortly.") {
    super(message);
    this.name = "BrokerApiRateLimitError";
  }
}

export class BrokerApiRateLimiter {
  private active = false;
  private readonly clearTimeoutCallback: (timer: BrokerApiRateLimiterTimer) => void;
  private nextStartAt = 0;
  private readonly maxQueueSize: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly queue: BrokerApiQueueItem<unknown>[] = [];
  private readonly setTimeoutCallback: (callback: () => void, delayMs: number) => BrokerApiRateLimiterTimer;
  private timer: BrokerApiRateLimiterTimer | undefined;

  public constructor(dependencies: BrokerApiRateLimiterDependencies = {}) {
    this.clearTimeoutCallback = dependencies.clearTimeout ?? clearTimeout;
    this.maxQueueSize = dependencies.maxQueueSize ?? defaultMaxQueueSize;
    this.minIntervalMs = dependencies.minIntervalMs ?? defaultMinIntervalMs;
    this.now = dependencies.now ?? Date.now;
    this.setTimeoutCallback = dependencies.setTimeout ?? setTimeout;
  }

  public run<T>(operation: BrokerApiOperation<T>): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new BrokerApiRateLimitError());
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        operation,
        reject,
        resolve,
      } as BrokerApiQueueItem<unknown>);
      this.schedule();
    });
  }

  private schedule() {
    if (true === this.active || 0 === this.queue.length) {
      return;
    }

    const delayMs = Math.max(0, this.nextStartAt - this.now());
    if (0 < delayMs) {
      if (undefined === this.timer) {
        this.timer = this.setTimeoutCallback(() => {
          this.timer = undefined;
          this.schedule();
        }, delayMs);
      }

      return;
    }

    if (undefined !== this.timer) {
      this.clearTimeoutCallback(this.timer);
      this.timer = undefined;
    }

    this.startNext();
  }

  private startNext() {
    const queueItem = this.queue.shift();
    if (undefined === queueItem) {
      return;
    }

    this.active = true;
    this.nextStartAt = this.now() + this.minIntervalMs;

    Promise.resolve()
      .then(() => queueItem.operation())
      .then(queueItem.resolve, queueItem.reject)
      .finally(() => {
        this.active = false;
        this.schedule();
      });
  }
}

export const optionDataRateLimiter = new BrokerApiRateLimiter();
