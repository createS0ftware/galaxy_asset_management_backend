/**
 * End-to-end journey against Stellar testnet, through the HTTP API.
 * Needs backend/.env.testnet (npm run bootstrap:testnet). Run: E2E=1 npx vitest run test/e2e.testnet.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCheckInPayload,
  buildReleasePayload,
  offlineValidUntil,
  signCheckIn,
  signClaimAdvance,
  signClaimFinalPay,
  signTransactionXdr,
  type CheckInTemplate,
} from '../src/client/driver.js';
import { loadConfig } from '../src/config.js';
import { createContext, type Ctx } from '../src/context.js';
import { schema } from '../src/db/client.js';
import { buildApp } from '../src/http/app.js';
import { hashPassword } from '../src/lib/crypto.js';
import { indexOnce } from '../src/services/indexer.js';
import type { DevSms } from '../src/services/sms.js';

const run = process.env.E2E === '1' ? describe : describe.skip;

function loadEnvFile(path: string) {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const quiet = { info: () => {}, warn: () => {}, error: console.error };

run('testnet journey: TR-2041 Tema → Kumasi', () => {
  let ctx: Ctx;
  let app: FastifyInstance;
  let staff: string;
  let driverToken: string;
  const driverKey = Keypair.random();
  const suffix = Date.now().toString(36).toUpperCase();
  const assetId = `GX400-${suffix}`;
  const tripId = `TR-2041-${suffix}`;
  const tag = '04:A3:7E:91';
  const driverPhone = `+23324${Math.floor(1e6 + Math.random() * 8e6)}`;
  const receiverPhone = `+23320${Math.floor(1e6 + Math.random() * 8e6)}`;
  let tracking: string;
  let driverId: number;
  let template: CheckInTemplate;
  let templateSeenAt: Date;

  const call = async (method: 'GET' | 'POST', url: string, body?: unknown, token?: string) => {
    const res = await app.inject({ method, url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body };
  };
  const sms = () => ctx.sms as DevSms;
  const codeFrom = (phone: string) => /(\d{6})/.exec(sms().last(phone)!.text)![1]!;

  const places = [
    { name: 'Tema Port', type: 'pickup', lat: 5.6333, lon: 0.0167, legPay: '0' },
    { name: 'Nsawam', type: 'checkpoint', lat: 5.8089, lon: -0.3503, legPay: '18.00' },
    { name: 'Nkawkaw', type: 'checkpoint', lat: 6.55, lon: -0.7667, legPay: '22.00' },
    { name: 'Konongo', type: 'checkpoint', lat: 6.6167, lon: -1.2167, legPay: '15.00' },
    { name: 'Kumasi · Warehouse B', type: 'delivery', lat: 6.6885, lon: -1.6244, legPay: '25.00' },
  ] as const;

  const checkIn = async (wp: number, at = new Date(), offset = 0.0004) => {
    const p = places[wp]!;
    const payload = buildCheckInPayload(
      tripId,
      { wp, event: wp === 0 ? 'pickup' : wp === 4 ? 'arrival' : 'checkin', asset: assetId },
      { tag, lat: p.lat + offset, lon: p.lon, accM: 8, at, photos: [`sha256:${'ab'.repeat(32)}`] },
    );
    return signCheckIn(driverKey, tripId, template, payload, offlineValidUntil(template, templateSeenAt));
  };

  beforeAll(async () => {
    const env = { ...loadEnvFile(new URL('../.env.testnet', import.meta.url).pathname), DATABASE_URL: 'pglite://memory', INDEXER_INTERVAL_MS: '0' };
    ctx = await createContext(loadConfig(env), { log: quiet });
    app = await buildApp(ctx);
    await ctx.db.insert(schema.staffUsers).values({ email: 'ops@example.com', name: 'Ama Ops', role: 'admin', passwordHash: await hashPassword('secret-pass') });
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.close();
  });

  it('staff signs in', async () => {
    const r = await call('POST', '/v1/auth/staff/login', { email: 'ops@example.com', password: 'secret-pass' });
    expect(r.status).toBe(200);
    staff = r.body.token;
    expect((await call('GET', '/v1/assets')).status).toBe(401);
  });

  it('registers the asset and activates it only with the right tag (T1, BR-01)', async () => {
    const r = await call('POST', '/v1/assets', { id: assetId, name: 'Diesel generator 400 kVA', type: 'generator', serial: 'GX400-0041', value: '48000 USD', tagId: tag, documents: [{ name: 'invoice.pdf', sha256: 'cd'.repeat(32) }] }, staff);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.event.status).toBe('confirmed');
    expect((await call('POST', `/v1/assets/${assetId}/activate`, { tag: 'WRONG' }, staff)).body.error).toBe('TAG_MISMATCH');
    const a = await call('POST', `/v1/assets/${assetId}/activate`, { tag }, staff);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.asset.status).toBe('active');
  });

  it('onboards the driver: OTP login and sponsored wallet + trustline (T2)', async () => {
    const d = await call('POST', '/v1/drivers', { phone: driverPhone, name: 'Kwame Asante', momoNumber: '+233241234567' }, staff);
    expect(d.status).toBe(201);
    driverId = d.body.id;
    await call('POST', '/v1/auth/driver/otp', { phone: driverPhone });
    expect((await call('POST', '/v1/auth/driver/verify', { phone: driverPhone, code: '000000' })).status).toBe(401);
    const v = await call('POST', '/v1/auth/driver/verify', { phone: driverPhone, code: codeFrom(driverPhone) });
    driverToken = v.body.token;

    const prep = await call('POST', '/v1/driver/wallet/prepare', { publicKey: driverKey.publicKey() }, driverToken);
    expect(prep.status, JSON.stringify(prep.body)).toBe(200);
    const signed = signTransactionXdr(prep.body.xdr, prep.body.networkPassphrase, driverKey);
    const sub = await call('POST', '/v1/driver/wallet/submit', { xdr: signed }, driverToken);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect((await call('GET', '/v1/driver/me', undefined, driverToken)).body.walletStatus).toBe('ready');
  });

  it('plans and funds the trip: escrow = legs + advance limit (T3, BR-02)', async () => {
    const now = Date.now();
    const r = await call(
      'POST',
      '/v1/trips',
      {
        id: tripId,
        assetId,
        driverId,
        receiver: { phone: receiverPhone, name: 'Warehouse B' },
        vehicle: 'GT-4471-22',
        advanceLimit: '40.00',
        waypoints: places.map((p) => ({ ...p, windowStart: new Date(now - 3_600_000).toISOString(), windowEnd: new Date(now + 4 * 3_600_000).toISOString() })),
      },
      staff,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.trip.escrow.funded).toBe('120.00');
    expect(r.body.trip.waypoints.map((w: { radiusM: number }) => w.radiusM)).toEqual([300, 200, 200, 200, 150]);
    tracking = r.body.trip.trackingUrl.split('/t/')[1];
    expect(sms().last(receiverPhone)!.text).toContain(tracking);
  });

  it('driver sees a funded offer, accepts and picks up (T4)', async () => {
    const t = await call('GET', `/v1/driver/trips/${tripId}`, undefined, driverToken);
    expect(t.body.escrow.funded_badge).toBe(true);
    expect(t.body.waypoints[4].payNote).toBe('paid when the receiver signs');
    template = t.body.checkIn;
    templateSeenAt = new Date();
    expect((await call('POST', `/v1/driver/trips/${tripId}/accept`, undefined, driverToken)).body.status).toBe('accepted');

    const far = await checkIn(0, new Date(), 0.05);
    const bad = await call('POST', `/v1/driver/trips/${tripId}/checkins`, far, driverToken);
    expect(bad.body.error).toBe('OUTSIDE_GEOFENCE');

    const r = await call('POST', `/v1/driver/trips/${tripId}/checkins`, await checkIn(0), driverToken);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.checks).toMatchObject({ tagMatched: true, insideGeofence: true, recordedOnLedger: true });
    expect(r.body.legPay).toBe('0.00');
  });

  it('queues two check-ins signed offline and submits them in order (§4.4, BR-04)', async () => {
    const signedAt = new Date(Date.now() - 20 * 60_000); // signed 20 min ago with no signal
    const items = [await checkIn(1, signedAt), await checkIn(2, new Date(signedAt.getTime() + 60_000))];
    const r = await call('POST', `/v1/driver/trips/${tripId}/checkins/batch`, { items }, driverToken);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.stoppedAt).toBeNull();
    expect(r.body.results.map((x: { legPay: string }) => x.legPay)).toEqual(['18.00', '22.00']);
    expect(r.body.results[0].event.offline).toBe(true);
    expect(r.body.results[1].balance).toBe('40.00');
    // Replaying the queue is idempotent.
    const again = await call('POST', `/v1/driver/trips/${tripId}/checkins`, items[0], driverToken);
    expect(again.body.duplicate).toBe(true);
  });

  it('fuel advance: request, approve (T6), claim with phone signature (T7, BR-06)', async () => {
    expect((await call('POST', `/v1/driver/trips/${tripId}/advances`, { amount: '30.00' }, driverToken)).body.error).toBe('ADVANCE_OVER_LIMIT');
    const req = await call('POST', `/v1/driver/trips/${tripId}/advances`, { amount: '20.00', reason: 'diesel' }, driverToken);
    expect(req.status).toBe(201);
    const board = await call('GET', '/v1/trips', undefined, staff);
    expect(board.body.attention.some((a: { kind: string }) => a.kind === 'advance_request')).toBe(true);
    const ok = await call('POST', `/v1/advances/${req.body.id}/approve`, { expiresInHours: 6 }, staff);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const entry = await signClaimAdvance(driverKey, tripId, template.contractId, template.networkPassphrase, template.latestLedger + 2000);
    const claim = await call('POST', `/v1/driver/trips/${tripId}/advances/claim`, { authEntry: entry }, driverToken);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect((await call('GET', '/v1/driver/wallet', undefined, driverToken)).body.balance).toBe('60.00');
  });

  it('last checkpoint, then arrival waits for the receiver (T5)', async () => {
    expect((await call('POST', `/v1/driver/trips/${tripId}/checkins`, await checkIn(3), driverToken)).status).toBe(201);
    const arr = await call('POST', `/v1/driver/trips/${tripId}/checkins`, await checkIn(4), driverToken);
    expect(arr.status, JSON.stringify(arr.body)).toBe(201);
    expect(arr.body.awaitingSignature).toBe(true);
    expect(sms().last(receiverPhone)!.text).toMatch(/inspect and sign/);

    // §4.6: the final leg is claimable by the driver only after the deadline set at dispatch.
    const t = await call('GET', `/v1/driver/trips/${tripId}`, undefined, driverToken);
    expect(t.body.finalPay).toMatchObject({ claimable: false, amount: '5.00', deadline: t.body.deliveryDeadline });
    const early = await signClaimFinalPay(driverKey, tripId, t.body.finalPay, buildReleasePayload(tripId, assetId), t.body.finalPay.latestLedger + 100);
    const refused = await call('POST', `/v1/driver/trips/${tripId}/final-pay`, early, driverToken);
    expect([refused.status, refused.body.error]).toEqual([422, 'DEADLINE_NOT_PASSED']);
  });

  it('receiver tracks and signs with OTP; final pay minus advance is released (T8, BR-05)', async () => {
    const view = await call('GET', `/v1/track/${tracking}`);
    expect(view.body.status).toBe('awaiting_signature');
    expect(view.body.verified).toHaveLength(5);
    expect(view.body.driverFirstName).toBe('Kwame');
    await call('POST', `/v1/track/${tracking}/otp`);
    expect((await call('POST', `/v1/track/${tracking}/sign`, { code: '000000', tag, noDamage: true })).status).toBe(401);
    await call('POST', `/v1/track/${tracking}/otp`);
    const r = await call('POST', `/v1/track/${tracking}/sign`, { code: codeFrom(receiverPhone), tag, noDamage: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.finalPay).toBe('5.00');
    expect((await call('GET', '/v1/driver/wallet', undefined, driverToken)).body.balance).toBe('80.00');
  });

  it('closes the trip and returns unused escrow (T10, BR-10)', async () => {
    const r = await call('POST', `/v1/trips/${tripId}/close`, undefined, staff);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.refunded).toBe('40.00');
    const t = await call('GET', `/v1/trips/${tripId}`, undefined, staff);
    expect(t.body.status).toBe('closed');
  });

  it('auditor verifies every hash against the ledger via a proof link (5.4)', async () => {
    const link = await call('POST', `/v1/assets/${assetId}/proof-links`, { days: 7 }, staff);
    const token = link.body.token;
    const r = await call('GET', `/v1/verify/${token}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.chain.intact).toBe(true);
    expect(r.body.matched).toBe(r.body.total);
    expect(r.body.rows.map((x: { event: string }) => x.event)).toEqual([
      'REGISTER', 'ACTIVATE', 'DISPATCH', 'PICKUP', 'CHECKIN', 'CHECKIN', 'CHECKIN', 'ARRIVAL', 'DELIVERY',
    ]);
    expect(r.body.flags.some((f: { type: string }) => f.type === 'offline_gap')).toBe(true);
    const ev = r.body.rows.find((x: { event: string }) => x.event === 'CHECKIN');
    const p = await call('GET', `/v1/verify/${token}/events/${ev.eventId}/payload`);
    expect(p.body.payload.salt).toBeTruthy();
    const pack = await call('GET', `/v1/verify/${token}/proof-pack`);
    expect(pack.body.events).toHaveLength(r.body.total);
    if (process.env.PROOF_PACK_OUT) writeFileSync(process.env.PROOF_PACK_OUT, JSON.stringify(pack.body, null, 2));
  });

  it('driver cashes out to MoMo via the anchor, fee-bumped by the platform (T9)', async () => {
    const q = await call('POST', '/v1/driver/cashouts/quote', { amount: '10.00' }, driverToken);
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.anchorFee).toBe('0.10');
    const prep = await call('POST', `/v1/driver/cashouts/${q.body.id}/prepare`, undefined, driverToken);
    expect(prep.status, JSON.stringify(prep.body)).toBe(200);
    const signed = signTransactionXdr(prep.body.xdr, prep.body.networkPassphrase, driverKey);
    const sub = await call('POST', `/v1/driver/cashouts/${q.body.id}/submit`, { xdr: signed }, driverToken);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('completed');
    expect((await call('GET', '/v1/driver/wallet', undefined, driverToken)).body.balance).toBe('70.00');
  });

  it('indexer reads the events back and payments reconcile', async () => {
    const n = await indexOnce(ctx);
    expect(n).toBeGreaterThan(0);
    const csv = await call('GET', '/v1/payments/reconciliation.csv', undefined, staff);
    expect(csv.body).toContain(tripId);
    const s = await call('GET', '/v1/payments/summary', undefined, staff);
    expect(s.status).toBe(200);
    expect(Number(s.body.feeAccount.xlm)).toBeGreaterThan(0);
  });
});
