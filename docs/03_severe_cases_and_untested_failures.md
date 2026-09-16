# Part 2 (Continued): Five Most Severe Edge Cases & Three Untested Failure Modes

---

## The Five Most Severe Edge Cases (Exhaustive Step-by-Step Execution Protocols)

These five cases represent catastrophic failure points where money is lost, seats are double-sold, or data integrity is violated. Each protocol is written with exact, unassisted numbered steps that any external auditor can execute on the build.

---

### Severe Case 1: Late Payment Arriving After Hold Expiry When Seat Was Sold to Another Customer
- **Risk Profile**: **CRITICAL (P0)** — Customer pays money but receives no seat, or two passengers arrive at the bus at 22:30 expecting the same seat 4C.
- **Root Cause**: Payment gateway asynchronous settlement latency exceeding the server-side hold lease duration.

#### Step-by-Step Reproduction & Verification Protocol:
1. Open two browser windows side-by-side:
   - Window A: `http://localhost:3000/?dev=1` (Customer A)
   - Window B: `http://localhost:3000/?dev=1` (Customer B)
2. In Window A:
   - In the **Dev Panel** (`?dev=1` docked at top right), set **Hold Duration** to `20 seconds`.
   - Set **Simulated Gateway Mode** to `Succeed Late (Delay 35s)`.
   - On the seat map, select **Seat 4C**. Notice Seat 4C turns green ("Selected") and the hold timer counts down from 00:20.
   - In Window B, observe that Seat 4C immediately turns amber ("Held by another").
3. In Window A:
   - Click **'Proceed to Passenger Details'**.
   - Enter Name: `"Alice Walker"`, Age: `29`, Gender: `"Female"`, Phone: `"9876543210"`.
   - Select Boarding Point: `"Swargate (22:30)"`.
   - Click **'Proceed to Payment'**.
   - Review Fare Summary (Total: ₹504).
   - Click **'Pay ₹504 (Simulated Gateway)'**.
   - Gateway modal opens displaying `"Processing payment with bank..."`.
4. Wait 20 seconds:
   - Observe in both Window A and Window B that Customer A's 20-second hold expires.
   - In Window B, Seat 4C turns white ("Available").
5. In Window B (Customer B):
   - Immediately click **Seat 4C**.
   - Click **'Proceed to Passenger Details'**.
   - Enter Name: `"Bob Smith"`, Age: `34`, Gender: `"Male"`, Phone: `"9123456789"`, Boarding: `"Swargate (22:30)"`.
   - Click **'Proceed to Payment'** and then click **'Pay ₹504'** (with default instant success mode).
   - Verify Window B transitions to **Confirmation Screen**, showing confirmed Booking Reference (e.g. `BL-PN-9410`) for Seat 4C.
6. Return to Window A (Customer A):
   - At t=35 seconds, the delayed payment completes at the gateway.
   - Observe the server reaction:
     - The server rejects assigning Seat 4C to Customer A with status `CONFLICT_SEAT_TAKEN`.
     - Server triggers an automated full refund reversal transaction (`REFUND_INSTANT_AUTO`).
     - Window A renders an empathetic alert:  
       > **"Payment Received After Reservation Expired"**  
       > *"Your 20-second hold expired and Seat 4C was assigned to another traveler before payment cleared. A full refund of ₹504 has been automatically initiated to your account (Refund Ref: REF-AUTO-XXXXX). You have not been charged."*
7. Audit Verification:
   - In the Dev Panel, click **'Copy State'**.
   - Inspect the JSON log: Seat 4C has exactly one owner (Bob Smith, Booking `BL-PN-9410`). Alice's transaction is logged under `refunded_transactions` with status `REFUND_SETTLED`. No double-booking occurred.

---

### Severe Case 2: Concurrent Contention on the Final Remaining Seat
- **Risk Profile**: **HIGH (P0)** — Race condition causing two database write locks to collide or grant dual ownership.
- **Root Cause**: Non-atomic check-then-act read/write queries without mutual exclusion.

#### Step-by-Step Reproduction & Verification Protocol:
1. Open two browser sessions (Session A and Session B) at `http://localhost:3000/?dev=1`.
2. In Session A's Dev Panel:
   - Click the preset button **'Preset: One Seat Left'**.
   - Observe that seats 1A through 8C (31 seats) are instantly marked as booked. Only **Seat 8D** remains white ("Available").
   - Session B's seat map updates simultaneously over SSE, showing only 8D available.
3. Prepare both browsers:
   - Position the mouse cursor in Session A directly over Seat 8D.
   - Position the mouse cursor in Session B directly over Seat 8D.
4. Click Seat 8D in both sessions within the same fraction of a second.
5. Expected Observable Behavior:
   - The server processes both incoming requests through an atomic mutex queue.
   - Session A (first millisecond arrival): Acquires lease. Seat turns green ("Selected"), and 10-minute hold countdown starts.
   - Session B (second arrival): Receives HTTP 409 Conflict. Seat 8D immediately turns amber ("Held by another"). A non-blocking toast appears in Session B: *"Seat 8D was just reserved by another passenger."*
6. Session A completes booking for 8D. Once confirmed, Session B's map updates 8D to grey ("Booked"). The bus status switches to **"Bus Full (0 seats available)"**.

---

### Severe Case 3: Duplicate Payment Webhook Confirmation (Idempotency Violation)
- **Risk Profile**: **HIGH (P0)** — Duplicate financial debit, redundant seat locks, or corrupted ledger state.
- **Root Cause**: Gateway webhook retries (due to dropped TCP ACKs or network retransmission) processed without an idempotency key cache.

#### Step-by-Step Reproduction & Verification Protocol:
1. Open `http://localhost:3000/?dev=1`.
2. Select Seat 2B, enter passenger details, and navigate to the payment screen.
3. In the Dev Panel, check the option: **'Simulate Gateway Twin-Webhook (Idempotency Stress)'**.
4. Click **'Pay ₹504'**.
5. The simulated gateway engine dispatches the success webhook `HOOK_PAY_202` to `/api/payment/confirm`, and simultaneously dispatches an exact duplicate of `HOOK_PAY_202` with 50ms jitter.
6. Server Execution Verification:
   - Webhook 1 acquires transaction lock for `orderId`, confirms booking `BL-PN-7721`, marks Seat 2B as booked, and returns HTTP 200 `{status: "BOOKED", ref: "BL-PN-7721"}`.
   - Webhook 2 hits the server. The idempotency guard identifies `HOOK_PAY_202` in the processed transaction cache. It bypasses booking logic, executes zero DB writes, and returns HTTP 200 with the previously generated `BL-PN-7721`.
7. Observable Outcome:
   - Only ONE booking confirmation email/pass is generated.
   - The customer's card is debited exactly once (₹504).
   - In Dev Panel -> Raw State Inspector: `payments.length` is 1, and `seats["2B"].bookingRef` is uniquely `BL-PN-7721`.

---

### Severe Case 4: Price Tampering and Gateway Amount Integrity Violation
- **Risk Profile**: **CRITICAL (P0)** — Deliberate financial exploitation; adversary buys bus tickets for ₹1 instead of ₹1,449.
- **Root Cause**: Server trusting client-supplied total amount in payment submission payloads.

#### Step-by-Step Reproduction & Verification Protocol:
1. Open `http://localhost:3000/?dev=1`.
2. Select 3 seats: 1A, 1B, 1C.
3. Verify Fare Summary:
   - 3 Seats × ₹450 = ₹1,350
   - Convenience Fee = ₹30
   - Subtotal = ₹1,380
   - 5% GST = ₹69.00
   - Total = **₹1,449.00**.
4. In the Dev Panel under **Adversarial Exploits**, click **'Tamper Amount to ₹1'** (or use browser DevTools console to dispatch `fetch('/api/payment/initiate', {method: 'POST', body: JSON.stringify({holdToken: token, amount: 1})})`).
5. Click **'Pay'**.
6. Server Validation Verification:
   - The server calculates the authoritative amount from the server-side hold ledger (`3 × 450 = 1350 + 30 + 69 = 1449`).
   - The server detects `client_amount (1) !== server_amount (1449)`.
   - The server immediately terminates the request with HTTP 400 Bad Request:  
     `{error: "PAYLOAD_AMOUNT_MISMATCH", expected: 1449, received: 1}`.
   - No payment token is issued, and no booking is confirmed.
7. Observable Outcome:
   - Error banner displayed: *"Transaction security validation failed. Fare mismatch detected."*
   - Seat holds remain intact; ticket cannot be procured without paying the authentic ₹1,449.

---

### Severe Case 5: Background Tab Hold Expiry with Stale Re-submission
- **Risk Profile**: **HIGH (P1)** — Mobile user locks phone on checkout; timer freezes; user unlocks phone 15 minutes later and taps Pay, assuming seats are still theirs.
- **Root Cause**: Mobile browsers throttling `setInterval` / `setTimeout` timers to save battery when backgrounded, causing client clock to freeze.

#### Step-by-Step Reproduction & Verification Protocol:
1. Open `http://localhost:3000/?dev=1` on a mobile browser (or desktop browser with DevTools background throttling).
2. Select Seat 3C. Proceed to Payment Screen.
3. In the Dev Panel, click **'Expire Hold Immediately'** (simulating 10 minutes passing while phone screen was off).
4. Do not refresh the page. Click the active **'Pay ₹504'** button.
5. Client-Server Verification:
   - The client verifies hold validity with the server prior to opening the payment gateway modal.
   - The server returns `{valid: false, reason: "HOLD_EXPIRED"}`.
   - The payment flow is immediately aborted before card details or gateway calls are triggered.
   - A modal displays:  
     > **"Hold Expired"**  
     > *"Your 10-minute hold on Seat 3C expired while you were away. The seat has been released to other passengers."*
   - Clicking 'Return to Seat Map' takes the customer back to an updated, synchronized seat map.

---

## Three Failure Modes Believed Real But Untestable in This Environment

While our test harness simulates network latency, gateway errors, and clock skew, three distributed failure modes cannot be honestly tested without infrastructure beyond a single-machine sandbox.

---

### Untested Failure Mode 1: Distributed Split-Brain Under Multi-Region Network Partition
- **The Failure**:  
  In a high-availability active-active multi-datacenter deployment (e.g., AWS Mumbai `ap-south-1a` and Pune edge node), if the interconnecting WAN partition occurs, two different customers connected to different regional nodes could simultaneously acquire a distributed Redis/etcd lock for Seat 4A. Both regions independently believe they hold quorum, process payments, and issue conflicting booking confirmations for the same seat.
- **What Would Have to Exist to Test It**:
  1. A multi-node distributed database cluster (e.g., CockroachDB, Spanner, or Redis Raft cluster) running across at least 3 distinct availability zones.
  2. A chaos orchestration framework such as **Chaos Mesh** or **Jepsen** running in a Kubernetes cluster.
  3. Linux kernel network manipulation capabilities (`iptables`, `tc`, or `iproute2`) to inject asymmetric bidirectional packet loss, cross-zone partitions, and leader isolation while hammering the `/api/hold` endpoint with 10,000 requests/second.

---

### Untested Failure Mode 2: NTP Kernel Step-Backwards Clock Jumps During Expiry Sweeps
- **The Failure**:  
  If the host server synchronizes its system clock with an upstream NTP server that has drifted, the operating system clock may step backward by 60 seconds (or during an astronomical leap second insertion). If the hold reaper relies on wall-clock time (`Date.now()` or `time.time()`) rather than a monotonic hardware clock (`process.hrtime.bigint()` or `CLOCK_MONOTONIC`), active holds could have their remaining time lengthened by 60 seconds or prematurely purged, causing ghost locks or unexpected early cancellations.
- **What Would Have to Exist to Test It**:
  1. A bare-metal Linux hypervisor or privileged container running `systemd-timesyncd` / `chrony`.
  2. Root capabilities (`CAP_SYS_TIME`) allowing automated scripts to call `adjtimex()` or `clock_settime(CLOCK_REALTIME, ...)` to force instantaneous backward time jumps of -60s and +60s while hold timers are being reaped.
  3. Verification tools monitoring kernel time syscalls to prove the state engine strictly uses monotonic clock offsets.

---

### Untested Failure Mode 3: Banking Core Asynchronous Settlement Replay Across Multi-Day Boundaries
- **The Failure**:  
  In the Indian banking network (NPCI / IMPS / UPI switches), a transaction initiated at 22:25 IST on Monday may fail to respond with a final clearing code due to midnight clearinghouse batch roll-over. The customer cancels their unconfirmed session and receives an automated release. However, 36 hours later, the acquiring bank's batch reconciliation engine settles the pending transaction and sends an asynchronous `SETTLEMENT_SUCCESS` HTTP postback. If the booking engine's webhook handler naively attempts to resurrect the booking, it would attempt to assign a seat on a bus that already departed yesterday.
- **What Would Have to Exist to Test It**:
  1. Direct integration with an actual banking switch sandbox (e.g., Razorpay / Juspay / NPCI simulated clearinghouse) capable of delaying webhooks across multiple settlement calendar days (T+2 settlement windows).
  2. Multi-day state persistence infrastructure with automated synthetic batch jobs simulating midnight bank account reconciliations.
  3. Integration with accounting ledger systems (ERP / GST filing systems) to verify that an out-of-band late settlement automatically registers as an unallocated credit and triggers an autonomous reversal without resurrecting a past journey.
