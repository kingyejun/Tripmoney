'use strict';
/* =====================================================================
   여행 자금 플래너
   - 예산은 "현지 통화 기준 단가 × 환율"로 계산해서 환율이 바뀌면 같이 바뀝니다.
   - 환율은 실시간 API(open.er-api.com)로 받아오고, 실패하면 내장 기준값을 씁니다.
   - 지출은 기록하는 순간의 환율·수수료를 함께 저장해서 나중에 환율이 변해도 금액이 바뀌지 않습니다.
   ===================================================================== */

/* ---------- 통화 · 목적지 데이터 ---------- */
// per: 환율을 표시할 때 기준 단위 (일본 엔, 베트남 동은 관례대로 100단위)
const CUR = {
  JPY:{u:'엔', per:100}, TWD:{u:'대만달러', per:1}, VND:{u:'동', per:100},
  THB:{u:'바트', per:1}, SGD:{u:'싱가포르달러', per:1}, HKD:{u:'홍콩달러', per:1},
  PHP:{u:'페소', per:1}, EUR:{u:'유로', per:1}, USD:{u:'달러', per:1}
};

// 단가는 "1인 기준 현지 통화". 숙소는 2인 1실 기준 1인 1박. flight·prep은 원화.
// 참고용 평균값이므로 항공권·숙소는 실제 가격으로 수정하는 것을 권장합니다.
const PRESETS = {
  '일본':    {city:'TYO', name:'도쿄', cur:'JPY', flight:350000,  stay:10000,  food:6000,   transit:1800,  act:2000,  shop:25000,   prep:40000},
  '대만':    {city:'TPE', name:'타이베이', cur:'TWD', flight:300000,  stay:1500,   food:800,    transit:250,   act:400,   shop:4000,    prep:40000},
  '베트남':  {city:'DAD', name:'다낭', cur:'VND', flight:380000,  stay:700000, food:450000, transit:150000,act:400000,shop:2000000, prep:40000},
  '태국':    {city:'BKK', name:'방콕', cur:'THB', flight:420000,  stay:1000,   food:600,    transit:200,   act:500,   shop:3000,    prep:40000},
  '싱가포르':{city:'SIN', name:'싱가포르', cur:'SGD', flight:520000,  stay:110,    food:55,     transit:12,    act:30,    shop:200,     prep:40000},
  '홍콩':    {city:'HKG', name:'홍콩', cur:'HKD', flight:420000,  stay:600,    food:300,    transit:60,    act:150,   shop:1500,    prep:40000},
  '필리핀':  {city:'CEB', name:'세부', cur:'PHP', flight:350000,  stay:1500,   food:1000,   transit:300,   act:1000,  shop:4000,    prep:40000},
  '유럽':    {city:'CDG', name:'파리', cur:'EUR', flight:1300000, stay:90,     food:50,     transit:15,    act:25,    shop:300,     prep:80000},
  '미국':    {city:'LAX', name:'로스앤젤레스', cur:'USD', flight:1500000, stay:120,    food:65,     transit:25,    act:35,    shop:400,     prep:80000}
};
const STYLES = {'알뜰':{f:.85, m:.7}, '보통':{f:1, m:1}, '여유':{f:1.5, m:1.6}};

// 1단위(원/현지통화) 내장 기준값: ECB 기준환율(2026-10-05)로 계산한 교차환율.
// 대만달러·동은 ECB 고시 통화가 아니라 추정치입니다. 실시간 환율을 받아오면 자동으로 덮어씁니다.
const FALLBACK = {
  date:'2026-10-05',
  map:{JPY:8.494, USD:1344.0, EUR:1505.8, SGD:1049.8, THB:39.89, HKD:171.3, PHP:21.44, TWD:43.4, VND:0.0531},
  estimated:['TWD','VND']
};

const CATS = [
  ['flight','항공권','var(--c1)'], ['stay','숙소','var(--c2)'], ['food','식비','var(--c3)'],
  ['transit','현지 교통','var(--c4)'], ['act','관광·액티비티','var(--c5)'], ['shop','쇼핑','var(--c6)'],
  ['prep','준비비 (보험·eSIM 등)','var(--c7)'], ['fee','환전·카드 수수료','var(--c8)'], ['buffer','예비비','var(--c9)']
];
const LOCAL5 = ['stay','food','transit','act','shop'];     // 현지 통화로 쓰는 항목
const TRIP_CATS = ['stay','food','transit','act','shop','buffer'];
const KEY = 'travel-fund-planner-v2', RKEY = 'travel-fund-rates-v1';

/* ---------- 유틸 ---------- */
const sum = a => a.reduce((x,y)=>x+y, 0);
const r10k = x => Math.round(x/10000)*10000;
const pad = n => String(n).padStart(2,'0');
const iso = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const parseDate = s => { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); };
const esc = s => String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const won = n => Math.round(n).toLocaleString('ko-KR')+'원';
const man = n => { const v=Math.round(n/1000)/10; return v.toLocaleString('ko-KR')+'만원'; };
const catName = k => (CATS.find(c=>c[0]===k)||[k,k])[1];
const fmtNum = (n,max=2) => n.toLocaleString('ko-KR',{maximumFractionDigits:max});
const fmtLocal = (n,cur) => fmtNum(n, (n<100 && ['USD','EUR','SGD','HKD'].includes(cur))?2:0)+CUR[cur].u;

/* ---------- 상태 ---------- */
function defaults(){
  const d=new Date();
  return {
    dest:'일본', nights:4, people:2, style:'보통',
    depart: iso(new Date(d.getFullYear(), d.getMonth()+5, d.getDate())), start: iso(d),
    saved:0, monthly:500000, feePct:1, bufPct:10,
    rateMode:'auto', manualRate:null, ov:{}, deposits:[], expenses:[], tripDay:1, tab:'goal'
  };
}
let S = defaults();
try{ const raw=localStorage.getItem(KEY); if(raw) S=Object.assign(defaults(), JSON.parse(raw)); }catch(e){}
const save = () => { try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} };

/* ---------- 환율 ---------- */
let RATES = {map:Object.assign({}, FALLBACK.map), live:false, src:'내장 기준값 ('+FALLBACK.date+', ECB 교차환율)', ts:null, loading:false, failed:false};
try{
  const c=JSON.parse(localStorage.getItem(RKEY)||'null');
  if(c && c.map && c.ts && Date.now()-c.ts < 24*3600*1000){
    RATES={map:Object.assign({}, FALLBACK.map, c.map), live:true, src:c.src, ts:c.ts, loading:false, failed:false};
  }
}catch(e){}

async function fetchRates(){
  RATES.loading=true; RATES.failed=false; render();
  const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(), 8000);
  try{
    const res=await fetch('https://open.er-api.com/v6/latest/KRW', {signal:ctrl.signal});
    if(!res.ok) throw new Error('http '+res.status);
    const j=await res.json();
    if(j.result!=='success' || !j.rates) throw new Error('bad payload');
    const map={};
    Object.keys(CUR).forEach(code=>{ const per=j.rates[code]; if(per>0) map[code]=1/per; });   // 1 KRW = per 단위 → 1 단위 = 1/per 원
    RATES={map:Object.assign({}, FALLBACK.map, map), live:true, src:'시장 환율 (open.er-api.com)', ts:Date.now(), loading:false, failed:false};
    try{ localStorage.setItem(RKEY, JSON.stringify({map, src:RATES.src, ts:RATES.ts})); }catch(e){}
  }catch(e){
    RATES.loading=false; RATES.failed=true;
  }finally{ clearTimeout(to); }
  render();
}

/* ---------- 핵심 계산 ---------- */
function calc(st, rates){
  st=st||S; rates=rates||RATES;
  const p=PRESETS[st.dest], cur=p.cur, m=STYLES[st.style], P=st.people, N=st.nights, D=N+1;
  const autoRate = rates.map[cur];
  const rate = (st.rateMode==='manual' && st.manualRate>0) ? st.manualRate : autoRate;

  // 1) 현지 통화 총액 → 원화 (환율 반영)
  const localAmt = {
    stay: p.stay*N*P*m.m, food: p.food*D*P*m.m, transit: p.transit*D*P,
    act: p.act*D*P*m.m, shop: p.shop*P*m.m
  };
  const auto = {flight: r10k(p.flight*m.f*P), prep: r10k(p.prep*P)};
  LOCAL5.forEach(k=>{ auto[k]=r10k(localAmt[k]*rate); });

  // 2) 사용자가 직접 입력한 금액(ov)이 있으면 그 값을 우선
  const val={};
  ['flight','stay','food','transit','act','shop','prep'].forEach(k=>{ val[k]= st.ov[k]!=null ? st.ov[k] : auto[k]; });

  // 3) 수수료 = 현지 지출 항목 합 × 수수료율
  const local5 = sum(LOCAL5.map(k=>val[k]));
  val.fee = Math.round(local5*st.feePct/100);

  // 4) 예비비 = (수수료까지 포함한 소계) × 예비비율
  const pre = val.flight+val.prep+local5+val.fee;
  auto.buffer = r10k(pre*st.bufPct/100);
  val.buffer = st.ov.buffer!=null ? st.ov.buffer : auto.buffer;
  const total = pre+val.buffer;

  // 5) 여행 중 쓸 돈(수수료 포함) — 지출 기록과 동일한 기준
  const bud={}; LOCAL5.forEach(k=>{ bud[k]=val[k]*(1+st.feePct/100); }); bud.buffer=val.buffer;
  const tripBudget = sum(TRIP_CATS.map(k=>bud[k]));

  // 6) 저축 계산
  const depSum = sum(st.deposits.map(d=>d.amt));
  const saved = st.saved+depSum;
  const remaining = Math.max(0, total-saved);
  const t0=new Date(); t0.setHours(0,0,0,0);
  const dep=parseDate(st.depart), startD=parseDate(st.start);
  const daysLeft = Math.round((dep-t0)/864e5);
  const months = Math.max(1, Math.ceil(daysLeft/30.4375));
  const weeks  = Math.max(1, Math.ceil(daysLeft/7));
  const need = remaining/months;
  const span = Math.max(1, Math.round((dep-startD)/864e5));
  const elapsed = Math.min(span, Math.max(0, Math.round((t0-startD)/864e5)));
  const idealNow = st.saved + Math.max(0,total-st.saved)*(elapsed/span);

  // 7) 환율 민감도: 직접 입력하지 않은 현지 통화 항목이 환율 +5%일 때 얼마나 늘어나는지
  const exposed = sum(LOCAL5.filter(k=>st.ov[k]==null).map(k=>val[k]));
  const fx5 = exposed*0.05*(1+st.feePct/100);

  return {p,cur,P,N,D,auto,val,bud,total,rate,autoRate,saved,remaining,daysLeft,months,weeks,need,tripBudget,idealNow,fx5,depSum,startD,dep};
}

/* ---------- 렌더: 상단 탑승권 ---------- */
const PLANE = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="#1c9fe0" transform="rotate(90 12 12)" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>';
function renderPass(c){
  const pct = c.total ? Math.min(100, c.saved/c.total*100) : 0;
  const dd = c.daysLeft>0 ? 'D-'+c.daysLeft : (c.daysLeft===0 ? '오늘 출발' : '출발일 지남');
  document.getElementById('pass').innerHTML = `
  <div class="ticket">
    <div class="tk-main">
      <div class="route">
        <div><div class="code">ICN</div><div class="city">인천</div></div>
        <div class="mid">${PLANE}</div>
        <div style="text-align:right"><div class="code">${c.p.city}</div><div class="city">${esc(S.dest)} · ${esc(c.p.name)}</div></div>
      </div>
      <div class="tk-info">
        <div>출발<b>${esc(S.depart)} (${dd})</b></div>
        <div>일정<b>${S.nights}박 ${S.nights+1}일</b></div>
        <div>인원<b>${S.people}명 · ${esc(S.style)}</b></div>
      </div>
      <div class="tk-prog">
        <div class="row"><span>모은 돈 ${man(c.saved)}</span><span>${Math.floor(pct)}%</span></div>
        <div class="sky-track"><div class="sky-fill" style="width:${pct}%"></div>
          <div class="sky-plane" style="left:${Math.max(3,Math.min(97,pct))}%">${PLANE}</div></div>
      </div>
    </div>
    <div class="tk-stub">
      <div class="cap">예상 총 경비</div>
      <div class="tot">${man(c.total)}</div>
      <div class="per">1인 ${man(c.total/c.P)}</div>
    </div>
  </div>`;
  document.getElementById('tabs').innerHTML = [['goal','계획'],['budget','예산'],['save','모으기'],['spend','쓰기']]
    .map(([k,l])=>`<button role="tab" aria-selected="${S.tab===k}" data-act="tab" data-v="${k}">${l}</button>`).join('');
}

/* ---------- 탭 1: 계획 ---------- */
function rateLabel(c, rate){ const per=CUR[c.cur].per; return per+CUR[c.cur].u+' = '+fmtNum(rate*per,2)+'원'; }
function fxCard(c){
  const est = !RATES.live && FALLBACK.estimated.includes(c.cur);
  const per=CUR[c.cur].per;
  const status = RATES.loading ? '<span class="pill off">불러오는 중…</span>'
    : RATES.live ? '<span class="pill live">실시간</span>' : '<span class="pill off">내장 기준값</span>';
  const when = RATES.ts ? new Date(RATES.ts).toLocaleString('ko-KR') : '기준일 '+FALLBACK.date;
  return `
  <div class="card">
    <div class="rowx"><h2>환율</h2><button class="btn sky sm" data-act="refreshFx">최신 환율 불러오기</button></div>
    <div class="fxbig num">${rateLabel(c,c.rate)}</div>
    <p class="small muted" style="margin:4px 0 12px">${status} ${esc(RATES.src)} · ${when}${S.rateMode==='manual'?' · <b>직접 입력 중</b>':''}</p>
    ${est?`<div class="callout warn small">이 통화(${CUR[c.cur].u})는 내장값이 추정치예요. '최신 환율 불러오기'를 눌러 실제 환율을 적용하세요.</div>`:''}
    ${RATES.failed?`<div class="callout warn small">환율을 불러오지 못해 내장 기준값을 쓰고 있어요. 인터넷 연결을 확인하거나 아래에서 직접 입력하세요.</div>`:''}
    <div class="grid">
      <div><label class="f" style="margin:0">환율 적용 방식</label>
        <div class="seg"><button data-act="rateMode" data-v="auto" aria-pressed="${S.rateMode==='auto'}">자동</button>
        <button data-act="rateMode" data-v="manual" aria-pressed="${S.rateMode==='manual'}">직접 입력</button></div></div>
      ${S.rateMode==='manual'?`<label class="f">${per}${CUR[c.cur].u} = 몇 원?<input type="number" min="0" step="any" data-f="manualRate" value="${S.manualRate? +(S.manualRate*per).toFixed(4):''}" placeholder="${fmtNum(c.autoRate*per,2)}"></label>`:''}
      <label class="f">환전·카드 수수료 (%)<input type="number" min="0" max="10" step="0.1" data-f="feePct" value="${S.feePct}"></label>
      <label class="f">예비비 비율 (%)<input type="number" min="0" max="50" step="1" data-f="bufPct" value="${S.bufPct}"></label>
    </div>
    <p class="small muted" style="margin:10px 0 0">시장 환율에는 은행 환전 마진이 빠져 있어요. 현찰 환전은 보통 1~2%, 수수료 낮은 체크카드는 0.3~1% 정도를 수수료에 반영하면 실제와 가까워져요.</p>
  </div>`;
}
function summaryCallout(c){
  if(c.daysLeft<0) return `<div class="callout bad"><b>출발일이 이미 지났어요.</b> 출발일을 다시 설정해 주세요.</div>`;
  if(c.remaining<=0) return `<div class="callout good"><b>목표 금액을 모두 모았어요!</b> '쓰기' 탭에서 하루 예산을 확인해 보세요.</div>`;
  if(S.monthly>=c.need) return `<div class="callout good"><b>지금 계획으로 충분해요.</b> 매달 ${man(c.need)}씩 ${c.months}개월 모으면 되고, 한 달 저축 가능액(${man(S.monthly)})보다 ${man(S.monthly-c.need)} 여유가 있어요.</div>`;
  return `<div class="callout warn"><b>매달 ${man(c.need-S.monthly)}이 부족해요.</b> 필요한 월 저축액은 ${man(c.need)}, 저축 가능액은 ${man(S.monthly)}이에요. '모으기' 탭에서 해결 방법을 비교해 보세요.</div>`;
}
function tabGoal(c){
  const opts=Object.keys(PRESETS).map(k=>`<option ${k===S.dest?'selected':''}>${k}</option>`).join('');
  const seg=(f,list,cur,suf='')=>`<div class="seg">${list.map(v=>`<button data-act="set" data-f="${f}" data-v="${v}" aria-pressed="${String(v)===String(cur)}">${v}${suf}</button>`).join('')}</div>`;
  return `
  <div class="card">
    <h2>어디로, 언제 가나요?</h2>
    <div class="grid">
      <label class="f">목적지<select data-f="dest">${opts}</select></label>
      <label class="f">출발일<input type="date" data-f="depart" value="${S.depart}"></label>
      <label class="f">여행 기간 (박)<input type="number" min="1" max="30" data-f="nights" value="${S.nights}"></label>
      <div><label class="f" style="margin:0">인원</label>${seg('people',[1,2,3,4],S.people,'명')}</div>
      <div><label class="f" style="margin:0">여행 스타일</label>${seg('style',Object.keys(STYLES),S.style)}</div>
      <label class="f">지금까지 모은 금액 (만원)<input type="number" min="0" step="1" data-f="saved" value="${S.saved/10000}"></label>
      <label class="f">매달 저축 가능 금액 (만원)<input type="number" min="0" step="1" data-f="monthly" value="${S.monthly/10000}"></label>
    </div>
    <p class="small muted" style="margin:12px 0 0">목적지·인원·스타일·기간을 바꾸면 예산이 다시 계산되고, 직접 수정해 둔 예산은 초기화돼요.</p>
  </div>
  ${summaryCallout(c)}
  <div class="card">
    <h2>한눈에 보기</h2>
    <div class="stats">
      <div class="stat hl"><div class="k">예상 총 경비</div><div class="v">${man(c.total)}</div></div>
      <div class="stat hl2"><div class="k">더 모아야 할 돈</div><div class="v">${man(c.remaining)}</div></div>
      <div class="stat"><div class="k">월 필요 저축액</div><div class="v">${man(c.need)}</div></div>
      <div class="stat"><div class="k">현지에서 쓸 돈</div><div class="v">${man(c.tripBudget)}</div></div>
    </div>
  </div>
  ${fxCard(c)}`;
}

/* ---------- 탭 2: 예산 ---------- */
function tabBudget(c){
  const bar=CATS.map(([k,,col])=>`<span title="${catName(k)}" style="width:${c.total?c.val[k]/c.total*100:0}%;background:${col}"></span>`).join('');
  const p=c.p, m=STYLES[S.style];
  const basis = {
    flight:'왕복 1인 '+won(p.flight*m.f), stay:'1인 1박 '+fmtLocal(p.stay*m.m,c.cur)+' (2인 1실)',
    food:'1인 1일 '+fmtLocal(p.food*m.m,c.cur), transit:'1인 1일 '+fmtLocal(p.transit,c.cur),
    act:'1인 1일 '+fmtLocal(p.act*m.m,c.cur), shop:'1인 '+fmtLocal(p.shop*m.m,c.cur),
    prep:'1인 '+won(p.prep), fee:'현지 지출 × '+S.feePct+'%', buffer:'소계 × '+S.bufPct+'%'
  };
  const rows=CATS.map(([k,name,col])=>{
    const edit = k!=='fee';
    const mark = (S.ov[k]!=null) ? ' <span class="pill off">직접 입력</span>' : '';
    return `<tr>
      <td><span class="dot" style="background:${col}"></span>${name}${mark}<div class="basis">${basis[k]}</div></td>
      <td class="r small muted num">${c.total?(c.val[k]/c.total*100).toFixed(1):0}%</td>
      <td class="r">${edit?`<input type="number" min="0" step="1" data-ov="${k}" value="${Math.round(c.val[k]/10000*10)/10}" aria-label="${name} (만원)">`:`<span class="num">${man(c.val[k])}</span>`}</td>
    </tr>`;
  }).join('');
  const big=[...CATS].filter(x=>!['fee','buffer'].includes(x[0])).sort((a,b)=>c.val[b[0]]-c.val[a[0]]);
  const dailyPP = c.tripBudget/c.P/c.D;
  return `
  <div class="card">
    <h2>예산 구성</h2>
    <div class="share">${bar}</div>
    <div class="scroll"><table>
      <thead><tr><th>항목</th><th class="r">비중</th><th class="r">금액 (만원)</th></tr></thead>
      <tbody>${rows}<tr><td><b>합계</b></td><td></td><td class="r num"><b>${man(c.total)}</b></td></tr></tbody>
    </table></div>
    <p style="margin:12px 0 0"><button class="btn ghost sm" data-act="resetOv">자동 추정으로 되돌리기</button></p>
  </div>
  <div class="card">
    <h2>예산 분석</h2>
    <div class="stats" style="margin-bottom:14px">
      <div class="stat"><div class="k">1인 총 경비</div><div class="v">${man(c.total/c.P)}</div></div>
      <div class="stat"><div class="k">1인 하루 현지 지출</div><div class="v">${man(dailyPP)}</div></div>
      <div class="stat"><div class="k">환율 5% 오르면</div><div class="v" style="color:var(--bad)">+${man(c.fx5)}</div></div>
    </div>
    <ul class="tips">
      <li>가장 큰 항목은 <b>${big[0][1]}</b>(${man(c.val[big[0][0]])}), 그다음은 <b>${big[1][1]}</b>(${man(c.val[big[1][0]])})예요. 줄일 수 있는 폭이 큰 곳이에요.</li>
      <li>환율이 5% 오르면 현지 지출 때문에 총 경비가 약 <b>${man(c.fx5)}</b> 늘어나요. 여행 비용의 일부를 미리 나눠서 환전해 두면 변동 위험이 줄어요.</li>
      <li>항공권(${(c.val.flight/c.total*100).toFixed(0)}%)은 실제 검색 가격으로 바꾸면 전체 정확도가 가장 크게 올라가요.</li>
    </ul>
  </div>`;
}

/* ---------- 탭 3: 모으기 ---------- */
function planCard(title, desc, monthly, months, c){
  const mo = Math.max(0, monthly);
  const ok = mo <= S.monthly;
  return `<div class="plan ${ok?'ok':''}">
    <h3>${title}</h3><div class="small muted">${desc}</div>
    <div class="big num">월 ${man(mo)}</div>
    <div class="small">${months}개월 · 주 ${man(mo/(30.4375/7))}</div>
    <div class="small" style="color:${ok?'var(--good)':'var(--bad)'};margin-top:4px;font-weight:700">${ok?'저축 가능 금액 안에서 가능':'월 '+man(mo-S.monthly)+' 부족'}</div>
  </div>`;
}
function chartSvg(c){
  const W=640,H=230,L=46,R=12,T=14,B=26;
  const t0=c.startD.getTime(), t1=c.dep.getTime(), span=Math.max(864e5,t1-t0);
  const maxY=Math.max(c.total,c.saved)*1.05||1;
  const x=t=>L+Math.min(1,Math.max(0,(t-t0)/span))*(W-L-R);
  const y=v=>T+(1-v/maxY)*(H-T-B);
  const ds=[...S.deposits].sort((a,b)=>a.date<b.date?-1:1);
  let cum=S.saved; const pts=[[t0,cum]];
  ds.forEach(d=>{ cum+=d.amt; pts.push([parseDate(d.date).getTime(),cum]); });
  pts.push([Math.min(Math.max(Date.now(),t0),t1),cum]);
  const path=pts.map((p,i)=>(i?'L':'M')+x(p[0]).toFixed(1)+' '+y(p[1]).toFixed(1)).join(' ');
  const grid=[0,.5,1].map(f=>{const v=maxY/1.05*f; return `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#dcebf5"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="#5f7b92">${Math.round(v/10000).toLocaleString('ko-KR')}</text>`;}).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="저축 진행 그래프">
    ${grid}
    <line x1="${x(t0)}" y1="${y(S.saved)}" x2="${x(t1)}" y2="${y(c.total)}" stroke="#ffb938" stroke-width="3" stroke-dasharray="7 6"/>
    <path d="${path}" fill="none" stroke="#1c9fe0" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(pts[pts.length-1][0])}" cy="${y(cum)}" r="6" fill="#1c9fe0" stroke="#fff" stroke-width="2"/>
    <text x="${L}" y="${H-6}" font-size="11" fill="#5f7b92">${S.start}</text>
    <text x="${W-R}" y="${H-6}" text-anchor="end" font-size="11" fill="#5f7b92">${S.depart}</text>
    <text x="${W-R}" y="${T+8}" text-anchor="end" font-size="11" fill="#5f7b92">단위: 만원</text>
  </svg>`;
}
function tabSave(c){
  const left=c.remaining;
  const planB=Math.max(0,c.total*0.85-c.saved)/c.months;
  const m2=c.months+2, planC=left/m2;
  const weekly=left/c.weeks, daily=left/Math.max(1,c.daysLeft);
  const diff=c.saved-c.idealNow;
  let pace='';
  if(c.daysLeft>0 && left>0){
    pace = diff>=0
      ? `<div class="callout good small">오늘 기준 이상적인 저축액(${man(c.idealNow)})보다 <b>${man(diff)} 앞서 있어요.</b></div>`
      : `<div class="callout warn small">오늘 기준 이상적인 저축액(${man(c.idealNow)})보다 <b>${man(-diff)} 뒤처져 있어요.</b></div>`;
  }
  let eta='';
  if(left>0 && S.monthly>0 && c.daysLeft>0){
    const need=Math.ceil(left/S.monthly);
    const d=new Date(); d.setMonth(d.getMonth()+need);
    const gap=Math.round((c.dep-d)/864e5);
    eta=`<li>지금 저축 가능액(월 ${man(S.monthly)})으로는 <b>${need}개월 뒤(${iso(d)})</b>에 목표를 채워요. 출발일보다 ${gap>=0?gap+'일 빨라요':(-gap)+'일 늦어요'}.</li>`;
  }
  const today=iso(new Date());
  const deps=[...S.deposits].sort((p,q)=>p.date<q.date?1:-1).map(d=>`
    <li><span>${esc(d.date)}</span><span class="num"><b>${won(d.amt)}</b><button class="x" data-act="delDep" data-id="${d.id}" aria-label="삭제">×</button></span></li>`).join('');
  const top=[...CATS].filter(x=>!['fee','buffer'].includes(x[0])).sort((p,q)=>c.val[q[0]]-c.val[p[0]])[0];
  return `
  <div class="card">
    <h2>얼마나 모아야 할까</h2>
    ${summaryCallout(c)}
    <div class="stats">
      <div class="stat hl2"><div class="k">목표까지 남은 금액</div><div class="v">${man(left)}</div></div>
      <div class="stat"><div class="k">남은 기간</div><div class="v">${Math.max(0,c.daysLeft)}일</div></div>
      <div class="stat"><div class="k">주 단위</div><div class="v">${man(weekly)}</div></div>
      <div class="stat"><div class="k">하루 단위</div><div class="v">${won(daily)}</div></div>
    </div>
  </div>
  <div class="card">
    <h2>어떻게 모을까</h2>
    <div class="plans">
      ${planCard('그대로 모으기','목표 금액을 유지', left/c.months, c.months, c)}
      ${planCard('예산 15% 줄이기','숙소·식비·쇼핑 조정', planB, c.months, c)}
      ${planCard('출발 2개월 미루기','기간을 늘려 월 부담 감소', planC, m2, c)}
    </div>
    <p class="small muted" style="margin:10px 0 0">초록 테두리는 월 저축 가능액(${man(S.monthly)}) 안에서 가능한 방법이에요. 개월 수는 남은 일수 ÷ 30.4375일을 올림해서 계산해요.</p>
  </div>
  <div class="card">
    <h2>진행 상황</h2>
    ${pace}
    ${chartSvg(c)}
    <div class="small muted" style="margin-top:6px">노란 점선은 이상적인 저축선, 파란 실선은 실제로 모은 금액이에요.</div>
    <div class="grid" style="margin-top:14px;align-items:end">
      <label class="f">입금 날짜<input type="date" id="dep-date" value="${today}"></label>
      <label class="f">입금액 (원)<input type="number" min="1" step="1000" id="dep-amt" placeholder="예: 300000"></label>
      <div><button class="btn" data-act="addDep">저축 기록하기</button></div>
    </div>
    <ul class="list" style="margin-top:10px">${deps||'<li class="empty">아직 기록이 없어요. 첫 저축을 기록해 보세요.</li>'}</ul>
  </div>
  <div class="card">
    <h2>실천 팁</h2>
    <ul class="tips">
      ${eta}
      <li>월급날 다음 날 <b>월 ${man(left/c.months)}</b>이 여행 통장으로 자동이체되게 해 두세요. 쓰고 남은 돈을 모으는 것보다 훨씬 잘 지켜져요.</li>
      <li>가장 큰 항목은 <b>${top[1]}</b>(${man(c.val[top[0]])})예요. 이 항목부터 줄이면 저축 부담이 가장 크게 줄어요.</li>
      <li>환율이 낮을 때마다 나눠서 환전하면 평균 환율을 낮출 수 있어요. 필요한 외화의 1/3씩 세 번에 나눠 사는 방법이 무난해요.</li>
      <li>항공권·숙소는 환불 가능한 조건으로 미리 예약하면 가격 상승 위험을 줄일 수 있어요.</li>
    </ul>
  </div>`;
}

/* ---------- 탭 4: 쓰기 ---------- */
function tabSpend(c){
  const spent={}; TRIP_CATS.forEach(k=>spent[k]=0);
  S.expenses.forEach(e=>{ spent[e.cat]=(spent[e.cat]||0)+e.krw; });
  const spentTotal=sum(Object.values(spent));
  const remain=c.tripBudget-spentTotal;
  const day=Math.min(S.tripDay,c.D);
  const daysLeft=Math.max(1,c.D-day+1);
  const spentBefore=sum(S.expenses.filter(e=>e.day<day).map(e=>e.krw));
  const spentToday=sum(S.expenses.filter(e=>e.day===day).map(e=>e.krw));
  const allowance=(c.tripBudget-spentBefore)/daysLeft;          // 오늘 쓸 수 있는 금액
  const todayLeft=allowance-spentToday;
  const dayOpts=Array.from({length:c.D},(_,i)=>i+1).map(i=>`<option value="${i}" ${i===day?'selected':''}>${i}일차</option>`).join('');
  const f=1+S.feePct/100;
  const dailyRows=[['food','식비 (1일)',c.D],['transit','현지 교통 (1일)',c.D],['act','관광·액티비티 (1일)',c.D],['stay','숙소 (1박)',c.N]]
    .map(([k,l,div])=>`<tr><td>${l}</td><td class="r num">${won(c.val[k]*f/div)}</td><td class="r num muted">${fmtLocal(c.val[k]/c.rate/div,c.cur)}</td></tr>`).join('')
    +`<tr><td>쇼핑 (전체)</td><td class="r num">${won(c.val.shop*f)}</td><td class="r num muted">${fmtLocal(c.val.shop/c.rate,c.cur)}</td></tr>`;
  const bars=TRIP_CATS.map(k=>{
    const b=c.bud[k], s=spent[k]||0, p=b?Math.min(100,s/b*100):0, over=s>b;
    return `<div style="margin-bottom:12px"><div class="rowx small"><span>${k==='buffer'?'기타·예비':catName(k)}</span>
      <span class="num" style="${over?'color:var(--bad);font-weight:700':'color:var(--muted)'}">${man(s)} / ${man(b)}</span></div>
      <div class="bar"><i class="${over?'over':''}" style="width:${p}%"></i></div></div>`;
  }).join('');
  const dayAvg=c.tripBudget/c.D;
  const dayBars=Array.from({length:c.D},(_,i)=>{
    const d=i+1, s=sum(S.expenses.filter(e=>e.day===d).map(e=>e.krw));
    const p=Math.min(100,s/dayAvg*100);
    return `<div style="margin-bottom:8px"><div class="rowx small"><span>${d}일차</span><span class="num muted">${won(s)}</span></div>
      <div class="bar"><i class="${s>dayAvg?'over':''}" style="width:${p}%"></i></div></div>`;
  }).join('');
  const catOpts=TRIP_CATS.map(k=>`<option value="${k}">${k==='buffer'?'기타·예비':catName(k)}</option>`).join('');
  const ex=[...S.expenses].sort((a,b)=>b.id-a.id).map(e=>`
    <li><span>${e.day}일차 · ${e.cat==='buffer'?'기타·예비':catName(e.cat)}${e.memo?' · '+esc(e.memo):''}
      <span class="basis" style="display:block">${e.cur==='local'?fmtLocal(e.local,e.code)+' × '+fmtNum(e.rate*CUR[e.code].per,2)+'원/'+CUR[e.code].per+CUR[e.code].u+' + 수수료 '+e.fee+'%':'원화 입력'}</span></span>
      <span class="num"><b>${won(e.krw)}</b><button class="x" data-act="delExp" data-id="${e.id}" aria-label="삭제">×</button></span></li>`).join('');
  const status = remain<0
    ? `<div class="callout bad"><b>현지 예산을 ${man(-remain)} 초과했어요.</b> 남은 일정에서 지출을 줄여야 해요.</div>`
    : `<div class="callout"><b>${day}일차 오늘은 ${won(Math.max(0,allowance))} (${fmtLocal(Math.max(0,allowance)/f/c.rate,c.cur)})</b>까지 쓰면 예산에 맞아요. 지금까지 오늘 ${won(spentToday)}을 썼고, ${todayLeft>=0?'<b>'+won(todayLeft)+'</b> 남았어요.':'<b>'+won(-todayLeft)+'</b> 초과했어요.'}</div>`;
  return `
  <div class="card">
    <h2>하루 예산 가이드</h2>
    <div class="scroll"><table>
      <thead><tr><th>항목</th><th class="r">원화 (수수료 포함)</th><th class="r">현지 통화</th></tr></thead>
      <tbody>${dailyRows}</tbody>
    </table></div>
    <p class="small muted" style="margin:10px 0 0">${rateLabel(c,c.rate)}, 수수료 ${S.feePct}% 기준이에요. '계획' 탭에서 바꿀 수 있어요.</p>
  </div>
  <div class="card">
    <h2>여행 중 지출 기록</h2>
    <div class="grid" style="margin-bottom:12px">
      <label class="f">오늘은 여행 몇 일차?<select data-f="tripDay">${dayOpts}</select></label>
    </div>
    ${status}
    <div class="stats" style="margin-bottom:16px">
      <div class="stat hl2"><div class="k">현지 예산</div><div class="v">${man(c.tripBudget)}</div></div>
      <div class="stat"><div class="k">쓴 돈</div><div class="v">${man(spentTotal)}</div></div>
      <div class="stat ${remain<0?'':'hl'}"><div class="k">남은 돈</div><div class="v" ${remain<0?'style="color:var(--bad)"':''}>${man(remain)}</div></div>
    </div>
    ${bars}
    <div class="grid" style="align-items:end;margin-top:16px">
      <label class="f">분류<select id="ex-cat">${catOpts}</select></label>
      <label class="f">금액<input type="number" min="0" step="any" id="ex-amt" placeholder="숫자 입력"></label>
      <label class="f">통화<select id="ex-cur"><option value="local">${CUR[c.cur].u} (현지 통화)</option><option value="krw">원</option></select></label>
      <label class="f">메모 (선택)<input type="text" id="ex-memo" maxlength="30" placeholder="예: 점심 라멘"></label>
      <div><button class="btn" data-act="addExp">지출 기록하기</button></div>
    </div>
    <p class="small muted" style="margin:8px 0 0">현지 통화로 입력하면 지금 환율과 수수료 ${S.feePct}%를 적용해 원화로 저장해요. 나중에 환율이 변해도 이미 기록한 금액은 바뀌지 않아요.</p>
    <ul class="list" style="margin-top:10px">${ex||'<li class="empty">기록된 지출이 없어요. 쓸 때마다 바로 적어 두세요.</li>'}</ul>
  </div>
  <div class="card">
    <h2>일별 지출</h2>
    <p class="small muted" style="margin:0 0 10px">하루 평균 예산 ${won(dayAvg)} 대비예요. 넘으면 빨간색으로 보여요.</p>
    ${dayBars}
  </div>
  <div class="card">
    <h2>똑똑하게 쓰는 법</h2>
    <ul class="tips">
      <li>해외 결제는 수수료가 낮은 체크·트래블 카드를 쓰고, 현금은 하루 예산의 30~40%만 들고 다니세요.</li>
      <li>결제할 때 원화 결제(DCC)를 권하면 거절하고 현지 통화로 결제하세요. 수수료가 더 붙어요.</li>
      <li>식비는 '한 끼는 맛집, 나머지는 가볍게'로 쓰면 하루 예산(${won(c.val.food*f/c.D)})을 지키기 쉬워요.</li>
      <li>쇼핑 예산(${man(c.val.shop*f)})은 출발 전에 정해 두고, 면세·세금 환급 가능 여부를 확인하세요.</li>
    </ul>
  </div>`;
}

/* ---------- 렌더 · 이벤트 ---------- */
function render(){
  if(typeof document==='undefined') return;
  const c=calc();
  renderPass(c);
  const m=document.getElementById('main');
  m.innerHTML = S.tab==='goal'?tabGoal(c) : S.tab==='budget'?tabBudget(c) : S.tab==='save'?tabSave(c) : tabSpend(c);
}

if(typeof document!=='undefined'){
  document.addEventListener('change', e=>{
    const t=e.target;
    if(t.id==='import-file'){ importBackup(t.files[0]); t.value=''; return; }
    if(t.dataset.ov){ S.ov[t.dataset.ov]=Math.max(0,Number(t.value)||0)*10000; save(); render(); return; }
    const f=t.dataset.f; if(!f) return;
    const v=t.value;
    if(f==='saved'||f==='monthly') S[f]=Math.max(0,Math.round((Number(v)||0)*10000));
    else if(f==='nights'){ S.nights=Math.min(30,Math.max(1,Math.round(Number(v))||1)); S.ov={}; S.tripDay=1; }
    else if(f==='feePct'||f==='bufPct'){ S[f]=Math.max(0,Number(v)||0); }
    else if(f==='manualRate'){ const n=Number(v), per=CUR[PRESETS[S.dest].cur].per; S.manualRate = n>0 ? n/per : null; }
    else if(f==='dest'){ S.dest=v; S.ov={}; S.manualRate=null; S.rateMode='auto'; S.tripDay=1; }
    else if(f==='tripDay') S.tripDay=Number(v);
    else if(f==='depart'){ if(v) S.depart=v; }
    else S[f]=v;
    save(); render();
  });
  document.addEventListener('click', e=>{
    const t=e.target.closest('[data-act]'); if(!t) return;
    const a=t.dataset.act;
    if(a==='tab'){ S.tab=t.dataset.v; window.scrollTo({top:0}); }
    else if(a==='set'){ const f=t.dataset.f, v=t.dataset.v; S[f]= f==='people' ? Number(v) : v; S.ov={}; }
    else if(a==='rateMode'){ S.rateMode=t.dataset.v; }
    else if(a==='refreshFx'){ fetchRates(); return; }
    else if(a==='resetOv'){ S.ov={}; }
    else if(a==='addDep'){
      const amt=Math.round(Number(document.getElementById('dep-amt').value));
      const date=document.getElementById('dep-date').value;
      if(!(amt>0)||!date){ document.getElementById('dep-amt').focus(); return; }
      S.deposits.push({id:Date.now(),date,amt});
    }
    else if(a==='delDep'){ S.deposits=S.deposits.filter(d=>String(d.id)!==t.dataset.id); }
    else if(a==='addExp'){
      const c=calc();
      const amt=Number(document.getElementById('ex-amt').value);
      if(!(amt>0)){ document.getElementById('ex-amt').focus(); return; }
      const curSel=document.getElementById('ex-cur').value;
      const entry={id:Date.now(), day:Math.min(S.tripDay,c.D), cat:document.getElementById('ex-cat').value,
        memo:document.getElementById('ex-memo').value.trim(), cur:curSel};
      if(curSel==='local'){
        Object.assign(entry,{code:c.cur, local:amt, rate:c.rate, fee:S.feePct, krw:Math.round(amt*c.rate*(1+S.feePct/100))});
      }else{
        Object.assign(entry,{krw:Math.round(amt)});
      }
      S.expenses.push(entry);
    }
    else if(a==='delExp'){ S.expenses=S.expenses.filter(x=>String(x.id)!==t.dataset.id); }
    else if(a==='export'){ exportBackup(); return; }
    else if(a==='reset'){ if(!confirm('모든 데이터를 지우고 처음부터 시작할까요?')) return; S=defaults(); }
    save(); render();
  });
}

function exportBackup(){
  const blob=new Blob([JSON.stringify(S,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='travel-fund-backup-'+iso(new Date())+'.json'; a.click(); URL.revokeObjectURL(a.href);
}
function importBackup(file){
  if(!file) return;
  const r=new FileReader();
  r.onload=()=>{ try{ const d=JSON.parse(r.result); if(!PRESETS[d.dest]) throw 0; S=Object.assign(defaults(),d); save(); render(); }catch(e){ alert('올바른 백업 파일이 아니에요.'); } };
  r.readAsText(file);
}

if(typeof document!=='undefined'){
  render();
  if(!RATES.live) fetchRates();   // 캐시가 없거나 오래됐으면 시작할 때 최신 환율을 받아옵니다
}
if(typeof module!=='undefined') module.exports={calc,PRESETS,STYLES,FALLBACK,defaults,CUR};
