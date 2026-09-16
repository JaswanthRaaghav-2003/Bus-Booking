# Part 1: Specification Review & Rectified Engineering Specification

**Document Version:** 1.0.0-PROD-SPEC  
**Product:** BusLane Intercity Reservation Engine  
**Route:** Pune to Nashik (Departing 22:30 IST)  

---

## 1. Line-by-Line Review of the Original Specification

Each line of the original 29-line specification has been scrutinized for logical consistency, financial integrity, concurrency safety, user privacy, and operational viability.

| Line | Original Specification Statement | Category | Detailed Analysis & Failure Mechanism |
| :--- | :--- | :--- | :--- |
| **1** | *One route: Pune to Nashik, departing 22:30.* | **Omission** | Does not specify: (a) Calendar travel date, (b) Journey duration and arrival time, (c) Boarding and dropping landmark points, (d) Time zone (assumed IST UTC+05:30), and (e) Booking cut-off window before departure (e.g., stops booking 15 minutes before 22:30). |
| **2** | *One bus, 32 seats, two-plus-two across eight rows, numbered 1A to 8D.* | **Omission** | Missing layout orientation: which seats are window vs. aisle (standard 2+2 layout: A & D are window seats, B & C are aisle seats). Lacks driver cabin location, door placement, and emergency exit designations necessary for accessibility and safety regulations. |
| **3** | *Seats 3A, 3B, 4A and 4B are ladies seats, bookable only by female passengers.* | **Buildable exactly as written and still wrong for a paying customer** / **Omission** | 1. **Co-traveler deadlock**: If a family (e.g., husband and wife, or mother and son) books together, can a female passenger take 3A while the male takes an adjacent seat? The rule as written strictly isolates seats 3A–4B, preventing mixed-gender family bookings if one wants a ladies seat.<br>2. **Adjacent stranger hazard**: If a female stranger books 3A, 3B is still reserved for females, which is safe. But what about row 5? Spec does not prevent a male stranger from booking right next to a solo female passenger in general seats.<br>3. **Verification vacuum**: System collects self-declared gender with no verification mechanism, enabling bad actors to falsely select "Female" to access ladies seats. |
| **4** | *A customer may book up to four seats in one booking.* | **Omission** | Does not prevent a single user or bot from opening multiple browser tabs/sessions and hoarding the entire bus 4 seats at a time under the same phone number or payment instrument. |
| **5** | *The customer taps seats to select them. Booked seats cannot be selected.* | **Omission** | Fails to address **held** seats. If Customer A selects seat 1A, can Customer B tap it? The spec only says "Booked seats cannot be selected". If held seats are selectable, multiple customers proceed to details/payment simultaneously, guaranteeing downstream collisions. |
| **6** | *The seat map displays the name of the passenger in each booked seat, so groups travelling together can find one another.* | **Buildable exactly as written and still wrong for a paying customer** | **Severe Privacy & Personal Safety Hazard (Critical P0)**:<br>1. Publicly displaying real passenger names on an unauthenticated public seat map exposes passenger identities, travel patterns, and personal schedules to stalkers, predators, and commercial data scrapers.<br>2. Combined with Line 3 (ladies seats 3A, 3B, 4A, 4B), this allows any stranger on the internet to see the full names and exact seating locations of solo female travelers on a night bus (22:30).<br>3. Blatant violation of India's Digital Personal Data Protection Act (DPDP Act 2023) and global GDPR standards. Groups can coordinate via booking reference codes or private links, never via public passenger name broadcasts. |
| **7** | *A seat is held for ten minutes from the moment it is selected.* | **Sequencing problem** / **Contradiction** | 1. **Rolling vs. Discrete Timers**: If a customer selects seat 1A at 00:00 (expires 10:00) and selects seat 1B at 04:00, does 1A expire at 10:00 and 1B at 14:00, or does selecting 1B reset the entire basket timer to 14:00? If timers are seat-discrete, partial basket expiry occurs midway through form fill.<br>2. **Direct Conflict with Line 9**: Line 9 gives a 5-minute payment timeout. If the user spends 7 minutes entering passenger details, 3 minutes remain on the seat hold. When reaching payment, does the customer get 5 minutes or 3 minutes? If 5 minutes, the seat hold expires 2 minutes before the payment window closes! |
| **8** | *Passenger details are collected for each passenger: name, age, gender, phone number.* | **Omission** | 1. **Child validation**: Line 19 states children under five travel free. Does an infant have a phone number? Requiring phone numbers for infants/minors is impossible for families.<br>2. **Format and validation rules**: No regex or validation bounds for phone number (e.g., 10-digit Indian mobile `^[6-9]\d{9}$`), name length (min 2, max 50 chars, no control characters), or age bounds (0–120). |
| **9** | *The payment page times out after five minutes.* | **Contradiction** / **Sequencing problem** | Conflicts directly with Line 7. If payment page timer is independent of the hold timer, a customer can initiate payment when hold has 30 seconds remaining; payment takes 60 seconds; gateway succeeds, but hold expired and seat was already sold to another customer. |
| **10** | *If payment fails, the customer returns to the seat map with their seats still selected.* | **Contradiction** / **Omission** | If payment fails because the payment window timed out or the 10-minute hold expired, returning the customer to the seat map with the seats "still selected" creates a ghost state. Another customer may have already held or booked those seats. If the server does not re-verify availability, this results in an immediate crash or double booking. |
| **11** | *If the customer abandons payment, we send an SMS link to complete the booking and hold the seats for thirty minutes.* | **Buildable exactly as written and still wrong for a paying customer** / **Omission** | **Catastrophic Denial of Service (DoS) Exploit**:<br>1. An attacker or competitor can initiate 8 bookings of 4 seats each (total 32 seats), enter dummy passenger data, close the tab at payment, and lock down the **entire bus for 30 minutes** without paying a single rupee. Repeating this every 30 minutes blocks the bus indefinitely.<br>2. Ambiguity: How does the system detect "abandonment"? Closing browser tab cannot reliably send an HTTP beacon on mobile browsers. If inactivity triggers this, an indecisive user gets rewarded with a 30-minute lock while denying seats to paying customers. |
| **12** | *The confirmation screen shows a booking reference, the seat numbers and the boarding point.* | **Sequencing problem** | Directly contradicts Line 13! If boarding point is selected *after* payment (Line 13), the initial confirmation screen cannot show the boarding point unless boarding point selection happens *before* confirmation or *before* payment. |
| **13** | *The customer chooses their boarding point after payment.* | **Sequencing problem** / **Buildable exactly as written and still wrong for a paying customer** | 1. Boarding point dictates departure time (e.g., Swargate 22:30, Wakad 23:15). If a customer pays first and then finds their desired boarding location is unavailable, already closed, or inconvenient, they are trapped in a paid booking they cannot use.<br>2. If the user closes the tab immediately upon seeing the payment success screen (very common behavior), the booking is created without any boarding point, stranding both the passenger and the bus operator. Boarding point selection **must** happen before payment. |
| **14** | *Two customers cannot book the same seat.* | **Omission** | A business assertion with zero technical mechanism specified. Without atomic distributed transactions, optimistic concurrency control (version checks), or database row locks, concurrent payment confirmations create double-booked seats. |
| **15** | *Base fare ₹450 per seat.* | **Buildable** | Unambiguous base rate per seat. |
| **16** | *Convenience fee ₹30 per booking, not per seat.* | **Buildable** | Flat fee per transaction. |
| **17** | *GST at 5%.* | **Omission** | Ambiguity in tax base: Does 5% GST apply to Base Fare only (`₹450 × N × 0.05`), or to (Base Fare + Convenience Fee) (`[Base + 30] × 0.05`)? Under Indian GST law, passenger transport in non-AC/ordinary buses or stage carriages has specific tax brackets, but convenience fees as platform services are technically taxable. The specification fails to state the exact formula. |
| **18** | *Worked example, two seats: ₹450 × 2 = ₹900, plus ₹30 convenience fee, plus 5% GST, total ₹960.* | **Arithmetic error** | **Glaring Mathematical Error**:<br>- Subtotal: ₹900 (base) + ₹30 (fee) = ₹930.<br>- 5% of ₹900 is ₹45.00 → Total = ₹975.00.<br>- 5% of ₹930 is ₹46.50 → Total = ₹976.50.<br>- The spec's total of ₹960 implies GST is `₹960 - ₹930 = ₹30`, which is **3.225%** of ₹930 (or 3.33% of ₹900), not 5%! Either the author added ₹30 twice by mistake or invented an arbitrary number. This calculation will fail any financial audit. |
| **19** | *Children under five travel free, but must be entered as passengers.* | **Contradiction** | Directly contradicts Line 20 ("Every passenger must be assigned a seat") and conflicts with Line 4 (max 4 seats). |
| **20** | *Every passenger must be assigned a seat.* | **Contradiction** | **Direct Contradiction with Line 21**: Line 20 states every passenger MUST be assigned a seat. Line 21 explicitly states "Passengers travelling free are not assigned a seat." Both statements cannot be true simultaneously. |
| **21** | *Passengers travelling free are not assigned a seat.* | **Contradiction** / **Omission** | Contradicts Line 20. Furthermore, omission: How many lap children (under 5) can accompany an adult? If one adult books 1 seat and brings 5 children under 5, this creates severe vehicle safety, overloading, and seatbelt violations. Max 1 lap infant per ticketed adult must be strictly enforced. |
| **22** | *Fares may change at any time, and the current price must always be shown.* | **Contradiction** / **Sequencing problem** | Clashes directly with Line 23. If fare changes dynamically while a user is entering passenger details or on the payment page, which price prevails? |
| **23** | *The price shown at seat selection is the price the customer pays.* | **Contradiction** / **Omission** | Conflicts with Line 22 if dynamic pricing is active. If the price is locked at seat selection, what happens when the 10-minute hold expires? If the customer stays on the payment screen, does the lock persist past hold expiry? (Answer: Price is locked to the hold session token; if hold expires, price lock is voided). |
| **24** | *Cancelled more than 24 hours before departure: full refund. Within 24 hours: 50%. After departure: none.* | **Omission** | 1. **Convenience fee refundability**: Standard commercial practice dictates platform convenience fees are non-refundable. The spec does not state if the ₹30 fee and its GST are retained or refunded.<br>2. **Exact boundary condition**: What happens at exactly 24 hours (24h 00m 00s)?<br>3. **GST refund mechanism**: Does the operator issue a formal GST Credit Note for the refunded tax? |
| **25** | *Refunds reach the customer in five to seven working days.* | **Omission** | Fails to distinguish between server-side payment refund initiation (which happens within seconds) and inter-bank clearing/settlement timelines. |
| **26** | *The booking shows as "Refunded" in the app immediately on cancellation.* | **Buildable exactly as written and still wrong for a paying customer** | If the app displays "Refunded" the second the customer hits cancel, but the money takes 5–7 working days to reflect in their bank account (Line 25), customers flood customer support demanding to know where their money is. The correct status is `"Cancellation Confirmed — Refund Initiated"`. |
| **27** | *The ticket is generated on the server and emailed to the customer.* | **Omission** | Does not specify: (a) What happens if the customer's email bounces or is mistyped, (b) Whether an in-app downloadable/printable ticket view exists. |
| **28** | *If the email fails to send, the booking is still confirmed.* | **Buildable** | Good decoupling practice: asynchronous notification failure does not rollback a finalized financial transaction. |
| **29** | *The ticket must be shown to the driver at boarding.* | **Omission** | What constitutes the ticket for the driver? Is an SMS reference code, digital in-app ticket with QR code, or physical printout required? Does the driver have a conductor manifest/scanner app to validate against offline fraud? |

---

## 2. The Rectified Numbered Specification (BusLane v1.0 Production Rules)

To eliminate all contradictions, race conditions, arithmetic errors, and security holes, BusLane operates under the following short, definitive, buildable engineering rules:

### Trip & Bus Configuration
1. **Route & Schedule**: BusLane operates Route BL-PN-01 (Pune Swargate to Nashik CBS, departure 22:30 IST). Booking closes strictly 15 minutes before departure (22:15 IST).
2. **Bus Layout**: Single-deck coach with 32 seats in an 8-row, 2+2 layout:
   - Window seats: Columns A and D (1A..8A, 1D..8D).
   - Aisle seats: Columns B and C (1B..8B, 1C..8C).
3. **Ladies Seats & Safeguards**:
   - Seats 3A, 3B, 4A, and 4B are reserved exclusively for female passengers.
   - Any booking assigning a male passenger to seats 3A, 3B, 4A, or 4B is rejected by the server with a validation error.
   - **Privacy Guarantee**: The seat map displays seat statuses anonymously as `Available`, `Held by another`, or `Booked`. **Passenger names are never displayed on the public seat map.**
4. **Booking Limits**: A customer may book a maximum of 4 physical seats per transaction.

### Seat Selection, Holds & Boarding Point
5. **Atomic Holds & Durations**:
   - Selecting a seat issues an atomic server-side hold lease tied to a unique `holdToken` for exactly **10 minutes (600 seconds)**.
   - Real-time synchronization broadcasts seat state to all connected clients immediately.
   - If a customer adds or removes seats within their 4-seat quota, the hold countdown continues from the earliest selected seat timestamp (no timer elongation exploits).
6. **Boarding Point Selection**:
   - The customer selects their boarding point (Swargate 22:30, Shivaji Nagar 22:50, Nashik Phata 23:15, or Bhosari 23:45) **during seat selection / passenger details**, before payment is initiated.
7. **Hold Expiry Policy**:
   - If the 10-minute hold expires while the customer is on any screen (seat map, passenger details, or payment):
     - The seats are automatically released back to the global pool.
     - The client UI transitions to an `Expired Hold` notice.
     - Any in-flight payment submission against an expired hold token is rejected by the server before charging.

### Passenger Details & Child Fare Rules
8. **Passenger Demographics**:
   - Each seated passenger requires: Full Name (2–50 chars, alphabetic), Age (5–120), Gender (`Female`, `Male`, `Other`), and a Primary Contact Phone (10 digits) for the booking.
9. **Children Under Five Policy**:
   - Children under 5 travel free as **lap infants** and are **not assigned a physical seat**.
   - Maximum 1 lap infant per adult passenger (age ≥ 18).
   - Lap infants must be registered with their name, age (< 5), and gender, and are tethered to an accompanying adult passenger in the manifest for insurance and safety compliance.

### Fares, Price Lock & Mathematical Formulas
10. **Fare Structure & Canonical Tax Calculation**:
    - **Base Fare**: ₹450 per seat.
    - **Convenience Fee**: Flat ₹30 per booking (regardless of the number of seats).
    - **Tax Base**: GST applies at 5% on the entire taxable invoice (Base Fare + Convenience Fee).
    - **Rounding Rule**: Financial amounts are rounded half-up to the nearest whole Rupee (₹0.50 rounds up to ₹1.00; ₹0.49 rounds down).
    - **Worked 3-Seat Calculation (to the Rupee)**:
      - 3 Seats × ₹450 = **₹1,350.00**
      - Convenience Fee = **₹30.00**
      - Taxable Subtotal = ₹1,350 + ₹30 = **₹1,380.00**
      - GST @ 5% = ₹1,380.00 × 0.05 = **₹69.00**
      - **Grand Total Payable = ₹1,449.00**
11. **Price Lock Guarantee**:
    - The price displayed at seat selection is locked for the duration of the active 10-minute hold.
    - If base fares change in the system while a hold is active, the customer pays the locked rate.
    - If the hold expires, any subsequent re-hold fetches the newly updated dynamic fare.

### Payment, Gateway Concurrency & Recovery
12. **Payment Window**:
    - The payment gateway window is bounded by the remaining seat hold time, with an absolute maximum of 5 minutes. (If hold has 3 minutes left, the payment window is 3 minutes).
13. **Late Payment / Seat Stolen Resolution**:
    - If payment succeeds after the server hold expired, and the seat has already been booked by another customer:
      1. Server rejects ticket creation with status `CONFLICT_SEAT_TAKEN`.
      2. Server instantly executes an automated full refund reversal (`REFUND_INSTANT_AUTO`).
      3. Client renders an empathetic resolution screen: *"Your payment was received after the reservation hold expired and the seat was claimed. A full refund of ₹[amount] has been initiated to your source account. Reference: [TxnID]."*
14. **Idempotent Payment Confirmation**:
    - Every payment attempt carries an `idempotencyKey`. Duplicate webhook or client payment confirmations return the existing confirmed booking without charging twice.
15. **Abandonment Policy (Anti-DoS)**:
    - If a customer abandons payment or closes the tab, the seats remain held only until the original 10-minute hold expires, after which they immediately become available to other customers.
    - A recovery link allows restoring passenger details only if the seats remain available in the pool.

### Confirmation, Cancellation & Boarding
16. **Confirmation & Durability**:
    - Successful payment generates a cryptographically unique 10-character booking reference (e.g. `BL-PN-88219`), displays confirmed seats, selected boarding point, boarding time, passenger roster, and a scannable QR ticket.
    - Seat state persists across page reloads via server-authoritative session sync.
17. **Cancellation & Refund Policy**:
    - Cancelled > 24 hours prior to 22:30 departure: 100% refund of Base Fare + GST on Base Fare. (Convenience fee of ₹30 + fee GST is non-refundable).
    - Cancelled within 24 hours prior to departure: 50% refund of Base Fare + GST on Base Fare.
    - Cancelled after departure (< 0 min): Zero refund.
    - Application displays status as `"Cancellation Confirmed — Refund Initiated"`, with settlement arriving in 5–7 bank working days.
