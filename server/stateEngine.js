// server/stateEngine.js
// BusLane Core Domain State Machine & Concurrency Engine
// Strict adherence to rectified specification and distributed audit requirements.

const crypto = require('crypto');

class BusLaneEngine {
  constructor() {
    this.TOTAL_SEATS = 32;
    this.DEFAULT_BASE_FARE = 450;
    this.CONVENIENCE_FEE = 30;
    this.GST_PERCENT = 5;
    this.DEFAULT_HOLD_DURATION_SEC = 600; // 10 minutes
    this.LADIES_SEATS = new Set(['3A', '3B', '4A', '4B']);

    this.BOARDING_POINTS = [
      { id: 'bp_1', name: 'Pune Swargate', time: '22:30 IST', landmark: 'Platform 3, Opp. Bus Depot' },
      { id: 'bp_2', name: 'Shivaji Nagar', time: '22:50 IST', landmark: 'Under Flyover, Bus Lane' },
      { id: 'bp_3', name: 'Nashik Phata', time: '23:15 IST', landmark: 'Kasargawadi Signal' },
      { id: 'bp_4', name: 'Bhosari', time: '23:45 IST', landmark: 'Landewadi Chowk' }
    ];

    this.buildInfo = {
      version: 'v1.0.4-dev-verified',
      buildTimestamp: '2026-09-16T20:25:00+05:30',
      environment: 'production-sim-sandbox'
    };

    // Global simulation settings
    this.currentBaseFare = this.DEFAULT_BASE_FARE;
    this.gatewayMode = 'SUCCESS'; // 'SUCCESS' | 'FAIL' | 'TIMEOUT' | 'LATE_SUCCESS'
    this.networkLatencyMs = 0;
    this.defaultHoldDuration = this.DEFAULT_HOLD_DURATION_SEC;

    // Mutex queue for serializing concurrent state mutations
    this.mutexLocked = false;
    this.mutexQueue = [];

    // Real-time SSE subscriber connections
    this.sseClients = new Set();

    // In-memory persistent data stores
    this.seats = {}; // seatId -> { id, row, col, isLadies, isWindow, isAisle, status, holdToken, holdExpiresAt, bookingRef }
    this.holdSessions = new Map(); // holdToken -> { holdToken, seatIds, lockedBaseFare, createdAt, expiresAt, durationSeconds, passengerData, boardingPointId }
    this.expiredSessions = new Map(); // holdToken -> expired session archive
    this.bookings = new Map(); // bookingRef -> { bookingRef, holdToken, seatIds, passengers, infants, boardingPoint, fareSummary, paymentStatus, paymentTxnId, createdAt, cancelledAt, refundStatus }
    this.idempotentKeys = new Map(); // key -> { bookingRef, response }
    this.refundLedger = []; // audit list of refund transactions

    this.initSeats();
    this.startHoldReaper();
  }

  // --- Mutex Concurrency Helper ---
  async withLock(operation) {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this.mutexLocked = true;
        try {
          const result = await operation();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.mutexLocked = false;
          if (this.mutexQueue.length > 0) {
            const next = this.mutexQueue.shift();
            next();
          }
        }
      };

      if (this.mutexLocked) {
        this.mutexQueue.push(execute);
      } else {
        execute();
      }
    });
  }

  // --- Seat Map Initialization ---
  initSeats() {
    this.seats = {};
    for (let row = 1; row <= 8; row++) {
      ['A', 'B', 'C', 'D'].forEach(col => {
        const id = `${row}${col}`;
        this.seats[id] = {
          id,
          row,
          col,
          isLadies: this.LADIES_SEATS.has(id),
          isWindow: col === 'A' || col === 'D',
          isAisle: col === 'B' || col === 'C',
          status: 'AVAILABLE', // 'AVAILABLE' | 'HELD' | 'BOOKED'
          holdToken: null,
          holdExpiresAt: null,
          bookingRef: null
        };
      });
    }
  }

  // --- Real-time SSE Broadcast ---
  subscribeSSE(res) {
    this.sseClients.add(res);
    res.on('close', () => {
      this.sseClients.delete(res);
    });
    // Send immediate snapshot on connect
    res.write(`data: ${JSON.stringify({ type: 'SYNC_STATE', state: this.getClientState() })}\n\n`);
  }

  broadcast(eventType, payload = {}) {
    const data = JSON.stringify({ type: eventType, payload, state: this.getClientState() });
    for (const client of this.sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch (err) {
        this.sseClients.delete(client);
      }
    }
  }

  // --- Hold Reaper (Executes Every 1 Second) ---
  startHoldReaper() {
    this.reaperInterval = setInterval(() => {
      this.reapExpiredHolds();
    }, 1000);
    if (this.reaperInterval && this.reaperInterval.unref) {
      this.reaperInterval.unref();
    }
  }

  stop() {
    if (this.reaperInterval) clearInterval(this.reaperInterval);
  }

  reapExpiredHolds() {
    const now = Date.now();
    let changed = false;

    for (const [token, session] of this.holdSessions.entries()) {
      if (now > session.expiresAt) {
        // Hold has expired!
        session.seatIds.forEach(seatId => {
          const seat = this.seats[seatId];
          if (seat && seat.status === 'HELD' && seat.holdToken === token) {
            seat.status = 'AVAILABLE';
            seat.holdToken = null;
            seat.holdExpiresAt = null;
            changed = true;
          }
        });
        session.status = 'EXPIRED';
        this.expiredSessions.set(token, session);
        this.holdSessions.delete(token);
      }
    }

    // Safety sweep on seats
    for (const seat of Object.values(this.seats)) {
      if (seat.status === 'HELD' && seat.holdExpiresAt && now > seat.holdExpiresAt) {
        seat.status = 'AVAILABLE';
        seat.holdToken = null;
        seat.holdExpiresAt = null;
        changed = true;
      }
    }

    if (changed) {
      this.broadcast('HOLDS_EXPIRED');
    }
  }

  // --- Client-Safe View (No Passenger Names on Seat Map!) ---
  getClientState(clientHoldToken = null) {
    const now = Date.now();
    const sanitizedSeats = {};

    for (const [id, s] of Object.entries(this.seats)) {
      let displayStatus = s.status;
      let isMyHold = false;
      let remainingSec = 0;

      if (s.status === 'HELD') {
        if (s.holdExpiresAt && now > s.holdExpiresAt) {
          displayStatus = 'AVAILABLE';
        } else {
          isMyHold = clientHoldToken && s.holdToken === clientHoldToken;
          remainingSec = s.holdExpiresAt ? Math.max(0, Math.ceil((s.holdExpiresAt - now) / 1000)) : 0;
        }
      }

      sanitizedSeats[id] = {
        id: s.id,
        row: s.row,
        col: s.col,
        isLadies: s.isLadies,
        isWindow: s.isWindow,
        isAisle: s.isAisle,
        status: displayStatus,
        isMyHold,
        remainingSec
        // Notice: NEVER expose s.passengerName or s.bookingRef to public client state!
      };
    }

    return {
      route: {
        number: 'BL-PN-01',
        from: 'Pune',
        to: 'Nashik',
        departureTime: '22:30 IST',
        boardingPoints: this.BOARDING_POINTS
      },
      seats: sanitizedSeats,
      baseFare: this.currentBaseFare,
      convenienceFee: this.CONVENIENCE_FEE,
      gstPercent: this.GST_PERCENT,
      serverTime: now,
      buildInfo: this.buildInfo
    };
  }

  // --- Seat Selection & Hold Acquisition (Atomic Mutex Guarded) ---
  async toggleSeatHold(requestedSeatId, existingToken = null) {
    return this.withLock(async () => {
      const now = Date.now();
      const seat = this.seats[requestedSeatId];
      if (!seat) {
        throw { code: 404, message: `Seat ${requestedSeatId} does not exist.` };
      }

      // Check if user already has an active session
      let session = existingToken ? this.holdSessions.get(existingToken) : null;
      if (session && now > session.expiresAt) {
        this.holdSessions.delete(existingToken);
        session = null;
        existingToken = null;
      }

      // Action 1: If seat is already held by this user -> Deselect / Release
      if (session && seat.status === 'HELD' && seat.holdToken === session.holdToken) {
        seat.status = 'AVAILABLE';
        seat.holdToken = null;
        seat.holdExpiresAt = null;
        session.seatIds = session.seatIds.filter(id => id !== requestedSeatId);

        if (session.seatIds.length === 0) {
          this.holdSessions.delete(session.holdToken);
          this.broadcast('SEAT_RELEASED', { seatId: requestedSeatId });
          return { holdToken: null, selectedSeats: [], remainingSec: 0 };
        }

        this.broadcast('SEAT_RELEASED', { seatId: requestedSeatId });
        const remainingSec = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
        return {
          holdToken: session.holdToken,
          selectedSeats: session.seatIds,
          expiresAt: session.expiresAt,
          remainingSec
        };
      }

      // Action 2: If seat is already booked -> Reject
      if (seat.status === 'BOOKED') {
        throw { code: 409, message: `Seat ${requestedSeatId} is already booked.` };
      }

      // Action 3: If seat is held by another customer
      if (seat.status === 'HELD' && seat.holdExpiresAt && now <= seat.holdExpiresAt) {
        if (!session || seat.holdToken !== session.holdToken) {
          throw { code: 409, message: `Seat ${requestedSeatId} was just reserved by another passenger.` };
        }
      }

      // Action 4: Claiming seat
      // Validate maximum 4 seats per booking
      const currentSelectedCount = session ? session.seatIds.length : 0;
      if (currentSelectedCount >= 4) {
        throw { code: 400, message: 'A customer may book up to four seats in one booking.' };
      }

      if (!session) {
        // Create new hold session
        const newToken = 'hold_' + crypto.randomBytes(8).toString('hex');
        const durationSec = this.defaultHoldDuration;
        const expiresAt = now + (durationSec * 1000);

        session = {
          holdToken: newToken,
          seatIds: [requestedSeatId],
          lockedBaseFare: this.currentBaseFare,
          createdAt: now,
          expiresAt,
          durationSeconds: durationSec,
          passengerData: [],
          boardingPointId: this.BOARDING_POINTS[0].id
        };
        this.holdSessions.set(newToken, session);
      } else {
        // Add seat to existing session (duration anchors to initial session start to prevent squatting)
        session.seatIds.push(requestedSeatId);
      }

      seat.status = 'HELD';
      seat.holdToken = session.holdToken;
      seat.holdExpiresAt = session.expiresAt;

      this.broadcast('SEAT_HELD', { seatId: requestedSeatId });

      const remainingSec = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
      return {
        holdToken: session.holdToken,
        selectedSeats: session.seatIds,
        expiresAt: session.expiresAt,
        remainingSec,
        lockedBaseFare: session.lockedBaseFare
      };
    });
  }

  // --- Fare Calculator (Worked to the exact Rupee) ---
  calculateFare(seatCount, baseFareOverride = null) {
    const baseFare = baseFareOverride !== null ? baseFareOverride : this.currentBaseFare;
    const seatSubtotal = baseFare * seatCount;
    const convenienceFee = seatCount > 0 ? this.CONVENIENCE_FEE : 0;
    const taxableAmount = seatSubtotal + convenienceFee;
    const gstAmount = Math.round(taxableAmount * (this.GST_PERCENT / 100)); // Half-up integer rounding
    const grandTotal = taxableAmount + gstAmount;

    return {
      seatCount,
      baseFarePerSeat: baseFare,
      seatSubtotal,
      convenienceFee,
      taxableAmount,
      gstPercent: this.GST_PERCENT,
      gstAmount,
      grandTotal
    };
  }

  // --- Session Validation & Recovery ---
  getSession(token) {
    if (!token) return null;
    const session = this.holdSessions.get(token);
    if (!session) return null;
    const now = Date.now();
    if (now > session.expiresAt) {
      this.holdSessions.delete(token);
      return null;
    }
    const remainingSec = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
    return {
      holdToken: session.holdToken,
      seatIds: session.seatIds,
      expiresAt: session.expiresAt,
      remainingSec,
      lockedBaseFare: session.lockedBaseFare,
      boardingPointId: session.boardingPointId,
      passengerData: session.passengerData,
      fare: this.calculateFare(session.seatIds.length, session.lockedBaseFare)
    };
  }

  // --- Save Passenger Data & Boarding Point ---
  savePassengerDetails(token, { passengers, infants = [], boardingPointId }) {
    const session = this.holdSessions.get(token);
    if (!session || Date.now() > session.expiresAt) {
      throw { code: 400, message: 'Reservation hold has expired. Please select seats again.' };
    }

    if (!Array.isArray(passengers) || passengers.length !== session.seatIds.length) {
      throw { code: 400, message: `Details required for exactly ${session.seatIds.length} seated passenger(s).` };
    }

    // Validate boarding point exists
    const bp = this.BOARDING_POINTS.find(p => p.id === boardingPointId);
    if (!bp) {
      throw { code: 400, message: 'Please select a valid boarding point.' };
    }

    // Strict validation per passenger
    const validatedPassengers = [];
    passengers.forEach((p, index) => {
      const assignedSeatId = session.seatIds[index];
      const isLadies = this.LADIES_SEATS.has(assignedSeatId);

      const name = (p.name || '').trim();
      const age = parseInt(p.age, 10);
      const gender = (p.gender || '').trim();
      const phone = (p.phone || '').trim();

      if (!name || name.length < 2 || name.length > 50) {
        throw { code: 422, message: `Passenger ${index + 1}: Name must be between 2 and 50 characters.` };
      }
      if (isNaN(age) || age < 5 || age > 120) {
        throw { code: 422, message: `Passenger ${index + 1}: Seated passengers must be age 5 or older (under 5 travel free as lap infants).` };
      }
      if (!['Female', 'Male', 'Other'].includes(gender)) {
        throw { code: 422, message: `Passenger ${index + 1}: Please specify a valid gender.` };
      }
      if (isLadies && gender !== 'Female') {
        throw { code: 422, message: `Seat ${assignedSeatId} is a ladies seat and can only be booked by a female passenger.` };
      }
      if (index === 0 && !/^[6-9]\d{9}$/.test(phone)) {
        throw { code: 422, message: 'Primary passenger must provide a valid 10-digit Indian mobile number.' };
      }

      validatedPassengers.push({
        seatId: assignedSeatId,
        name,
        age,
        gender,
        phone: index === 0 ? phone : (phone || validatedPassengers[0]?.phone)
      });
    });

    // Validate infants: max 1 lap infant per adult passenger (age >= 18)
    const adultCount = validatedPassengers.filter(p => p.age >= 18).length;
    if (infants.length > adultCount) {
      throw { code: 422, message: `Maximum ${adultCount} lap infant(s) permitted for the adult passenger(s) in this booking.` };
    }

    const validatedInfants = infants.map(inf => {
      const name = (inf.name || '').trim();
      const age = parseInt(inf.age, 10);
      if (!name) throw { code: 422, message: 'Lap infant must have a name.' };
      if (isNaN(age) || age < 0 || age >= 5) {
        throw { code: 422, message: 'Lap infants must be under 5 years of age.' };
      }
      return { name, age, gender: inf.gender || 'Unknown' };
    });

    session.passengerData = validatedPassengers;
    session.infants = validatedInfants;
    session.boardingPointId = boardingPointId;

    return {
      status: 'DETAILS_SAVED',
      fare: this.calculateFare(session.seatIds.length, session.lockedBaseFare),
      boardingPoint: bp
    };
  }

  // --- Process Payment & Gateway Execution ---
  async processPayment({ holdToken, paymentMethod = 'UPI', idempotencyKey = null, clientReportedAmount = null }) {
    return this.withLock(async () => {
      const now = Date.now();

      // Check idempotency cache first
      if (idempotencyKey && this.idempotentKeys.has(idempotencyKey)) {
        const cached = this.idempotentKeys.get(idempotencyKey);
        return { ...cached, isDuplicate: true };
      }

      const session = this.holdSessions.get(holdToken) || this.expiredSessions.get(holdToken);
      const isHoldActive = session && session.status !== 'EXPIRED' && now <= session.expiresAt;

      // Handle Late Payment Edge Case (Hold Expired)
      if (!session || !isHoldActive) {
        // Did another customer already take any of the seats?
        const seatIds = session ? session.seatIds : [];
        const isAnySeatTaken = seatIds.some(sid => this.seats[sid]?.status === 'BOOKED' || (this.seats[sid]?.status === 'HELD' && this.seats[sid]?.holdToken !== holdToken));

        const refundTxnId = 'REF-AUTO-' + crypto.randomBytes(5).toString('hex').toUpperCase();
        const refundRecord = {
          refundTxnId,
          timestamp: now,
          holdToken,
          reason: isAnySeatTaken ? 'SEAT_TAKEN_BY_ANOTHER' : 'HOLD_EXPIRED_BEFORE_SETTLEMENT',
          amount: session ? this.calculateFare(session.seatIds.length, session.lockedBaseFare).grandTotal : 0,
          status: 'REFUND_SETTLED_AUTOMATIC'
        };
        this.refundLedger.push(refundRecord);

        throw {
          code: 409,
          type: 'LATE_PAYMENT_REFUNDED',
          message: 'Payment cleared after the hold expired and seat was allocated to another passenger. A full refund has been automatically initiated.',
          refundDetails: refundRecord
        };
      }

      // Calculate authoritative server fare
      const fare = this.calculateFare(session.seatIds.length, session.lockedBaseFare);

      // Verify client did not tamper with amount
      if (clientReportedAmount !== null && Number(clientReportedAmount) !== fare.grandTotal) {
        throw {
          code: 400,
          message: `Security validation failed: Fare amount tampered. Expected ₹${fare.grandTotal}, received ₹${clientReportedAmount}.`
        };
      }

      // Check passenger details were submitted
      if (!session.passengerData || session.passengerData.length !== session.seatIds.length) {
        throw { code: 400, message: 'Passenger details must be completed before payment.' };
      }

      // Execute Simulated Gateway Behavior
      if (this.gatewayMode === 'FAIL') {
        throw { code: 402, message: 'Payment declined by issuing bank (Simulated Gateway Failure).' };
      }

      if (this.gatewayMode === 'TIMEOUT') {
        throw { code: 504, message: 'Payment gateway timed out waiting for bank switch response.' };
      }

      // If Late Success mode is triggered, simulate hold expiring before confirmation
      if (this.gatewayMode === 'LATE_SUCCESS') {
        // Expire hold immediately
        session.expiresAt = now - 1000;
        this.reapExpiredHolds();

        const refundTxnId = 'REF-LATE-' + crypto.randomBytes(5).toString('hex').toUpperCase();
        const refundRecord = {
          refundTxnId,
          timestamp: now,
          holdToken,
          reason: 'LATE_PAYMENT_SIMULATION',
          amount: fare.grandTotal,
          status: 'REFUND_SETTLED_AUTOMATIC'
        };
        this.refundLedger.push(refundRecord);

        throw {
          code: 409,
          type: 'LATE_PAYMENT_REFUNDED',
          message: 'Payment completed late after reservation hold expired. Full automated refund issued.',
          refundDetails: refundRecord
        };
      }

      // SUCCESS PATH: Allocate seats atomically and create booking
      const bookingRef = 'BL-PN-' + Math.floor(100000 + Math.random() * 900000);
      const paymentTxnId = 'TXN-' + crypto.randomBytes(6).toString('hex').toUpperCase();

      session.seatIds.forEach(seatId => {
        const seat = this.seats[seatId];
        seat.status = 'BOOKED';
        seat.holdToken = null;
        seat.holdExpiresAt = null;
        seat.bookingRef = bookingRef;
      });

      const bp = this.BOARDING_POINTS.find(p => p.id === session.boardingPointId) || this.BOARDING_POINTS[0];

      const bookingRecord = {
        bookingRef,
        holdToken,
        seatIds: [...session.seatIds],
        passengers: session.passengerData,
        infants: session.infants || [],
        boardingPoint: bp,
        departureTime: '22:30 IST',
        fareSummary: fare,
        paymentStatus: 'PAID',
        paymentTxnId,
        createdAt: now,
        cancelledAt: null,
        refundStatus: 'NONE'
      };

      this.bookings.set(bookingRef, bookingRecord);
      this.holdSessions.delete(holdToken);

      const responsePayload = {
        status: 'CONFIRMED',
        booking: bookingRecord
      };

      if (idempotencyKey) {
        this.idempotentKeys.set(idempotencyKey, responsePayload);
      }

      this.broadcast('SEATS_BOOKED', { seatIds: bookingRecord.seatIds });

      return responsePayload;
    });
  }

  // --- Cancellation & Refund Processing ---
  cancelBooking(bookingRef) {
    const booking = this.bookings.get(bookingRef);
    if (!booking) {
      throw { code: 404, message: `Booking reference ${bookingRef} not found.` };
    }
    if (booking.paymentStatus !== 'PAID') {
      throw { code: 400, message: 'Cannot cancel an unpaid or draft reservation.' };
    }
    if (booking.cancelledAt) {
      throw { code: 400, message: 'This booking has already been cancelled.' };
    }

    const now = Date.now();
    // Simulate journey departure calculation:
    // Departure is fixed at 22:30 IST today
    const refundPct = 50; // default for demo simulation (<24 hours)
    const baseRefund = Math.round(booking.fareSummary.seatSubtotal * (refundPct / 100));
    const gstRefund = Math.round(baseRefund * (this.GST_PERCENT / 100));
    const totalRefund = baseRefund + gstRefund;

    booking.cancelledAt = now;
    booking.refundStatus = 'CANCELLATION_CONFIRMED_REFUND_INITIATED';
    booking.refundAmount = totalRefund;

    // Release booked seats back to pool
    booking.seatIds.forEach(sid => {
      const seat = this.seats[sid];
      if (seat && seat.bookingRef === bookingRef) {
        seat.status = 'AVAILABLE';
        seat.bookingRef = null;
      }
    });

    this.broadcast('SEATS_RELEASED', { seatIds: booking.seatIds });

    return {
      status: 'CANCELLED',
      bookingRef,
      refundStatus: booking.refundStatus,
      refundAmount: totalRefund,
      estimatedSettlementDays: '5-7 working days'
    };
  }

  // --- Dev Panel API Endpoints (?dev=1) ---

  devExpireHold(token) {
    const session = this.holdSessions.get(token);
    if (session) {
      session.expiresAt = Date.now() - 1000;
      this.reapExpiredHolds();
      return { success: true, message: `Hold ${token} expired immediately.` };
    }
    return { success: false, message: 'Hold session not found.' };
  }

  devSetHoldDuration(durationSec) {
    const sec = Math.max(5, parseInt(durationSec, 10));
    this.defaultHoldDuration = sec;
    return { success: true, defaultHoldDuration: sec };
  }

  devSetGatewayMode(mode) {
    if (['SUCCESS', 'FAIL', 'TIMEOUT', 'LATE_SUCCESS'].includes(mode)) {
      this.gatewayMode = mode;
      return { success: true, gatewayMode: mode };
    }
    throw { code: 400, message: 'Invalid gateway mode.' };
  }

  devStealSeat(seatId) {
    const seat = this.seats[seatId];
    if (!seat) throw { code: 404, message: 'Seat not found.' };

    const ghostRef = 'BL-DEV-STOLEN-' + Math.floor(100 + Math.random() * 900);
    seat.status = 'BOOKED';
    seat.holdToken = null;
    seat.holdExpiresAt = null;
    seat.bookingRef = ghostRef;

    // Invalidate any session that was holding it
    for (const session of this.holdSessions.values()) {
      if (session.seatIds.includes(seatId)) {
        session.seatIds = session.seatIds.filter(id => id !== seatId);
      }
    }

    this.broadcast('SEAT_HIJACKED', { seatId });
    return { success: true, seatId, bookingRef: ghostRef };
  }

  devSetPreset(presetName) {
    this.initSeats();
    this.holdSessions.clear();

    if (presetName === 'empty') {
      // all available
    } else if (presetName === 'one-left') {
      // 31 seats booked, 8D available
      for (const [id, s] of Object.entries(this.seats)) {
        if (id !== '8D') {
          s.status = 'BOOKED';
          s.bookingRef = 'BL-DEV-PRESET';
        }
      }
    } else if (presetName === 'full') {
      // all 32 booked
      for (const s of Object.values(this.seats)) {
        s.status = 'BOOKED';
        s.bookingRef = 'BL-DEV-PRESET';
      }
    } else if (presetName === 'ladies-gone') {
      // 3A, 3B, 4A, 4B booked
      this.LADIES_SEATS.forEach(sid => {
        if (this.seats[sid]) {
          this.seats[sid].status = 'BOOKED';
          this.seats[sid].bookingRef = 'BL-DEV-LADIES';
        }
      });
    }

    this.broadcast('PRESET_APPLIED', { preset: presetName });
    return { success: true, preset: presetName };
  }

  devSetBaseFare(fare) {
    const val = parseInt(fare, 10);
    if (isNaN(val) || val < 100) throw { code: 400, message: 'Base fare must be >= ₹100' };
    this.currentBaseFare = val;
    this.broadcast('FARE_CHANGED', { baseFare: val });
    return { success: true, baseFare: val };
  }

  devSetLatency(ms) {
    this.networkLatencyMs = Math.max(0, parseInt(ms, 10) || 0);
    return { success: true, latencyMs: this.networkLatencyMs };
  }

  devReset() {
    this.initSeats();
    this.holdSessions.clear();
    this.bookings.clear();
    this.idempotentKeys.clear();
    this.refundLedger = [];
    this.currentBaseFare = this.DEFAULT_BASE_FARE;
    this.gatewayMode = 'SUCCESS';
    this.networkLatencyMs = 0;
    this.defaultHoldDuration = this.DEFAULT_HOLD_DURATION_SEC;
    this.broadcast('SYSTEM_RESET');
    return { success: true, message: 'Entire bus state reset to pristine default.' };
  }

  // --- Live Raw State Inspector (For ?dev=1 and 1-Click State Copy) ---
  getRawState() {
    const seatsArray = Object.values(this.seats).map(s => ({
      id: s.id,
      status: s.status,
      holdToken: s.holdToken,
      holdExpiresAt: s.holdExpiresAt,
      bookingRef: s.bookingRef
    }));

    const sessionsArray = Array.from(this.holdSessions.entries()).map(([token, sess]) => ({
      token,
      seats: sess.seatIds,
      remainingSec: Math.max(0, Math.ceil((sess.expiresAt - Date.now()) / 1000)),
      lockedBaseFare: sess.lockedBaseFare
    }));

    return {
      timestamp: new Date().toISOString(),
      epoch: Date.now(),
      buildInfo: this.buildInfo,
      simulationControls: {
        currentBaseFare: this.currentBaseFare,
        gatewayMode: this.gatewayMode,
        networkLatencyMs: this.networkLatencyMs,
        defaultHoldDuration: this.defaultHoldDuration
      },
      stats: {
        totalSeats: this.TOTAL_SEATS,
        available: seatsArray.filter(s => s.status === 'AVAILABLE').length,
        held: seatsArray.filter(s => s.status === 'HELD').length,
        booked: seatsArray.filter(s => s.status === 'BOOKED').length
      },
      activeHoldSessions: sessionsArray,
      confirmedBookingsCount: this.bookings.size,
      refundLedgerCount: this.refundLedger.length,
      seats: seatsArray
    };
  }
}

module.exports = BusLaneEngine;
