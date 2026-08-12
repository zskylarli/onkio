/** Serialize calls to a source with a minimum interval between them. */
export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private minIntervalMs: number) {}

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    // Keep the chain alive even if a caller's work throws.
    this.chain = next.catch(() => {});
    return next;
  }
}
