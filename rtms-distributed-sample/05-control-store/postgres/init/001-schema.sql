CREATE TABLE IF NOT EXISTS stream_routes (
  rtms_stream_id text PRIMARY KEY,
  rtms_id text,
  product_type text NOT NULL,
  region_code text NOT NULL,
  start_envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stream_routes_rtms_id_idx
  ON stream_routes (rtms_id);

CREATE INDEX IF NOT EXISTS stream_routes_region_idx
  ON stream_routes (region_code, updated_at DESC);

CREATE TABLE IF NOT EXISTS stream_leases (
  rtms_stream_id text PRIMARY KEY,
  owner_node_id text,
  lease_version bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stream_leases_expired_idx
  ON stream_leases (lease_expires_at)
  WHERE owner_node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stream_state (
  rtms_stream_id text PRIMARY KEY,
  rtms_id text,
  product_type text,
  region_code text,
  state text NOT NULL,
  first_packet_at timestamptz,
  stopped_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stream_state_rtms_id_idx
  ON stream_state (rtms_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS stream_state_state_idx
  ON stream_state (state, updated_at DESC);

CREATE INDEX IF NOT EXISTS stream_state_region_idx
  ON stream_state (region_code, updated_at DESC);

CREATE TABLE IF NOT EXISTS node_heartbeats (
  node_id text PRIMARY KEY,
  region_code text NOT NULL,
  state text NOT NULL,
  active_streams integer NOT NULL DEFAULT 0,
  max_streams integer NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS node_heartbeats_region_idx
  ON node_heartbeats (region_code, last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS stream_artifacts (
  artifact_id text PRIMARY KEY,
  rtms_stream_id text NOT NULL,
  rtms_id text,
  region_code text,
  artifact_type text NOT NULL,
  content_type text NOT NULL,
  blob_uri text NOT NULL,
  byte_size bigint,
  checksum text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stream_artifacts_stream_idx
  ON stream_artifacts (rtms_stream_id, created_at DESC);

CREATE INDEX IF NOT EXISTS stream_artifacts_type_idx
  ON stream_artifacts (artifact_type, created_at DESC);

CREATE INDEX IF NOT EXISTS stream_artifacts_stream_type_idx
  ON stream_artifacts (rtms_stream_id, artifact_type, created_at DESC);

CREATE INDEX IF NOT EXISTS stream_artifacts_rtms_id_idx
  ON stream_artifacts (rtms_id, created_at DESC);

CREATE INDEX IF NOT EXISTS stream_artifacts_region_time_idx
  ON stream_artifacts (region_code, created_at DESC);
