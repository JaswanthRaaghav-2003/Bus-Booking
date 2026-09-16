// server/test/concurrency.test.js
// Verifies that under intense simultaneous contention on the same seat, exactly 1 succeeds and others get 409 Conflict.

const assert = require('assert');
const BusLaneEngine = require('../stateEngine');

async function testConcurrency() {
  console.log('--- Running Concurrency Stress Test ---');
  const engine = new BusLaneEngine();

  const targetSeat = '8D';
  const NUM_REQUESTERS = 10;

  // Launch 10 simultaneous hold requests in the same event loop tick
  const promises = Array.from({ length: NUM_REQUESTERS }).map(async (_, idx) => {
    try {
      const res = await engine.toggleSeatHold(targetSeat);
      return { success: true, idx, res };
    } catch (err) {
      return { success: false, idx, error: err };
    }
  });

  const results = await Promise.all(promises);
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);

  console.log(`[Result] Requesters: ${NUM_REQUESTERS} | Successes: ${successes.length} | Conflicts: ${failures.length}`);

  assert.strictEqual(successes.length, 1, 'CRITICAL: Exactly ONE requester must acquire the seat lease!');
  assert.strictEqual(failures.length, NUM_REQUESTERS - 1, 'CRITICAL: All other requesters must receive conflict!');
  assert.strictEqual(failures[0].error.code, 409, 'Error code must be HTTP 409 Conflict');

  console.log('✓ PASS: Concurrency mutex successfully serialized 10 simultaneous requests without double-lease.\n');
}

if (require.main === module) {
  testConcurrency().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}

module.exports = testConcurrency;
