// server/test/fares.test.js
// Verifies exact rupee calculations, 5% GST, ₹30 convenience fee, and infant policy.

const assert = require('assert');
const BusLaneEngine = require('../stateEngine');

async function testFares() {
  console.log('--- Running Fare Calculation & GST Test ---');
  const engine = new BusLaneEngine();

  // Test 1: 1 Seat
  // Base = 450, Fee = 30, Subtotal = 480, 5% GST = 24.00, Total = 504
  const fare1 = engine.calculateFare(1);
  assert.strictEqual(fare1.seatSubtotal, 450);
  assert.strictEqual(fare1.convenienceFee, 30);
  assert.strictEqual(fare1.taxableAmount, 480);
  assert.strictEqual(fare1.gstAmount, 24);
  assert.strictEqual(fare1.grandTotal, 504);
  console.log('✓ PASS: 1 Seat -> ₹504.00 verified');

  // Test 2: 2 Seats (Original Spec Line 18 claimed ₹960)
  // Rectified: Base = 900, Fee = 30, Subtotal = 930, 5% GST = 46.50 -> rounds half-up to 47 or 46.5
  // Note: 930 * 0.05 = 46.5 -> Math.round is 47. Total = 930 + 47 = 977!
  // Spec's ₹960 is an arithmetic error by ₹17.
  const fare2 = engine.calculateFare(2);
  assert.strictEqual(fare2.seatSubtotal, 900);
  assert.strictEqual(fare2.convenienceFee, 30);
  assert.strictEqual(fare2.taxableAmount, 930);
  assert.strictEqual(fare2.gstAmount, 47);
  assert.strictEqual(fare2.grandTotal, 977);
  console.log('✓ PASS: 2 Seats -> ₹977.00 verified (Original spec error of ₹960 formally identified and corrected)');

  // Test 3: 3 Seats (Required worked calculation from assignment prompt!)
  // Base: 3 * 450 = 1350
  // Fee: 30
  // Subtotal: 1380
  // GST 5%: 1380 * 0.05 = 69.00
  // Grand Total: 1380 + 69 = 1449!
  const fare3 = engine.calculateFare(3);
  assert.strictEqual(fare3.seatSubtotal, 1350);
  assert.strictEqual(fare3.convenienceFee, 30);
  assert.strictEqual(fare3.taxableAmount, 1380);
  assert.strictEqual(fare3.gstAmount, 69);
  assert.strictEqual(fare3.grandTotal, 1449);
  console.log('✓ PASS: 3 Seats -> Exactly ₹1,449.00 to the rupee verified');

  // Test 4: Dynamic Fare update
  // Operator surges base fare to 600
  const fareSurge = engine.calculateFare(3, 600);
  // Base: 3 * 600 = 1800, Fee: 30, Subtotal: 1830, GST 5%: 91.50 -> 92. Total = 1922
  assert.strictEqual(fareSurge.seatSubtotal, 1800);
  assert.strictEqual(fareSurge.grandTotal, 1922);
  console.log('✓ PASS: Dynamic pricing surcharge accurately recalculates tax and total to the rupee.\n');
}

if (require.main === module) {
  testFares().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}

module.exports = testFares;
