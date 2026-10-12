import { expect, test } from "bun:test";
import { DuckDbTrainingCapture } from "./training-capture";
import { duckQuery } from "./duck";

process.env.DUCKDB_PATH = "/tmp/jev_capture_test.duckdb";
const integration = test;

const assessment = {
  shouldDelete: true, probability: 0.97, strongestSignal: "easy_money_bait",
  model: "typesafe/jev-router", signals: {}, contextProbabilities: [],
} as never;
const settle = async (capture: DuckDbTrainingCapture) => {
  while ((capture as unknown as { inFlight: number }).inFlight) await Bun.sleep(10);
};

integration("training capture stores request/answers and prunes by age and row cap", async () => {
  const capture = new DuckDbTrainingCapture({ maxRows: 2, retentionDays: 30 });
  capture.record(-1001, 1, { message: { text: "earn" } }, { easy_money_bait: { noul: 0.97 } }, assessment);
  await settle(capture);
  await duckQuery("DELETE FROM training_samples");
  (capture as unknown as { lastPrune: number }).lastPrune = 0;
  for (const id of [1, 2, 3]) {
    capture.record(-1001, id, { message: { text: `m${id}` } }, {}, assessment);
    await settle(capture);
  }
  expect(capture.counters).toMatchObject({ stored: 4, failed: 0 });
  // First insert after the hourly window pruned; later ones did not.
  expect((await duckQuery("SELECT message_id::BIGINT AS message_id FROM training_samples ORDER BY id")).rows.map(r => r.message_id)).toEqual([1, 2, 3]);
  await duckQuery("UPDATE training_samples SET created_at = NOW() - INTERVAL 40 DAY WHERE message_id = 1");
  (capture as unknown as { lastPrune: number }).lastPrune = 0;
  capture.record(-1001, 4, { message: {} }, {}, assessment);
  await settle(capture);
  expect((await duckQuery("SELECT message_id::BIGINT AS message_id, request::VARCHAR AS request FROM training_samples ORDER BY id")).rows)
    .toEqual([
      { message_id: 3, request: JSON.stringify({ message: { text: "m3" } }) },
      { message_id: 4, request: JSON.stringify({ message: {} }) },
    ]);
  await capture.close();
});
