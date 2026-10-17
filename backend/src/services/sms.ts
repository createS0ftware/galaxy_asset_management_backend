/** SMS delivery. Dev implementation logs and keeps an outbox; swap for a real provider. */
export interface Sms {
  send(to: string, text: string): Promise<void>;
}

export class DevSms implements Sms {
  readonly outbox: { to: string; text: string; at: Date }[] = [];
  constructor(private readonly log: (msg: string) => void = console.log) {}
  async send(to: string, text: string) {
    this.outbox.push({ to, text, at: new Date() });
    this.log(`[sms → ${to}] ${text}`);
  }
  last(to: string) {
    return [...this.outbox].reverse().find((m) => m.to === to);
  }
}
