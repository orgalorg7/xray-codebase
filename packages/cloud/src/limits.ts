export type RateLimit = {
  /** Requests allowed in a burst. */
  capacity: number;
  /** How long a full bucket takes to refill, in milliseconds. */
  windowMs: number;
};

type Bucket = { tokens: number; at: number };

/** A token bucket per client: `capacity` requests at once, refilled evenly over `windowMs`. */
export class RateLimiter {
  readonly #limit: RateLimit;
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  #sweptAt = 0;

  constructor(limit: RateLimit, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** Takes one request from the client's bucket: 0 if allowed, else seconds until it would be. */
  take(client: string): number {
    const { capacity, windowMs } = this.#limit;
    const now = this.#now();
    const perMs = capacity / windowMs;
    const bucket = this.#buckets.get(client) ?? { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * perMs);
    bucket.at = now;
    this.#buckets.set(client, bucket);
    this.#sweep(now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / perMs / 1000);
  }

  /** Forgets clients whose buckets have refilled, so memory stays bounded. */
  #sweep(now: number): void {
    if (now - this.#sweptAt < this.#limit.windowMs) return;
    this.#sweptAt = now;
    for (const [client, bucket] of this.#buckets) {
      if (now - bucket.at >= this.#limit.windowMs) this.#buckets.delete(client);
    }
  }
}
