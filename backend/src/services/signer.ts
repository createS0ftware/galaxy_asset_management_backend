import type { Keypair, xdr } from '@stellar/stellar-sdk';
import { distanceM } from '../lib/geo.js';
import type { WaypointPayload } from '../lib/payload.js';
import type { AuthPlan } from '../stellar/submitter.js';
import type { TrailContract } from '../stellar/trail.js';

/** Platform co-signatures are short-lived: they're made right before submission. */
const PLATFORM_AUTH_LEDGERS = 100;

export interface WaypointRule {
  idx: number;
  type: 'pickup' | 'checkpoint' | 'delivery';
  lat: number;
  lon: number;
  radiusM: number;
  windowStart: Date;
  windowEnd: Date;
}

export interface CheckInContext {
  tripId: string;
  assetId: string;
  tagId: string;
  nextWp: number;
  waypoint: WaypointRule | undefined;
  lastWp: number;
  now: Date;
  maxOfflineHours: number;
}

export interface CheckResult {
  distanceM: number;
  insideGeofence: true;
  tagMatched: true;
}

export class CheckInRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Expected `event` for a waypoint. */
export const eventFor = (wp: number, last: number) => (wp === 0 ? 'pickup' : wp === last ? 'arrival' : 'checkin');

/**
 * BR-03: the server-side checks the signer service runs before it will co-sign a check-in.
 * Pure function so it can be tested exhaustively.
 */
export function checkWaypoint(p: WaypointPayload, c: CheckInContext): CheckResult {
  const reject = (code: string, msg: string, details?: Record<string, unknown>) => {
    throw new CheckInRejected(code, msg, details);
  };
  if (p.v !== 1) reject('BAD_PAYLOAD', 'Unsupported payload version');
  if (p.trip !== c.tripId) reject('TRIP_MISMATCH', 'Payload is for a different trip');
  if (p.asset !== c.assetId) reject('ASSET_MISMATCH', 'Payload is for a different asset');
  if (p.wp !== c.nextWp) reject('WRONG_WAYPOINT', `Next expected waypoint is ${c.nextWp}`, { expected: c.nextWp, got: p.wp });
  const w = c.waypoint;
  if (!w) return reject('WRONG_WAYPOINT', 'No such waypoint');
  if (p.event !== eventFor(p.wp, c.lastWp)) reject('EVENT_MISMATCH', `Waypoint ${p.wp} expects event "${eventFor(p.wp, c.lastWp)}"`);
  if (p.tag !== c.tagId) reject('TAG_MISMATCH', "Scanned tag doesn't match the trip's asset");
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.acc_m) || p.acc_m < 0) {
    reject('BAD_PAYLOAD', 'Invalid GPS fix');
  }
  if (!Array.isArray(p.photos) || p.photos.some((h) => typeof h !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(h))) {
    reject('BAD_PAYLOAD', 'photos must be "sha256:<hex>" strings');
  }

  const d = distanceM(p, w);
  if (p.acc_m > w.radiusM) reject('LOW_ACCURACY', `GPS accuracy ${p.acc_m} m is worse than the ${w.radiusM} m geofence`, { accM: p.acc_m });
  if (d > w.radiusM) {
    reject('OUTSIDE_GEOFENCE', `${Math.round(d)} m from the waypoint centre (radius ${w.radiusM} m)`, { distanceM: Math.round(d) });
  }

  const t = new Date(p.t_device);
  if (Number.isNaN(t.getTime())) return reject('BAD_PAYLOAD', 't_device must be an ISO timestamp');
  if (t.getTime() > c.now.getTime() + 5 * 60_000) reject('FUTURE_TIME', 'Device time is in the future');
  if (c.now.getTime() - t.getTime() > c.maxOfflineHours * 3_600_000) {
    reject('STALE_CHECKIN', `Check-in is older than ${c.maxOfflineHours} h; needs an ops override`);
  }
  if (t < w.windowStart || t > w.windowEnd) {
    reject('OUTSIDE_WINDOW', 'Check-in is outside the waypoint time window', {
      windowStart: w.windowStart.toISOString(),
      windowEnd: w.windowEnd.toISOString(),
    });
  }
  return { distanceM: Math.round(d), insideGeofence: true, tagMatched: true };
}

/**
 * Holds the platform key (in production: a KMS/HSM-backed signer). Callers run the business
 * checks first; this class only ever produces short-lived signatures for exact calls.
 */
export class PlatformSigner {
  constructor(
    private readonly key: Keypair,
    private readonly trail: TrailContract,
  ) {}

  get address() {
    return this.key.publicKey();
  }

  /** Co-sign `method(args)` (after the caller's checks passed). */
  coSign(method: string, args: xdr.ScVal[], latestLedger: number) {
    return this.trail.sign(this.key, method, args, latestLedger + PLATFORM_AUTH_LEDGERS);
  }

  /** Recording-mode plan for admin calls that also need the platform (activation, forced check-in). */
  withAdmin(admin: Keypair): AuthPlan {
    return { kind: 'record', signers: [admin, this.key] };
  }
}
