// server/test/run_all_tests.js
// Master Test Runner for BusLane Core Verification

const testConcurrency = require('./concurrency.test');
const testFares = require('./fares.test');
const testLadiesSeatsAndInfants = require('./ladies_seats.test');
const testHoldExpiryAndLatePayment = require('./hold_expiry.test');

async function runAll() {
  console.log('====================================================');
  console.log('   BUSLANE DISTRIBUTED SYSTEM AUTOMATED TEST RUNNER ');
  console.log('====================================================\n');

  try {
    await testConcurrency();
    await testFares();
    await testLadiesSeatsAndInfants();
    await testHoldExpiryAndLatePayment();

    console.log('====================================================');
    console.log('   ALL TEST SUITES PASSED CLEANLY (100% SUCCESS)    ');
    console.log('====================================================');
  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
  }
}

runAll();
