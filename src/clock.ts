export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  #current: Date;

  constructor(start: Date | string = "2026-01-01T00:00:00.000Z") {
    this.#current = new Date(start);
  }

  now(): Date {
    return new Date(this.#current);
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }

  set(at: Date | string): void {
    this.#current = new Date(at);
  }
}
