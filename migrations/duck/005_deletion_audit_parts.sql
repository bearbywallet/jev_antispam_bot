CREATE TABLE IF NOT EXISTS deletion_audit_parts (
  audit_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 256),
  report TEXT NOT NULL CHECK (length(report) BETWEEN 1 AND 4000),
  state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','send_unknown','terminal')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  receipt_message_id BIGINT CHECK (receipt_message_id BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (audit_id, sequence),
  CHECK ((state = 'sending') = (lease_until IS NOT NULL)),
  CHECK ((state = 'sending') = (lease_token IS NOT NULL)),
  CHECK (receipt_message_id IS NULL OR state = 'sent')
);
