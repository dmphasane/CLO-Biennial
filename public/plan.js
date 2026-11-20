// ═══════════════════════════════════════════════════════════════════════════
// NEDLO payment plan calculator — ONE implementation shared by the registration
// forms, the portal and the server (so they can never disagree).
//
// A new registration's plan starts in the month they register (that month's payment
// is due) and is spread in equal parts:
//   • Registration fee (R5,700): from the join month to DECEMBER 2026. If they join
//     after December, it is due in full in their join month.
//   • Accommodation: from the join month to MAY 2027 (due in full in the join month
//     if they join after May).
// The last instalment of each part absorbs rounding cents, so totals are always exact.
// A member's plan is stored on their record at registration and never recalculated.
// ═══════════════════════════════════════════════════════════════════════════
(function(root){
  const REG_TOTAL = 5700;
  const REG_END = '2026-12';
  const ACCOM_END = '2027-05';
  const TOL = 0.005;

  const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  // Inclusive list of 'YYYY-MM' keys from a to b ([] when a is after b)
  function monthsBetween(a, b){
    const out = [];
    let [y, m] = a.split('-').map(Number);
    const [ey, em] = b.split('-').map(Number);
    while(y < ey || (y === ey && m <= em)){
      out.push(y + '-' + String(m).padStart(2, '0'));
      m++; if(m > 12){ m = 1; y++; }
    }
    return out;
  }

  // The current month in South Africa (so a registration just after midnight on the 1st
  // lands in the right month regardless of the server's / visitor's clock).
  function currentMonthKey(date){
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit' })
      .formatToParts(date || new Date());
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    return y + '-' + m;
  }

  // Today's date in South Africa as 'YYYY-MM-DD'
  function currentDate(date){
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(date || new Date());
  }

  // Split a total into n equal parts; the last part absorbs the rounding difference.
  function splitEqual(total, n){
    if(n <= 0) return [];
    const each = r2(total / n);
    const arr = new Array(n).fill(each);
    arr[n - 1] = r2(total - each * (n - 1));
    return arr;
  }

  // Build a member's plan. accomTotal = 0 for Registration Only.
  // Returns [{ month, reg, accom, due }] in month order.
  function buildPlan(opts){
    const start = opts.start;
    const accomTotal = Number(opts.accomTotal) || 0;
    const regTotal = opts.regTotal === undefined ? REG_TOTAL : Number(opts.regTotal);
    const regMonths = monthsBetween(start, start <= REG_END ? REG_END : start);
    const accMonths = accomTotal > 0 ? monthsBetween(start, start <= ACCOM_END ? ACCOM_END : start) : [];
    const regParts = splitEqual(regTotal, regMonths.length);
    const accParts = splitEqual(accomTotal, accMonths.length);
    const reg = {}, acc = {};
    regMonths.forEach((m, i) => { reg[m] = regParts[i]; });
    accMonths.forEach((m, i) => { acc[m] = accParts[i]; });
    const months = Array.from(new Set(regMonths.concat(accMonths))).sort();
    return months.map(m => ({ month: m, reg: reg[m] || 0, accom: acc[m] || 0, due: r2((reg[m] || 0) + (acc[m] || 0)) }));
  }

  function planTotal(plan){ return r2(plan.reduce((s, r) => s + r.due, 0)); }
  function planRegTotal(plan){ return r2(plan.reduce((s, r) => s + r.reg, 0)); }
  function planAccomTotal(plan){ return r2(plan.reduce((s, r) => s + r.accom, 0)); }
  function dueForMonth(plan, month){ const r = plan.find(x => x.month === month); return r ? r.due : 0; }

  // Spread what a member has paid across their plan, month by month, in order.
  // Within a month the registration part is covered first. Returns the per-month
  // picture plus any credit (paid beyond the whole plan).
  function allocate(plan, paid){
    let remaining = r2(paid);
    const rows = plan.map(r => {
      let paidReg = 0, paidAccom = 0, status = 'UNPAID';
      if(remaining >= r.due - TOL && r.due > 0){
        paidReg = r.reg; paidAccom = r.accom; remaining = r2(remaining - r.due); status = 'PAID';
      } else if(remaining > TOL){
        paidReg = r2(Math.min(remaining, r.reg));
        paidAccom = r2(Math.min(remaining - paidReg, r.accom));
        remaining = 0; status = 'PARTIAL';
      }
      return { month: r.month, reg: r.reg, accom: r.accom, due: r.due, paidReg, paidAccom, paid: r2(paidReg + paidAccom), status };
    });
    return { rows, credit: remaining > TOL ? r2(remaining) : 0 };
  }

  // For each plan month, the index of the payment (in the order given) that completed it, or -1.
  function coveringPayment(plan, amountsInOrder){
    const cumDue = []; let c = 0;
    plan.forEach(r => { c = r2(c + r.due); cumDue.push(c); });
    const res = plan.map(() => -1);
    let paid = 0;
    amountsInOrder.forEach((a, i) => {
      paid = r2(paid + a);
      cumDue.forEach((cd, j) => { if(res[j] === -1 && paid >= cd - TOL) res[j] = i; });
    });
    return res;
  }

  root.NedloPlan = {
    REG_TOTAL, REG_END, ACCOM_END,
    r2, monthsBetween, currentMonthKey, currentDate, splitEqual, buildPlan,
    planTotal, planRegTotal, planAccomTotal, dueForMonth, allocate, coveringPayment,
  };
})(globalThis);
