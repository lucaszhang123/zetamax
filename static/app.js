(function () {
  const OPS = ['add', 'sub', 'mul', 'div'];
  const OP_LABEL = { add: 'Addition', sub: 'Subtraction', mul: 'Multiplication', div: 'Division' };
  const MIN_RUNS_FOR_IMPROVEMENT = 10;
  const QUEUE_INITIAL = 20;
  const QUEUE_REFILL_AT = 8;
  const QUEUE_REFILL_AMOUNT = 20;

  let runs = [];
  let statsDuration = 120; // which duration's headline stats are currently shown

  // A run only counts toward the headline stats if it's a standard run using
  // every operation at the unmodified default ranges — otherwise score isn't
  // comparable (a 30s run, a custom-range run, or an improvement run that's
  // deliberately fed harder problems will all score differently for reasons
  // that have nothing to do with getting better).
  function isDefaultConfig(run) {
    const ops = run.ops || [];
    const hasAllOps = OPS.every(o => ops.includes(o)) && ops.length === OPS.length;
    const ranges = run.ranges || {};
    const addMatch = JSON.stringify(ranges.add) === JSON.stringify(DEFAULT_RANGES.add);
    const mulMatch = JSON.stringify(ranges.mul) === JSON.stringify(DEFAULT_RANGES.mul);
    return hasAllOps && addMatch && mulMatch;
  }

  // Runs saved before ops/ranges tracking existed have no config data at all
  // (backfilled as ops: [] on migration) — that's different from a run that
  // was deliberately customized, so it shouldn't get the same "custom" label.
  function hasConfigData(run) {
    return Array.isArray(run.ops) && run.ops.length > 0;
  }

  // Improvement runs don't count toward "how many runs have you done" for
  // gating purposes — only standard runs do. Otherwise improvement mode
  // could bootstrap its own unlock, which defeats the point of the gate.
  function standardRunCount() {
    return runs.filter(r => r.mode === 'standard').length;
  }

  // Groups a single solved problem down to a specific "fact": for mul/div
  // that's the exact ×/÷ table entry (2 through 12) — e.g. "×9" — since
  // that's the level people actually mean when they say they're slow at a
  // specific times table. Add/sub don't have an equivalent single-fact
  // identity (operands range over 2-100), so they're grouped into rough
  // magnitude bands instead.
  function bucketOf(n) { if (n < 35) return 'low'; if (n < 68) return 'mid'; return 'high'; }
  const BUCKET_LABEL = { low: 'small numbers', mid: 'mid-size numbers', high: 'large numbers' };

  function groupIdFor(p) {
    if (p.op === 'mul') return `mul_${p.x1}`;   // x1 is always the 2-12 factor
    if (p.op === 'div') return `div_${p.x2}`;   // x2 is always the 2-12 divisor
    if (p.op === 'add') return `add_${bucketOf(Math.max(p.x1, p.x2))}`;
    return `sub_${bucketOf(p.x1)}`; // x1 is always the larger operand for sub
  }

  function groupLabel(groupId) {
    const [op, rest] = groupId.split('_');
    if (op === 'mul') return `× ${rest}`;
    if (op === 'div') return `÷ ${rest}`;
    return `${OP_LABEL[op]} · ${BUCKET_LABEL[rest] || rest}`;
  }

  // ---------------------------------------------------------------------
  // API helpers
  // ---------------------------------------------------------------------
  async function apiGetRuns() {
    const res = await fetch('/api/runs');
    if (!res.ok) return [];
    return res.json();
  }
  async function apiSaveRun(run) {
    await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(run),
    });
  }
  async function apiClearRuns() {
    await fetch('/api/runs', { method: 'DELETE' });
  }
  async function apiDeleteRun(id) {
    await fetch(`/api/runs/${id}`, { method: 'DELETE' });
  }
  async function apiNextProblems(mode, ops, count, ranges, factIds = []) {
    const res = await fetch('/api/next_problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, ops, count, ranges, fact_ids: factIds }),
    });
    if (!res.ok) return { problems: [], model_used: false, training_samples: 0 };
    return res.json();
  }

  // ---------------------------------------------------------------------
  // tiny client-side fallback generator (only used if a fetch fails mid-run
  // so gameplay never stalls waiting on the network)
  // ---------------------------------------------------------------------
  function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  const DEFAULT_RANGES = { add: [2, 100, 2, 100], mul: [2, 12, 2, 100] };
  function fallbackProblem(ops, ranges) {
    ranges = ranges || DEFAULT_RANGES;
    const op = ops[randInt(0, ops.length - 1)];
    const [addMin1, addMax1, addMin2, addMax2] = ranges.add || DEFAULT_RANGES.add;
    const [mulMin1, mulMax1, mulMin2, mulMax2] = ranges.mul || DEFAULT_RANGES.mul;
    if (op === 'add') {
      const x1 = randInt(addMin1, addMax1), x2 = randInt(addMin2, addMax2);
      return { op, x1, x2, question: `${x1} + ${x2}`, answer: x1 + x2 };
    }
    if (op === 'sub') {
      let a = randInt(addMin1, addMax1), b = randInt(addMin2, addMax2);
      if (b > a) [a, b] = [b, a];
      return { op, x1: a, x2: b, question: `${a} − ${b}`, answer: a - b };
    }
    if (op === 'mul') {
      const x1 = randInt(mulMin1, mulMax1), x2 = randInt(mulMin2, mulMax2);
      return { op, x1, x2, question: `${x1} × ${x2}`, answer: x1 * x2 };
    }
    const divisor = randInt(mulMin1, mulMax1), quotient = randInt(mulMin2, mulMax2);
    return { op, x1: divisor * quotient, x2: divisor, question: `${divisor * quotient} ÷ ${divisor}`, answer: quotient };
  }

  function fallbackProblemForFact(factId, ranges) {
    const [op, rest] = factId.split('_');
    const [addMin1, addMax1, addMin2, addMax2] = ranges.add || DEFAULT_RANGES.add;
    const [mulMin1, mulMax1, mulMin2, mulMax2] = ranges.mul || DEFAULT_RANGES.mul;

    if (op === 'mul') {
      const factor = Number(rest), x2 = randInt(mulMin2, mulMax2);
      return { op, x1: factor, x2, question: `${factor} × ${x2}`, answer: factor * x2 };
    }
    if (op === 'div') {
      const divisor = Number(rest), quotient = randInt(mulMin2, mulMax2);
      return { op, x1: divisor * quotient, x2: divisor, question: `${divisor * quotient} ÷ ${divisor}`, answer: quotient };
    }

    // Use the ordinary generator until it lands in the requested number-size
    // band. This is only an emergency network fallback, not the normal path.
    for (let i = 0; i < 200; i++) {
      const p = fallbackProblem([op], ranges);
      if (groupIdFor(p) === factId) return p;
    }
    return fallbackProblem([op], ranges);
  }

  function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) * (v - m), 0) / (arr.length - 1));
  }
  function statCard(num, label) {
    return `<div class="ss-stat-card"><div class="ss-stat-num">${num}</div><div class="ss-stat-label">${label}</div></div>`;
  }

  // ---------------------------------------------------------------------
  // home dashboard
  // ---------------------------------------------------------------------
  function renderHomeStats() {
    const startStandardBtn = document.getElementById('ssStartStandard');
    if (startStandardBtn) startStandardBtn.disabled = false;

    const body = document.getElementById('ssStatsBody');
    const comparable = runs.filter(r => r.mode === 'standard' && r.duration === statsDuration && isDefaultConfig(r));
    const excludedCount = runs.length - comparable.length;

    if (!comparable.length) {
      body.innerHTML = `<div class="ss-empty">No standard runs yet at ${statsDuration}s with default settings (all four operations, unmodified ranges). Run one to start building stats for this duration.</div>`;
    } else {
      const scores = comparable.map(r => r.score);
      const max = Math.max(...scores);
      const avg = mean(scores);
      const sd = stdev(scores);
      body.innerHTML = `
        <div class="ss-stat-grid" style="margin-bottom:16px;">
          ${statCard(max, 'max score')}
          ${statCard(avg.toFixed(1), 'avg score')}
          ${statCard(sd.toFixed(1), 'std dev')}
          ${statCard(comparable.length, 'total runs')}
        </div>
        <div class="ss-chart-wrap">${renderMiniChart(comparable)}</div>
      `;
    }
    const note = document.getElementById('ssStatsFilterNote');
    if (note) {
      note.textContent = excludedCount > 0
        ? `Showing standard runs at ${statsDuration}s with default settings. ${excludedCount} other run${excludedCount === 1 ? '' : 's'} (different duration, custom ranges/operations, improvement mode, or runs saved before settings tracking was added) are kept in your run history below but left out of these numbers so scores stay comparable.`
        : `Showing standard runs at ${statsDuration}s with default settings (all four operations, unmodified ranges).`;
    }
    renderScoreDistribution(statsDuration);
    renderWeakTable();
    renderGroupTable();
    renderRunHistory();
    renderImprovementGate();
  }

  function renderMiniChart(list) {
    const recent = list.slice(-20);
    const max = Math.max(1, ...recent.map(r => r.score));
    const w = Math.max(recent.length * 26, 100), h = 70;
    const bars = recent.map((r, i) => {
      const bh = Math.max(3, (r.score / max) * (h - 14));
      return `<rect x="${i * 26 + 4}" y="${h - bh}" width="16" height="${bh}" rx="3" fill="var(--cyan)"></rect>`;
    }).join('');
    return `<svg width="${w}" height="${h + 4}" style="display:block;">${bars}</svg>
      <div class="ss-sub" style="margin-top:4px;">last ${recent.length} runs at ${statsDuration}s, default settings</div>`;
  }

  function renderWeakTable() {
    const wrap = document.getElementById('ssWeakBody');
    const opAgg = {};
    OPS.forEach(op => { opAgg[op] = { count: 0, totalMs: 0 }; });
    runs.forEach(r => (r.problems || []).forEach(p => {
      if (!p.correct || !opAgg[p.op]) return;
      opAgg[p.op].count++;
      opAgg[p.op].totalMs += p.timeMs;
    }));
    const rows = OPS.filter(op => opAgg[op].count > 0).map(op => ({
      op, count: opAgg[op].count, avg: opAgg[op].totalMs / opAgg[op].count
    })).sort((a, b) => b.avg - a.avg);

    if (!rows.length) {
      wrap.innerHTML = '<div class="ss-empty">Category breakdown will appear after your first run.</div>';
      return;
    }
    const maxAvg = Math.max(...rows.map(r => r.avg));
    wrap.innerHTML = `<table class="ss-table">
      <tr><th>Category</th><th>Avg solve time</th><th>Samples</th><th></th></tr>
      ${rows.map((r, i) => `
        <tr>
          <td style="font-family:Inter,sans-serif;">${OP_LABEL[r.op]} ${i === 0 ? '<span class="ss-pill ss-pill-slow">slowest</span>' : ''}${i === rows.length - 1 && rows.length > 1 ? '<span class="ss-pill ss-pill-fast">fastest</span>' : ''}</td>
          <td>${(r.avg / 1000).toFixed(2)}s</td>
          <td>${r.count}</td>
          <td style="width:120px;"><div class="ss-bar-track"><div class="ss-bar-fill" style="width:${(r.avg / maxAvg) * 100}%; background:${i === 0 ? 'var(--red)' : 'var(--cyan)'};"></div></div></td>
        </tr>`).join('')}
    </table>`;
  }

  function renderGroupTable() {
    const wrap = document.getElementById('ssGroupBody');
    if (!wrap) return;
    const agg = {};
    runs.forEach(r => (r.problems || []).forEach(p => {
      if (!p.correct || p.x1 === undefined || p.x2 === undefined) return;
      const id = groupIdFor(p);
      if (!agg[id]) agg[id] = { count: 0, totalMs: 0 };
      agg[id].count++;
      agg[id].totalMs += p.timeMs;
    }));

    const MIN_GROUP_SAMPLES = 2;
    const rows = Object.keys(agg)
      .filter(id => agg[id].count >= MIN_GROUP_SAMPLES)
      .map(id => ({ id, count: agg[id].count, avg: agg[id].totalMs / agg[id].count }))
      .sort((a, b) => b.avg - a.avg);

    if (!rows.length) {
      wrap.innerHTML = '<div class="ss-empty">Fact-level breakdown will appear once you\'ve solved a few problems (each fact needs at least 2 solves to show up here).</div>';
      return;
    }

    const SHOWN = 12;
    const shown = rows.slice(0, SHOWN);
    const maxAvg = Math.max(...shown.map(r => r.avg));

    wrap.innerHTML = `<table class="ss-table">
      <tr><th>Fact</th><th>Avg solve time</th><th>Samples</th><th></th></tr>
      ${shown.map((r, i) => `
        <tr>
          <td class="ss-mono">${groupLabel(r.id)} ${i === 0 ? '<span class="ss-pill ss-pill-slow">slowest</span>' : ''}</td>
          <td>${(r.avg / 1000).toFixed(2)}s</td>
          <td>${r.count}</td>
          <td style="width:120px;"><div class="ss-bar-track"><div class="ss-bar-fill" style="width:${(r.avg / maxAvg) * 100}%; background:${i === 0 ? 'var(--red)' : 'var(--cyan)'};"></div></div></td>
        </tr>`).join('')}
    </table>
    ${rows.length > SHOWN ? `<div class="ss-sub" style="margin-top:8px;">Showing the ${SHOWN} slowest of ${rows.length} tracked facts.</div>` : ''}`;
  }

  // ---------------------------------------------------------------------
  // History tab — daily trends
  // ---------------------------------------------------------------------
  let trendDuration = 120;

  // Sort-stable local date key (YYYY-MM-DD) so days group and sort correctly
  // regardless of what locale/timezone the browser is in.
  function dateKey(dateStr) {
    const d = new Date(dateStr);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function dailyScoreSeries(duration) {
    const relevant = runs.filter(r => r.mode === 'standard' && r.duration === duration && isDefaultConfig(r));
    const byDay = {};
    relevant.forEach(r => {
      const k = dateKey(r.date);
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push(r.score);
    });
    return Object.keys(byDay).sort().map(k => ({
      date: k,
      avg: mean(byDay[k]),
      max: Math.max(...byDay[k]),
      count: byDay[k].length,
    }));
  }

  // Per-day, per-operation average solve time — uses every correctly solved
  // problem regardless of run mode or duration, since solve time is a
  // per-problem measurement, not affected by run length or which other
  // operations were enabled that run.
  function dailyCategorySeries() {
    const byDayOp = {};
    runs.forEach(r => (r.problems || []).forEach(p => {
      if (!p.correct) return;
      const k = dateKey(r.date);
      if (!byDayOp[k]) byDayOp[k] = {};
      if (!byDayOp[k][p.op]) byDayOp[k][p.op] = { totalMs: 0, count: 0 };
      byDayOp[k][p.op].totalMs += p.timeMs;
      byDayOp[k][p.op].count++;
    }));
    const days = Object.keys(byDayOp).sort();
    const series = { add: [], sub: [], mul: [], div: [] };
    days.forEach(day => {
      OPS.forEach(op => {
        const cell = byDayOp[day][op];
        series[op].push(cell ? cell.totalMs / cell.count : null);
      });
    });
    return { days, series };
  }

  function renderTrendScoreChart(duration) {
    const wrap = document.getElementById('ssTrendScoreChart');
    if (!wrap) return;
    const data = dailyScoreSeries(duration);
    if (!data.length) {
      wrap.innerHTML = `<div class="ss-empty">No standard runs yet at ${duration}s with default settings.</div>`;
      return;
    }
    const recent = data.slice(-30);
    const maxVal = Math.max(...recent.map(d => d.avg), 1);
    const barW = 34, h = 130;
    const w = Math.max(recent.length * barW, 140);
    const bars = recent.map((d, i) => {
      const bh = Math.max(3, (d.avg / maxVal) * (h - 36));
      const x = i * barW + 6;
      return `
        <rect x="${x}" y="${h - 22 - bh}" width="22" height="${bh}" rx="3" fill="var(--cyan)"></rect>
        <text x="${x + 11}" y="${h - 22 - bh - 6}" font-size="10" fill="var(--text-dim)" text-anchor="middle" font-family="'JetBrains Mono', monospace">${Math.round(d.avg)}</text>
        <text x="${x + 11}" y="${h - 6}" font-size="9" fill="var(--text-dim)" text-anchor="middle" font-family="'JetBrains Mono', monospace">${d.date.slice(5)}</text>
      `;
    }).join('');
    wrap.innerHTML = `<div class="ss-chart-wrap"><svg width="${w}" height="${h}">${bars}</svg></div>
      <div class="ss-sub" style="margin-top:4px;">${recent.length} day${recent.length === 1 ? '' : 's'} with data, most recent ${recent.length === data.length ? 'all shown' : '30 shown'}.</div>`;
  }

  function renderScoreDistribution(duration) {
    const wrap = document.getElementById('ssHomeDistribution');
    if (!wrap) return;

    const relevant = runs.filter(
      r => r.mode === 'standard' && r.duration === duration && isDefaultConfig(r)
    );

    if (relevant.length < 3) {
      wrap.innerHTML = `<div class="ss-empty">Need at least 3 standard runs at ${duration}s with default settings to show a distribution — you have ${relevant.length}.</div>`;
      return;
    }

    const scores = relevant.map(r => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const binCount = Math.min(10, Math.max(4, Math.ceil(Math.sqrt(scores.length))));
    const binSize = Math.max(1, Math.ceil((max - min + 1) / binCount));
    const bins = [];

    for (let start = min; start <= max; start += binSize) {
      bins.push({
        start,
        end: Math.min(max, start + binSize - 1),
        count: 0,
      });
    }

    scores.forEach(score => {
      const index = Math.min(bins.length - 1, Math.floor((score - min) / binSize));
      bins[index].count++;
    });

    const maxCount = Math.max(...bins.map(bin => bin.count), 1);
    const barWidth = 54;
    const height = 130;
    const width = Math.max(bins.length * barWidth, 220);

    const bars = bins.map((bin, i) => {
      const barHeight = Math.max(3, (bin.count / maxCount) * (height - 40));
      const x = i * barWidth + 7;
      const label = bin.start === bin.end
        ? `${bin.start}`
        : `${bin.start}–${bin.end}`;

      return `
        <rect x="${x}" y="${height - 24 - barHeight}" width="40" height="${barHeight}" rx="4" fill="var(--amber)"></rect>
        <text x="${x + 20}" y="${height - 24 - barHeight - 7}" font-size="10" fill="var(--text-dim)" text-anchor="middle" font-family="'JetBrains Mono', monospace">${bin.count}</text>
        <text x="${x + 20}" y="${height - 7}" font-size="9" fill="var(--text-dim)" text-anchor="middle" font-family="'JetBrains Mono', monospace">${label}</text>
      `;
    }).join('');

    wrap.innerHTML = `
      <div class="ss-chart-wrap">
        <svg width="${width}" height="${height}" role="img" aria-label="Score distribution for ${duration}-second runs">
          ${bars}
        </svg>
      </div>
      <div class="ss-sub" style="margin-top:4px;">${scores.length} runs, scores ${min}–${max}.</div>
    `;
  }

  function renderTrendCategoryChart() {
    const wrap = document.getElementById('ssTrendCategoryChart');
    if (!wrap) return;
    const { days, series } = dailyCategorySeries();
    if (days.length < 2) {
      wrap.innerHTML = '<div class="ss-empty">Need at least 2 days of solved problems to show a trend.</div>';
      return;
    }
    const recentDays = days.slice(-30);
    const offset = days.length - recentDays.length;
    const colors = { add: 'var(--amber)', sub: 'var(--cyan)', mul: 'var(--green)', div: 'var(--red)' };
    const allVals = [];
    OPS.forEach(op => series[op].slice(offset).forEach(v => { if (v !== null) allVals.push(v); }));
    const maxVal = Math.max(...allVals, 1);
    const w = Math.max(recentDays.length * 34, 220), h = 150;
    const stepX = recentDays.length > 1 ? (w - 20) / (recentDays.length - 1) : 0;

    function pathFor(op) {
      const pts = series[op].slice(offset);
      let d = '';
      let started = false;
      pts.forEach((v, i) => {
        if (v === null) { started = false; return; }
        const x = 10 + i * stepX;
        const y = h - 26 - (v / maxVal) * (h - 40);
        d += (started ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
        started = true;
      });
      return d.trim();
    }

    const lines = OPS.map(op => `<path d="${pathFor(op)}" fill="none" stroke="${colors[op]}" stroke-width="2"></path>`).join('');
    const firstLabel = recentDays[0].slice(5);
    const lastLabel = recentDays[recentDays.length - 1].slice(5);
    const legend = OPS.map(op => `<span style="color:${colors[op]}">■</span> ${OP_LABEL[op]}`).join(' &nbsp; ');

    wrap.innerHTML = `<div class="ss-chart-wrap"><svg width="${w}" height="${h}">
        ${lines}
        <text x="10" y="${h - 6}" font-size="9" fill="var(--text-dim)" font-family="'JetBrains Mono', monospace">${firstLabel}</text>
        <text x="${w - 10}" y="${h - 6}" font-size="9" fill="var(--text-dim)" text-anchor="end" font-family="'JetBrains Mono', monospace">${lastLabel}</text>
      </svg></div>
      <div class="ss-sub" style="margin-top:6px;">${legend} &nbsp; — lower is faster</div>`;
  }

  function renderTrendFactTable() {
    const wrap = document.getElementById('ssTrendFactBody');
    if (!wrap) return;
    const sortedRuns = [...runs].sort((a, b) => new Date(a.date) - new Date(b.date));
    const byGroup = {};
    sortedRuns.forEach(r => (r.problems || []).forEach(p => {
      if (!p.correct || p.x1 === undefined || p.x2 === undefined) return;
      const id = groupIdFor(p);
      if (!byGroup[id]) byGroup[id] = [];
      byGroup[id].push(p.timeMs);
    }));

    const MIN = 4;
    const rows = Object.keys(byGroup)
      .filter(id => byGroup[id].length >= MIN)
      .map(id => {
        const list = byGroup[id]; // chronological
        const half = Math.floor(list.length / 2);
        const olderAvg = mean(list.slice(0, half));
        const recentAvg = mean(list.slice(half));
        const pctChange = ((recentAvg - olderAvg) / olderAvg) * 100;
        return { id, count: list.length, olderAvg, recentAvg, pctChange };
      })
      .sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));

    if (!rows.length) {
      wrap.innerHTML = `<div class="ss-empty">Need at least ${MIN} solves on a specific fact to show a trend.</div>`;
      return;
    }

    wrap.innerHTML = `<table class="ss-table">
      <tr><th>Fact</th><th>Was</th><th>Now</th><th>Change</th></tr>
      ${rows.slice(0, 12).map(r => {
        const improving = r.pctChange < 0;
        const color = improving ? 'var(--green)' : 'var(--red)';
        const arrow = improving ? '▼' : '▲';
        return `<tr>
          <td class="ss-mono">${groupLabel(r.id)}</td>
          <td>${(r.olderAvg / 1000).toFixed(2)}s</td>
          <td>${(r.recentAvg / 1000).toFixed(2)}s</td>
          <td style="color:${color};">${arrow} ${Math.abs(r.pctChange).toFixed(0)}%</td>
        </tr>`;
      }).join('')}
    </table>`;
  }

  function renderHistoryTab() {
    renderTrendScoreChart(trendDuration);
    renderTrendCategoryChart();
    renderTrendFactTable();
  }

  function renderRunHistory() {
    const wrap = document.getElementById('ssHistoryBody');
    if (!wrap) return;
    if (!runs.length) {
      wrap.innerHTML = '<div class="ss-empty">No runs yet.</div>';
      return;
    }
    const sorted = [...runs].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);
    wrap.innerHTML = `<table class="ss-table">
      <tr><th>Date</th><th>Mode</th><th>Duration</th><th>Score</th><th></th><th></th></tr>
      ${sorted.map(r => {
        let tag = '';
        if (!hasConfigData(r)) {
          tag = '<span class="ss-pill ss-pill-neutral">settings not recorded</span>';
        } else if (!isDefaultConfig(r)) {
          tag = '<span class="ss-pill ss-pill-slow">custom settings</span>';
        }
        return `
        <tr>
          <td style="font-family:Inter,sans-serif;">${new Date(r.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
          <td style="font-family:Inter,sans-serif; color:${r.mode === 'improvement' ? 'var(--amber)' : 'var(--cyan)'};">${r.mode}</td>
          <td>${r.duration}s</td>
          <td>${r.score}</td>
          <td>${tag}</td>
          <td><button class="ss-icon-btn" data-run-id="${r.id}" title="Delete this run">✕</button></td>
        </tr>`;
      }).join('')}
    </table>`;
    wrap.querySelectorAll('[data-run-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-run-id');
        if (!confirm('Delete this run? This cannot be undone.')) return;
        await apiDeleteRun(id);
        runs = runs.filter(r => String(r.id) !== String(id));
        renderHomeStats();
      });
    });
  }

  function renderImprovementGate() {
    const note = document.getElementById('ssImproveGateNote');
    const btn = document.getElementById('ssStartImprove');
    if (!note || !btn) return;
    const count = standardRunCount();
    if (count < MIN_RUNS_FOR_IMPROVEMENT) {
      btn.disabled = true;
      note.textContent = `Improvement mode unlocks at ${MIN_RUNS_FOR_IMPROVEMENT} standard runs — you're at ${count}/${MIN_RUNS_FOR_IMPROVEMENT}. It weights problems toward categories where a small model predicts you'll be slow, trained on your own solve-time history. Improvement runs themselves don't count toward this — they don't add to your score stats, though the speed data from them still feeds the model and the category/fact breakdowns below.`;
    } else {
      btn.disabled = false;
      note.textContent = `Improvement mode uses your solve-time history. Click Start improvement run to let the model choose automatically or manually select the exact weak facts you want to practice. It doesn't count toward your score stats, but its speed data still updates your category and fact breakdowns.`;
    }
  }

  // ---------------------------------------------------------------------
  // settings UI
  // ---------------------------------------------------------------------
  function numVal(id, fallback) {
    const el = document.getElementById(id);
    const n = parseInt(el.value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function getEnabledOps() {
    const ops = [];
    if (document.getElementById('ssOpAdd').checked) ops.push('add');
    if (document.getElementById('ssOpSub').checked) ops.push('sub');
    if (document.getElementById('ssOpMul').checked) ops.push('mul');
    if (document.getElementById('ssOpDiv').checked) ops.push('div');
    return ops;
  }

  // Subtraction reuses addition's range; division reuses multiplication's
  // range — same convention Zetamac uses ("X problems in reverse").
  function getRanges() {
    let addMin1 = numVal('ssAddMin1', 2), addMax1 = numVal('ssAddMax1', 100);
    let addMin2 = numVal('ssAddMin2', 2), addMax2 = numVal('ssAddMax2', 100);
    let mulMin1 = numVal('ssMulMin1', 2), mulMax1 = numVal('ssMulMax1', 12);
    let mulMin2 = numVal('ssMulMin2', 2), mulMax2 = numVal('ssMulMax2', 100);

    // keep ranges sane: min at least 1, max at least min
    addMin1 = Math.max(1, addMin1); addMax1 = Math.max(addMin1, addMax1);
    addMin2 = Math.max(1, addMin2); addMax2 = Math.max(addMin2, addMax2);
    mulMin1 = Math.max(1, mulMin1); mulMax1 = Math.max(mulMin1, mulMax1);
    mulMin2 = Math.max(1, mulMin2); mulMax2 = Math.max(mulMin2, mulMax2);

    return {
      add: [addMin1, addMax1, addMin2, addMax2],
      mul: [mulMin1, mulMax1, mulMin2, mulMax2],
    };
  }

  function bindOpsUI() {
    const pairs = [
      ['ssOpAdd', 0], ['ssOpSub', 1], ['ssOpMul', 2], ['ssOpDiv', 3],
    ];
    pairs.forEach(([id]) => {
      const input = document.getElementById(id);
      const row = input.closest('.ss-op-row');
      const sync = () => row.classList.toggle('ss-op-disabled', !input.checked);
      input.addEventListener('change', sync);
      sync();
    });
  }

  // ---------------------------------------------------------------------
  // improvement-mode chooser
  // ---------------------------------------------------------------------
  let improvementEligibleOps = [];

  function factOp(groupId) {
    return groupId.split('_', 1)[0];
  }

  function factCompatibleWithRanges(groupId, ranges) {
    const [op, rest] = groupId.split('_');
    const [addMin1, addMax1, addMin2, addMax2] = ranges.add || DEFAULT_RANGES.add;
    const [mulMin1, mulMax1] = ranges.mul || DEFAULT_RANGES.mul;

    if (op === 'mul' || op === 'div') {
      const factor = Number(rest);
      return Number.isFinite(factor) && factor >= mulMin1 && factor <= mulMax1;
    }

    // Addition and subtraction both classify by the larger displayed operand.
    if (rest === 'low') return addMin1 < 35 && addMin2 < 35;
    if (rest === 'mid') {
      const canStayAtOrBelow67 = addMin1 <= 67 && addMin2 <= 67;
      const canReach35 = addMax1 >= 35 || addMax2 >= 35;
      return canStayAtOrBelow67 && canReach35;
    }
    return addMax1 >= 68 || addMax2 >= 68;
  }

  function getImprovementFactStats(eligibleOps, ranges) {
    const agg = {};
    runs.forEach(run => (run.problems || []).forEach(p => {
      if (!p.correct || !eligibleOps.includes(p.op) || !Number.isFinite(Number(p.timeMs))) return;
      if (p.x1 === undefined || p.x2 === undefined) return;
      const id = groupIdFor(p);
      if (!factCompatibleWithRanges(id, ranges)) return;
      if (!agg[id]) agg[id] = { count: 0, totalMs: 0 };
      agg[id].count++;
      agg[id].totalMs += Number(p.timeMs);
    }));

    // Match the Weak spots by fact table: a fact appears after at least two
    // correctly solved samples, sorted from slowest average time to fastest.
    return Object.keys(agg)
      .filter(id => agg[id].count >= 2)
      .map(id => ({ id, count: agg[id].count, avg: agg[id].totalMs / agg[id].count }))
      .sort((a, b) => b.avg - a.avg);
  }

  function setImprovementModalStep(step) {
    document.getElementById('ssImproveChoiceStep').classList.toggle('ss-hidden', step !== 'choice');
    document.getElementById('ssImproveManualStep').classList.toggle('ss-hidden', step !== 'manual');
    if (step === 'manual') {
      const first = document.querySelector('#ssImproveCategoryList input');
      if (first) first.focus();
    } else {
      document.getElementById('ssImproveAutoChoice').focus();
    }
  }

  function updateManualStartButton() {
    const selectedCount = document.querySelectorAll('#ssImproveCategoryList input[data-improve-fact]:checked').length;
    const btn = document.getElementById('ssImproveManualStart');
    btn.disabled = selectedCount === 0;
    btn.textContent = selectedCount
      ? `Start ${selectedCount} selected fact${selectedCount === 1 ? '' : 's'}`
      : 'Select at least one fact';
  }

  function renderImprovementManualFacts(eligibleOps) {
    const rows = getImprovementFactStats(eligibleOps, getRanges());
    const defaultSelected = new Set(rows.slice(0, 2).map(r => r.id));
    const list = document.getElementById('ssImproveCategoryList');

    if (!rows.length) {
      list.innerHTML = '<div class="ss-empty">No tracked facts match the currently enabled operations and ranges yet. Solve each fact at least twice before it can be selected here.</div>';
      updateManualStartButton();
      return;
    }

    list.innerHTML = rows.map((r, index) => {
      const rank = index === 0 ? 'slowest' : `#${index + 1}`;
      return `
        <label class="ss-improve-category-option">
          <input type="checkbox" data-improve-fact="${r.id}" ${defaultSelected.has(r.id) ? 'checked' : ''}>
          <span class="ss-improve-category-copy">
            <strong class="ss-mono">${groupLabel(r.id)}</strong>
            <span>${(r.avg / 1000).toFixed(2)}s average · ${r.count} solve${r.count === 1 ? '' : 's'}</span>
          </span>
          <span class="ss-improve-rank ${index === 0 ? 'ss-improve-rank-slowest' : ''}">${rank}</span>
        </label>`;
    }).join('');

    document.querySelectorAll('#ssImproveCategoryList input[data-improve-fact]').forEach(input => {
      input.addEventListener('change', updateManualStartButton);
    });
    updateManualStartButton();
  }

  function closeImprovementChooser() {
    document.getElementById('ssImproveModal').classList.add('ss-hidden');
    document.body.classList.remove('ss-modal-open');
  }

  function openImprovementChooser() {
    const enabledOps = getEnabledOps();
    if (!enabledOps.length) {
      alert('Pick at least one operation.');
      return;
    }
    if (standardRunCount() < MIN_RUNS_FOR_IMPROVEMENT) {
      alert(`Improvement mode unlocks after ${MIN_RUNS_FOR_IMPROVEMENT} standard runs. You currently have ${standardRunCount()}.`);
      return;
    }

    improvementEligibleOps = enabledOps.slice();
    renderImprovementManualFacts(improvementEligibleOps);
    document.getElementById('ssImproveModal').classList.remove('ss-hidden');
    document.body.classList.add('ss-modal-open');
    setImprovementModalStep('choice');
  }

  // ---------------------------------------------------------------------
  // game state
  // ---------------------------------------------------------------------
  let game = null;

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function flap(el, newHTML) {
    el.classList.remove('ss-flapping');
    void el.offsetWidth;
    el.classList.add('ss-flapping');
    setTimeout(() => { el.innerHTML = newHTML; }, 100);
  }

  async function refillQueue(amount) {
    if (game.fetching) return;
    game.fetching = true;
    try {
      const data = await apiNextProblems(game.mode, game.ops, amount, game.ranges, game.manualFactIds);
      game.queue.push(...data.problems);
      game.modelUsed = data.model_used;
      game.trainingSamples = data.training_samples;
      updateModeTag();
    } catch (e) {
      console.error('problem fetch failed', e);
    }
    game.fetching = false;
  }

  function updateModeTag() {
    const tag = document.getElementById('ssModeTag');
    if (game.mode === 'improvement') {
      const strategy = game.improvementStrategy === 'manual' ? `manual facts (${game.manualFactIds.length})` : 'auto model';
      tag.textContent = game.modelUsed
        ? `Improvement · ${strategy} · ${game.trainingSamples} solves`
        : `Improvement · ${strategy} · gathering data`;
      tag.classList.add('ss-improve');
    } else {
      tag.textContent = 'Standard';
      tag.classList.remove('ss-improve');
    }
  }

  function nextProblem() {
    if (game.queue.length < QUEUE_REFILL_AT && !game.fetching) {
      refillQueue(QUEUE_REFILL_AMOUNT);
    }
    if (!game.queue.length) {
      if (game.improvementStrategy === 'manual' && game.manualFactIds.length) {
        const factId = game.manualFactIds[randInt(0, game.manualFactIds.length - 1)];
        game.queue.push(fallbackProblemForFact(factId, game.ranges));
      } else {
        game.queue.push(fallbackProblem(game.ops, game.ranges));
      }
    }
    const p = game.queue.shift();
    game.current = p;
    game.problemStart = performance.now();
    game.wrongAttempts = 0;
    document.getElementById('ssProblemText').textContent = p.question;
    const input = document.getElementById('ssAnswerInput');
    input.value = '';
    input.focus();
  }

  async function startRun(mode, opsOverride = null, improvementStrategy = null, manualFactIdsOverride = []) {
    const sourceOps = Array.isArray(opsOverride) ? opsOverride : getEnabledOps();
    const enabledOps = [...new Set(sourceOps.filter(op => OPS.includes(op)))];
    if (!enabledOps.length) { alert('Pick at least one operation.'); return; }
    if (mode === 'improvement' && standardRunCount() < MIN_RUNS_FOR_IMPROVEMENT) {
      alert(`Improvement mode unlocks after ${MIN_RUNS_FOR_IMPROVEMENT} standard runs. You currently have ${standardRunCount()}.`);
      return;
    }
    // Disable immediately so a fast double-click can't fire startRun twice
    // and spin up two overlapping timers.
    document.getElementById('ssStartStandard').disabled = true;
    document.getElementById('ssStartImprove').disabled = true;

    // If a previous game object still has a live interval (e.g. a double
    // click on Start, or a leftover from a run that didn't clean up),
    // clear it before starting a new one so it can't keep ticking in the
    // background against the new game state.
    if (game && game.timerHandle) {
      clearInterval(game.timerHandle);
    }

    const duration = parseInt(document.getElementById('ssDuration').value, 10);
    const ranges = getRanges();

    game = {
      mode, ops: enabledOps, ranges, duration, timeLeft: duration,
      improvementStrategy: mode === 'improvement' ? (improvementStrategy || 'auto') : null,
      manualFactIds: mode === 'improvement' && improvementStrategy === 'manual'
        ? [...new Set(manualFactIdsOverride)] : [],
      score: 0, streak: 0, problems: [], current: null, wrongAttempts: 0,
      queue: [], fetching: false, modelUsed: false, trainingSamples: 0,
      ended: false, timerHandle: null,
    };

    showScreen('game');
    document.getElementById('ssProblemText').textContent = 'loading…';
    document.getElementById('ssTimerFlap').textContent = fmtTime(game.timeLeft);
    document.getElementById('ssScoreFlap').textContent = '0';
    document.getElementById('ssStreakLabel').textContent = 'streak 0';
    updateModeTag();

    await refillQueue(QUEUE_INITIAL);
    nextProblem();
    game.timerHandle = setInterval(tick, 1000);
  }

  function tick() {
    if (!game || game.ended) return;
    game.timeLeft--;
    flap(document.getElementById('ssTimerFlap'), fmtTime(Math.max(0, game.timeLeft)));
    if (game.timeLeft <= 0) endRun();
  }

  function flashCard(cls) {
    const card = document.getElementById('ssProblemCard');
    card.classList.remove('ss-flash-correct', 'ss-flash-wrong');
    card.classList.add(cls);
    setTimeout(() => card.classList.remove(cls), 200);
  }

  function handleCorrect() {
    const timeMs = performance.now() - game.problemStart;
    const p = game.current;
    game.problems.push({
      op: p.op, x1: p.x1, x2: p.x2, timeMs,
      correct: true, wrongAttempts: game.wrongAttempts,
    });
    game.score++;
    game.streak++;
    flap(document.getElementById('ssScoreFlap'), String(game.score));
    document.getElementById('ssStreakLabel').textContent = `streak ${game.streak}`;
    flashCard('ss-flash-correct');
    nextProblem();
  }

  // Auto-submit: the box just shows whatever the user types. The only thing
  // that happens automatically is: once the typed value equals the answer,
  // it submits and moves to the next problem. Nothing is cleared or flashed
  // for a wrong/partial value — it just sits there until it's right.
  function onAnswerInput(e) {
    const input = e.target;
    const val = input.value.trim();
    if (!game || !game.current || val === '') return;

    if (Number(val) === game.current.answer) {
      handleCorrect();
    }
  }

  async function endRun() {
    if (!game || game.ended) return;
    game.ended = true;
    clearInterval(game.timerHandle);
    const run = {
      mode: game.mode,
      improvementStrategy: game.improvementStrategy,
      duration: game.duration,
      score: game.score,
      date: new Date().toISOString(),
      problems: game.problems,
      ops: game.ops,
      ranges: game.ranges,
    };
    await apiSaveRun(run);
    runs = await apiGetRuns(); // refetch so the new run has a real id from the DB
    renderResults(run);
    showScreen('results');
  }

  // Quit: bail out of the current run immediately, discard it entirely
  // (nothing is saved to the backend), and go back to the home screen.
  function quitRun() {
    if (!game) { showScreen('home'); return; }
    if (!confirm('Quit this run? Nothing will be saved.')) return;
    game.ended = true;
    clearInterval(game.timerHandle);
    game = null;
    showScreen('home');
  }

  function renderResults(run) {
    document.getElementById('ssResultMode').textContent = run.mode === 'improvement'
      ? `${run.improvementStrategy === 'manual' ? 'manual facts' : 'auto'} improvement run`
      : 'standard run';
    document.getElementById('ssResultScore').textContent = run.score;
    document.getElementById('ssResultMeta').textContent = `correct answers in ${fmtTime(run.duration)}`;

    const byOp = {};
    OPS.forEach(op => byOp[op] = { count: 0, totalMs: 0, misses: 0 });
    run.problems.forEach(p => {
      byOp[p.op].count++;
      byOp[p.op].totalMs += p.timeMs;
      byOp[p.op].misses += p.wrongAttempts > 0 ? 1 : 0;
    });
    const rows = OPS.filter(op => byOp[op].count > 0)
      .map(op => ({ op, count: byOp[op].count, avg: byOp[op].totalMs / byOp[op].count, misses: byOp[op].misses }))
      .sort((a, b) => b.avg - a.avg);

    const tableWrap = document.getElementById('ssResultTable');
    if (!rows.length) {
      tableWrap.innerHTML = '<div class="ss-empty">No problems answered.</div>';
    } else {
      tableWrap.innerHTML = `<table class="ss-table">
        <tr><th>Category</th><th>Avg time</th><th>Solved</th><th>Had a miss</th></tr>
        ${rows.map((r, i) => `<tr>
          <td style="font-family:Inter,sans-serif;">${OP_LABEL[r.op]} ${i === 0 ? '<span class="ss-pill ss-pill-slow">slowest today</span>' : ''}</td>
          <td>${(r.avg / 1000).toFixed(2)}s</td>
          <td>${r.count}</td>
          <td>${r.misses}</td>
        </tr>`).join('')}
      </table>`;
    }

    const comparable = runs.filter(r => r.mode === 'standard' && r.duration === run.duration && isDefaultConfig(r));
    const snapshotWrap = document.getElementById('ssResultAllTime');
    if (run.mode === 'standard' && isDefaultConfig(run) && comparable.length) {
      const scores = comparable.map(r => r.score);
      snapshotWrap.innerHTML = `
        ${statCard(Math.max(...scores), 'max score')}
        ${statCard(mean(scores).toFixed(1), 'avg score')}
        ${statCard(stdev(scores).toFixed(1), 'std dev')}
        ${statCard(comparable.length, 'total runs')}
      `;
      document.getElementById('ssResultAllTimeNote').textContent = `Standard runs at ${run.duration}s with default settings.`;
    } else {
      snapshotWrap.innerHTML = `<div class="ss-empty">This run used custom settings or improvement mode, so it isn't included in a comparable snapshot — check "Your stats" on the home screen instead.</div>`;
      document.getElementById('ssResultAllTimeNote').textContent = '';
    }
  }


  // ---------------------------------------------------------------------
  // multiplayer race mode
  // ---------------------------------------------------------------------
  let currentScreen = 'home';
  const RACE_MAX_PLAYERS = 8;
  const RACE_MIN_QUESTIONS = 5;
  const RACE_MAX_QUESTIONS = 200;
  const RACE_POLL_MS = 650;
  const RACE_STORAGE_KEY = 'zetamaxActiveRace';
  let raceSession = {
    code: null,
    state: null,
    pollHandle: null,
    clockHandle: null,
    pollBusy: false,
    answerBusy: false,
    serverOffsetMs: 0,
    lastProgress: null,
    lastTrackProgress: null,
    countdownRefreshTriggered: false,
    // Incremented whenever the user switches rooms. Poll responses from an
    // older room are ignored so they cannot pull the UI back into stale state.
    transitionId: 0,
  };

  function readCookie(name) {
    const prefix = `${encodeURIComponent(name)}=`;
    const item = document.cookie
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
  }

  // This value is captured once when this page loads. Signing into another
  // account in a different tab changes the shared login cookie, but it does
  // not change this old tab's captured marker. The server can therefore stop
  // the old tab before it starts controlling the newly signed-in account.
  const RACE_PAGE_SESSION_TOKEN = readCookie('zetamax_page_session');
  let raceAccountLockShown = false;

  function lockRaceForAccountChange(message) {
    if (raceAccountLockShown) return;
    raceAccountLockShown = true;
    raceSession.answerBusy = true;
    stopRacePolling();

    const input = document.getElementById('ssRaceAnswerInput');
    if (input) input.disabled = true;

    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '99999',
      display: 'grid', placeItems: 'center', padding: '24px',
      background: 'rgba(4, 8, 15, .82)', backdropFilter: 'blur(8px)',
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      width: 'min(560px, 100%)', padding: '28px', borderRadius: '18px',
      border: '1px solid rgba(85, 183, 201, .38)',
      background: '#121a27', color: '#ece8de',
      boxShadow: '0 24px 80px rgba(0,0,0,.55)',
      fontFamily: 'Inter, sans-serif',
    });

    const title = document.createElement('h2');
    title.textContent = 'Account changed in another tab';
    Object.assign(title.style, { margin: '0 0 10px', fontSize: '22px' });

    const body = document.createElement('p');
    body.textContent = message || 'This race tab has been locked to prevent it from controlling another player.';
    Object.assign(body.style, {
      margin: '0 0 18px', color: '#a8b2c3', lineHeight: '1.55', fontSize: '14px',
    });

    const note = document.createElement('p');
    note.textContent = 'To test two accounts at once, use an incognito window, another browser, or a separate browser profile.';
    Object.assign(note.style, {
      margin: '0 0 22px', color: '#55b7c9', lineHeight: '1.5', fontSize: '13px',
    });

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload as the current account';
    Object.assign(reload.style, {
      border: '0', borderRadius: '10px', padding: '12px 18px',
      background: '#e8a33d', color: '#161006', fontWeight: '700', cursor: 'pointer',
    });
    reload.addEventListener('click', () => window.location.reload());

    card.append(title, body, note, reload);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  async function raceApi(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (RACE_PAGE_SESSION_TOKEN) {
      headers.set('X-Zetamax-Page-Session', RACE_PAGE_SESSION_TOKEN);
    }

    const response = await fetch(url, { ...options, headers });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = {}; }
    }
    if (!response.ok) {
      const error = new Error(data.error || `Race request failed (${response.status})`);
      error.code = data.code || '';
      if (error.code === 'account_changed' || error.code === 'auth_required') {
        lockRaceForAccountChange(error.message);
      }
      throw error;
    }
    return data;
  }

  function apiCreateRace(ops, ranges, questionCount) {
    return raceApi('/api/races', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops, ranges, question_count: questionCount }),
    });
  }

  function apiGetRaceCareer() {
    return raceApi('/api/race_career');
  }

  function apiJoinRace(code) {
    return raceApi('/api/races/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  }

  function apiGetRace(code) {
    return raceApi(`/api/races/${encodeURIComponent(code)}`);
  }

  function apiStartRace(code) {
    return raceApi(`/api/races/${encodeURIComponent(code)}/start`, { method: 'POST' });
  }

  function apiSubmitRaceAnswer(code, answer) {
    return raceApi(`/api/races/${encodeURIComponent(code)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
  }

  function apiLeaveRace(code) {
    return raceApi(`/api/races/${encodeURIComponent(code)}/leave`, { method: 'POST' });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function ordinal(n) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    if (n % 10 === 1) return `${n}st`;
    if (n % 10 === 2) return `${n}nd`;
    if (n % 10 === 3) return `${n}rd`;
    return `${n}th`;
  }

  function fmtRaceTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const totalTenths = Math.floor(ms / 100);
    const minutes = Math.floor(totalTenths / 600);
    const seconds = Math.floor((totalTenths % 600) / 10);
    const tenths = totalTenths % 10;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
  }

  function getRaceOps() {
    const pairs = [
      ['ssRaceOpAdd', 'add'],
      ['ssRaceOpSub', 'sub'],
      ['ssRaceOpMul', 'mul'],
      ['ssRaceOpDiv', 'div'],
    ];
    return pairs.filter(([id]) => document.getElementById(id).checked).map(([, op]) => op);
  }

  function getRaceQuestionCount() {
    const input = document.getElementById('ssRaceQuestionCount');
    const parsed = Number.parseInt(input.value, 10);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(RACE_MIN_QUESTIONS, Math.min(RACE_MAX_QUESTIONS, parsed));
  }

  function syncRaceCountPresets() {
    const count = getRaceQuestionCount();
    document.querySelectorAll('[data-race-count]').forEach(button => {
      button.classList.toggle('ss-race-count-active', Number(button.dataset.raceCount) === count);
    });
  }

  function raceCatalogLabel(ops) {
    const labels = (ops || []).map(op => OP_LABEL[op]).filter(Boolean);
    return labels.length === OPS.length ? 'Mixed catalog · all four operations' : `${labels.join(', ')} catalog`;
  }

  function setRaceMessage(id, message, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('ss-race-message-error', Boolean(message && isError));
  }

  function formatRaceDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  async function renderRaceCareer() {
    const body = document.getElementById('ssRaceCareerBody');
    if (!body) return;
    body.innerHTML = '<div class="ss-panel"><div class="ss-empty">Loading race career…</div></div>';
    try {
      const career = await apiGetRaceCareer();
      if (!career.races_completed) {
        body.innerHTML = `
          <div class="ss-panel ss-career-empty">
            <div class="ss-career-empty-car" aria-hidden="true">🏎️</div>
            <h2>No completed races yet</h2>
            <p>Finish your first multiplayer race to start building QPM and win statistics.</p>
            <button class="ss-btn ss-btn-primary" id="ssCareerStartRace" type="button">Create a race</button>
          </div>`;
        document.getElementById('ssCareerStartRace').addEventListener('click', () => showScreen('race'));
        return;
      }

      const recentRows = career.recent.map(race => {
        const place = race.racer_count >= 2 ? ordinal(race.place) : 'solo';
        const result = race.won
          ? '<span class="ss-career-result ss-career-result-win">Win</span>'
          : `<span class="ss-career-result">${place}</span>`;
        return `
          <tr>
            <td style="font-family:Inter,sans-serif;">${formatRaceDate(race.completed_at)}</td>
            <td>${result}</td>
            <td>${race.racer_count}</td>
            <td>${race.question_count}</td>
            <td>${fmtRaceTime(race.elapsed_ms)}</td>
            <td><strong>${Number(race.qpm).toFixed(1)}</strong></td>
          </tr>`;
      }).join('');

      body.innerHTML = `
        <div class="ss-career-stat-grid">
          <div class="ss-career-stat ss-career-stat-featured">
            <span class="ss-career-stat-icon">🏆</span>
            <strong class="ss-mono">${career.wins}</strong>
            <span>races won</span>
          </div>
          <div class="ss-career-stat">
            <span class="ss-career-stat-icon">⚡</span>
            <strong class="ss-mono">${Number(career.average_qpm).toFixed(1)}</strong>
            <span>average QPM</span>
          </div>
          <div class="ss-career-stat">
            <span class="ss-career-stat-icon">🚀</span>
            <strong class="ss-mono">${Number(career.best_qpm).toFixed(1)}</strong>
            <span>best QPM</span>
          </div>
          <div class="ss-career-stat">
            <span class="ss-career-stat-icon">🏁</span>
            <strong class="ss-mono">${career.races_completed}</strong>
            <span>races completed</span>
          </div>
        </div>

        <div class="ss-panel">
          <div class="ss-panel-title">
            <span>Career record</span>
            <span>${Number(career.win_rate).toFixed(1)}% win rate</span>
          </div>
          <div class="ss-career-record-bar">
            <div class="ss-career-record-fill" style="width:${Math.max(0, Math.min(100, Number(career.win_rate)))}%"></div>
          </div>
          <p class="ss-sub" style="margin:10px 0 0;">Wins are counted only in races with at least two racers. QPM includes every race you completed.</p>
        </div>

        <div class="ss-panel">
          <div class="ss-panel-title"><span>Recent races</span><span>last ${career.recent.length}</span></div>
          <div class="ss-career-table-wrap">
            <table class="ss-table ss-career-table">
              <tr><th>Date</th><th>Result</th><th>Racers</th><th>Questions</th><th>Time</th><th>QPM</th></tr>
              ${recentRows}
            </table>
          </div>
        </div>`;
    } catch (error) {
      body.innerHTML = `<div class="ss-panel"><div class="ss-empty">Could not load race career: ${escapeHtml(error.message)}</div></div>`;
    }
  }

  function currentRacePlayer(state = raceSession.state) {
    return state ? state.players.find(player => player.is_me) : null;
  }

  function updateRaceServerClock(state) {
    if (!state || !state.server_now) return;
    const serverNow = Date.parse(state.server_now);
    if (Number.isFinite(serverNow)) raceSession.serverOffsetMs = serverNow - Date.now();
  }

  function raceNowMs() {
    return Date.now() + raceSession.serverOffsetMs;
  }

  function stableRaceHue(value) {
    let hash = 0;
    const text = String(value || 'racer');
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
    return ((hash % 360) + 360) % 360;
  }

  function raceCarSvg() {
    return `<svg class="ss-race-car-svg" viewBox="0 0 154 66" aria-hidden="true" focusable="false">
      <ellipse class="ss-car-ground-shadow" cx="79" cy="57" rx="62" ry="7"></ellipse>
      <g class="ss-car-body-group">
        <path class="ss-car-rear-wing" d="M19 27h26l8 7H17z"></path>
        <path class="ss-car-main" d="M29 39c7-15 20-23 41-25h28c12 2 22 9 30 20l14 6c5 2 8 6 8 12H10c1-7 7-11 19-13Z"></path>
        <path class="ss-car-cockpit" d="M65 17h31c9 2 17 7 24 16H52c4-8 8-13 13-16Z"></path>
        <path class="ss-car-window" d="M69 20h25c7 2 13 5 18 10H58c3-5 7-8 11-10Z"></path>
        <path class="ss-car-highlight" d="M36 37c18-7 46-10 86-5l9 7H31Z"></path>
        <path class="ss-car-nose" d="M124 35l21 7c5 2 8 5 9 9h-31Z"></path>
        <rect class="ss-car-bumper" x="9" y="46" width="137" height="7" rx="3"></rect>
        <circle class="ss-car-headlight" cx="137" cy="42" r="3"></circle>
      </g>
      <g transform="translate(42 51)"><g class="ss-car-wheel ss-car-wheel-rear">
        <circle r="13"></circle><circle class="ss-car-rim" r="7"></circle><path class="ss-car-spoke" d="M0-6V6M-6 0H6M-4-4 4 4M4-4-4 4"></path>
      </g></g>
      <g transform="translate(119 51)"><g class="ss-car-wheel ss-car-wheel-front">
        <circle r="13"></circle><circle class="ss-car-rim" r="7"></circle><path class="ss-car-spoke" d="M0-6V6M-6 0H6M-4-4 4 4M4-4-4 4"></path>
      </g></g>
    </svg>`;
  }

  function renderRaceTracks(players, targetId, questionCount, options = {}) {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!players || !players.length) {
      target.innerHTML = '<div class="ss-empty">No racers yet.</div>';
      return;
    }

    const total = Math.max(1, Number(questionCount) || 1);
    const finalView = Boolean(options.finalView);
    const liveView = Boolean(options.live) && !finalView;
    const me = players.find(player => player.is_me) || players[0];
    const focusProgress = Math.max(0, Math.min(total, Number(me.progress) || 0));
    const windowQuestions = Math.max(1, Math.ceil(total * 0.05));
    const overallRatio = focusProgress / total;
    const cameraAnchor = 31 + (overallRatio * 39); // your car gradually moves from 31% to 70%
    const previousTrackProgress = raceSession.lastTrackProgress;

    let visiblePlayers;
    let offscreenAhead = 0;
    let offscreenBehind = 0;

    if (finalView) {
      visiblePlayers = [...players].sort((a, b) => {
        if (a.finished_at && b.finished_at) return Number(a.position || 999) - Number(b.position || 999);
        if (a.finished_at) return -1;
        if (b.finished_at) return 1;
        return Number(b.progress || 0) - Number(a.progress || 0);
      });
    } else {
      visiblePlayers = players
        .filter(player => player.is_me || Math.abs((Number(player.progress) || 0) - focusProgress) <= windowQuestions)
        .sort((a, b) => Number(b.progress || 0) - Number(a.progress || 0));
      offscreenAhead = players.filter(player => (Number(player.progress) || 0) > focusProgress + windowQuestions).length;
      offscreenBehind = players.filter(player => (Number(player.progress) || 0) < focusProgress - windowQuestions).length;
    }

    const remaining = Math.max(0, total - focusProgress);
    const showFinish = finalView || remaining <= windowQuestions;
    const finishX = finalView
      ? 94
      : cameraAnchor + ((remaining / windowQuestions) * (96 - cameraAnchor));
    const qpm = Number(me.qpm || 0);
    const roadSpeed = Math.max(.48, Math.min(1.15, 1.22 - (qpm / 105)));
    const skySpeed = Math.max(8, roadSpeed * 18);

    const hiddenParts = [];
    if (offscreenAhead) hiddenParts.push(`${offscreenAhead} racer${offscreenAhead === 1 ? '' : 's'} ahead`);
    if (offscreenBehind) hiddenParts.push(`${offscreenBehind} racer${offscreenBehind === 1 ? '' : 's'} behind`);
    const cameraContext = finalView
      ? 'Full finishing field'
      : (hiddenParts.length ? hiddenParts.join(' · ') : 'Every nearby racer is in view');

    const rows = visiblePlayers.map((player, index) => {
      const progress = Math.max(0, Math.min(total, Number(player.progress) || 0));
      const finished = progress >= total;
      const pct = progress / total;
      const carX = finalView
        ? 5 + (pct * 89)
        : Math.max(5, Math.min(95, cameraAnchor + (((progress - focusProgress) / windowQuestions) * 42)));
      const detail = finished
        ? `${fmtRaceTime(player.elapsed_ms)} · ${Number(player.qpm || 0).toFixed(1)} QPM`
        : `${progress}/${total}`;
      const hue = player.is_me ? 191 : stableRaceHue(player.username);
      const boosted = liveView && player.is_me && previousTrackProgress !== null && progress > previousTrackProgress;

      return `<div class="ss-race-competitor ${player.is_me ? 'ss-race-competitor-me' : ''} ${finished ? 'ss-race-competitor-finished' : ''}">
        <span class="ss-race-lane-rank ss-mono">${player.finished_at ? ordinal(player.position) : `P${index + 1}`}</span>
        <div class="ss-race-nameplate" style="left:${carX}%">
          <strong>${escapeHtml(player.username)}${player.is_host ? '<span class="ss-race-host-tag">host</span>' : ''}</strong>
          <span class="ss-mono">${detail}</span>
        </div>
        <div class="ss-race-car-shell ${player.is_me ? 'ss-race-car-me' : ''} ${boosted ? 'ss-race-car-boost' : ''} ${finished ? 'ss-race-car-finished' : ''}" style="left:${carX}%; --car-hue:${hue}; color:hsl(${hue} 82% 60%);">
          <span class="ss-race-exhaust" aria-hidden="true"></span>
          ${raceCarSvg()}
        </div>
      </div>`;
    }).join('');

    target.innerHTML = `<div class="ss-race-camera ${liveView ? 'ss-race-camera-live' : 'ss-race-camera-final'}" style="--road-speed:${roadSpeed.toFixed(2)}s; --sky-speed:${skySpeed.toFixed(2)}s; --visible-racers:${visiblePlayers.length}; --camera-height:${116 + (visiblePlayers.length * 84)}px;">
      <div class="ss-race-scenery ss-race-scenery-stars" aria-hidden="true"></div>
      <div class="ss-race-scenery ss-race-scenery-mountains" aria-hidden="true"></div>
      <div class="ss-race-scenery ss-race-scenery-city" aria-hidden="true"></div>
      <div class="ss-race-camera-hud">
        <span><i class="ss-live-dot"></i>${finalView ? 'Race replay' : 'Live camera'}</span>
        <strong>${escapeHtml(cameraContext)}</strong>
      </div>
      <div class="ss-race-course">
        ${showFinish ? `<div class="ss-race-finish-zoom" style="left:${Math.max(6, Math.min(96, finishX))}%" aria-label="Finish line"><span>FINISH</span></div>` : ''}
        ${rows}
      </div>
      <div class="ss-race-camera-scale">
        <span>${finalView ? 'START' : `−${windowQuestions}Q`}</span>
        <strong>${finalView ? `${total} QUESTIONS` : `YOU · ${focusProgress}/${total}`}</strong>
        <span>${finalView ? 'FINISH' : `+${windowQuestions}Q`}</span>
      </div>
    </div>`;

    if (liveView) {
      raceSession.lastTrackProgress = focusProgress;
      const note = document.getElementById('ssRaceWindowNote');
      if (note) note.textContent = `Focused within ±${windowQuestions} question${windowQuestions === 1 ? '' : 's'}`;
    }
  }

  function renderRaceLobby(state) {
    document.getElementById('ssRaceLobbyCode').textContent = state.code;
    document.getElementById('ssRaceLobbyCatalog').textContent = `${state.question_count} shared questions · ${raceCatalogLabel(state.ops)}`;
    document.getElementById('ssRaceLobbyCount').textContent = `${state.players.length} / ${RACE_MAX_PLAYERS}`;
    document.getElementById('ssRaceGameCode').textContent = state.code;
    document.getElementById('ssRaceResultsCode').textContent = state.code;

    const wrap = document.getElementById('ssRaceLobbyPlayers');
    wrap.innerHTML = state.players.map(player => `
      <div class="ss-race-lobby-player ${player.is_me ? 'ss-race-lobby-player-me' : ''}">
        <span class="ss-race-lobby-car">🏎️</span>
        <span>${escapeHtml(player.username)}</span>
        ${player.is_host ? '<span class="ss-race-host-tag">host</span>' : ''}
      </div>`).join('');

    const startButton = document.getElementById('ssStartRace');
    startButton.classList.toggle('ss-hidden', !state.is_host);
    startButton.disabled = state.status !== 'waiting';
    document.getElementById('ssRaceLobbyStatus').textContent = state.is_host
      ? `Ready with ${state.players.length} racer${state.players.length === 1 ? '' : 's'}.`
      : 'Waiting for the host to start…';
  }

  function renderRaceGame(state) {
    const me = currentRacePlayer(state);
    if (!me) return;
    document.getElementById('ssRaceGameCode').textContent = state.code;
    document.getElementById('ssRaceGameTitle').textContent = `Race to ${state.question_count}`;
    document.getElementById('ssRaceProgress').textContent = `${me.progress} / ${state.question_count}`;
    document.getElementById('ssRaceLiveQpm').textContent = Number(me.qpm || 0).toFixed(1);
    document.getElementById('ssRaceMistakes').textContent = `mistakes ${me.wrong_attempts}`;
    renderRaceTracks(state.players, 'ssRaceTrackList', state.question_count, { live: true });

    const problemText = document.getElementById('ssRaceProblemText');
    const input = document.getElementById('ssRaceAnswerInput');
    const startedAt = Date.parse(state.started_at || '');
    const hasStarted = Number.isFinite(startedAt) && raceNowMs() >= startedAt;

    if (!hasStarted) {
      problemText.textContent = 'Get ready…';
      input.disabled = true;
    } else if (state.current_question) {
      problemText.textContent = state.current_question;
      input.disabled = raceSession.answerBusy;
      if (raceSession.lastProgress !== me.progress) {
        input.value = '';
        raceSession.lastProgress = me.progress;
      }
      if (!raceSession.answerBusy && currentScreen === 'raceGame') input.focus();
    } else {
      problemText.textContent = 'Loading next question…';
      input.disabled = true;
    }
    updateRaceClock();
  }

  function renderRaceResults(state) {
    const me = currentRacePlayer(state);
    if (!me) return;
    document.getElementById('ssRaceResultsCode').textContent = state.code;
    document.getElementById('ssRaceResultQpm').textContent = Number(me.qpm || 0).toFixed(1);
    document.getElementById('ssRaceResultPlace').textContent = me.finished_at
      ? `${ordinal(me.position)} place`
      : `${me.progress}/${state.question_count}`;
    renderRaceTracks(state.players, 'ssRaceFinalTrack', state.question_count, { finalView: true });

    const table = document.getElementById('ssRaceResultsTable');
    table.innerHTML = `<table class="ss-table ss-race-results-table">
      <tr><th>Place</th><th>Racer</th><th>Time</th><th>QPM</th><th>Mistakes</th></tr>
      ${state.players.map(player => `
        <tr class="${player.is_me ? 'ss-race-result-me' : ''}">
          <td>${player.finished_at ? ordinal(player.position) : '—'}</td>
          <td style="font-family:Inter,sans-serif;">${escapeHtml(player.username)}${player.is_host ? ' <span class="ss-race-host-tag">host</span>' : ''}</td>
          <td>${player.finished_at ? fmtRaceTime(player.elapsed_ms) : `${player.progress}/${state.question_count}`}</td>
          <td>${Number(player.qpm || 0).toFixed(1)}</td>
          <td>${player.wrong_attempts}</td>
        </tr>`).join('')}
    </table>`;

    const unfinished = state.players.filter(player => !player.finished_at).length;
    document.getElementById('ssRaceResultsNote').textContent = unfinished
      ? `${unfinished} racer${unfinished === 1 ? ' is' : 's are'} still on the track. Standings update live.`
      : 'All racers finished. Rankings are ordered by completion time.';
  }

  function stopRacePolling() {
    if (raceSession.pollHandle) clearInterval(raceSession.pollHandle);
    if (raceSession.clockHandle) clearInterval(raceSession.clockHandle);
    raceSession.pollHandle = null;
    raceSession.clockHandle = null;
    raceSession.pollBusy = false;
  }

  function ensureRacePolling() {
    if (!raceSession.pollHandle) {
      raceSession.pollHandle = setInterval(refreshRaceState, RACE_POLL_MS);
    }
    if (!raceSession.clockHandle) {
      raceSession.clockHandle = setInterval(updateRaceClock, 100);
    }
  }

  function resetRaceSession() {
    // Invalidate any fetch that was started for the previous room.
    raceSession.transitionId += 1;
    stopRacePolling();
    localStorage.removeItem(RACE_STORAGE_KEY);
    raceSession.code = null;
    raceSession.state = null;
    raceSession.answerBusy = false;
    raceSession.lastProgress = null;
    raceSession.lastTrackProgress = null;
    raceSession.countdownRefreshTriggered = false;
    document.getElementById('ssRaceAnswerInput').value = '';
  }

  function beginRaceSwitch() {
    const snapshot = {
      code: raceSession.code,
      state: raceSession.state,
      transitionId: raceSession.transitionId + 1,
    };
    raceSession.transitionId = snapshot.transitionId;
    stopRacePolling();
    return snapshot;
  }

  function restoreRaceAfterFailedSwitch(snapshot) {
    if (!snapshot || snapshot.transitionId !== raceSession.transitionId) return;
    if (!snapshot.code || !snapshot.state) return;
    raceSession.code = snapshot.code;
    raceSession.state = snapshot.state;
    localStorage.setItem(RACE_STORAGE_KEY, snapshot.code);
    ensureRacePolling();
  }

  function activateRaceState(state) {
    raceSession.code = state.code;
    raceSession.state = state;
    updateRaceServerClock(state);
    localStorage.setItem(RACE_STORAGE_KEY, state.code);
    ensureRacePolling();

    const me = currentRacePlayer(state);
    if (state.status === 'waiting') {
      if (currentScreen !== 'raceLobby') showScreen('raceLobby');
      renderRaceLobby(state);
      return;
    }

    if (state.status === 'finished' || (me && me.finished_at)) {
      if (currentScreen !== 'raceResults') showScreen('raceResults');
      renderRaceResults(state);
      if (state.status === 'finished') stopRacePolling();
      return;
    }

    if (currentScreen !== 'raceGame') showScreen('raceGame');
    renderRaceGame(state);
  }

  async function refreshRaceState() {
    if (!raceSession.code || raceSession.pollBusy) return;
    const requestedCode = raceSession.code;
    const requestedTransitionId = raceSession.transitionId;
    raceSession.pollBusy = true;
    try {
      const state = await apiGetRace(requestedCode);

      // A create/join/leave may have happened while this request was in
      // flight. Never let an old response replace the newly selected room.
      if (
        requestedTransitionId !== raceSession.transitionId
        || requestedCode !== raceSession.code
      ) return;

      activateRaceState(state);
    } catch (error) {
      console.error('race polling failed', error);
      if (
        requestedTransitionId === raceSession.transitionId
        && requestedCode === raceSession.code
        && /not found/i.test(error.message)
      ) {
        resetRaceSession();
        showScreen('race');
        setRaceMessage('ssRaceSetupMessage', error.message, true);
      }
    } finally {
      raceSession.pollBusy = false;
    }
  }

  function updateRaceClock() {
    const state = raceSession.state;
    if (!state || !state.started_at) return;
    const startedAt = Date.parse(state.started_at);
    if (!Number.isFinite(startedAt)) return;
    const delta = raceNowMs() - startedAt;
    const me = currentRacePlayer(state);

    if (currentScreen === 'raceGame') {
      const countdown = document.getElementById('ssRaceCountdown');
      const input = document.getElementById('ssRaceAnswerInput');
      if (delta < 0) {
        countdown.textContent = String(Math.max(1, Math.ceil(-delta / 1000)));
        countdown.classList.remove('ss-hidden');
        input.disabled = true;
        document.getElementById('ssRaceElapsed').textContent = '0:00.0';
      } else {
        countdown.classList.add('ss-hidden');
        document.getElementById('ssRaceElapsed').textContent = fmtRaceTime(delta);
        if (me && !me.finished_at && state.current_question && !raceSession.answerBusy) {
          input.disabled = false;
        }
        const liveQpm = me && delta > 0 ? me.progress * 60000 / delta : 0;
        document.getElementById('ssRaceLiveQpm').textContent = liveQpm.toFixed(1);
        if (!state.current_question && !raceSession.countdownRefreshTriggered) {
          raceSession.countdownRefreshTriggered = true;
          refreshRaceState();
        }
      }
    }
  }

  async function createRace() {
    const ops = getRaceOps();
    if (!ops.length) {
      setRaceMessage('ssRaceSetupMessage', 'Select at least one question category.', true);
      return;
    }
    const questionCount = getRaceQuestionCount();
    if (questionCount === null) {
      setRaceMessage('ssRaceSetupMessage', 'Enter a question count from 5 to 200.', true);
      return;
    }
    const countInput = document.getElementById('ssRaceQuestionCount');
    countInput.value = String(questionCount);
    syncRaceCountPresets();
    const button = document.getElementById('ssCreateRace');
    button.disabled = true;
    setRaceMessage('ssRaceSetupMessage', 'Creating a shared question set…');
    const switchSnapshot = beginRaceSwitch();
    try {
      const state = await apiCreateRace(ops, getRanges(), questionCount);
      if (switchSnapshot.transitionId !== raceSession.transitionId) return;

      const previousCode = switchSnapshot.code;
      setRaceMessage('ssRaceSetupMessage', '');
      activateRaceState(state);

      // Cleanly leave an older room after the new room is confirmed.
      if (previousCode && previousCode !== state.code) {
        apiLeaveRace(previousCode).catch(error => {
          console.warn('could not leave previous race cleanly', error);
        });
      }
    } catch (error) {
      restoreRaceAfterFailedSwitch(switchSnapshot);
      setRaceMessage('ssRaceSetupMessage', error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function joinRace() {
    const input = document.getElementById('ssJoinRaceCode');
    const code = input.value.trim().toUpperCase();
    if (code.length !== 6) {
      setRaceMessage('ssRaceSetupMessage', 'Enter the six-character room code.', true);
      return;
    }
    const button = document.getElementById('ssJoinRace');
    button.disabled = true;
    setRaceMessage('ssRaceSetupMessage', 'Joining race…');
    const switchSnapshot = beginRaceSwitch();
    try {
      const state = await apiJoinRace(code);
      if (switchSnapshot.transitionId !== raceSession.transitionId) return;

      const previousCode = switchSnapshot.code;
      setRaceMessage('ssRaceSetupMessage', '');
      activateRaceState(state);

      if (previousCode && previousCode !== state.code) {
        apiLeaveRace(previousCode).catch(error => {
          console.warn('could not leave previous race cleanly', error);
        });
      }
    } catch (error) {
      restoreRaceAfterFailedSwitch(switchSnapshot);
      setRaceMessage('ssRaceSetupMessage', error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function startMultiplayerRace() {
    if (!raceSession.code) return;
    const button = document.getElementById('ssStartRace');
    button.disabled = true;
    setRaceMessage('ssRaceLobbyMessage', 'Starting countdown…');
    try {
      const state = await apiStartRace(raceSession.code);
      raceSession.countdownRefreshTriggered = false;
      setRaceMessage('ssRaceLobbyMessage', '');
      activateRaceState(state);
    } catch (error) {
      setRaceMessage('ssRaceLobbyMessage', error.message, true);
      button.disabled = false;
    }
  }

  function onRaceAnswerInput(event) {
    const state = raceSession.state;
    const value = event.target.value.trim();
    if (
      !state
      || !state.current_question
      || state.current_answer === null
      || state.current_answer === undefined
      || value === ''
      || raceSession.answerBusy
    ) return;

    // Match standard mode: wrong and partial values simply remain in the box.
    // The server is contacted only once the typed number is exactly correct.
    if (Number(value) === Number(state.current_answer)) {
      submitRaceAnswer();
    }
  }

  async function submitRaceAnswer() {
    const state = raceSession.state;
    const input = document.getElementById('ssRaceAnswerInput');
    const answer = input.value.trim();
    if (
      !state
      || !state.current_question
      || state.current_answer === null
      || state.current_answer === undefined
      || answer === ''
      || Number(answer) !== Number(state.current_answer)
      || raceSession.answerBusy
    ) return;

    raceSession.answerBusy = true;
    input.disabled = true;
    try {
      const result = await apiSubmitRaceAnswer(state.code, answer);
      updateRaceServerClock(result);

      if (result.light) {
        // Fast path: the server only sent back this player's own next
        // question, not a full room rebuild. Patch just this player's
        // entry in the existing local state instead of waiting on/asking
        // for a full race_state() — this is what removes the extra
        // round-trip that was making the input feel laggy.
        const me = currentRacePlayer(state);
        if (me) {
          me.progress = result.progress;
          if (!result.answer_correct) me.wrong_attempts = (me.wrong_attempts || 0) + 1;
        }
        state.current_question = result.current_question;
        state.current_answer = result.current_answer;
        raceSession.state = state;

        if (!result.answer_correct) {
          // Wrong-answer edge case (question changed underneath the
          // client): keep it lightweight too, just refresh this player's
          // row and let the next poll tick reconcile everyone else.
          input.disabled = false;
          return;
        }

        input.value = '';
        const card = document.getElementById('ssRaceProblemCard');
        card.classList.remove('ss-flash-wrong');
        card.classList.add('ss-flash-correct');
        setTimeout(() => card.classList.remove('ss-flash-correct'), 180);
        renderRaceGame(state);
        return;
      }

      raceSession.state = result;
      if (!result.answer_correct) {
        activateRaceState(result);
        return;
      }

      input.value = '';
      const card = document.getElementById('ssRaceProblemCard');
      card.classList.remove('ss-flash-wrong');
      card.classList.add('ss-flash-correct');
      setTimeout(() => card.classList.remove('ss-flash-correct'), 180);
      activateRaceState(result);
    } catch (error) {
      setRaceMessage('ssRaceLobbyMessage', error.message, true);
    } finally {
      raceSession.answerBusy = false;
      const latest = raceSession.state;
      if (currentScreen === 'raceGame' && latest && latest.current_question) {
        input.disabled = false;
        input.focus();
      }
    }
  }

  async function leaveCurrentRace(destination = 'race') {
    if (!raceSession.code) {
      resetRaceSession();
      showScreen(destination);
      return;
    }
    const state = raceSession.state;
    if (state && state.status === 'racing') {
      const me = currentRacePlayer(state);
      if (me && !me.finished_at && !confirm('Leave this live race? Your car will be removed from the track.')) return;
    }
    const code = raceSession.code;
    resetRaceSession();
    try { await apiLeaveRace(code); } catch (error) { console.warn('could not leave race cleanly', error); }
    showScreen(destination);
  }

  async function resumeSavedRace() {
    const code = localStorage.getItem(RACE_STORAGE_KEY);
    if (!code) return false;
    try {
      const state = await apiGetRace(code);
      activateRaceState(state);
      return true;
    } catch (_) {
      localStorage.removeItem(RACE_STORAGE_KEY);
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // screen nav
  // ---------------------------------------------------------------------
  function showScreen(name) {
    currentScreen = name;
    ['home', 'race', 'career', 'raceLobby', 'raceGame', 'raceResults', 'game', 'results', 'history'].forEach(s => {
      const screen = document.getElementById('ssScreen' + s.charAt(0).toUpperCase() + s.slice(1));
      if (screen) screen.classList.toggle('ss-hidden', s !== name);
    });
    const tabbar = document.getElementById('ssTabbar');
    const immersive = ['game', 'results', 'raceLobby', 'raceGame', 'raceResults'].includes(name);
    if (tabbar) tabbar.classList.toggle('ss-hidden', immersive);
    const activeTab = name.startsWith('race') ? 'race' : name;
    document.querySelectorAll('.ss-tab').forEach(t => t.classList.toggle('ss-tab-active', t.dataset.tab === activeTab));
    if (name === 'home') renderHomeStats();
    if (name === 'career') renderRaceCareer();
    if (name === 'history') renderHistoryTab();
  }

  // ---------------------------------------------------------------------
  // wire up
  // ---------------------------------------------------------------------
  document.getElementById('ssStartStandard').addEventListener('click', () => startRun('standard'));
  document.getElementById('ssStartImprove').addEventListener('click', openImprovementChooser);
  document.getElementById('ssImproveModalClose').addEventListener('click', closeImprovementChooser);
  document.getElementById('ssImproveManualCancel').addEventListener('click', closeImprovementChooser);
  document.getElementById('ssImproveManualBack').addEventListener('click', () => setImprovementModalStep('choice'));
  document.getElementById('ssImproveManualChoice').addEventListener('click', () => setImprovementModalStep('manual'));
  document.getElementById('ssImproveAutoChoice').addEventListener('click', () => {
    const selectedOps = improvementEligibleOps.slice();
    closeImprovementChooser();
    startRun('improvement', selectedOps, 'auto');
  });
  document.getElementById('ssImproveManualStart').addEventListener('click', () => {
    const selectedFacts = [...document.querySelectorAll('#ssImproveCategoryList input[data-improve-fact]:checked')]
      .map(input => input.dataset.improveFact);
    if (!selectedFacts.length) return;
    const selectedOps = [...new Set(selectedFacts.map(factOp))];
    closeImprovementChooser();
    startRun('improvement', selectedOps, 'manual', selectedFacts);
  });
  document.getElementById('ssImproveModal').addEventListener('click', e => {
    if (e.target.id === 'ssImproveModal') closeImprovementChooser();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('ssImproveModal').classList.contains('ss-hidden')) {
      closeImprovementChooser();
    }
  });
  document.getElementById('ssQuitRun').addEventListener('click', quitRun);
  document.getElementById('ssRunAgain').addEventListener('click', () => showScreen('home'));
  document.getElementById('ssBackHome').addEventListener('click', () => showScreen('home'));
  document.getElementById('ssAnswerInput').addEventListener('input', onAnswerInput);

  document.getElementById('ssCreateRace').addEventListener('click', createRace);
  document.querySelectorAll('[data-race-count]').forEach(button => {
    button.addEventListener('click', () => {
      document.getElementById('ssRaceQuestionCount').value = button.dataset.raceCount;
      syncRaceCountPresets();
    });
  });
  document.getElementById('ssRaceQuestionCount').addEventListener('input', syncRaceCountPresets);
  document.getElementById('ssRaceQuestionCount').addEventListener('blur', event => {
    const count = getRaceQuestionCount();
    event.target.value = String(count === null ? 50 : count);
    syncRaceCountPresets();
  });
  document.getElementById('ssJoinRace').addEventListener('click', joinRace);
  document.getElementById('ssJoinRaceCode').addEventListener('input', event => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  document.getElementById('ssJoinRaceCode').addEventListener('keydown', event => {
    if (event.key === 'Enter') joinRace();
  });
  document.getElementById('ssCopyRaceCode').addEventListener('click', async () => {
    if (!raceSession.code) return;
    try {
      await navigator.clipboard.writeText(raceSession.code);
      document.getElementById('ssCopyRaceCode').textContent = 'Copied!';
      setTimeout(() => { document.getElementById('ssCopyRaceCode').textContent = 'Copy code'; }, 1200);
    } catch (_) {
      prompt('Copy this race code:', raceSession.code);
    }
  });
  document.getElementById('ssStartRace').addEventListener('click', startMultiplayerRace);
  document.getElementById('ssLeaveRaceLobby').addEventListener('click', () => leaveCurrentRace('race'));
  document.getElementById('ssQuitRace').addEventListener('click', () => leaveCurrentRace('race'));
  document.getElementById('ssRaceAnswerInput').addEventListener('input', onRaceAnswerInput);
  document.getElementById('ssNewRace').addEventListener('click', () => {
    resetRaceSession();
    showScreen('race');
  });
  document.getElementById('ssRaceBackHome').addEventListener('click', () => {
    resetRaceSession();
    showScreen('home');
  });
  document.getElementById('ssReset').addEventListener('click', async () => {
    if (!confirm('Clear all saved runs and stats for this account? This cannot be undone.')) return;
    await apiClearRuns();
    runs = [];
    renderHomeStats();
  });

  function bindDurationPills(containerId, onChange) {
    document.querySelectorAll(`#${containerId} .ss-duration-pill`).forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${containerId} .ss-duration-pill`).forEach(b => b.classList.remove('ss-duration-pill-active'));
        btn.classList.add('ss-duration-pill-active');
        onChange(parseInt(btn.dataset.duration, 10));
      });
    });
  }
  bindDurationPills('ssHomeDurationPills', d => { statsDuration = d; renderHomeStats(); });
  bindDurationPills('ssTrendDurationPills', d => { trendDuration = d; renderHistoryTab(); });

  document.querySelectorAll('.ss-tab').forEach(tab => {
    tab.addEventListener('click', () => showScreen(tab.dataset.tab));
  });

  bindOpsUI();

  // ---------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------
  (async function init() {
    runs = await apiGetRuns();
    renderHomeStats();
    await resumeSavedRace();
  })();
})();