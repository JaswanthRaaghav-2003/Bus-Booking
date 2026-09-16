// server/server.js
// BusLane Production-Ready Server with REST APIs, Server-Sent Events, and ?dev=1 Testing Suite

const express = require('express');
const cors = require('cors');
const path = require('path');
const BusLaneEngine = require('./stateEngine');

const app = express();
const PORT = process.env.PORT || 3000;
const engine = new BusLaneEngine();

app.use(cors());
app.use(express.json());

// Simulated Network Latency Middleware
app.use((req, res, next) => {
  if (engine.networkLatencyMs > 0 && !req.path.startsWith('/api/dev/')) {
    setTimeout(next, engine.networkLatencyMs);
  } else {
    next();
  }
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// --- Real-time Server-Sent Events Stream ---
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  engine.subscribeSSE(res);
});

// --- Customer Flow REST APIs ---

// 1. Get Live State
app.get('/api/state', (req, res) => {
  const token = req.query.token || null;
  res.json(engine.getClientState(token));
});

// 2. Toggle Seat Selection / Hold
app.post('/api/hold/toggle', async (req, res) => {
  try {
    const { seatId, holdToken } = req.body;
    if (!seatId) {
      return res.status(400).json({ error: 'Seat ID is required.' });
    }
    const result = await engine.toggleSeatHold(seatId, holdToken);
    res.json(result);
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message || 'Internal server error' });
  }
});

// 3. Restore / Query Active Session
app.get('/api/hold/session', (req, res) => {
  const token = req.query.token;
  const session = engine.getSession(token);
  if (!session) {
    return res.status(404).json({ error: 'Hold session not found or expired.' });
  }
  res.json(session);
});

// 4. Save Passenger Details & Boarding Point
app.post('/api/passengers', (req, res) => {
  try {
    const { token, passengers, infants, boardingPointId } = req.body;
    if (!token) return res.status(400).json({ error: 'Hold token is required.' });

    const result = engine.savePassengerDetails(token, {
      passengers,
      infants: infants || [],
      boardingPointId
    });
    res.json(result);
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message || 'Validation failed' });
  }
});

// 5. Submit Payment & Confirm Booking
app.post('/api/pay', async (req, res) => {
  try {
    const { holdToken, paymentMethod, idempotencyKey, clientReportedAmount } = req.body;
    if (!holdToken) return res.status(400).json({ error: 'Hold token is required.' });

    const result = await engine.processPayment({
      holdToken,
      paymentMethod,
      idempotencyKey,
      clientReportedAmount
    });
    res.json(result);
  } catch (err) {
    res.status(err.code || 500).json({
      error: err.message || 'Payment processing error',
      type: err.type || 'PAYMENT_FAILED',
      refundDetails: err.refundDetails || null
    });
  }
});

// 6. Query Confirmed Booking
app.get('/api/booking/:ref', (req, res) => {
  const booking = engine.bookings.get(req.params.ref);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  res.json(booking);
});

// 7. Cancel Booking & Issue Refund
app.post('/api/booking/cancel', (req, res) => {
  try {
    const { bookingRef } = req.body;
    if (!bookingRef) return res.status(400).json({ error: 'Booking reference is required.' });

    const result = engine.cancelBooking(bookingRef);
    res.json(result);
  } catch (err) {
    res.status(err.code || 500).json({ error: err.message || 'Cancellation failed.' });
  }
});

// --- Dev Mode APIs (?dev=1) ---

app.post('/api/dev/expire-hold', (req, res) => {
  const { token } = req.body;
  res.json(engine.devExpireHold(token));
});

app.post('/api/dev/set-hold-duration', (req, res) => {
  const { durationSec } = req.body;
  res.json(engine.devSetHoldDuration(durationSec));
});

app.post('/api/dev/set-gateway-mode', (req, res) => {
  const { mode } = req.body;
  try {
    res.json(engine.devSetGatewayMode(mode));
  } catch (err) {
    res.status(err.code || 400).json({ error: err.message });
  }
});

app.post('/api/dev/steal-seat', (req, res) => {
  const { seatId } = req.body;
  try {
    res.json(engine.devStealSeat(seatId));
  } catch (err) {
    res.status(err.code || 400).json({ error: err.message });
  }
});

app.post('/api/dev/preset', (req, res) => {
  const { preset } = req.body;
  res.json(engine.devSetPreset(preset));
});

app.post('/api/dev/set-base-fare', (req, res) => {
  const { baseFare } = req.body;
  try {
    res.json(engine.devSetBaseFare(baseFare));
  } catch (err) {
    res.status(err.code || 400).json({ error: err.message });
  }
});

app.post('/api/dev/set-latency', (req, res) => {
  const { latencyMs } = req.body;
  res.json(engine.devSetLatency(latencyMs));
});

app.post('/api/dev/reset', (req, res) => {
  res.json(engine.devReset());
});

app.get('/api/dev/raw-state', (req, res) => {
  res.json(engine.getRawState());
});

// Fallback HTML routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[BusLane Server] Running on http://localhost:${PORT}`);
    console.log(`[BusLane Server] Dev Mode Harness reachable at http://localhost:${PORT}/?dev=1`);
  });
}

module.exports = { app, engine };
