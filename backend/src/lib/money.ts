/** Stellar assets have 7 decimal places. Amounts are handled as bigint stroops internally. */
const SCALE = 10_000_000n;

export function toStroops(amount: string | number): bigint {
  const s = typeof amount === 'number' ? amount.toFixed(7) : amount.trim();
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(s);
  if (!m) throw new Error(`Invalid amount: ${amount}`);
  return BigInt(m[1]!) * SCALE + BigInt((m[2] ?? '').padEnd(7, '0'));
}

export function fromStroops(stroops: bigint | number): string {
  const v = BigInt(stroops);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const frac = (abs % SCALE).toString().padStart(7, '0').replace(/0{1,5}$/, '');
  return `${sign}${abs / SCALE}.${frac.padEnd(2, '0')}`;
}
