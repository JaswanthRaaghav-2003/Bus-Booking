// public/app.js
// BusLane Client Application & Distributed Verification Suite
// Dual-mode architecture: seamlessly connects to Node.js Express backend OR falls back
// to an embedded in-browser engine with BroadcastChannel for 100% functionality on static hosts like Netlify!

class LocalMockEngine {
  constructor() {
    this.STORAGE_KEY = 'buslane_local_state';
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('buslane_sync_channel') : null;
    this.LADIES_SEATS = new Set(['3A', '3B', '4A', '4B']);
    this.BOARDING_POINTS = [
      { id: 'bp_1', name: 'Pune Swargate', time: '22:30 IST', landmark: 'Platform 3, Opp. Bus Depot' },
      { id: 'bp_2', name: 'Shivaji Nagar', time: '22:50 IST', landmark: 'Under Flyover, Bus Lane' },
      { id: 'bp_3', name: 'Nashik Phata', time: '23:15 IST', landmark: 'Kasargawadi Signal' },
      { id: 'bp_4', name: 'Bhosari', time: '23:45 IST', landmark: 'Landewadi Chowk' }
    ];
    this.loadState();
    this.startReaper();
  }

  loadState() {
    const raw = localStorage.getItem(this.STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        this.seats = parsed.seats || this.createSeats();
        this.holdSessions = parsed.holdSessions || {};
        this.bookings = parsed.bookings || {};
        this.refundLedger = parsed.refundLedger || [];
        this.baseFare = parsed.baseFare || 450;
        this.gatewayMode = parsed.gatewayMode || 'SUCCESS';
        this.defaultHoldDuration = parsed.defaultHoldDuration || 600;
        return;
      } catch (err) {}
    }
    this.resetState();
  }

  saveState() {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
      seats: this.seats,
      holdSessions: this.holdSessions,
      bookings: this.bookings,
      refundLedger: this.refundLedger,
      baseFare: this.baseFare,
      gatewayMode: this.gatewayMode,
      defaultHoldDuration: this.defaultHoldDuration
    }));
  }

  notifyBroadcast(type, payload = {}) {
    this.saveState();
    if (this.channel) {
      this.channel.postMessage({ type, payload, state: this.getClientState() });
    }
  }

  createSeats() {
    const seats = {};
    for (let row = 1; row <= 8; row++) {
      ['A', 'B', 'C', 'D'].forEach(col => {
        const id = `${row}${col}`;
        seats[id] = {
          id,
          row,
          col,
          isLadies: this.LADIES_SEATS.has(id),
          isWindow: col === 'A' || col === 'D',
          isAisle: col === 'B' || col === 'C',
          status: 'AVAILABLE',
          holdToken: null,
          holdExpiresAt: null,
          bookingRef: null
        };
      });
    }
    return seats;
  }

  resetState() {
    this.seats = this.createSeats();
    this.holdSessions = {};
    this.bookings = {};
    this.refundLedger = [];
    this.baseFare = 450;
    this.gatewayMode = 'SUCCESS';
    this.defaultHoldDuration = 600;
    this.saveState();
  }

  startReaper() {
    setInterval(() => {
      this.reap();
    }, 1000);
  }

  reap() {
    const now = Date.now();
    let changed = false;
    for (const [token, session] of Object.entries(this.holdSessions)) {
      if (now > session.expiresAt) {
        session.seatIds.forEach(sid => {
          if (this.seats[sid] && this.seats[sid].holdToken === token) {
            this.seats[sid].status = 'AVAILABLE';
            this.seats[sid].holdToken = null;
            this.seats[sid].holdExpiresAt = null;
            changed = true;
          }
        });
        delete this.holdSessions[token];
      }
    }
    if (changed) {
      this.notifyBroadcast('HOLDS_EXPIRED');
    }
  }

  getClientState(token = null) {
    const now = Date.now();
    const sanitized = {};
    for (const [id, s] of Object.entries(this.seats)) {
      let displayStatus = s.status;
      let isMyHold = false;
      let remainingSec = 0;
      if (s.status === 'HELD') {
        if (s.holdExpiresAt && now > s.holdExpiresAt) {
          displayStatus = 'AVAILABLE';
        } else {
          isMyHold = token && s.holdToken === token;
          remainingSec = s.holdExpiresAt ? Math.max(0, Math.ceil((s.holdExpiresAt - now) / 1000)) : 0;
        }
      }
      sanitized[id] = {
        id: s.id,
        row: s.row,
        col: s.col,
        isLadies: s.isLadies,
        isWindow: s.isWindow,
        isAisle: s.isAisle,
        status: displayStatus,
        isMyHold,
        remainingSec
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
      seats: sanitized,
      baseFare: this.baseFare,
      convenienceFee: 30,
      gstPercent: 5,
      serverTime: now,
      buildInfo: { version: 'v1.0.4-netlify-ready', environment: 'static-browser-sync' }
    };
  }

  calculateFare(count, baseOverride = null) {
    const base = baseOverride || this.baseFare;
    const subtotal = base * count;
    const fee = count > 0 ? 30 : 0;
    const taxable = subtotal + fee;
    const gst = Math.round(taxable * 0.05);
    return {
      seatCount: count,
      baseFarePerSeat: base,
      seatSubtotal: subtotal,
      convenienceFee: fee,
      taxableAmount: taxable,
      gstPercent: 5,
      gstAmount: gst,
      grandTotal: taxable + gst
    };
  }

  toggleSeat(seatId, existingToken) {
    this.loadState();
    const now = Date.now();
    const seat = this.seats[seatId];
    if (!seat) throw { code: 404, message: 'Seat not found' };

    let session = existingToken ? this.holdSessions[existingToken] : null;
    if (session && now > session.expiresAt) {
      delete this.holdSessions[existingToken];
      session = null;
    }

    if (session && seat.status === 'HELD' && seat.holdToken === session.holdToken) {
      // Release
      seat.status = 'AVAILABLE';
      seat.holdToken = null;
      seat.holdExpiresAt = null;
      session.seatIds = session.seatIds.filter(id => id !== seatId);
      if (session.seatIds.length === 0) {
        delete this.holdSessions[session.holdToken];
        this.notifyBroadcast('SEAT_RELEASED');
        return { holdToken: null, selectedSeats: [], remainingSec: 0 };
      }
      this.notifyBroadcast('SEAT_RELEASED');
      return {
        holdToken: session.holdToken,
        selectedSeats: session.seatIds,
        expiresAt: session.expiresAt,
        remainingSec: Math.max(0, Math.ceil((session.expiresAt - now) / 1000))
      };
    }

    if (seat.status === 'BOOKED') throw { code: 409, message: 'Seat is already booked.' };
    if (seat.status === 'HELD' && (!session || seat.holdToken !== session.holdToken)) {
      throw { code: 409, message: 'Seat was just reserved by another passenger.' };
    }

    const currentCount = session ? session.seatIds.length : 0;
    if (currentCount >= 4) throw { code: 400, message: 'Maximum 4 seats allowed per booking.' };

    if (!session) {
      const newToken = 'hold_local_' + Math.random().toString(36).substring(2, 9);
      const duration = this.defaultHoldDuration;
      const expiresAt = now + (duration * 1000);
      session = {
        holdToken: newToken,
        seatIds: [seatId],
        lockedBaseFare: this.baseFare,
        createdAt: now,
        expiresAt,
        durationSeconds: duration,
        passengerData: [],
        boardingPointId: 'bp_1'
      };
      this.holdSessions[newToken] = session;
    } else {
      session.seatIds.push(seatId);
    }

    seat.status = 'HELD';
    seat.holdToken = session.holdToken;
    seat.holdExpiresAt = session.expiresAt;

    this.notifyBroadcast('SEAT_HELD');
    return {
      holdToken: session.holdToken,
      selectedSeats: session.seatIds,
      expiresAt: session.expiresAt,
      remainingSec: Math.max(0, Math.ceil((session.expiresAt - now) / 1000)),
      lockedBaseFare: session.lockedBaseFare
    };
  }

  savePassengers(token, { passengers, infants = [], boardingPointId }) {
    this.loadState();
    const session = this.holdSessions[token];
    if (!session || Date.now() > session.expiresAt) {
      throw { code: 400, message: 'Hold session expired.' };
    }
    const bp = this.BOARDING_POINTS.find(p => p.id === boardingPointId) || this.BOARDING_POINTS[0];
    session.passengerData = passengers.map((p, idx) => ({
      seatId: session.seatIds[idx],
      name: p.name,
      age: p.age,
      gender: p.gender,
      phone: p.phone
    }));
    session.infants = infants;
    session.boardingPointId = boardingPointId;
    this.saveState();
    return {
      status: 'DETAILS_SAVED',
      fare: this.calculateFare(session.seatIds.length, session.lockedBaseFare),
      boardingPoint: bp
    };
  }

  pay({ holdToken, paymentMethod }) {
    this.loadState();
    const now = Date.now();
    const session = this.holdSessions[holdToken];

    if (!session || now > session.expiresAt || this.gatewayMode === 'LATE_SUCCESS') {
      const refundId = 'REF-AUTO-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      this.refundLedger.push({ refundTxnId: refundId, timestamp: now, amount: 504 });
      this.saveState();
      throw {
        code: 409,
        type: 'LATE_PAYMENT_REFUNDED',
        message: 'Payment received after hold expired. Full automatic refund initiated.',
        refundDetails: { refundTxnId: refundId, amount: 504, reason: 'SEAT_TAKEN_BY_ANOTHER' }
      };
    }

    if (this.gatewayMode === 'FAIL') {
      throw { code: 402, message: 'Payment declined by issuing bank (Simulated Failure).' };
    }
    if (this.gatewayMode === 'TIMEOUT') {
      throw { code: 504, message: 'Payment gateway timed out.' };
    }

    const bookingRef = 'BL-PN-' + Math.floor(100000 + Math.random() * 900000);
    const txnId = 'TXN-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    session.seatIds.forEach(sid => {
      this.seats[sid].status = 'BOOKED';
      this.seats[sid].holdToken = null;
      this.seats[sid].holdExpiresAt = null;
      this.seats[sid].bookingRef = bookingRef;
    });

    const bp = this.BOARDING_POINTS.find(p => p.id === session.boardingPointId) || this.BOARDING_POINTS[0];
    const fare = this.calculateFare(session.seatIds.length, session.lockedBaseFare);

    const booking = {
      bookingRef,
      holdToken,
      seatIds: [...session.seatIds],
      passengers: session.passengerData,
      infants: session.infants || [],
      boardingPoint: bp,
      departureTime: '22:30 IST',
      fareSummary: fare,
      paymentStatus: 'PAID',
      paymentTxnId: txnId,
      createdAt: now
    };

    this.bookings[bookingRef] = booking;
    delete this.holdSessions[holdToken];

    this.notifyBroadcast('SEATS_BOOKED');
    return { status: 'CONFIRMED', booking };
  }

  cancelBooking(ref) {
    this.loadState();
    const booking = this.bookings[ref];
    if (!booking) throw { code: 404, message: 'Booking not found' };
    booking.cancelledAt = Date.now();
    booking.refundStatus = 'CANCELLATION_CONFIRMED_REFUND_INITIATED';
    booking.seatIds.forEach(sid => {
      if (this.seats[sid]) {
        this.seats[sid].status = 'AVAILABLE';
        this.seats[sid].bookingRef = null;
      }
    });
    this.notifyBroadcast('SEATS_RELEASED');
    return {
      status: 'CANCELLED',
      bookingRef: ref,
      refundStatus: booking.refundStatus,
      refundAmount: Math.round(booking.fareSummary.grandTotal * 0.5),
      estimatedSettlementDays: '5-7 working days'
    };
  }

  devExpireHold(token) {
    this.loadState();
    if (this.holdSessions[token]) {
      this.holdSessions[token].expiresAt = Date.now() - 1000;
      this.reap();
      return { success: true, message: 'Hold expired immediately.' };
    }
    return { success: false, message: 'Session not found' };
  }

  devStealSeat(seatId) {
    this.loadState();
    if (!this.seats[seatId]) throw { code: 404, message: 'Seat not found' };
    this.seats[seatId].status = 'BOOKED';
    this.seats[seatId].bookingRef = 'BL-DEV-STOLEN';
    this.seats[seatId].holdToken = null;
    this.seats[seatId].holdExpiresAt = null;
    this.notifyBroadcast('SEAT_HIJACKED');
    return { success: true, seatId, bookingRef: 'BL-DEV-STOLEN' };
  }

  devSetPreset(preset) {
    this.resetState();
    if (preset === 'one-left') {
      Object.values(this.seats).forEach(s => {
        if (s.id !== '8D') {
          s.status = 'BOOKED';
          s.bookingRef = 'BL-DEV-PRESET';
        }
      });
    } else if (preset === 'full') {
      Object.values(this.seats).forEach(s => {
        s.status = 'BOOKED';
        s.bookingRef = 'BL-DEV-PRESET';
      });
    } else if (preset === 'ladies-gone') {
      this.LADIES_SEATS.forEach(id => {
        this.seats[id].status = 'BOOKED';
        this.seats[id].bookingRef = 'BL-DEV-LADIES';
      });
    }
    this.notifyBroadcast('PRESET_APPLIED');
    return { success: true, preset };
  }

  getRawState() {
    this.loadState();
    const seatsArray = Object.values(this.seats).map(s => ({
      id: s.id,
      status: s.status,
      holdToken: s.holdToken,
      holdExpiresAt: s.holdExpiresAt,
      bookingRef: s.bookingRef
    }));
    return {
      timestamp: new Date().toISOString(),
      mode: 'Client-Side Engine (Netlify Ready)',
      baseFare: this.baseFare,
      gatewayMode: this.gatewayMode,
      activeHolds: Object.keys(this.holdSessions).length,
      bookingsCount: Object.keys(this.bookings).length,
      stats: {
        totalSeats: 32,
        available: seatsArray.filter(s => s.status === 'AVAILABLE').length,
        held: seatsArray.filter(s => s.status === 'HELD').length,
        booked: seatsArray.filter(s => s.status === 'BOOKED').length
      },
      seats: seatsArray
    };
  }
}

// Global Browser App Controller
class BusLaneApp {
  constructor() {
    this.currentStep = 1;
    this.holdToken = localStorage.getItem('buslane_hold_token') || null;
    this.selectedSeats = [];
    this.seatsData = {};
    this.currentBaseFare = 450;
    this.convenienceFee = 30;
    this.gstPercent = 5;
    this.holdExpiresAt = null;
    this.holdDurationSec = 600;
    this.holdTimerInterval = null;
    this.gatewayTimerInterval = null;
    this.eventSource = null;
    this.isDevMode = false;
    this.serverTimeOffset = 0;
    this.infants = [];
    this.confirmedBooking = null;

    this.localEngine = new LocalMockEngine();
    this.isStaticMode = false; // toggles to true on Netlify / pure static hosting

    this.init();
  }

  init() {
    this.detectDevMode();
    this.bindEvents();
    this.initRealtimeSSE();
    this.checkSessionRecovery();
    this.startDevStatePoller();
  }

  // Dual-mode API requester: delegates to local engine if server is unreachable / static
  async apiRequest(url, options = {}) {
    if (!this.isStaticMode) {
      try {
        const res = await fetch(url, options);
        if (res.status === 404 && url.startsWith('/api/')) {
          this.activateStaticMode();
        } else {
          return res;
        }
      } catch (err) {
        this.activateStaticMode();
      }
    }

    // Static In-Browser Fallback Router
    return this.routeLocalMock(url, options);
  }

  activateStaticMode() {
    if (this.isStaticMode) return;
    this.isStaticMode = true;
    console.log('[BusLane] Static host detected (Netlify). Activated in-browser state engine & BroadcastChannel sync.');
    const syncPill = document.getElementById('sync-status');
    if (syncPill) {
      syncPill.classList.add('online');
      syncPill.querySelector('.sync-label').textContent = 'Live Sync (Browser)';
    }

    if (this.localEngine.channel) {
      this.localEngine.channel.onmessage = (e) => {
        if (e.data && e.data.state) {
          this.applyServerState(e.data.state);
        }
      };
    }
  }

  routeLocalMock(url, options = {}) {
    const body = options.body ? JSON.parse(options.body) : {};
    const method = options.method || 'GET';

    try {
      if (url.startsWith('/api/state')) {
        const token = new URLSearchParams(url.split('?')[1]).get('token');
        return { ok: true, status: 200, json: async () => this.localEngine.getClientState(token) };
      }
      if (url.startsWith('/api/hold/session')) {
        const token = new URLSearchParams(url.split('?')[1]).get('token');
        const sess = this.localEngine.holdSessions[token];
        if (!sess) return { ok: false, status: 404, json: async () => ({ error: 'Session expired' }) };
        const remainingSec = Math.max(0, Math.ceil((sess.expiresAt - Date.now()) / 1000));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            holdToken: sess.holdToken,
            seatIds: sess.seatIds,
            remainingSec,
            expiresAt: sess.expiresAt
          })
        };
      }
      if (url === '/api/hold/toggle') {
        const res = this.localEngine.toggleSeat(body.seatId, body.holdToken);
        return { ok: true, status: 200, json: async () => res };
      }
      if (url === '/api/passengers') {
        const res = this.localEngine.savePassengers(body.token, body);
        return { ok: true, status: 200, json: async () => res };
      }
      if (url === '/api/pay') {
        const res = this.localEngine.pay(body);
        return { ok: true, status: 200, json: async () => res };
      }
      if (url === '/api/booking/cancel') {
        const res = this.localEngine.cancelBooking(body.bookingRef);
        return { ok: true, status: 200, json: async () => res };
      }
      if (url === '/api/dev/expire-hold') {
        const res = this.localEngine.devExpireHold(body.token);
        return { ok: true, status: 200, json: async () => res };
      }
      if (url === '/api/dev/set-hold-duration') {
        this.localEngine.defaultHoldDuration = parseInt(body.durationSec, 10);
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (url === '/api/dev/set-gateway-mode') {
        this.localEngine.gatewayMode = body.mode;
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (url === '/api/dev/steal-seat') {
        const res = this.localEngine.devStealSeat(body.seatId);
        return { ok: true, status: 200, json: async () => res };
      }
      if (url === '/api/dev/preset') {
        const res = this.localEngine.devSetPreset(body.preset);
        return { ok: true, status: 200, json: async () => res };
      }
      if (url === '/api/dev/set-base-fare') {
        this.localEngine.baseFare = parseInt(body.baseFare, 10);
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (url === '/api/dev/reset') {
        this.localEngine.resetState();
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (url === '/api/dev/raw-state') {
        return { ok: true, status: 200, json: async () => this.localEngine.getRawState() };
      }
    } catch (err) {
      return {
        ok: false,
        status: err.code || 500,
        json: async () => ({ error: err.message, type: err.type, refundDetails: err.refundDetails })
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  }

  detectDevMode() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('dev') === '1') {
      this.enableDevMode();
    }
  }

  enableDevMode() {
    this.isDevMode = true;
    const panel = document.getElementById('dev-panel');
    const badge = document.getElementById('dev-toggle-btn');
    if (panel) panel.classList.remove('hidden');
    if (badge) badge.classList.add('active');
  }

  toggleDevMode() {
    this.isDevMode = !this.isDevMode;
    const panel = document.getElementById('dev-panel');
    const badge = document.getElementById('dev-toggle-btn');
    if (panel) panel.classList.toggle('hidden', !this.isDevMode);
    if (badge) badge.classList.toggle('active', this.isDevMode);
  }

  initRealtimeSSE() {
    const syncPill = document.getElementById('sync-status');
    const tokenParam = this.holdToken ? `?token=${this.holdToken}` : '';

    if (this.eventSource) this.eventSource.close();

    try {
      this.eventSource = new EventSource(`/api/events${tokenParam}`);
      this.eventSource.onopen = () => {
        syncPill.classList.add('online');
        syncPill.querySelector('.sync-label').textContent = 'Live Sync';
      };
      this.eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          this.handleServerBroadcast(payload);
        } catch (err) {}
      };
      this.eventSource.onerror = () => {
        // If SSE fails (e.g. on Netlify static host), gracefully switch to static broadcast sync
        this.activateStaticMode();
      };
    } catch (err) {
      this.activateStaticMode();
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.fetchFullState();
      }
    });
  }

  handleServerBroadcast(payload) {
    if (payload.state) this.applyServerState(payload.state);
    if (payload.type === 'HOLDS_EXPIRED' && this.holdToken) {
      this.verifyHoldStatus();
    }
  }

  async fetchFullState() {
    try {
      const url = this.holdToken ? `/api/state?token=${this.holdToken}` : '/api/state';
      const res = await this.apiRequest(url);
      if (res.ok) {
        const data = await res.json();
        this.applyServerState(data);
      }
    } catch (err) {}
  }

  applyServerState(state) {
    if (!state) return;
    this.seatsData = state.seats || {};
    this.currentBaseFare = state.baseFare || 450;
    this.convenienceFee = state.convenienceFee || 30;
    this.gstPercent = state.gstPercent || 5;

    if (state.serverTime) {
      this.serverTimeOffset = state.serverTime - Date.now();
    }

    const baseFareLabel = document.getElementById('legend-base-fare');
    if (baseFareLabel) baseFareLabel.textContent = this.currentBaseFare;

    this.renderSeatMap();
    this.updatePricePreview();
  }

  async checkSessionRecovery() {
    if (!this.holdToken) {
      this.fetchFullState();
      return;
    }
    try {
      const res = await this.apiRequest(`/api/hold/session?token=${this.holdToken}`);
      if (res.ok) {
        const session = await res.json();
        this.selectedSeats = session.seatIds || [];
        this.holdExpiresAt = session.expiresAt;
        this.startHoldTimer(session.remainingSec);
        this.renderSelectedChips();
        this.updatePricePreview();
      } else {
        this.clearLocalHold();
      }
    } catch (err) {
      this.clearLocalHold();
    }
    this.fetchFullState();
  }

  clearLocalHold() {
    this.holdToken = null;
    this.selectedSeats = [];
    this.holdExpiresAt = null;
    localStorage.removeItem('buslane_hold_token');
    clearInterval(this.holdTimerInterval);
    const banner = document.getElementById('hold-banner');
    if (banner) banner.classList.add('hidden');
    this.renderSelectedChips();
    this.updatePricePreview();
  }

  startHoldTimer(initialRemainingSec) {
    clearInterval(this.holdTimerInterval);
    const banner = document.getElementById('hold-banner');
    const countdownEl = document.getElementById('hold-countdown');
    const progressEl = document.getElementById('hold-progress-bar');
    banner.classList.remove('hidden');

    let remaining = initialRemainingSec;
    const totalDuration = this.holdDurationSec || 600;

    const updateUI = () => {
      if (remaining <= 0) {
        clearInterval(this.holdTimerInterval);
        countdownEl.textContent = '00:00';
        progressEl.style.width = '0%';
        this.handleHoldExpiredLocally();
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      countdownEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      const pct = Math.max(0, Math.min(100, (remaining / totalDuration) * 100));
      progressEl.style.width = `${pct}%`;
      remaining--;
    };

    updateUI();
    this.holdTimerInterval = setInterval(updateUI, 1000);
  }

  handleHoldExpiredLocally() {
    alert('Your seat reservation hold has expired. The seats have been released back to the bus pool.');
    this.clearLocalHold();
    this.goToStep(1);
    this.fetchFullState();
  }

  async verifyHoldStatus() {
    if (!this.holdToken) return;
    try {
      const res = await this.apiRequest(`/api/hold/session?token=${this.holdToken}`);
      if (!res.ok) this.handleHoldExpiredLocally();
    } catch (err) {}
  }

  renderSeatMap() {
    const colAB = document.getElementById('seats-col-a-b');
    const colCD = document.getElementById('seats-col-c-d');
    if (!colAB || !colCD) return;

    colAB.innerHTML = '';
    colCD.innerHTML = '';

    for (let row = 1; row <= 8; row++) {
      ['A', 'B'].forEach(col => {
        const id = `${row}${col}`;
        const seat = this.seatsData[id] || { id, isLadies: ['3A', '3B', '4A', '4B'].includes(id), status: 'AVAILABLE' };
        colAB.appendChild(this.createSeatElement(seat));
      });

      ['C', 'D'].forEach(col => {
        const id = `${row}${col}`;
        const seat = this.seatsData[id] || { id, isLadies: ['3A', '3B', '4A', '4B'].includes(id), status: 'AVAILABLE' };
        colCD.appendChild(this.createSeatElement(seat));
      });
    }
  }

  createSeatElement(seat) {
    const btn = document.createElement('button');
    btn.className = 'seat-btn';
    btn.dataset.seatId = seat.id;
    btn.type = 'button';

    const isSelectedByMe = this.selectedSeats.includes(seat.id) || seat.isMyHold;

    if (seat.isLadies) btn.classList.add('ladies');

    if (seat.status === 'BOOKED') {
      btn.classList.add('booked');
      btn.disabled = true;
      btn.title = `Seat ${seat.id} - Booked`;
    } else if (seat.status === 'HELD' && !isSelectedByMe) {
      btn.classList.add('held-by-other');
      btn.disabled = true;
      btn.title = `Seat ${seat.id} - Reserved by another passenger`;
    } else if (isSelectedByMe) {
      btn.classList.add('selected');
      btn.title = `Seat ${seat.id} - Held by you`;
    } else {
      btn.classList.add('available');
      btn.title = `Seat ${seat.id} - Available (₹${this.currentBaseFare})`;
    }

    let innerHTML = `<span class="seat-label">${seat.id}</span>`;
    if (seat.isLadies) {
      innerHTML += `<span class="seat-badge-ladies" title="Ladies Only Seat">♀</span>`;
    }
    if (seat.status === 'HELD' && !isSelectedByMe) {
      innerHTML += `<span class="seat-timer-sub">Held</span>`;
    }

    btn.innerHTML = innerHTML;
    btn.addEventListener('click', () => this.handleSeatClick(seat.id));
    return btn;
  }

  async handleSeatClick(seatId) {
    const isAlreadySelected = this.selectedSeats.includes(seatId);
    if (!isAlreadySelected && this.selectedSeats.length >= 4) {
      alert('Maximum 4 seats allowed per booking.');
      return;
    }

    try {
      const res = await this.apiRequest('/api/hold/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatId, holdToken: this.holdToken })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to select seat.');
        this.fetchFullState();
        return;
      }

      if (data.holdToken) {
        this.holdToken = data.holdToken;
        localStorage.setItem('buslane_hold_token', this.holdToken);
        this.selectedSeats = data.selectedSeats || [];
        this.holdExpiresAt = data.expiresAt;
        this.startHoldTimer(data.remainingSec);
      } else {
        this.clearLocalHold();
      }

      this.renderSelectedChips();
      this.updatePricePreview();
      this.fetchFullState();
    } catch (err) {
      alert('Error updating seat reservation.');
    }
  }

  renderSelectedChips() {
    const container = document.getElementById('selected-seats-chips');
    const continueBtn = document.getElementById('btn-to-passengers');
    if (!container) return;

    if (this.selectedSeats.length === 0) {
      container.innerHTML = `<span class="no-selection-hint">Tap up to 4 seats</span>`;
      if (continueBtn) continueBtn.disabled = true;
      return;
    }

    container.innerHTML = this.selectedSeats
      .map(s => `<span class="seat-chip">${s}</span>`)
      .join('');

    if (continueBtn) continueBtn.disabled = false;
  }

  updatePricePreview() {
    const previewEl = document.getElementById('seatmap-price-preview');
    if (!previewEl) return;
    const count = this.selectedSeats.length;
    if (count === 0) {
      previewEl.textContent = '₹0';
      return;
    }
    const base = this.currentBaseFare * count;
    const fee = this.convenienceFee;
    const taxable = base + fee;
    const gst = Math.round(taxable * (this.gstPercent / 100));
    previewEl.textContent = `₹${taxable + gst}`;
  }

  renderPassengerForms() {
    const container = document.getElementById('passengers-form-container');
    if (!container) return;
    container.innerHTML = '';

    this.selectedSeats.forEach((seatId, idx) => {
      const isLadies = ['3A', '3B', '4A', '4B'].includes(seatId);
      const card = document.createElement('div');
      card.className = `card passenger-card ${isLadies ? 'ladies-assigned' : ''}`;
      card.innerHTML = `
        <div class="passenger-header">
          <h4>Passenger ${idx + 1}</h4>
          <span class="seat-badge ${isLadies ? 'ladies-badge' : ''}">
            Seat ${seatId} ${isLadies ? '• Ladies Only ♀' : '• General'}
          </span>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Full Name (as on ID) *</label>
            <input type="text" class="form-control p-name" data-idx="${idx}" placeholder="e.g. Priya Sharma" required>
          </div>
          <div class="form-group">
            <label class="form-label">Age *</label>
            <input type="number" class="form-control p-age" data-idx="${idx}" min="5" max="120" placeholder="e.g. 28" required>
            <small class="helper-text">Age 5+ (under 5 enter below as infant)</small>
          </div>
          <div class="form-group">
            <label class="form-label">Gender *</label>
            <select class="form-control p-gender" data-idx="${idx}" required ${isLadies ? 'data-locked="female"' : ''}>
              ${isLadies ? `
                <option value="Female" selected>Female (Mandatory for Ladies Seat)</option>
              ` : `
                <option value="">Select Gender</option>
                <option value="Female">Female</option>
                <option value="Male">Male</option>
                <option value="Other">Other</option>
              `}
            </select>
          </div>
        </div>
        ${idx === 0 ? `
          <div class="form-group">
            <label class="form-label">Primary Contact Mobile Number *</label>
            <input type="tel" id="primary-phone" class="form-control" placeholder="10-digit mobile (e.g. 9876543210)" pattern="^[6-9]\\d{9}$" required>
            <small class="helper-text">Booking reference & departure alerts will be sent here.</small>
          </div>
        ` : ''}
      `;
      container.appendChild(card);
    });
    this.renderInfants();
  }

  addInfant() {
    if (this.infants.length >= this.selectedSeats.length) {
      alert(`Maximum ${this.selectedSeats.length} lap infant(s) permitted for this booking.`);
      return;
    }
    this.infants.push({ name: '', age: 2, gender: 'Female' });
    this.renderInfants();
  }

  removeInfant(idx) {
    this.infants.splice(idx, 1);
    this.renderInfants();
  }

  renderInfants() {
    const container = document.getElementById('infants-container');
    if (!container) return;
    container.innerHTML = '';
    this.infants.forEach((inf, idx) => {
      const row = document.createElement('div');
      row.className = 'infant-row';
      row.innerHTML = `
        <div>
          <label class="form-label">Infant Full Name</label>
          <input type="text" class="form-control infant-name" data-idx="${idx}" value="${inf.name}" placeholder="Baby Name" required>
        </div>
        <div>
          <label class="form-label">Age (0-4)</label>
          <input type="number" class="form-control infant-age" data-idx="${idx}" value="${inf.age}" min="0" max="4" required>
        </div>
        <div>
          <label class="form-label">Gender</label>
          <select class="form-control infant-gender" data-idx="${idx}">
            <option value="Female" ${inf.gender === 'Female' ? 'selected' : ''}>Female</option>
            <option value="Male" ${inf.gender === 'Male' ? 'selected' : ''}>Male</option>
          </select>
        </div>
        <div>
          <button type="button" class="btn btn-danger-outline btn-sm remove-infant-btn" data-idx="${idx}">Remove</button>
        </div>
      `;
      container.appendChild(row);
    });

    container.querySelectorAll('.remove-infant-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.removeInfant(parseInt(e.target.dataset.idx, 10));
      });
    });
  }

  async saveAndProceedToFare() {
    if (this.selectedSeats.length === 0) {
      alert('Please select at least one seat.');
      this.goToStep(1);
      return;
    }

    const passengerCards = document.querySelectorAll('.passenger-card');
    const passengers = [];

    for (let i = 0; i < passengerCards.length; i++) {
      const card = passengerCards[i];
      const seatId = this.selectedSeats[i];
      const isLadies = ['3A', '3B', '4A', '4B'].includes(seatId);

      const nameInput = card.querySelector('.p-name');
      const ageInput = card.querySelector('.p-age');
      const genderSelect = card.querySelector('.p-gender');
      const phoneInput = document.getElementById('primary-phone');

      const name = nameInput.value.trim();
      const age = parseInt(ageInput.value, 10);
      const gender = genderSelect.value;
      const phone = phoneInput ? phoneInput.value.trim() : '';

      if (!name || name.length < 2) {
        alert(`Passenger ${i + 1}: Please enter a valid name (min 2 characters).`);
        nameInput.focus();
        return;
      }
      if (isNaN(age) || age < 5 || age > 120) {
        alert(`Passenger ${i + 1}: Age must be between 5 and 120.`);
        ageInput.focus();
        return;
      }
      if (!gender) {
        alert(`Passenger ${i + 1}: Please select gender.`);
        genderSelect.focus();
        return;
      }
      if (isLadies && gender !== 'Female') {
        alert(`Seat ${seatId} is reserved for ladies. Passenger must be female.`);
        genderSelect.focus();
        return;
      }
      if (i === 0 && !/^[6-9]\d{9}$/.test(phone)) {
        alert('Please enter a valid 10-digit Indian mobile number.');
        phoneInput.focus();
        return;
      }
      passengers.push({ name, age, gender, phone });
    }

    const infantNames = document.querySelectorAll('.infant-name');
    const infantAges = document.querySelectorAll('.infant-age');
    const infantGenders = document.querySelectorAll('.infant-gender');
    const infantsList = [];

    for (let i = 0; i < infantNames.length; i++) {
      infantsList.push({
        name: infantNames[i].value.trim(),
        age: parseInt(infantAges[i].value, 10),
        gender: infantGenders[i].value
      });
    }

    const boardingPointId = document.getElementById('boarding-select').value;

    try {
      const res = await this.apiRequest('/api/passengers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: this.holdToken,
          passengers,
          infants: infantsList,
          boardingPointId
        })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Validation failed');
        return;
      }
      this.renderFareSummary(data.fare);
      this.goToStep(3);
    } catch (err) {
      alert('Error saving passenger details.');
    }
  }

  renderFareSummary(fare) {
    const count = this.selectedSeats.length;
    document.getElementById('invoice-base-calc').textContent = `₹${fare.baseFarePerSeat} × ${count} seat(s)`;
    document.getElementById('invoice-base-subtotal').textContent = `₹${fare.seatSubtotal}`;
    document.getElementById('invoice-convenience-fee').textContent = `₹${fare.convenienceFee}`;
    document.getElementById('invoice-taxable-amount').textContent = `₹${fare.taxableAmount}`;
    document.getElementById('invoice-gst-amount').textContent = `₹${fare.gstAmount}`;
    document.getElementById('invoice-grand-total').textContent = `₹${fare.grandTotal}`;
    document.getElementById('btn-pay-amount').textContent = `₹${fare.grandTotal}`;
    document.getElementById('pay-display-amount').textContent = `₹${fare.grandTotal}`;
  }

  async executePayment() {
    const payBtn = document.getElementById('btn-submit-payment');
    const modal = document.getElementById('gateway-modal');
    const timerDisplay = document.getElementById('gateway-timer-display');
    const conflictAlert = document.getElementById('conflict-refund-alert');

    payBtn.disabled = true;
    conflictAlert.classList.add('hidden');
    modal.classList.remove('hidden');

    let elapsed = 0;
    timerDisplay.textContent = `Elapsed: 0s`;
    clearInterval(this.gatewayTimerInterval);
    this.gatewayTimerInterval = setInterval(() => {
      elapsed++;
      timerDisplay.textContent = `Elapsed: ${elapsed}s`;
    }, 1000);

    const idempotencyKey = 'pay_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const selectedMethod = document.querySelector('input[name="pay-method"]:checked')?.value || 'UPI';

    try {
      const res = await this.apiRequest('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holdToken: this.holdToken,
          paymentMethod: selectedMethod,
          idempotencyKey
        })
      });

      clearInterval(this.gatewayTimerInterval);
      modal.classList.add('hidden');
      payBtn.disabled = false;

      const data = await res.json();

      if (res.ok && data.status === 'CONFIRMED') {
        this.confirmedBooking = data.booking;
        this.renderTicketConfirmation(data.booking);
        this.clearLocalHold();
        this.goToStep(5);
      } else if (res.status === 409 && data.type === 'LATE_PAYMENT_REFUNDED') {
        conflictAlert.classList.remove('hidden');
        document.getElementById('conflict-alert-title').textContent = '⚠️ Payment Received After Hold Expired';
        document.getElementById('conflict-alert-message').textContent =
          'Your hold expired and the seat was claimed by another customer. A full automated refund has been issued to your source account.';
        document.getElementById('conflict-refund-meta').innerHTML = `
          Refund Ref: <strong>${data.refundDetails?.refundTxnId || 'REF-AUTO-9981'}</strong><br>
          Amount: <strong>₹${data.refundDetails?.amount || 0}</strong> (100% Refunded)<br>
          Reason: <strong>${data.refundDetails?.reason || 'SEAT_TAKEN_BY_ANOTHER'}</strong>
        `;
        this.clearLocalHold();
      } else {
        alert(data.error || 'Payment was declined or timed out.');
      }
    } catch (err) {
      clearInterval(this.gatewayTimerInterval);
      modal.classList.add('hidden');
      payBtn.disabled = false;
      alert('Payment simulation error.');
    }
  }

  renderTicketConfirmation(booking) {
    document.getElementById('ticket-booking-ref').textContent = booking.bookingRef;
    document.getElementById('ticket-boarding-point').textContent = booking.boardingPoint.name;
    document.getElementById('ticket-boarding-time').textContent = booking.boardingPoint.time;
    document.getElementById('ticket-seats-list').textContent = booking.seatIds.join(', ');
    document.getElementById('ticket-paid-amount').textContent = `₹${booking.fareSummary.grandTotal}`;
    document.getElementById('ticket-txn-id').textContent = booking.paymentTxnId;

    const watermark = document.getElementById('dev-watermark');
    if (this.isDevMode) watermark.classList.remove('hidden');
    else watermark.classList.add('hidden');

    const roster = document.getElementById('ticket-passenger-roster');
    roster.innerHTML = booking.passengers.map(p => `
      <div class="passenger-manifest-row">
        <span>Seat <strong>${p.seatId}</strong>: ${p.name} (${p.age}y, ${p.gender})</span>
        <span class="text-muted">${p.phone}</span>
      </div>
    `).join('');

    if (booking.infants && booking.infants.length > 0) {
      roster.innerHTML += booking.infants.map(inf => `
        <div class="passenger-manifest-row" style="color: #64748b; font-style: italic;">
          <span>👶 Lap Infant: ${inf.name} (${inf.age}y, ${inf.gender})</span>
          <span>Travelling Free</span>
        </div>
      `).join('');
    }

    document.getElementById('cancellation-feedback').classList.add('hidden');
  }

  async cancelBooking() {
    if (!this.confirmedBooking) return;
    if (!confirm('Are you sure you want to cancel this booking and initiate a refund?')) return;

    try {
      const res = await this.apiRequest('/api/booking/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingRef: this.confirmedBooking.bookingRef })
      });
      const data = await res.json();
      if (res.ok) {
        const feedback = document.getElementById('cancellation-feedback');
        feedback.classList.remove('hidden');
        feedback.innerHTML = `
          <strong>✓ Cancellation Confirmed — Refund Initiated</strong><br>
          Refund Amount: <strong>₹${data.refundAmount}</strong><br>
          Status: <strong>${data.refundStatus}</strong><br>
          Estimated Settlement: <strong>${data.estimatedSettlementDays}</strong>
        `;
        document.getElementById('ticket-status-pill').textContent = 'CANCELLED (REFUND INITIATED)';
        document.getElementById('ticket-status-pill').className = 'status-pill status-cancelled';
        this.fetchFullState();
      } else {
        alert(data.error || 'Failed to cancel booking.');
      }
    } catch (err) {
      alert('Error communicating with cancellation endpoint.');
    }
  }

  goToStep(step) {
    this.currentStep = step;
    document.querySelectorAll('.step-view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.step-item').forEach(item => {
      const itemStep = parseInt(item.dataset.step, 10);
      item.classList.toggle('active', itemStep === step);
      item.classList.toggle('completed', itemStep < step);
    });

    if (step === 1) document.getElementById('step-seatmap').classList.add('active');
    else if (step === 2) {
      document.getElementById('step-passengers').classList.add('active');
      this.renderPassengerForms();
    } else if (step === 3) document.getElementById('step-fare').classList.add('active');
    else if (step === 4) document.getElementById('step-payment').classList.add('active');
    else if (step === 5) document.getElementById('step-confirmation').classList.add('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  startDevStatePoller() {
    setInterval(async () => {
      if (!this.isDevMode) return;
      try {
        const res = await this.apiRequest('/api/dev/raw-state');
        if (res.ok) {
          const raw = await res.json();
          const pre = document.getElementById('dev-raw-state-pre');
          if (pre) pre.textContent = JSON.stringify(raw, null, 2);
        }
      } catch (err) {}
    }, 1200);
  }

  async devExpireHold() {
    if (!this.holdToken) {
      alert('No active hold session on this client.');
      return;
    }
    const res = await this.apiRequest('/api/dev/expire-hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.holdToken })
    });
    const data = await res.json();
    alert(data.message || 'Hold expired.');
    this.fetchFullState();
  }

  async devSetHoldDuration(durationSec) {
    this.holdDurationSec = parseInt(durationSec, 10);
    await this.apiRequest('/api/dev/set-hold-duration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec })
    });
  }

  async devSetGatewayMode(mode) {
    await this.apiRequest('/api/dev/set-gateway-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
  }

  async devStealSeat() {
    if (this.selectedSeats.length === 0) {
      alert('Select at least one seat first to test seat theft.');
      return;
    }
    const target = this.selectedSeats[0];
    const res = await this.apiRequest('/api/dev/steal-seat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: target })
    });
    const data = await res.json();
    alert(`Seat ${target} was stolen by Customer B (Simulated Booking ${data.bookingRef})!`);
    this.fetchFullState();
  }

  async devSetPreset(preset) {
    await this.apiRequest('/api/dev/preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset })
    });
    this.clearLocalHold();
    this.fetchFullState();
  }

  async devUpdateBaseFare() {
    const input = document.getElementById('dev-base-fare-input');
    const val = parseInt(input.value, 10);
    const res = await this.apiRequest('/api/dev/set-base-fare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseFare: val })
    });
    if (res.ok) {
      alert(`Base fare updated to ₹${val}`);
      this.fetchFullState();
    }
  }

  async devSetLatency(latencyMs) {
    await this.apiRequest('/api/dev/set-latency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latencyMs })
    });
  }

  async devResetAll() {
    if (!confirm('Clear all bookings and holds?')) return;
    await this.apiRequest('/api/dev/reset', { method: 'POST' });
    this.clearLocalHold();
    this.goToStep(1);
    this.fetchFullState();
  }

  copyRawState() {
    const pre = document.getElementById('dev-raw-state-pre');
    if (!pre || !pre.textContent) return;
    navigator.clipboard.writeText(pre.textContent).then(() => {
      alert('Live raw state copied to clipboard!');
    }).catch(() => {
      alert('Failed to copy to clipboard.');
    });
  }

  bindEvents() {
    document.getElementById('dev-toggle-btn')?.addEventListener('click', () => this.toggleDevMode());
    document.getElementById('dev-minimize-btn')?.addEventListener('click', () => {
      document.getElementById('dev-panel')?.classList.toggle('minimized');
    });

    document.getElementById('btn-to-passengers')?.addEventListener('click', () => this.goToStep(2));
    document.getElementById('btn-back-to-seats')?.addEventListener('click', () => this.goToStep(1));
    document.getElementById('btn-to-fare')?.addEventListener('click', () => this.saveAndProceedToFare());
    document.getElementById('btn-back-to-passengers')?.addEventListener('click', () => this.goToStep(2));
    document.getElementById('btn-to-payment')?.addEventListener('click', () => this.goToStep(4));
    document.getElementById('btn-back-to-fare')?.addEventListener('click', () => this.goToStep(3));
    document.getElementById('btn-submit-payment')?.addEventListener('click', () => this.executePayment());
    document.getElementById('btn-conflict-return')?.addEventListener('click', () => this.goToStep(1));
    document.getElementById('btn-simulate-cancel')?.addEventListener('click', () => this.cancelBooking());
    document.getElementById('btn-book-another')?.addEventListener('click', () => {
      this.clearLocalHold();
      this.goToStep(1);
    });

    document.getElementById('btn-add-infant')?.addEventListener('click', () => this.addInfant());

    document.querySelectorAll('.dev-jump-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.goToStep(parseInt(e.target.dataset.target, 10));
      });
    });

    document.getElementById('dev-expire-hold-btn')?.addEventListener('click', () => this.devExpireHold());
    document.getElementById('dev-hold-duration-select')?.addEventListener('change', (e) => this.devSetHoldDuration(e.target.value));
    document.querySelectorAll('input[name="dev-gateway-mode"]').forEach(radio => {
      radio.addEventListener('change', (e) => this.devSetGatewayMode(e.target.value));
    });
    document.getElementById('dev-steal-seat-btn')?.addEventListener('click', () => this.devStealSeat());
    document.querySelectorAll('.dev-preset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.devSetPreset(e.target.dataset.preset));
    });
    document.getElementById('dev-update-fare-btn')?.addEventListener('click', () => this.devUpdateBaseFare());
    document.getElementById('dev-latency-select')?.addEventListener('change', (e) => this.devSetLatency(e.target.value));
    document.getElementById('dev-reset-all-btn')?.addEventListener('click', () => this.devResetAll());
    document.getElementById('dev-copy-state-btn')?.addEventListener('click', () => this.copyRawState());
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new BusLaneApp();
});
