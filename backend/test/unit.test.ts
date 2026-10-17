import { Keypair, Networks, rpc, scValToNative, StrKey } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCheckInPayload, buildReleasePayload, offlineValidUntil, signCheckIn, signClaimFinalPay } from '../src/client/driver.js';
import { loadConfig } from '../src/config.js';
import { createContext, type Ctx } from '../src/context.js';
import { schema } from '../src/db/client.js';
import { buildApp } from '../src/http/app.js';
import { issueToken } from '../src/http/auth.js';
import { finalPayBody } from '../src/http/routes/driver.js';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import type { HttpError } from '../src/lib/errors.js';
import { distanceM } from '../src/lib/geo.js';
import { fromStroops, toStroops } from '../src/lib/money.js';
import { KeyedMutex } from '../src/lib/mutex.js';
import { canonical, chainStep, hashPayload, Kind, kindName, makePayload, newSalt, type ReleasePayload } from '../src/lib/payload.js';
import { checkReleasePayload, finalPayAmount, isClaimable } from '../src/services/release.js';
import { CheckInRejected, checkWaypoint, type CheckInContext } from '../src/services/signer.js';
import { DevSms } from '../src/services/sms.js';
import { deliveryDeadline, getTripRow, type WaypointInput } from '../src/services/trips.js';
import { inspectAuthEntry, xdr } from '@stellar/stellar-sdk';
import { CONTRACT_ERRORS, type ChainTrip } from '../src/stellar/scval.js';
import { Submitter, type AuthPlan } from '../src/stellar/submitter.js';
import { contractInvocation, TrailContract } from '../src/stellar/trail.js';

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

/**
 * Golden vectors shared with the Android driver app: same inputs must give byte-identical
 * canonical JSON, SHA-256 and the root invocation the phone signs (base64 XDR).
 */
describe('golden cross-language vectors', () => {
  const salt = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const P1 = {
    v: 1 as const,
    event: 'checkin',
    trip: 'TR-2041',
    wp: 1,
    asset: 'GEN-400KVA-0192',
    tag: '04:A3:7E:91',
    lat: 5.603716,
    lon: -0.186964,
    acc_m: 12,
    t_device: '2026-10-16T11:51:37Z',
    photos: ['sha256:' + 'ab'.repeat(32)],
    salt,
  };
  const R1 = { v: 1 as const, event: 'release', trip: 'TR-2041', asset: 'GEN-400KVA-0192', t_device: '2026-10-18T09:00:00Z', salt };
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  const invocation = (method: string, args: xdr.ScVal[]) => contractInvocation(contractId, method, args).toXDR('base64');

  it('P1 waypoint payload: canonical JSON and SHA-256', () => {
    expect(canonical(P1)).toBe(
      '{"acc_m":12,"asset":"GEN-400KVA-0192","event":"checkin","lat":5.603716,"lon":-0.186964,' +
        '"photos":["sha256:abababababababababababababababababababababababababababababababab"],' +
        '"salt":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","t_device":"2026-10-16T11:51:37Z",' +
        '"tag":"04:A3:7E:91","trip":"TR-2041","v":1,"wp":1}',
    );
    expect(hashPayload(P1).toString('hex')).toBe('b7fb28679e2435b8f786069a4b7b336acefbfe68c9149ee2046a0869f70467f5');
  });

  it('R1 release payload: canonical JSON and SHA-256', () => {
    expect(canonical(R1)).toBe(
      '{"asset":"GEN-400KVA-0192","event":"release","salt":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",' +
        '"t_device":"2026-10-18T09:00:00Z","trip":"TR-2041","v":1}',
    );
    expect(hashPayload(R1).toString('hex')).toBe('de6bf3f90f5bea731f42dda7426f86090a7f75d9b6b336c2eec15d0502d49b39');
  });

  it('root invocations the phone signs', () => {
    expect(contractId).toBe('CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR');
    expect(invocation('check_in', TrailContract.args.check_in('TR-2041', 1, hashPayload(P1)))).toBe(
      'AAAAAAAAAAEHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwAAAAhjaGVja19pbgAAAAMAAAAOAAAAB1RSLTIwNDEAAAAAAwAAAAEAAAANAAAAILf7KGeeJDW494YGmkt7M2rO+/5oyRSe4gRqCGn3BGf1AAAAAA==',
    );
    expect(invocation('claim_advance', TrailContract.args.claim_advance('TR-2041'))).toBe(
      'AAAAAAAAAAEHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwAAAA1jbGFpbV9hZHZhbmNlAAAAAAAAAQAAAA4AAAAHVFItMjA0MQAAAAAA',
    );
    expect(invocation('claim_final_pay', TrailContract.args.claim_final_pay('TR-2041', hashPayload(R1)))).toBe(
      'AAAAAAAAAAEHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwAAAA9jbGFpbV9maW5hbF9wYXkAAAAAAgAAAA4AAAAHVFItMjA0MQAAAAANAAAAIN5r8/kPW+pzH0Ldp0JvhgkKf3XZtrM2wu7BXQUC1Js5AAAAAA==',
    );
  });
});

describe('final pay after the delivery deadline (§4.6)', () => {
  const now = new Date('2026-10-18T09:01:00Z');
  const trip = { tripId: 'TR-2041', assetId: 'GEN-400KVA-0192', now };
  const release = (over: Record<string, unknown> = {}) =>
    ({ ...buildReleasePayload('TR-2041', 'GEN-400KVA-0192', new Date('2026-10-18T09:00:00.123Z')), ...over }) as ReleasePayload;
  const error = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return `${(e as HttpError).status} ${(e as HttpError).code}`;
    }
    return 'OK';
  };

  it('phone builds a salted release payload with whole-second device time', () => {
    const p = release();
    expect(p).toMatchObject({ v: 1, event: 'release', trip: 'TR-2041', asset: 'GEN-400KVA-0192', t_device: '2026-10-18T09:00:00Z' });
    expect(Object.keys(p).sort()).toEqual(['asset', 'event', 'salt', 't_device', 'trip', 'v']);
    expect(Buffer.from(p.salt, 'base64')).toHaveLength(32);
    expect(hashPayload(p).equals(hashPayload(release()))).toBe(false);
  });

  it.each([
    ['OK', {}],
    ['422 TRIP_MISMATCH', { trip: 'TR-9' }],
    ['422 ASSET_MISMATCH', { asset: 'GEN-1' }],
    ['422 BAD_PAYLOAD', { t_device: 'yesterday' }],
    ['422 BAD_PAYLOAD', { t_device: '2026-10-18' }],
    ['422 BAD_PAYLOAD', { t_device: 1792300000 }],
    ['OK', { t_device: '2026-10-18T09:06:00Z' }],
    ['422 FUTURE_TIME', { t_device: '2026-10-18T09:06:01Z' }],
  ] as const)('payload check → %s (%j)', (expected, over) => {
    expect(error(() => checkReleasePayload(release(over), trip))).toBe(expected);
  });

  it('request body: release payload (extra fields kept for the hash) + auth entry', () => {
    const body = { payload: release(), authEntry: 'AAAA' };
    expect(finalPayBody.safeParse(body).success).toBe(true);
    expect(finalPayBody.parse({ ...body, payload: { ...body.payload, note: 'gate closed' } }).payload.note).toBe('gate closed');
    expect(finalPayBody.safeParse({ ...body, payload: { ...body.payload, event: 'arrival' } }).success).toBe(false);
    expect(finalPayBody.safeParse({ ...body, payload: { ...body.payload, v: 2 } }).success).toBe(false);
    const { salt: _salt, ...unsalted } = body.payload;
    expect(finalPayBody.safeParse({ ...body, payload: unsalted }).success).toBe(false);
    expect(finalPayBody.safeParse({ ...body, authEntry: '' }).success).toBe(false);
  });

  it('contract interface: claim_final_pay(trip, claim_hash), create_trip(..., deadline: u64), RELEASE = 15', () => {
    const args = TrailContract.args.claim_final_pay('TR-2041', Buffer.alloc(32, 5));
    expect(args.map((a) => a.type)).toEqual(['scvString', 'scvBytes']);
    expect(() => TrailContract.args.claim_final_pay('TR-2041', Buffer.alloc(31))).toThrow(/32 bytes/);
    const create = TrailContract.args.create_trip({
      id: 'TR-2041',
      asset: 'GEN-400KVA-0192',
      driver: Keypair.random().publicKey(),
      receiver: Keypair.random().publicKey(),
      funder: Keypair.random().publicKey(),
      legs: [0n, 250_000_000n],
      advanceLimit: 0n,
      planHash: Buffer.alloc(32, 3),
      deadline: 1_792_314_000,
    });
    expect(create).toHaveLength(9);
    expect(create.at(-1)!.type).toBe('scvU64');
    expect(scValToNative(create.at(-1)!)).toBe(1_792_314_000n);
    expect([Kind.RELEASE, kindName(15)]).toEqual([15, 'RELEASE']);
    expect([CONTRACT_ERRORS[21], CONTRACT_ERRORS[22]]).toEqual(['DeadlineNotPassed', 'DeadlinePassed']);
  });

  it('pays the final leg minus claimed advances, only once the deadline has passed', () => {
    expect(finalPayAmount({ advanced: 200_000_000 }, 250_000_000)).toEqual({ payout: 50_000_000n, deduction: 200_000_000n });
    const deadline = new Date('2026-10-18T09:00:00Z');
    expect(isClaimable({ status: 'awaiting_signature', deliveryDeadline: deadline }, deadline)).toBe(false);
    expect(isClaimable({ status: 'awaiting_signature', deliveryDeadline: deadline }, new Date(deadline.getTime() + 1))).toBe(true);
    expect(isClaimable({ status: 'disputed', deliveryDeadline: deadline }, now)).toBe(false);
    expect(isClaimable({ status: 'delivered', deliveryDeadline: deadline }, now)).toBe(false);
    expect(isClaimable({ status: 'awaiting_signature', deliveryDeadline: null }, now)).toBe(false);
  });

  it('phone signs claim_final_pay offline; server accepts exactly that call', async () => {
    const sub = new Submitter(new rpc.Server('https://example.invalid'), Networks.TESTNET, Keypair.random());
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
    const trail = new TrailContract(sub, contractId);
    const driver = Keypair.random();
    const p = buildReleasePayload('T1', 'A1');
    const { authEntry } = await signClaimFinalPay(driver, 'T1', { contractId, networkPassphrase: Networks.TESTNET }, p, 2000);
    const entry = xdr.SorobanAuthorizationEntry.fromXdr(authEntry, 'base64');
    expect(inspectAuthEntry(entry).address).toBe(driver.publicKey());
    const args = TrailContract.args.claim_final_pay('T1', hashPayload(p));
    expect(trail.checkEntry(entry, driver.publicKey(), 'claim_final_pay', args, 1000)).toBeNull();
    // A different payload hash, trip, method, signer, or an expired entry are all refused.
    expect(trail.checkEntry(entry, driver.publicKey(), 'claim_final_pay', TrailContract.args.claim_final_pay('T1', Buffer.alloc(32, 1)), 1000)).toMatch(/does not authorize/);
    expect(trail.checkEntry(entry, driver.publicKey(), 'claim_final_pay', TrailContract.args.claim_final_pay('T2', hashPayload(p)), 1000)).toMatch(/does not authorize/);
    expect(trail.checkEntry(entry, driver.publicKey(), 'confirm_delivery', TrailContract.args.confirm_delivery('T1', hashPayload(p)), 1000)).toMatch(/does not authorize/);
    expect(trail.checkEntry(entry, Keypair.random().publicKey(), 'claim_final_pay', args, 1000)).toMatch(/signed for/);
    expect(trail.checkEntry(entry, driver.publicKey(), 'claim_final_pay', args, 2000)).toMatch(/expired/);
  });

  it('delivery deadline: defaults to windowEnd + DELIVERY_SIGN_HOURS, whole seconds, later than the window and in the future', () => {
    const wps: WaypointInput[] = [
      { name: 'Tema Port', type: 'pickup', lat: 5.63, lon: 0.01, windowStart: '2026-10-17T08:00:00Z', windowEnd: '2026-10-17T09:00:00Z', legPay: 0n },
      { name: 'Kumasi', type: 'delivery', lat: 6.69, lon: -1.62, windowStart: '2026-10-17T12:00:00Z', windowEnd: '2026-10-17T14:00:00Z', legPay: 250_000_000n },
    ];
    const at = new Date('2026-10-17T07:00:00Z');
    expect(deliveryDeadline(wps, undefined, 24, at).toISOString()).toBe('2026-10-18T14:00:00.000Z');
    expect(deliveryDeadline(wps, undefined, 1.5, at).toISOString()).toBe('2026-10-17T15:30:00.000Z');
    expect(deliveryDeadline(wps, '2026-10-17T20:30:00.900Z', 24, at).toISOString()).toBe('2026-10-17T20:30:00.000Z');
    expect(error(() => deliveryDeadline(wps, '2026-10-17T14:00:00Z', 24, at))).toBe('400 BAD_DEADLINE');
    expect(error(() => deliveryDeadline(wps, '2026-10-17T14:00:00.500Z', 24, at))).toBe('400 BAD_DEADLINE');
    expect(error(() => deliveryDeadline(wps, undefined, 24, new Date('2026-10-18T14:00:00Z')))).toBe('400 BAD_DEADLINE');
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

/**
 * The HTTP contract the driver app builds against, over an in-process database. The ledger is
 * stubbed: `trail.call` records what would be submitted, `trail.trip` returns the post-call state.
 */
describe('delivery deadline and final pay over HTTP (PGlite, stubbed ledger)', () => {
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  const anchorAccount = Keypair.random().publicKey();
  const driverKey = Keypair.random();
  const receiverPhone = '+233200000001';
  const assetId = 'GEN-400KVA-0192';
  const tripId = 'TR-2041';
  const txHash = 'ab'.repeat(32);
  const ledgerTime = new Date('2026-10-18T09:00:05Z');
  const windowEnd = new Date(Date.now() + 4 * 3_600_000);
  const calls: { method: string; args: xdr.ScVal[]; plan: AuthPlan }[] = [];
  let chain: ChainTrip;
  let ctx: Ctx;
  let app: FastifyInstance;
  let staff: string;
  let driver: string;
  let otherDriver: string;
  let driverId: number;

  const call = async (method: 'GET' | 'POST', url: string, body?: unknown, token?: string) => {
    const res = await app.inject({ method, url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, body: res.json() };
  };
  /** Trip state the stubbed ledger reports after a call; only the fields the backend reads. */
  const onChain = (status: ChainTrip['status'], last: { kind: number; seq: number; amount?: bigint }, advanced = 0n) =>
    ({ status, nextWp: 2, released: 0n, advanced, records: [{ ...last, amount: last.amount ?? 0n }] }) as unknown as ChainTrip;
  const release = (over: Partial<ReleasePayload> = {}) =>
    signClaimFinalPay(driverKey, tripId, { contractId, networkPassphrase: Networks.TESTNET }, { ...buildReleasePayload(tripId, assetId), ...over }, 2000);
  const finalPay = (body: unknown, token = driver) => call('POST', `/v1/driver/trips/${tripId}/final-pay`, body, token);
  const setTrip = (set: Partial<typeof schema.trips.$inferInsert>) => ctx.db.update(schema.trips).set(set).where(eq(schema.trips.id, tripId));

  beforeAll(async () => {
    const env = {
      DATABASE_URL: 'pglite://memory',
      STELLAR_RPC_URL: 'https://example.invalid',
      JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef',
      CONTRACT_ID: contractId,
      PAY_ASSET: `USDC:${Keypair.random().publicKey()}`,
      FEE_SECRET: Keypair.random().secret(),
      ADMIN_SECRET: Keypair.random().secret(),
      PLATFORM_SECRET: Keypair.random().secret(),
      TREASURY_SECRET: Keypair.random().secret(),
      RECEIVER_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      MOCK_ANCHOR_ACCOUNT: anchorAccount,
    };
    ctx = await createContext(loadConfig(env), { log: { info: () => {}, warn: () => {}, error: () => {} }, sms: new DevSms(() => {}) });
    ctx.sub.latestLedger = async () => 1000;
    ctx.server.getTrustline = (async () => ({ balance: 800_000_000n })) as never;
    ctx.trail.call = async (method, args, plan) => {
      calls.push({ method, args, plan });
      return { txHash, ledger: 1001, ledgerTime };
    };
    ctx.trail.trip = async () => chain;
    ctx.signer.coSign = () => {
      throw new Error('the platform must not co-sign');
    };
    app = await buildApp(ctx);

    const [user] = await ctx.db.insert(schema.staffUsers).values({ email: 'ops@example.com', name: 'Ama Ops', passwordHash: 'x' }).returning();
    await ctx.db.insert(schema.assets).values({ id: assetId, name: 'Generator 400 kVA', type: 'generator', serial: 'GX400-0192', tagId: '04:A3:7E:91', status: 'active', regHash: '00'.repeat(32) });
    const [d] = await ctx.db
      .insert(schema.drivers)
      .values({ phone: '+233240000001', name: 'Kwame Asante', publicKey: driverKey.publicKey(), walletStatus: 'ready', momoNumber: '+233241234567' })
      .returning();
    const [other] = await ctx.db.insert(schema.drivers).values({ phone: '+233240000002', name: 'Yaw Mensah' }).returning();
    await ctx.db.insert(schema.receivers).values({ phone: receiverPhone, name: 'Warehouse B', publicKey: Keypair.random().publicKey(), secretEnc: 'unused' });
    driverId = d!.id;
    staff = await issueToken(ctx, { role: 'staff', id: user!.id });
    driver = await issueToken(ctx, { role: 'driver', id: driverId });
    otherDriver = await issueToken(ctx, { role: 'driver', id: other!.id });
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.close();
  });

  it('POST /trips: deadline defaults to the delivery windowEnd + DELIVERY_SIGN_HOURS and goes to create_trip', async () => {
    const trip = (deliveryDeadline?: string) => ({
      id: tripId,
      assetId,
      driverId,
      receiver: { phone: receiverPhone },
      advanceLimit: '40.00',
      waypoints: [
        { name: 'Tema Port', type: 'pickup', lat: 5.6333, lon: 0.0167, windowStart: new Date(Date.now() - 3_600_000).toISOString(), windowEnd: new Date(Date.now() + 3_600_000).toISOString(), legPay: '0' },
        { name: 'Kumasi', type: 'delivery', lat: 6.6885, lon: -1.6244, windowStart: new Date().toISOString(), windowEnd: windowEnd.toISOString(), legPay: '25.00' },
      ],
      deliveryDeadline,
    });
    const early = await call('POST', '/v1/trips', trip(new Date(windowEnd.getTime() - 60_000).toISOString()), staff);
    expect([early.status, early.body.error]).toEqual([400, 'BAD_DEADLINE']);
    expect(calls).toHaveLength(0);

    chain = onChain('Funded', { kind: Kind.DISPATCH, seq: 3 });
    const r = await call('POST', '/v1/trips', trip(), staff);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const deadline = new Date(Math.floor((windowEnd.getTime() + 24 * 3_600_000) / 1000) * 1000);
    expect(r.body.trip.deliveryDeadline).toBe(deadline.toISOString());
    expect((await getTripRow(ctx, tripId)).deliveryDeadline).toEqual(deadline);
    const create = calls.at(-1)!;
    expect(create.method).toBe('create_trip');
    expect(create.args).toHaveLength(9);
    expect(scValToNative(create.args.at(-1)!)).toBe(BigInt(deadline.getTime() / 1000));
  });

  it('GET /driver/trips/:id shows the finalPay block only while awaiting the signature', async () => {
    const before = await call('GET', `/v1/driver/trips/${tripId}`, undefined, driver);
    expect(before.body.finalPay).toBeNull();
    expect(before.body.checkIn).not.toBeNull();

    // Arrived with a 20.00 advance claimed earlier.
    await setTrip({ status: 'awaiting_signature', nextWp: 2, advanced: 200_000_000 });
    const t = await call('GET', `/v1/driver/trips/${tripId}`, undefined, driver);
    expect(t.body.checkIn).toBeNull();
    expect(t.body.finalPay).toEqual({
      contractId,
      networkPassphrase: Networks.TESTNET,
      latestLedger: 1000,
      ledgerSeconds: 5,
      deadline: t.body.deliveryDeadline,
      claimable: false,
      amount: '5.00',
    });
  });

  it('POST /driver/trips/:id/final-pay is refused before the deadline', async () => {
    const r = await finalPay(await release());
    expect([r.status, r.body.error]).toEqual([422, 'DEADLINE_NOT_PASSED']);
    expect(r.body.details.deadline).toBe((await getTripRow(ctx, tripId)).deliveryDeadline!.toISOString());
    expect(calls.map((c) => c.method)).toEqual(['create_trip']);
  });

  it('after the deadline: a late dispute is refused and the claim becomes available', async () => {
    await setTrip({ deliveryDeadline: new Date(Date.now() - 60_000) });
    const { trackingToken } = await getTripRow(ctx, tripId);
    const late = await call('POST', `/v1/track/${trackingToken}/report`, { code: '123456', notes: 'dented', photos: [`sha256:${'cd'.repeat(32)}`] });
    expect([late.status, late.body.error]).toEqual([422, 'DEADLINE_PASSED']);
    expect((await call('GET', `/v1/driver/trips/${tripId}`, undefined, driver)).body.finalPay.claimable).toBe(true);
  });

  it('final-pay validates the caller, body, payload and auth entry', async () => {
    const ok = await release();
    expect((await finalPay(ok, otherDriver)).status).toBe(403);
    const arrival = await finalPay({ ...ok, payload: { ...ok.payload, event: 'arrival' } });
    expect([arrival.status, arrival.body.error]).toEqual([400, 'VALIDATION']);
    expect((await finalPay(await release({ trip: 'TR-9' }))).body.error).toBe('TRIP_MISMATCH');
    expect((await finalPay(await release({ asset: 'GEN-1' }))).body.error).toBe('ASSET_MISMATCH');
    expect((await finalPay(await release({ t_device: 'later' }))).body.error).toBe('BAD_PAYLOAD');
    expect((await finalPay(await release({ t_device: new Date(Date.now() + 3_600_000).toISOString() }))).body.error).toBe('FUTURE_TIME');
    const other = await release();
    const swapped = await finalPay({ payload: ok.payload, authEntry: other.authEntry });
    expect([swapped.status, swapped.body.error]).toEqual([422, 'BAD_AUTH_ENTRY']);
    expect(calls.map((c) => c.method)).toEqual(['create_trip']);
  });

  it('final-pay submits claim_final_pay with only the driver entry and records the RELEASE', async () => {
    chain = onChain('Delivered', { kind: Kind.RELEASE, seq: 9, amount: 50_000_000n }, 200_000_000n);
    const req = await release();
    const r = await finalPay(req);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ txHash, payout: '5.00', deduction: '20.00', balance: '80.00' });

    const claim = calls.at(-1)!;
    expect(claim.method).toBe('claim_final_pay');
    expect(claim.args.map((a) => a.toXDR('base64'))).toEqual(TrailContract.args.claim_final_pay(tripId, hashPayload(req.payload)).map((a) => a.toXDR('base64')));
    expect(claim.plan.kind).toBe('entries');
    expect(claim.plan.kind === 'entries' && claim.plan.entries.map((e) => e.toXDR('base64'))).toEqual([req.authEntry]);

    const trip = await getTripRow(ctx, tripId);
    expect([trip.status, trip.deliveredAt]).toEqual(['delivered', ledgerTime]);
    const ev = await ctx.db.query.custodyEvents.findFirst({ where: eq(schema.custodyEvents.kind, Kind.RELEASE) });
    expect(ev).toMatchObject({
      status: 'confirmed',
      wp: 1,
      hash: hashPayload(req.payload).toString('hex'),
      amount: 50_000_000,
      actor: `driver:${driverId}`,
      offline: false,
      authEntry: req.authEntry,
      txHash,
      seq: 9,
    });
    expect(ev!.payload).toBe(canonical(req.payload));
    expect(ev!.deviceTime).toEqual(new Date(req.payload.t_device));

    const again = await finalPay(req);
    expect([again.status, again.body.error]).toEqual([409, 'TRIP_NOT_AWAITING_SIGNATURE']);
  });

  it('cash-out quote returns the anchor account and memo the phone will be asked to pay', async () => {
    const q = await call('POST', '/v1/driver/cashouts/quote', { amount: '10.00' }, driver);
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    const row = (await ctx.db.query.cashouts.findFirst({ where: eq(schema.cashouts.id, q.body.id) }))!;
    expect(q.body.payTo).toBe(anchorAccount);
    expect([q.body.payTo, q.body.memo]).toEqual([row.destination, row.memo]);
  });
});
