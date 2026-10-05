import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const FROM_EMAIL = process.env.GMAIL_USER || 'nedloregistration@gmail.com';

// Gmail transport using an App Password (never the account password)
export function makeTransport(){
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: FROM_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD, // 16-char app password, no spaces
    },
  });
}

// â”€â”€â”€ Domain constants (must mirror the frontend) â”€â”€â”€
const REG_TOTAL = 5700;
const SCHEDULES = {
  legacy: ['2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12','2027-01','2027-02','2027-03','2027-04','2027-05'],
  new:    ['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03','2027-04','2027-05'],
  regonly:['2026-10','2026-11','2026-12'],
};
const r2 = n => parseFloat(n.toFixed(2));
const OPTIONS = {
  'OPT-1':{hotel:'Sandton Sun',type:'Not Sharing',total:2122.92,accom:1647.92,reg:475},
  'OPT-2':{hotel:'Sandton Sun',type:'Sharing',total:1382.29,accom:907.29,reg:475},
  'OPT-3':{hotel:'Sandton Towers',type:'Not Sharing',total:2247.92,accom:1772.92,reg:475},
  'OPT-4':{hotel:'Sandton Towers',type:'Sharing',total:1361.29,accom:886.29,reg:475},
  'OPT-5':{hotel:'Garden Court',type:'Not Sharing',total:1222.92,accom:747.92,reg:475},
  'OPT-6':{hotel:'Garden Court',type:'Sharing',total:909.38,accom:434.38,reg:475},
  'REG-ONLY':{hotel:'Registration Only',type:'No Accommodation',total:r2(REG_TOTAL/3),accom:0,reg:r2(REG_TOTAL/3),scheduleKey:'regonly'},
  'CAP-S':{hotel:'The Capital',type:'Single B&B',total:r2((12250+REG_TOTAL)/8),accom:r2(12250/8),reg:r2(REG_TOTAL/8),scheduleKey:'new'},
  'CAP-SH':{hotel:'The Capital',type:'Sharing B&B (per person)',total:r2((6900+REG_TOTAL)/8),accom:r2(6900/8),reg:r2(REG_TOTAL/8),scheduleKey:'new'},
  'CAT-S':{hotel:'The Catalyst',type:'Single B&B',total:r2((7950+REG_TOTAL)/8),accom:r2(7950/8),reg:r2(REG_TOTAL/8),scheduleKey:'new'},
  'CAT-SH':{hotel:'The Catalyst',type:'Sharing B&B (per person)',total:r2((4725+REG_TOTAL)/8),accom:r2(4725/8),reg:r2(REG_TOTAL/8),scheduleKey:'new'},
};
function fmt(n){ return 'R'+Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
function memberSchedule(m){
  const opt = OPTIONS[m.accommodationOption];
  if(opt && opt.scheduleKey==='regonly') return SCHEDULES.regonly;
  if(m.cohort==='new') return SCHEDULES.new;
  return SCHEDULES.legacy;
}
function monthLabel(k){ const [y,mm]=k.split('-'); return ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+mm]+' '+y; }
function elapsedMonths(m){
  const now=new Date(); const nk=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  return memberSchedule(m).filter(k=>k<=nk);
}

// â”€â”€â”€ Build professional HTML statement (mirrors the letter preview) â”€â”€â”€
export function buildStatementHTML(m, entries, settings={}){
  const opt = OPTIONS[m.accommodationOption]||{};
  const isFlex = opt.flexAmount;
  const mSched = memberSchedule(m);
  const nMo = mSched.length;
  const totalExp12 = isFlex?0:r2(m.expectedMonthlyTotal*nMo);
  const totalReg12 = isFlex?0:r2(m.expectedReg*nMo);
  const totalAccom12 = isFlex?0:r2(m.expectedAccom*nMo);
  const deadline = settings.deadline || '31 May 2027';
  const finsecName = settings.finsecName || 'Mr Dumisani Mphasane';
  const fromEmail = FROM_EMAIL;
  const surname = (m.fullName||'').trim().split(' ').pop();
  const logoUrl = settings.logoUrl || '';

  const matched = (entries||[]).filter(e=>e.linkedMemberId===m.id && e.matchStatus==='MATCHED').sort((a,b)=>(a.txnDate||'').localeCompare(b.txnDate||''));
  const uniqueEntries = [...new Map(matched.map(e=>[e.id,e])).values()];
  const actualPaid = uniqueEntries.reduce((s,e)=>s+Number(e.creditAmount),0);
  const outstanding = Math.max(0, totalExp12-actualPaid);
  const isFullyPaid = !isFlex && outstanding<=0.05;
  const monthsCovered = (!isFlex && m.expectedMonthlyTotal>0) ? Math.floor(actualPaid/m.expectedMonthlyTotal) : 0;
  const excess = (!isFlex && m.expectedMonthlyTotal>0) ? actualPaid-(monthsCovered*m.expectedMonthlyTotal) : 0;
  const elapsed = elapsedMonths(m);

  let scheduleRows='';
  mSched.map(k=>({key:k,label:monthLabel(k)})).forEach((mo,idx)=>{
    let amtRec='â€”', dateRec='â€”', status='Not Yet Due', bg='#fafafa', color='#6b7280';
    const isElapsed = elapsed.some(e=>e===mo.key);
    if(!isFlex && idx<monthsCovered){
      amtRec=fmt(m.expectedMonthlyTotal);
      const e=uniqueEntries[Math.min(idx,uniqueEntries.length-1)];
      dateRec=e?e.txnDate:'â€”'; status='Received'; bg='#f0fdf4'; color='#16a34a';
    } else if(!isFlex && idx===monthsCovered && excess>0.05){
      amtRec=fmt(excess); status='Partially Paid'; bg='#fefce8'; color='#b45309';
      const e=uniqueEntries[uniqueEntries.length-1]; dateRec=e?e.txnDate:'â€”';
    } else if(isElapsed){ status='Outstanding'; bg='#fef2f2'; color='#dc2626'; }
    scheduleRows+=`<tr style="background:${bg};">
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;">${mo.label}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">${isFlex?'â€”':fmt(m.expectedMonthlyTotal)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${amtRec}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;">${dateRec}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;font-weight:600;color:${color};">${status}</td>
    </tr>`;
  });

  let paymentsHtml='';
  if(uniqueEntries.length){
    paymentsHtml=`<div style="font-weight:700;color:#1a3a6b;margin:14px 0 6px;">PAYMENTS RECEIVED</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#f0fdf4;"><th style="padding:6px;text-align:left;">Date</th><th style="padding:6px;text-align:right;">Amount</th><th style="padding:6px;text-align:left;">Reference</th></tr></thead><tbody>`;
    uniqueEntries.forEach(e=>{ paymentsHtml+=`<tr><td style="padding:5px;border-bottom:1px solid #e5e7eb;">${e.txnDate}</td><td style="padding:5px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;">${fmt(e.creditAmount)}</td><td style="padding:5px;border-bottom:1px solid #e5e7eb;font-size:11px;">${e.referenceRaw||''}</td></tr>`; });
    paymentsHtml+=`<tr style="background:#dcfce7;font-weight:700;"><td style="padding:6px;">TOTAL RECEIVED</td><td style="padding:6px;text-align:right;">${fmt(actualPaid)}</td><td style="padding:6px;">${uniqueEntries.length} payment(s)</td></tr></tbody></table>`;
  }

  const banner = isFullyPaid
    ? `<div style="background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:12px;margin:14px 0;color:#15803d;"><strong>âœ… FULLY PAID â€” Thank you!</strong> Your accommodation and registration are confirmed.</div>`
    : (!isFlex ? `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:12px;margin:14px 0;color:#854d0e;"><strong>âš  Outstanding Balance: ${fmt(outstanding)}</strong> â€” please settle by ${deadline}.</div>` : '');

  const bankBox = isFullyPaid ? '' : `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px;margin:14px 0;">
    <div style="font-weight:700;color:#1a3a6b;margin-bottom:6px;">ðŸ’³ BANKING DETAILS</div>
    <table style="width:100%;font-size:13px;">
      <tr><td style="color:#6b7280;">Account Name</td><td>Biennial 2027 â€“ Lay Organization Stokvel Fund</td></tr>
      <tr><td style="color:#6b7280;">Account No.</td><td style="font-weight:700;">63211345582</td></tr>
      <tr><td style="color:#6b7280;">Bank</td><td>First National Bank (FNB)</td></tr>
      <tr><td style="color:#6b7280;">Branch Code</td><td>250655</td></tr>
      <tr><td style="color:#1a3a6b;font-weight:700;">Your Reference</td><td style="font-weight:800;color:#1a3a6b;">${m.paymentRef}</td></tr>
    </table></div>`;

  return `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1f2937;max-width:700px;margin:0 auto;">
    <div style="border-bottom:3px solid #1a3a6b;padding-bottom:12px;margin-bottom:14px;">
      ${logoUrl?`<img src="${logoUrl}" style="width:60px;height:60px;border-radius:50%;vertical-align:middle;margin-right:12px;"/>`:''}
      <span style="font-size:16px;font-weight:700;color:#1a3a6b;vertical-align:middle;">NEDLO Biennial 2027 Stokvel Fund</span><br/>
      <span style="font-size:11px;color:#6b7280;">Confirmation of Contributions Received â€” 19th Episcopal District Lay Organisation</span>
    </div>
    <p>Date: <strong>${new Date().toLocaleDateString('en-ZA',{day:'2-digit',month:'long',year:'numeric'})}</strong> &nbsp; | &nbsp; Conference: <strong>${m.conferenceCode}</strong></p>
    <p>Dear ${surname},</p>
    <p>This letter confirms the status of your contributions to the NEDLO Biennial 2027 Stokvel Fund.</p>
    ${banner}
    <div style="font-weight:700;color:#1a3a6b;margin:14px 0 6px;">SELECTED OPTION</div>
    <table style="width:100%;font-size:13px;">
      <tr><td style="color:#6b7280;width:220px;">Option</td><td><strong>${m.accommodationOption}${opt.hotel&&opt.hotel!=='N/A'?' â€“ '+opt.hotel+' ('+opt.type+')':' â€“ Once Off / Flexible'}</strong></td></tr>
      <tr><td style="color:#6b7280;">Biennial Registration</td><td>${isFlex?'Flexible':fmt(m.expectedReg)+'/mo ('+fmt(totalReg12)+' total)'}</td></tr>
      <tr><td style="color:#6b7280;">Accommodation</td><td>${isFlex?'Flexible':fmt(m.expectedAccom)+'/mo ('+fmt(totalAccom12)+' total)'}</td></tr>
      <tr><td style="color:#1a3a6b;font-weight:700;">Total (${nMo} months)</td><td style="font-weight:700;">${isFlex?'Flexible':fmt(totalExp12)}</td></tr>
    </table>
    <div style="font-weight:700;color:#1a3a6b;margin:14px 0 6px;">PAYMENT SCHEDULE & STATUS</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#1a3a6b;color:#fff;"><th style="padding:7px;text-align:left;">Month</th><th style="padding:7px;text-align:right;">Amount Due</th><th style="padding:7px;text-align:right;">Received</th><th style="padding:7px;text-align:left;">Date</th><th style="padding:7px;text-align:left;">Status</th></tr></thead>
      <tbody>${scheduleRows}</tbody>
    </table>
    ${paymentsHtml}
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:14px 0;">
      <div style="font-weight:700;color:#1a3a6b;margin-bottom:6px;">BALANCE SUMMARY</div>
      <table style="width:100%;font-size:13px;">
        <tr><td>Total Amount Due (${nMo} mo)</td><td style="text-align:right;font-weight:700;">${isFlex?'Flexible':fmt(totalExp12)}</td></tr>
        <tr><td>Total Received to Date</td><td style="text-align:right;font-weight:700;color:#16a34a;">${fmt(actualPaid)}</td></tr>
        <tr style="border-top:2px solid #1a3a6b;"><td style="font-weight:800;">Balance Outstanding</td><td style="text-align:right;font-weight:800;color:${isFullyPaid?'#16a34a':'#dc2626'};">${isFullyPaid?'NIL â€“ FULLY PAID':fmt(outstanding)}</td></tr>
      </table>
    </div>
    ${!isFullyPaid?`<p style="font-size:12px;color:#374151;">Please note the due date for Biennial Registration is <strong>31 December 2026</strong> (required to register members with CLO). Should the balance not be settled by <strong>${deadline}</strong>, your accommodation allocation may be affected. If you have already paid an amount not reflected here, contact us within seven (7) days.</p>`:''}
    ${bankBox}
    <div style="border-top:1px solid #e5e7eb;padding-top:12px;margin-top:14px;font-size:12px;">
      <p>Yours in service,<br/><strong>${finsecName}</strong><br/>Financial Secretary, NEDLO<br/><a href="mailto:${fromEmail}">${fromEmail}</a></p>
    </div>
  </div>`;
}

// â”€â”€â”€ Build a registration CONFIRMATION email (sent on self-registration) â”€â”€â”€
export function buildRegistrationConfirmationHTML(m){
  const opt = OPTIONS[m.accommodationOption] || {};
  const sched = memberSchedule(m);
  const nMo = sched.length;
  const monthly = Number(m.expectedMonthlyTotal)||0;
  const accomM  = Number(m.expectedAccom)||0;
  const regM    = Number(m.expectedReg)||0;
  const totalCommit = r2(monthly*nMo);
  const accomTotal  = r2(accomM*nMo);
  const regTotal    = r2(regM*nMo);
  const surname = (m.fullName||'').trim().split(' ').pop();
  const periodLabel = `${monthLabel(sched[0])} â€“ ${monthLabel(sched[nMo-1])}`;
  const isRegOnly = opt.scheduleKey === 'regonly';

  // Monthly schedule rows
  let scheduleRows = '';
  sched.forEach((k,i)=>{
    scheduleRows += `<tr style="background:${i%2?'#fafafa':'#fff'};">
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;">${monthLabel(k)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${fmt(monthly)}</td>
    </tr>`;
  });

  return `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1f2937;max-width:700px;margin:0 auto;">
    <div style="border-bottom:3px solid #1a3a6b;padding-bottom:12px;margin-bottom:14px;">
      <span style="font-size:16px;font-weight:700;color:#1a3a6b;">NEDLO Biennial 2027 Stokvel Fund</span><br/>
      <span style="font-size:11px;color:#6b7280;">Registration Confirmation â€” 19th Episcopal District Lay Organisation</span>
    </div>
    <p>Dear ${surname},</p>
    <p>Thank you for registering for the <strong>40th Lay Biennial Convention</strong> (8â€“11 August 2027, Sandton). This email confirms your registration and selected option.</p>
    <div style="background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:12px;margin:14px 0;color:#15803d;">
      <strong>âœ… Registration received.</strong> Please use your reference <strong>${m.paymentRef}</strong> for every payment.
    </div>

    <div style="font-weight:700;color:#1a3a6b;margin:14px 0 6px;">YOUR DETAILS</div>
    <table style="width:100%;font-size:13px;">
      <tr><td style="color:#6b7280;width:200px;">Full Name</td><td><strong>${m.fullName}</strong></td></tr>
      <tr><td style="color:#6b7280;">Conference</td><td>${m.conferenceCode}</td></tr>
      <tr><td style="color:#6b7280;">Local Church</td><td>${m.localChurch||'â€”'}</td></tr>
      <tr><td style="color:#6b7280;">Email</td><td>${m.email||'â€”'}</td></tr>
      <tr><td style="color:#6b7280;">Phone</td><td>${m.phone||'â€”'}</td></tr>
    </table>

    <div style="font-weight:700;color:#1a3a6b;margin:16px 0 6px;">SELECTED OPTION & COST BREAKDOWN</div>
    <table style="width:100%;font-size:13px;">
      <tr><td style="color:#6b7280;width:200px;">Option</td><td><strong>${m.accommodationOption} â€“ ${opt.hotel||''}${opt.type?' ('+opt.type+')':''}</strong></td></tr>
      ${isRegOnly ? '' : `<tr><td style="color:#6b7280;">Accommodation</td><td>${fmt(accomM)}/mo &nbsp;Ã—&nbsp; ${nMo} = <strong>${fmt(accomTotal)}</strong></td></tr>`}
      <tr><td style="color:#6b7280;">Biennial Registration</td><td>${fmt(regM)}/mo &nbsp;Ã—&nbsp; ${nMo} = <strong>${fmt(regTotal)}</strong></td></tr>
      <tr style="border-top:1px solid #e5e7eb;"><td style="color:#1a3a6b;font-weight:700;padding-top:6px;">Monthly Instalment</td><td style="font-weight:700;color:#1a3a6b;padding-top:6px;">${fmt(monthly)} per month</td></tr>
      <tr><td style="color:#1a3a6b;font-weight:700;">Total Commitment</td><td style="font-weight:800;color:#1a3a6b;">${fmt(totalCommit)} over ${nMo} months</td></tr>
      <tr><td style="color:#6b7280;">Payment Period</td><td>${periodLabel}</td></tr>
    </table>

    <div style="font-weight:700;color:#1a3a6b;margin:16px 0 6px;">PAYMENT SCHEDULE</div>
    <p style="font-size:12px;color:#374151;margin-bottom:6px;">Please pay <strong>${fmt(monthly)}</strong> each month for ${nMo} months (${periodLabel}):</p>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#1a3a6b;color:#fff;"><th style="padding:7px;text-align:left;">Month</th><th style="padding:7px;text-align:right;">Amount Due</th></tr></thead>
      <tbody>${scheduleRows}
        <tr style="background:#dbeafe;font-weight:700;"><td style="padding:7px;">TOTAL</td><td style="padding:7px;text-align:right;">${fmt(totalCommit)}</td></tr>
      </tbody>
    </table>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px;margin:16px 0;">
      <div style="font-weight:700;color:#1a3a6b;margin-bottom:6px;">ðŸ’³ BANKING DETAILS</div>
      <table style="width:100%;font-size:13px;">
        <tr><td style="color:#6b7280;width:160px;">Account Name</td><td>Biennial 2027 â€“ Lay Organization Stokvel Fund</td></tr>
        <tr><td style="color:#6b7280;">Account No.</td><td style="font-weight:700;">63211345582</td></tr>
        <tr><td style="color:#6b7280;">Bank</td><td>First National Bank (FNB)</td></tr>
        <tr><td style="color:#6b7280;">Branch Code</td><td>250655</td></tr>
        <tr><td style="color:#1a3a6b;font-weight:700;">Your Reference</td><td style="font-weight:800;color:#1a3a6b;font-size:14px;">${m.paymentRef}</td></tr>
      </table>
      <p style="margin-top:8px;font-size:11px;color:#6b7280;"><em>Please use your unique reference above for every payment so it is allocated correctly.</em></p>
    </div>

    <p style="font-size:12px;color:#374151;">The Biennial Registration portion must be fully settled by <strong>31 December 2026</strong> in order to register you with CLO. We look forward to welcoming you to Sandton in August 2027.</p>
    <div style="border-top:1px solid #e5e7eb;padding-top:12px;margin-top:14px;font-size:12px;">
      <p>Yours in service,<br/><strong>NEDLO Financial Secretary</strong><br/><a href="mailto:${FROM_EMAIL}">${FROM_EMAIL}</a></p>
    </div>
  </div>`;
}

