# BusLane — Distributed Bus Seat-Booking Flow & Test Harness

**Route:** Pune (Swargate) to Nashik (CBS) • Departure 22:30 IST  
**Bus Configuration:** 32 Seats (8 Rows, 2+2 Layout, 1A to 8D) • Ladies Seats: 3A, 3B, 4A, 4B  
**Build Version:** `v1.0.4-dev-verified`  

A production-grade, highly resilient bus seat-booking flow designed to withstand race conditions, payment gateway timeouts, clock drift, and adversarial tampering, accompanied by an interactive test harness (`?dev=1`), an automated test runner, and a 38-case edge case verification matrix.

---

## Quick Start Guide

### 1. Prerequisites
- **Node.js**: v18+ (Tested on v22.12.0)
- **npm**: v9+ (Tested on 10.9.0)

### 2. Installation
```bash
npm install
```

### 3. Run the Application
```bash
npm start
```
- Open **Customer Flow**: [http://localhost:3000](http://localhost:3000)
- Open **Test Mode Harness**: [http://localhost:3000/?dev=1](http://localhost:3000/?dev=1)
- **Open on Mobile Phone**: Connect your phone to the same Wi-Fi network and open `http://<your-laptop-ip>:3000/?dev=1`.

### 4. Run Automated Unit & Concurrency Tests
```bash
npm test
```
Executes:
- Concurrency stress test (10 simultaneous requests contending for the last seat).
- Exact rupee fare and statutory 5% GST tax calculation tests.
- Ladies seat restrictions (3A, 3B, 4A, 4B) and lap infant policy validation.
- Hold expiry reap loop and late-payment automated refund verification.

### 5. Run Hostile Adversarial Break Probes
```bash
node server/test/adversarial_break_attempts.js
```
Deliberately tests the 6 hostile vectors specified in Part 5:
1. Attempting to double-book the same seat.
2. Attempting to get a ticket without paying.
3. Attempting to tamper payment payload to ₹1 instead of ₹1,449.
4. Attempting to book a male passenger into ladies seat 3B.
5. Attempting to hold all 32 seats across multiple sessions (DoS).
6. Attempting to trap the application in an unrecoverable state.

---

## Documentation Artifacts

All formal deliverables required by the assignment prompt are located in the `docs/` directory:

| Document | Description |
| :--- | :--- |
| [`docs/01_specification_review.md`](./docs/01_specification_review.md) | **Part 1**: Line-by-line audit of lines 1–29 (Contradictions, Arithmetic Errors, Omissions, Sequencing Problems, Buildable-yet-Dangerous Decisions), rectified numbered specification, and 3-seat fare calculation worked to the rupee. |
| [`docs/02_edge_cases_matrix.md`](./docs/02_edge_cases_matrix.md) | **Part 2 & 5**: 38-case test matrix across all 12 domains + 10 mandatory edge cases with verified `Actual result` column. |
| [`docs/03_severe_cases_and_untested_failures.md`](./docs/03_severe_cases_and_untested_failures.md) | **Part 2**: The 5 most severe cases written out in full with numbered step-by-step instructions, plus 3 untested distributed failure modes and required infrastructure. |
| [`docs/04_bug_reports_and_writeup.md`](./docs/04_bug_reports_and_writeup.md) | **Part 6**: The 5 worst defects with raw test panel state JSON, 22:30 bus-stop operational impact statements, and the synthesis essay (<400 words). |

---

## Key Architectural Highlights

### 1. Resolution of Original Arithmetic Defect (Line 18)
- **Original Error**: Claimed `₹450 × 2 = ₹900, + ₹30 fee + 5% GST = ₹960` (implying GST was ₹30, or 3.22%).
- **Rectified Formula**: Base Fare (₹450 × N) + Flat Convenience Fee (₹30) = Taxable Subtotal. GST at statutory 5% applied on Taxable Subtotal, rounded half-up to the nearest integer Rupee.
- **Worked 3-Seat Calculation**:
  - 3 Seats × ₹450 = ₹1,350
  - Convenience Fee = ₹30
  - Taxable Subtotal = ₹1,380
  - 5% GST = ₹69.00
  - **Total = ₹1,449.00**

### 2. Real-Time Multi-Tab Synchronization
- Built using native **Server-Sent Events (SSE)** (`/api/events`).
- When a seat is held or booked in Tab 1, it updates instantly in Tab 2 without manual page refreshes.

### 3. Server-Authoritative Monotonic Countdown
- Client countdown is driven by `expiresAt - serverTime` relative deltas rather than client system clocks.
- Automatically handles background tab throttling and phone sleep via the browser `visibilitychange` API.

### 4. Empathetic Late-Payment & Conflict Reversal
- If a customer's payment succeeds after their seat hold expired and the seat was claimed by another customer:
  1. The server blocks duplicate ticket generation.
  2. The server autonomously issues a full refund transaction (`REFUND_SETTLED_AUTOMATIC`).
  3. The UI renders an empathetic resolution screen explaining the reallocation with the refund reference ID.

### 5. Test Harness Dock (`?dev=1`)
- Fast stage navigation (Jump to Seat Map, Details, Fare Summary, Payment, Confirmation).
- Expire hold immediately or adjust duration (5s to 600s).
- Simulate payment behaviors: Instant Success, Bank Decline, Gateway Timeout, Late Settlement.
- "Steal My Held Seat" button to simulate race collisions.
- Instant bus presets: Empty, 1 seat left, Full, Ladies seats gone.
- Dynamic fare surge adjuster.
- Live raw state inspector with 1-click JSON clipboard copy.
- Dev simulation watermark so test passes cannot be confused with valid tickets.

---

## AI Usage Disclosure & Engineering Audit

- **AI Tools Used**: Used for initial boilerplate scaffolding, schema drafting, and test matrix brainstorming.
- **Manual Verification Conducted**:
  - Validated mathematical formulas for GST and half-up rupee rounding across 1, 2, 3, and 4 seats.
  - Verified mutex serialization logic to guarantee zero double-booking under concurrent load.
  - Verified mobile touch targets and CSS grid responsive behavior on viewports down to 320px.
  - Verified session persistence and SSE reconnection semantics under simulated network drops.
