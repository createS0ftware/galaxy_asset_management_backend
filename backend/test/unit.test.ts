import { Keypair, Networks, rpc } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { buildCheckInPayload, offlineValidUntil, signCheckIn } from '../src/client/driver.js';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { distanceM } from '../src/lib/geo.js';
import { fromStroops, toStroops } from '../src/lib/money.js';
import { KeyedMutex } from '../src/lib/mutex.js';
import { canonical, chainStep, hashPayload, Kind, makePayload, newSalt } from '../src/lib/payload.js';
import { CheckInRejected, checkWaypoint, type CheckInContext } from '../src/services/signer.js';
import { inspectAuthEntry, xdr } from '@stellar/stellar-sdk';
import { Submitter } from '../src/stellar/submitter.js';
import { TrailContract } from '../src/stellar/trail.js';

describe('money', () => {
  it('round-trips 7-decimal amounts', () => {
    expect(toStroops('18.00')).toBe(180_000_000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops(25)).toBe(250_000_000n);
    expect(fromStroops(180_000_000n)).toBe('18.00');
    expect(fromStroops(1n)).toBe('0.0000001');
    expect(fromStroops(1_234_500_000n)).toBe('123.45');
    expect(() => toStroops('1.00000001')).toThrow();
    expect(() => toStroops('-1')).toThrow();
  });
});

describe('payload hashing (§4.2)', () => {
  it('is independent of key order (RFC 8785)', () => {
    const salt = newSalt();
    const a = { v: 1 as const, event: 'checkin', trip: 'TR-2041', wp: 4, lat: 6.6167, salt };
    const b = { salt, lat: 6.6167, wp: 4, trip: 'TR-2041', event: 'checkin', v: 1 as const };
    expect(canonical(a)).toBe(canonical(b));
    expect(hashPayload(a).equals(hashPayload(b))).toBe(true);
    expect(canonical(a)).toBe(`{"event":"checkin","lat":6.6167,"salt":"${salt}","trip":"TR-2041","v":1,"wp":4}`);
  });

  it('requires a 32-byte salt and changes with it', () => {
    expect(() => hashPayload({ v: 1, event: 'x', salt: 'short' })).toThrow(/salt/);
    const p1 = makePayload('checkin', { lat: 1 });
    const p2 = makePayload('checkin', { lat: 1 });
    expect(hashPayload(p1).equals(hashPayload(p2))).toBe(false);
  });

  it('chain step matches the contract test vectors', () => {
    const h = (n: number) => Buffer.alloc(32, n);
    const a = chainStep(Buffer.alloc(32), Kind.REGISTER, h(1));
    expect(a.toString('hex')).toBe('c7695f77adeead94104841d2030de0a21d9b31717b4895c2ed03f8dd78163579');
    const b = chainStep(a, Kind.DELIVERY, h(5), h(9));
    expect(b.toString('hex')).toBe('9ebcf3aa3252766db734ca41f4a6964c7d06e220ba4e300c8994c0112480f6d8');
  });
});

describe('crypto helpers', () => {
  it('hashes passwords and seals secrets', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
    const key = Buffer.alloc(32, 7).toString('base64');
    const sealed = encryptSecret('SXXXX', key);
    expect(sealed).not.toContain('SXXXX');
    expect(decryptSecret(sealed, key)).toBe('SXXXX');
    expect(() => decryptSecret(sealed, Buffer.alloc(32, 8).toString('base64'))).toThrow();
  });
});

describe('geo', () => {
  it('computes great-circle distance', () => {
    // Konongo → ~100 m north
    expect(distanceM({ lat: 6.6167, lon: -1.2167 }, { lat: 6.6176, lon: -1.2167 })).toBeCloseTo(100, -1);
  });
});

describe('BR-03 signer checks', () => {
  const base = (over: Partial<CheckInContext> = {}): CheckInContext => ({
    tripId: 'TR-2041',
    assetId: 'GX400-0041',
    tagId: '04:A3:7E:91',
    nextWp: 3,
    lastWp: 4,
    now: new Date('2026-10-16T11:52:00Z'),
    maxOfflineHours: 12,
    waypoint: {
      idx: 3,
      type: 'checkpoint',
      lat: 6.6167,
      lon: -1.2167,
      radiusM: 300,
      windowStart: new Date('2026-10-16T11:30:00Z'),
      windowEnd: new Date('2026-10-16T12:30:00Z'),
    },
    ...over,
  });
  const payload = (over: Record<string, unknown> = {}) =>
    ({
      ...buildCheckInPayload('TR-2041', { wp: 3, event: 'checkin', asset: 'GX400-0041' }, {
        tag: '04:A3:7E:91',
        lat: 6.6172,
        lon: -1.2165,
        accM: 8,
        at: new Date('2026-10-16T11:51:37Z'),
      }),
      ...over,
    }) as ReturnType<typeof buildCheckInPayload>;
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as CheckInRejected).code;
    }
    return 'OK';
  };

  it('accepts a valid check-in inside the geofence and window', () => {
    const r = checkWaypoint(payload(), base());
    expect(r.insideGeofence).toBe(true);
    expect(r.distanceM).toBeLessThan(100);
  });

  it.each([
    ['TRIP_MISMATCH', { trip: 'TR-9' }, {}],
    ['ASSET_MISMATCH', { asset: 'X' }, {}],
    ['WRONG_WAYPOINT', { wp: 2 }, {}],
    ['EVENT_MISMATCH', { event: 'arrival' }, {}],
    ['TAG_MISMATCH', { tag: '00:00' }, {}],
    ['OUTSIDE_GEOFENCE', { lat: 6.63 }, {}],
    ['LOW_ACCURACY', { acc_m: 500 }, {}],
    ['OUTSIDE_WINDOW', { t_device: '2026-10-16T11:00:00Z' }, { now: new Date('2026-10-16T11:01:00Z') }],
    ['FUTURE_TIME', { t_device: '2026-10-16T12:20:00Z' }, {}],
    ['STALE_CHECKIN', {}, { now: new Date('2026-10-17T11:52:00Z') }],
    ['BAD_PAYLOAD', { photos: ['nope'] }, {}],
  ] as const)('rejects %s', (expected, p, c) => {
    expect(code(() => checkWaypoint(payload(p), base(c)))).toBe(expected);
  });

  it('expects pickup at wp 0 and arrival at the last waypoint', () => {
    const wp4 = { ...base().waypoint!, idx: 4, type: 'delivery' as const };
    expect(code(() => checkWaypoint(payload({ wp: 4, event: 'checkin' }), base({ nextWp: 4, waypoint: wp4 })))).toBe('EVENT_MISMATCH');
    expect(code(() => checkWaypoint(payload({ wp: 4, event: 'arrival' }), base({ nextWp: 4, waypoint: wp4 })))).toBe('OK');
  });
});

describe('offline auth entries', () => {
  const sub = new Submitter(new rpc.Server('https://example.invalid'), Networks.TESTNET, Keypair.random());
  const contractId = 'CB7YOVHNTI3RWMY4FW5TFHFCQQZYKZU5PXPWLHD6OVUPPRVWW5JOB4D6';
  const trail = new TrailContract(sub, contractId);
  const tpl = {
    contractId,
    networkPassphrase: Networks.TESTNET,
    wp: 1,
    event: 'checkin' as const,
    asset: 'A1',
    latestLedger: 1000,
    ledgerSeconds: 5,
    maxOfflineHours: 12,
  };
  const driver = Keypair.random();

  it('phone signs without network; server accepts exactly that call', async () => {
    const p = buildCheckInPayload('T1', tpl, { tag: 't', lat: 1, lon: 1, accM: 5 });
    const until = offlineValidUntil(tpl, new Date(), new Date());
    expect(until).toBe(1000 + 12 * 720);
    const { authEntry } = await signCheckIn(driver, 'T1', tpl, p, until);
    const entry = xdr.SorobanAuthorizationEntry.fromXdr(authEntry, 'base64');
    expect(inspectAuthEntry(entry).address).toBe(driver.publicKey());

    const args = TrailContract.args.check_in('T1', 1, hashPayload(p));
    expect(trail.checkEntry(entry, driver.publicKey(), 'check_in', args, 1001)).toBeNull();
    // Different payload hash, waypoint, signer, or an expired entry are all refused.
    const other = TrailContract.args.check_in('T1', 1, Buffer.alloc(32, 1));
    expect(trail.checkEntry(entry, driver.publicKey(), 'check_in', other, 1001)).toMatch(/does not authorize/);
    expect(trail.checkEntry(entry, driver.publicKey(), 'check_in', TrailContract.args.check_in('T1', 2, hashPayload(p)), 1001)).toMatch(/does not authorize/);
    expect(trail.checkEntry(entry, Keypair.random().publicKey(), 'check_in', args, 1001)).toMatch(/signed for/);
    expect(trail.checkEntry(entry, driver.publicKey(), 'check_in', args, until)).toMatch(/expired/);
  });
});

describe('KeyedMutex', () => {
  it('serialises per key and survives failures', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = (tag: string, ms: number, fail = false) =>
      m.run('k', async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(tag);
        if (fail) throw new Error(tag);
      });
    const results = await Promise.allSettled([slow('a', 30), slow('b', 1, true), slow('c', 1)]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
