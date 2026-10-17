CREATE TABLE "advances" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"grant_tx" text,
	"claim_tx" text,
	"decided_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"serial" text NOT NULL,
	"value" text,
	"tag_id" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"reg_hash" text NOT NULL,
	"tag_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cashouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"driver_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	"quote" jsonb NOT NULL,
	"destination" text NOT NULL,
	"memo" text NOT NULL,
	"status" text NOT NULL,
	"inner_xdr" text,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custody_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"trip_id" text,
	"kind" integer NOT NULL,
	"wp" integer DEFAULT 0 NOT NULL,
	"payload" text NOT NULL,
	"hash" text NOT NULL,
	"aux_payload" text,
	"aux_hash" text,
	"amount" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"tx_hash" text,
	"ledger" integer,
	"ledger_time" timestamp with time zone,
	"seq" integer,
	"device_time" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"actor" text NOT NULL,
	"auth_entry" text
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text,
	"wallet_status" text DEFAULT 'none' NOT NULL,
	"pending_wallet_xdr" text,
	"wallet_tx" text,
	"momo_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_phone_unique" UNIQUE("phone"),
	CONSTRAINT "drivers_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger" integer NOT NULL,
	"ledger_time" timestamp with time zone NOT NULL,
	"tx_hash" text NOT NULL,
	"topic" text NOT NULL,
	"asset_id" text,
	"trip_id" text,
	"to_address" text,
	"kind" integer,
	"seq" integer,
	"hash" text,
	"head" text,
	"amount" bigint,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_positions" (
	"trip_id" text PRIMARY KEY NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"acc_m" integer,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proof_link_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"link_id" integer NOT NULL,
	"ip" text,
	"user_agent" text,
	"what" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proof_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"asset_id" text NOT NULL,
	"created_by" integer,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proof_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "receivers" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"secret_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receivers_phone_unique" UNIQUE("phone"),
	CONSTRAINT "receivers_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'ops' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"driver_id" integer NOT NULL,
	"receiver_id" integer NOT NULL,
	"vehicle" text,
	"status" text NOT NULL,
	"advance_limit" bigint NOT NULL,
	"escrow" bigint NOT NULL,
	"released" bigint DEFAULT 0 NOT NULL,
	"advanced" bigint DEFAULT 0 NOT NULL,
	"next_wp" integer DEFAULT 0 NOT NULL,
	"tracking_token" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trips_tracking_token_unique" UNIQUE("tracking_token")
);
--> statement-breakpoint
CREATE TABLE "waypoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"idx" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"radius_m" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"leg_pay" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_decided_by_staff_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashouts" ADD CONSTRAINT "cashouts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_positions" ADD CONSTRAINT "live_positions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_link_views" ADD CONSTRAINT "proof_link_views_link_id_proof_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."proof_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_links" ADD CONSTRAINT "proof_links_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_links" ADD CONSTRAINT "proof_links_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_receiver_id_receivers_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."receivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waypoints" ADD CONSTRAINT "waypoints_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custody_asset_idx" ON "custody_events" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "custody_trip_idx" ON "custody_events" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "ledger_events_trip_idx" ON "ledger_events" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "ledger_events_tx_idx" ON "ledger_events" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "waypoints_trip_idx" ON "waypoints" USING btree ("trip_id","idx");