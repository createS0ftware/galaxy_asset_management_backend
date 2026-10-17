import { randomUUID } from 'node:crypto';
import { fromStroops } from '../lib/money.js';

/**
 * Cash-out anchor (decision D3/D6 still open). Shaped after SEP-38 firm quotes + SEP-6
 * withdraw: the anchor returns a quote with `expiresAt`, then the account and memo to pay.
 */
export interface Quote {
  id: string;
  sellAmount: bigint;
  buyAmount: string;
  buyAsset: string;
  fee: bigint;
  rate: string;
  expiresAt: Date;
  arrival: string;
}

export interface Anchor {
  quote(sellAmount: bigint, destination: string): Promise<Quote>;
  withdrawInstructions(quote: Quote): Promise<{ account: string; memo: string }>;
}

/** Fixed-rate mock anchor paying "MTN MoMo" in GHS. */
export class MockAnchor implements Anchor {
  constructor(
    private readonly account: string,
    private readonly rate = 15.2,
    private readonly feeBps = 100,
  ) {}

  async quote(sellAmount: bigint): Promise<Quote> {
    const fee = (sellAmount * BigInt(this.feeBps)) / 10_000n;
    const net = Number(fromStroops(sellAmount - fee));
    return {
      id: randomUUID(),
      sellAmount,
      buyAmount: (net * this.rate).toFixed(2),
      buyAsset: 'iso4217:GHS',
      fee,
      rate: this.rate.toFixed(4),
      expiresAt: new Date(Date.now() + 5 * 60_000),
      arrival: 'within 5 minutes',
    };
  }

  async withdrawInstructions(quote: Quote) {
    return { account: this.account, memo: quote.id.replace(/-/g, '').slice(0, 28) };
  }
}
