CREATE SEQUENCE IF NOT EXISTS training_samples_id_seq START 1;
CREATE TABLE IF NOT EXISTS training_samples (
  id BIGINT PRIMARY KEY DEFAULT nextval('training_samples_id_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  model TEXT NOT NULL,
  should_delete BOOLEAN NOT NULL,
  probability DOUBLE NOT NULL,
  strongest_signal TEXT NOT NULL,
  request JSON NOT NULL,
  answers JSON NOT NULL
);
CREATE INDEX IF NOT EXISTS training_samples_created ON training_samples(created_at);
