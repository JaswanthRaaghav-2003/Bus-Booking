// server/test/hold_expiry.test.js
// Verifies hold expiry, seat hijacking, late payment automated refund, and payment idempotency.

const assert = require('assert');
const BusLaneEngine = require('../stateEngine');

async function testHoldExpiryAndLatePayment() {
  console.log('--- Running Hold Expiry & Late Payment Race Test ---');
  const engine = new BusLaneEngine();

  // 1. Customer A holds seat 4C
  const holdA = await engine.toggleSeatHold('4C');
  const tokenA = holdA.holdToken;

  engine.savePassengerDetails(tokenA, {
    passengers: [{ name: 'Customer Alice', age: 30, gender: 'Female', phone: '9876543210' }],
    boardingPointId: 'bp_1'
  });

  // 2. Simulate hold expiration on server
  engine.devExpireHold(tokenA);
  assert.strictEqual(engine.seats['4C'].status, 'AVAILABLE', 'Seat 4C must revert to AVAILABLE after expiry');

  // 3. Customer B claims 4C and successfully confirms booking
  const holdB = await engine.toggleSeatHold('4C');
  engine.savePassengerDetails(holdB.holdToken, {
    passengers: [{ name: 'Customer Bob', age: 35, gender: 'Male', phone: '9123456789' }],
    boardingPointId: 'bp_1'
  });
  const bookingB = await engine.processPayment({
    holdToken: holdB.holdToken,
    paymentMethod: 'UPI',
    idempotencyKey: 'idemp_bob_001'
  });

  assert.strictEqual(bookingB.status, 'CONFIRMED');
  assert.strictEqual(engine.seats['4C'].status, 'BOOKED');
  assert.strictEqual(engine.seats['4C'].bookingRef, bookingB.booking.bookingRef);
  console.log('✓ PASS: Customer B successfully booked 4C after Customer A hold expired');

  // 4. Customer A attempts to submit late payment against expired hold
  try {
    await engine.processPayment({
      holdToken: tokenA,
      paymentMethod: 'CARD',
      idempotencyKey: 'idemp_alice_late'
    });
    assert.fail('Customer A late payment should have been rejected!');
  } catch (err) {
    assert.strictEqual(err.code, 409);
    assert.strictEqual(err.type, 'LATE_PAYMENT_REFUNDED');
    assert(err.refundDetails, 'Must contain automated refund record');
    assert.strictEqual(err.refundDetails.reason, 'SEAT_TAKEN_BY_ANOTHER');
    console.log(`✓ PASS: Late payment rejected with automated refund: ${err.refundDetails.refundTxnId}`);
  }

  // 5. Test Idempotency for Customer B's payment
  const duplicateConfirm = await engine.processPayment({
    holdToken: holdB.holdToken,
    paymentMethod: 'UPI',
    idempotencyKey: 'idemp_bob_001'
  });
  assert.strictEqual(duplicateConfirm.isDuplicate, true);
  assert.strictEqual(duplicateConfirm.booking.bookingRef, bookingB.booking.bookingRef);
  console.log('✓ PASS: Idempotent payment callback handled safely without duplicate booking or charge.\n');
}

if (require.main === module) {
  testHoldExpiryAndLatePayment().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}

module.exports = testHoldExpiryAndLatePayment;
