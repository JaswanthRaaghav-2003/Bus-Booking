// server/test/ladies_seats.test.js
// Verifies enforcement of female-only rules on 3A, 3B, 4A, 4B and child under 5 policy.

const assert = require('assert');
const BusLaneEngine = require('../stateEngine');

async function testLadiesSeatsAndInfants() {
  console.log('--- Running Ladies Seats & Infant Eligibility Test ---');
  const engine = new BusLaneEngine();

  // Test 1: Hold Ladies Seat 3A
  const holdRes = await engine.toggleSeatHold('3A');
  const token = holdRes.holdToken;
  assert(token, 'Hold token must be generated');

  // Attempt to assign male passenger to 3A
  try {
    engine.savePassengerDetails(token, {
      passengers: [{ name: 'Vikram Mehta', age: 30, gender: 'Male', phone: '9876543210' }],
      boardingPointId: 'bp_1'
    });
    assert.fail('Should have rejected male passenger on ladies seat 3A!');
  } catch (err) {
    assert.strictEqual(err.code, 422, 'Expected 422 validation error');
    assert(err.message.includes('ladies seat'), 'Error message must specify ladies seat restriction');
    console.log('✓ PASS: Male passenger rejected on ladies seat 3A with 422 Unprocessable Entity');
  }

  // Assign female passenger to 3A
  const validRes = engine.savePassengerDetails(token, {
    passengers: [{ name: 'Anjali Sharma', age: 28, gender: 'Female', phone: '9876543210' }],
    infants: [{ name: 'Baby Aarav', age: 2, gender: 'Male' }],
    boardingPointId: 'bp_1'
  });
  assert.strictEqual(validRes.status, 'DETAILS_SAVED');
  console.log('✓ PASS: Female passenger + Lap infant under 5 accepted on ladies seat 3A');

  // Test 2: Reject assigning child under 5 as a seated passenger
  const holdGeneral = await engine.toggleSeatHold('1A');
  try {
    engine.savePassengerDetails(holdGeneral.holdToken, {
      passengers: [{ name: 'Toddler Priya', age: 3, gender: 'Female', phone: '9876543210' }],
      boardingPointId: 'bp_1'
    });
    assert.fail('Should have rejected child under 5 as seated passenger');
  } catch (err) {
    assert.strictEqual(err.code, 422);
    assert(err.message.includes('age 5 or older'), 'Must enforce seated passengers age >= 5');
    console.log('✓ PASS: Child under 5 rejected from occupying individual paid seat.\n');
  }
}

if (require.main === module) {
  testLadiesSeatsAndInfants().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}

module.exports = testLadiesSeatsAndInfants;
