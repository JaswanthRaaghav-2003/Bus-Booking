// public/app.js
// BusLane Client Application & Distributed Verification Suite

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
    this.serverTimeOffset = 0; // serverNow - clientNow
    this.infants = [];
    this.confirmedBooking = null;

    this.init();
  }

  init() {
    this.detectDevMode();
    this.bindEvents();
    this.initRealtimeSSE();
    this.checkSessionRecovery();
    this.startDevStatePoller();
  }

  // --- Dev Mode Detection (?dev=1) ---
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

  // --- Real-Time Server-Sent Events (SSE) Sync ---
  initRealtimeSSE() {
    const syncPill = document.getElementById('sync-status');
    const tokenParam = this.holdToken ? `?token=${this.holdToken}` : '';

    if (this.eventSource) {
      this.eventSource.close();
    }

    this.eventSource = new EventSource(`/api/events${tokenParam}`);

    this.eventSource.onopen = () => {
      syncPill.classList.add('online');
      syncPill.querySelector('.sync-label').textContent = 'Live Sync';
    };

    this.eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        this.handleServerBroadcast(payload);
      } catch (err) {
        console.error('[SSE Error parsing message]', err);
      }
    };

    this.eventSource.onerror = () => {
      syncPill.classList.remove('online');
      syncPill.querySelector('.sync-label').textContent = 'Reconnecting...';
    };

    // Auto-resync when returning from phone lock or background tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.fetchFullState();
      }
    });
  }

  handleServerBroadcast(payload) {
    if (payload.state) {
      this.applyServerState(payload.state);
    }

    if (payload.type === 'HOLDS_EXPIRED') {
      if (this.holdToken) {
        this.verifyHoldStatus();
      }
    }
  }

  async fetchFullState() {
    try {
      const url = this.holdToken ? `/api/state?token=${this.holdToken}` : '/api/state';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        this.applyServerState(data);
      }
    } catch (err) {
      console.warn('[Fetch State Failed]', err);
    }
  }

  applyServerState(state) {
    if (!state) return;
    this.seatsData = state.seats || {};
    this.currentBaseFare = state.baseFare || 450;
    this.convenienceFee = state.convenienceFee || 30;
    this.gstPercent = state.gstPercent || 5;

    // Calculate server clock delta
    if (state.serverTime) {
      this.serverTimeOffset = state.serverTime - Date.now();
    }

    const baseFareLabel = document.getElementById('legend-base-fare');
    if (baseFareLabel) baseFareLabel.textContent = this.currentBaseFare;

    this.renderSeatMap();
    this.updatePricePreview();
  }

  // --- Session Recovery on Page Reload / Tab Reopen ---
  async checkSessionRecovery() {
    if (!this.holdToken) {
      this.fetchFullState();
      return;
    }

    try {
      const res = await fetch(`/api/hold/session?token=${this.holdToken}`);
      if (res.ok) {
        const session = await res.json();
        this.selectedSeats = session.seatIds || [];
        this.holdExpiresAt = session.expiresAt;
        this.startHoldTimer(session.remainingSec);
        this.renderSelectedChips();
        this.updatePricePreview();
      } else {
        // Session expired while user was away
        this.clearLocalHold();
      }
    } catch (err) {
      console.warn('[Session Recovery Error]', err);
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

  // --- Monotonic Hold Timer (Immune to Local OS Clock Jumps) ---
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
      const res = await fetch(`/api/hold/session?token=${this.holdToken}`);
      if (!res.ok) {
        this.handleHoldExpiredLocally();
      }
    } catch (err) {}
  }

  // --- Seat Map Rendering ---
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

    if (seat.isLadies) {
      btn.classList.add('ladies');
    }

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

    btn.addEventListener('click', () => {
      this.handleSeatClick(seat.id);
    });

    return btn;
  }

  // --- Seat Selection Mutation (Atomic Hold Request) ---
  async handleSeatClick(seatId) {
    // Prevent selecting more than 4 seats client-side
    const isAlreadySelected = this.selectedSeats.includes(seatId);
    if (!isAlreadySelected && this.selectedSeats.length >= 4) {
      alert('Maximum 4 seats allowed per booking.');
      return;
    }

    try {
      const res = await fetch('/api/hold/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seatId,
          holdToken: this.holdToken
        })
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
        // Zero seats remaining in session
        this.clearLocalHold();
      }

      this.renderSelectedChips();
      this.updatePricePreview();
      this.fetchFullState();
    } catch (err) {
      alert('Network error communicating with reservation server.');
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
    const total = taxable + gst;

    previewEl.textContent = `₹${total}`;
  }

  // --- Step 2: Passenger Details Form Setup ---
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
    // Max 1 infant per seated passenger
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
        const idx = parseInt(e.target.dataset.idx, 10);
        this.removeInfant(idx);
      });
    });
  }

  // --- Collect & Validate Passenger Details ---
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
        alert(`Passenger ${i + 1}: Age must be between 5 and 120 (infants under 5 enter as lap infant).`);
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
        alert('Please enter a valid 10-digit Indian mobile number starting with 6-9.');
        phoneInput.focus();
        return;
      }

      passengers.push({ name, age, gender, phone });
    }

    // Collect infants data
    const infantNames = document.querySelectorAll('.infant-name');
    const infantAges = document.querySelectorAll('.infant-age');
    const infantGenders = document.querySelectorAll('.infant-gender');
    const infantsList = [];

    for (let i = 0; i < infantNames.length; i++) {
      const name = infantNames[i].value.trim();
      const age = parseInt(infantAges[i].value, 10);
      const gender = infantGenders[i].value;
      if (!name) {
        alert(`Lap Infant ${i + 1}: Please enter infant name.`);
        return;
      }
      if (isNaN(age) || age < 0 || age >= 5) {
        alert(`Lap Infant ${i + 1}: Age must be between 0 and 4.`);
        return;
      }
      infantsList.push({ name, age, gender });
    }

    const boardingPointId = document.getElementById('boarding-select').value;

    try {
      const res = await fetch('/api/passengers', {
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
      alert('Network error saving passenger details.');
    }
  }

  // --- Step 3: Fare Summary Display ---
  renderFareSummary(fare) {
    const count = this.selectedSeats.length;
    const baseCalc = document.getElementById('invoice-base-calc');
    const baseSubtotal = document.getElementById('invoice-base-subtotal');
    const convFee = document.getElementById('invoice-convenience-fee');
    const taxable = document.getElementById('invoice-taxable-amount');
    const gst = document.getElementById('invoice-gst-amount');
    const grandTotal = document.getElementById('invoice-grand-total');
    const payBtnAmount = document.getElementById('btn-pay-amount');
    const payDisplayAmount = document.getElementById('pay-display-amount');

    baseCalc.textContent = `₹${fare.baseFarePerSeat} × ${count} seat(s)`;
    baseSubtotal.textContent = `₹${fare.seatSubtotal}`;
    convFee.textContent = `₹${fare.convenienceFee}`;
    taxable.textContent = `₹${fare.taxableAmount}`;
    gst.textContent = `₹${fare.gstAmount}`;
    grandTotal.textContent = `₹${fare.grandTotal}`;

    if (payBtnAmount) payBtnAmount.textContent = `₹${fare.grandTotal}`;
    if (payDisplayAmount) payDisplayAmount.textContent = `₹${fare.grandTotal}`;
  }

  // --- Step 4: Payment Simulation ---
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
      const res = await fetch('/api/pay', {
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
        // Late Payment / Seat Stolen Conflict Handled Empathetically!
        conflictAlert.classList.remove('hidden');
        document.getElementById('conflict-alert-title').textContent = '⚠️ Payment Received After Hold Expired';
        document.getElementById('conflict-alert-message').textContent =
          'Your 10-minute hold expired and the seat was claimed by another customer before payment settled. A full automated refund has been issued to your source account.';
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
      alert('Network error executing simulated payment.');
    }
  }

  // --- Step 5: Confirmation & Boarding Pass ---
  renderTicketConfirmation(booking) {
    document.getElementById('ticket-booking-ref').textContent = booking.bookingRef;
    document.getElementById('ticket-boarding-point').textContent = booking.boardingPoint.name;
    document.getElementById('ticket-boarding-time').textContent = booking.boardingPoint.time;
    document.getElementById('ticket-seats-list').textContent = booking.seatIds.join(', ');
    document.getElementById('ticket-paid-amount').textContent = `₹${booking.fareSummary.grandTotal}`;
    document.getElementById('ticket-txn-id').textContent = booking.paymentTxnId;

    const watermark = document.getElementById('dev-watermark');
    if (this.isDevMode) {
      watermark.classList.remove('hidden');
    } else {
      watermark.classList.add('hidden');
    }

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

    const cancelFeedback = document.getElementById('cancellation-feedback');
    cancelFeedback.classList.add('hidden');
  }

  async cancelBooking() {
    if (!this.confirmedBooking) return;
    if (!confirm('Are you sure you want to cancel this booking and initiate a refund?')) return;

    try {
      const res = await fetch('/api/booking/cancel', {
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

  // --- Step Navigation State Machine ---
  goToStep(step) {
    this.currentStep = step;

    document.querySelectorAll('.step-view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.step-item').forEach(item => {
      const itemStep = parseInt(item.dataset.step, 10);
      item.classList.toggle('active', itemStep === step);
      item.classList.toggle('completed', itemStep < step);
    });

    if (step === 1) {
      document.getElementById('step-seatmap').classList.add('active');
    } else if (step === 2) {
      document.getElementById('step-passengers').classList.add('active');
      this.renderPassengerForms();
    } else if (step === 3) {
      document.getElementById('step-fare').classList.add('active');
    } else if (step === 4) {
      document.getElementById('step-payment').classList.add('active');
    } else if (step === 5) {
      document.getElementById('step-confirmation').classList.add('active');
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- Live Dev State Inspector Poller (?dev=1) ---
  startDevStatePoller() {
    setInterval(async () => {
      if (!this.isDevMode) return;
      try {
        const res = await fetch('/api/dev/raw-state');
        if (res.ok) {
          const raw = await res.json();
          const pre = document.getElementById('dev-raw-state-pre');
          if (pre) {
            pre.textContent = JSON.stringify(raw, null, 2);
          }
        }
      } catch (err) {}
    }, 1200);
  }

  // --- Dev Panel Actions ---
  async devExpireHold() {
    if (!this.holdToken) {
      alert('No active hold session on this client.');
      return;
    }
    const res = await fetch('/api/dev/expire-hold', {
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
    await fetch('/api/dev/set-hold-duration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec })
    });
  }

  async devSetGatewayMode(mode) {
    await fetch('/api/dev/set-gateway-mode', {
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
    const res = await fetch('/api/dev/steal-seat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: target })
    });
    const data = await res.json();
    alert(`Seat ${target} has been stolen by Customer B (Simulated Booking ${data.bookingRef})!`);
    this.fetchFullState();
  }

  async devSetPreset(preset) {
    await fetch('/api/dev/preset', {
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
    const res = await fetch('/api/dev/set-base-fare', {
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
    await fetch('/api/dev/set-latency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latencyMs })
    });
  }

  async devResetAll() {
    if (!confirm('Clear all bookings and holds?')) return;
    await fetch('/api/dev/reset', { method: 'POST' });
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

  // --- Bind DOM Listeners ---
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

    // Dev Panel controls
    document.querySelectorAll('.dev-jump-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = parseInt(e.target.dataset.target, 10);
        this.goToStep(target);
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

// Bootstrap Application on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new BusLaneApp();
});
