import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
/** Token amounts in stroops (7 decimals). Fits up to ~900M units as a JS number. */
const amount = (name: string) => bigint(name, { mode: 'number' });

export const staffUsers = pgTable('staff_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'ops'] }).notNull().default('ops'),
  createdAt: created(),
});

export const drivers = pgTable('drivers', {
  id: serial('id').primaryKey(),
  phone: text('phone').notNull().unique(),
  name: text('name').notNull(),
  /** Stellar G-address whose key lives in the phone's secure hardware. */
  publicKey: text('public_key').unique(),
  walletStatus: text('wallet_status', { enum: ['none', 'pending', 'ready'] }).notNull().default('none'),
  /** Unsigned onboarding tx (T2) waiting for the phone's signature. */
  pendingWalletXdr: text('pending_wallet_xdr'),
  walletTx: text('wallet_tx'),
  momoNumber: text('momo_number'),
  createdAt: created(),
});

export const otpCodes = pgTable('otp_codes', {
  id: serial('id').primaryKey(),
  subject: text('subject').notNull(),
  purpose: text('purpose').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: created(),
});

export const assets = pgTable('assets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  serial: text('serial').notNull(),
  value: text('value'),
  /** NFC/QR tag ID. Never on-chain; only its salted hash is. */
  tagId: text('tag_id').notNull(),
  status: text('status', { enum: ['registered', 'active'] }).notNull().default('registered'),
  regHash: text('reg_hash').notNull(),
  tagHash: text('tag_hash'),
  createdAt: created(),
});

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  assetId: text('asset_id').notNull().references(() => assets.id),
  name: text('name').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: created(),
});

/** Receiver identities. Option B of D1: platform-custodied ed25519 key unlocked by SMS OTP. */
export const receivers = pgTable('receivers', {
  id: serial('id').primaryKey(),
  phone: text('phone').notNull().unique(),
  name: text('name'),
  publicKey: text('public_key').notNull().unique(),
  secretEnc: text('secret_enc').notNull(),
  createdAt: created(),
});

export const trips = pgTable('trips', {
  id: text('id').primaryKey(),
  assetId: text('asset_id').notNull().references(() => assets.id),
  driverId: integer('driver_id').notNull().references(() => drivers.id),
  receiverId: integer('receiver_id').notNull().references(() => receivers.id),
  vehicle: text('vehicle'),
  status: text('status', {
    enum: ['funded', 'accepted', 'in_transit', 'awaiting_signature', 'disputed', 'delivered', 'cancelled', 'closed'],
  }).notNull(),
  advanceLimit: amount('advance_limit').notNull(),
  escrow: amount('escrow').notNull(),
  released: amount('released').notNull().default(0),
  advanced: amount('advanced').notNull().default(0),
  nextWp: integer('next_wp').notNull().default(0),
  trackingToken: text('tracking_token').notNull().unique(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  arrivedAt: timestamp('arrived_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdBy: integer('created_by').references(() => staffUsers.id),
  createdAt: created(),
});

export const waypoints = pgTable(
  'waypoints',
  {
    id: serial('id').primaryKey(),
    tripId: text('trip_id').notNull().references(() => trips.id),
    idx: integer('idx').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ['pickup', 'checkpoint', 'delivery'] }).notNull(),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    radiusM: integer('radius_m').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    legPay: amount('leg_pay').notNull(),
  },
  (t) => [uniqueIndex('waypoints_trip_idx').on(t.tripId, t.idx)],
);

/**
 * Every anchored custody event, with its full payload and salt. This is the private half of
 * the trail: the ledger holds the hashes, this table holds what was hashed.
 */
export const custodyEvents = pgTable(
  'custody_events',
  {
    id: serial('id').primaryKey(),
    assetId: text('asset_id').notNull().references(() => assets.id),
    tripId: text('trip_id').references(() => trips.id),
    kind: integer('kind').notNull(),
    wp: integer('wp').notNull().default(0),
    /** Canonical JSON (RFC 8785) exactly as hashed. */
    payload: text('payload').notNull(),
    hash: text('hash').notNull(),
    auxPayload: text('aux_payload'),
    auxHash: text('aux_hash'),
    amount: amount('amount').notNull().default(0),
    status: text('status', { enum: ['pending', 'submitted', 'confirmed', 'failed'] }).notNull().default('pending'),
    error: text('error'),
    txHash: text('tx_hash'),
    ledger: integer('ledger'),
    ledgerTime: timestamp('ledger_time', { withTimezone: true }),
    /** Position in the asset's on-chain hash chain. */
    seq: integer('seq'),
    deviceTime: timestamp('device_time', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    offline: boolean('offline').notNull().default(false),
    /** 'driver:12', 'staff:3', 'receiver:4', 'platform'. */
    actor: text('actor').notNull(),
    /** Signed driver auth entry (base64 XDR) for driver-originated events. */
    authEntry: text('auth_entry'),
  },
  (t) => [index('custody_asset_idx').on(t.assetId), index('custody_trip_idx').on(t.tripId)],
);

export const advances = pgTable('advances', {
  id: serial('id').primaryKey(),
  tripId: text('trip_id').notNull().references(() => trips.id),
  amount: amount('amount').notNull(),
  reason: text('reason'),
  status: text('status', { enum: ['requested', 'granted', 'declined', 'claimed', 'expired'] }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  grantTx: text('grant_tx'),
  claimTx: text('claim_tx'),
  decidedBy: integer('decided_by').references(() => staffUsers.id),
  createdAt: created(),
});

export const livePositions = pgTable('live_positions', {
  tripId: text('trip_id').primaryKey().references(() => trips.id),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
  accM: integer('acc_m'),
  at: timestamp('at', { withTimezone: true }).notNull(),
});

export const proofLinks = pgTable('proof_links', {
  id: serial('id').primaryKey(),
  token: text('token').notNull().unique(),
  assetId: text('asset_id').notNull().references(() => assets.id),
  createdBy: integer('created_by').references(() => staffUsers.id),
  note: text('note'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: created(),
});

export const proofLinkViews = pgTable('proof_link_views', {
  id: serial('id').primaryKey(),
  linkId: integer('link_id').notNull().references(() => proofLinks.id),
  ip: text('ip'),
  userAgent: text('user_agent'),
  what: text('what').notNull(),
  viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Raw contract events read back from the ledger by the indexer. */
export const ledgerEvents = pgTable(
  'ledger_events',
  {
    id: text('id').primaryKey(),
    ledger: integer('ledger').notNull(),
    ledgerTime: timestamp('ledger_time', { withTimezone: true }).notNull(),
    txHash: text('tx_hash').notNull(),
    topic: text('topic').notNull(),
    assetId: text('asset_id'),
    tripId: text('trip_id'),
    to: text('to_address'),
    kind: integer('kind'),
    seq: integer('seq'),
    hash: text('hash'),
    head: text('head'),
    amount: amount('amount'),
    data: jsonb('data').notNull(),
  },
  (t) => [index('ledger_events_trip_idx').on(t.tripId), index('ledger_events_tx_idx').on(t.txHash)],
);

export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const cashouts = pgTable('cashouts', {
  id: serial('id').primaryKey(),
  driverId: integer('driver_id').notNull().references(() => drivers.id),
  amount: amount('amount').notNull(),
  quote: jsonb('quote').notNull(),
  destination: text('destination').notNull(),
  memo: text('memo').notNull(),
  status: text('status', { enum: ['quoted', 'prepared', 'submitted', 'completed', 'failed'] }).notNull(),
  innerXdr: text('inner_xdr'),
  txHash: text('tx_hash'),
  error: text('error'),
  createdAt: created(),
});
