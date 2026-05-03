/**
 * =============================================================================
 * PN-Sim v2.0 | script.js
 * PN Junction Diode Simulator — Complete Engine
 *
 * Structure:
 *   1.  Physics constants
 *   2.  Material database  ← BUG FIX: all 12 materials, keys match <option> values
 *   3.  Simulator state
 *   4.  Physics functions  (Vt, Shockley equation, reverse breakdown)
 *   5.  Chart initialisation & update
 *   6.  Formatting helpers
 *   7.  UI update functions
 *   8.  Dropdown population
 *   9.  Documentation modal helpers
 *   10. Export functions (CSV + PDF)
 *   11. Toast notification helper
 *   12. Reset function
 *   13. DOM event listeners  ← single DOMContentLoaded block
 * =============================================================================
 */

'use strict';

/* =============================================================================
   1. PHYSICS CONSTANTS
   ============================================================================= */

const BOLTZMANN = 1.38e-23;  // k — Boltzmann constant (J/K)
const ELECTRON_CHARGE = 1.6e-19; // q — Electron charge (C)
const IDEALITY_FACTOR = 1.5; // n — ideality factor (1 = ideal, 2 = recombination dominated)

/* =============================================================================
   2. MATERIAL DATABASE
   ─────────────────────────────────────────────────────────────────────────────
   BUG FIX:
     Previously only the first 3 dropdown options worked because the select
     <option> values did not match any lookup keys in the old switch/if blocks.

   Fix applied:
     • Each key here EXACTLY matches the value="" on its <option> element.
     • The dropdown is populated dynamically from this object, so the keys
       and option values are guaranteed to stay in sync forever.

   Properties per material:
     name    — human-readable label shown in <select>
     Eg      — band gap energy (eV)
     Is      — reverse saturation current (Amperes)
     Vcut    — cut-in / threshold voltage (V)
     Vbreak  — reverse breakdown voltage magnitude (V)
     color   — hex colour used for the chart curve and UI badge
   ============================================================================= */

const MATERIALS = {
    silicon:   { name: 'Silicon (Si)',              Eg: 1.10, Is: 1e-12, Vcut: 0.70, Vbreak: 1.5,  color: '#00e5ff' },
    germanium: { name: 'Germanium (Ge)',             Eg: 0.66, Is: 1e-6,  Vcut: 0.30, Vbreak: 1.0,  color: '#f59e0b' },
    gaas:      { name: 'Gallium Arsenide (GaAs)',   Eg: 1.43, Is: 1e-14, Vcut: 1.20, Vbreak: 1.8,  color: '#a855f7' },
    inp:       { name: 'Indium Phosphide (InP)',    Eg: 1.35, Is: 1e-13, Vcut: 1.00, Vbreak: 1.7,  color: '#22c55e' },
    sic:       { name: 'Silicon Carbide (SiC)',     Eg: 3.26, Is: 1e-18, Vcut: 2.80, Vbreak: 2.0,  color: '#3b82f6' },
    gan:       { name: 'Gallium Nitride (GaN)',     Eg: 3.40, Is: 1e-20, Vcut: 3.00, Vbreak: 2.0,  color: '#6366f1' },
    inas:      { name: 'Indium Arsenide (InAs)',    Eg: 0.36, Is: 1e-4,  Vcut: 0.15, Vbreak: 0.8,  color: '#eab308' },
    cds:       { name: 'Cadmium Sulfide (CdS)',     Eg: 2.42, Is: 1e-16, Vcut: 2.00, Vbreak: 1.9,  color: '#ec4899' },
    insb:      { name: 'Indium Antimonide (InSb)',  Eg: 0.17, Is: 1e-2,  Vcut: 0.10, Vbreak: 0.5,  color: '#ef4444' },
    diamond:   { name: 'Diamond (C)',               Eg: 5.47, Is: 1e-25, Vcut: 4.50, Vbreak: 2.0,  color: '#f4f4f5' },
    zno:       { name: 'Zinc Oxide (ZnO)',          Eg: 3.37, Is: 1e-19, Vcut: 2.90, Vbreak: 2.0,  color: '#14b8a6' },
    gap:       { name: 'Gallium Phosphide (GaP)',   Eg: 2.26, Is: 1e-17, Vcut: 1.80, Vbreak: 1.9,  color: '#84cc16' },
};

/* Default material key — must exist in MATERIALS above */
const DEFAULT_MATERIAL = 'silicon';

/* =============================================================================
   3. SIMULATOR STATE
   Central mutable object — all functions read from / write to this.
   ============================================================================= */

const state = {
    material:       DEFAULT_MATERIAL, // key into MATERIALS
    voltage:        0.75,             // operating-point bias voltage (V)
    temperature:    300,              // junction temperature (K)
    isForwardBias:  true,             // true = forward mode, false = reverse mode
    gridVisible:    true,             // chart grid visibility toggle
    vMin:           -2,               // dynamic x-axis lower bound (always ≤ -2)
    vMax:            2,               // dynamic x-axis upper bound (≥ mat.Vcut + margin)
};

/* =============================================================================
   4. PHYSICS FUNCTIONS
   ============================================================================= */

/**
 * Thermal voltage Vt = kT / q
 * At 300 K → Vt ≈ 25.85 mV
 * @param {number} T — temperature in Kelvin
 * @returns {number} thermal voltage in Volts
 */
function calcVt(T) {
    return (BOLTZMANN * T) / ELECTRON_CHARGE;
}

/**
 * Shockley Ideal Diode Equation + Zener/Avalanche breakdown model.
 *
 * Forward / combined:
 *   I = Is · (exp(V / (n · Vt)) − 1)
 *
 * Reverse breakdown (only when isReverseMode = true and V < −Vbreak):
 *   I = −2 · exp((|V| − Vbreak) / 0.05)   [models exponential current rise]
 *
 * @param {number} V            — applied voltage (V)
 * @param {Object} mat          — material object from MATERIALS
 * @param {number} T            — junction temperature (K)
 * @param {boolean} isReverseMode — true when the user has toggled reverse bias
 * @returns {number}            — diode current in mA (clamped ±200 mA)
 */
function calcDiodeCurrent(V, mat, T, isReverseMode) {
    const Vt = calcVt(T);

    /* ── Reverse Breakdown (Zener / Avalanche) ──────────────────────────── */
    if (isReverseMode && V < -mat.Vbreak) {
        const excess = (-V) - mat.Vbreak;              // voltage past breakdown (V)
        const I_break = -2.0 * Math.exp(excess / 0.05); // mA — exponential rise
        return Math.max(-200, I_break);                 // clamp floor at −200 mA
    }

    /* ── Shockley Equation ───────────────────────────────────────────────── */
    const exponentArg = V / (IDEALITY_FACTOR * Vt);

    // Clamp to prevent IEEE 754 overflow: exp(x) for x > ~709 → Infinity
    const safeArg = Math.min(exponentArg, 50); // exp(50) ≈ 5.18e21 A — already enormous

    const I_amperes = mat.Is * (Math.exp(safeArg) - 1);

    // Convert Amperes → mA, cap at 200 mA for display clarity
    return Math.min(200, I_amperes * 1e3);
}

/* =============================================================================
   5. CHART — INITIALISATION & UPDATE
   ============================================================================= */

/** Reference to the Chart.js instance — set once in initChart() */
let ivChart = null;

/**
 * Convert a hex colour string to "rgba(r, g, b, alpha)" for Chart.js fills.
 * @param {string} hex   — e.g. "#00e5ff"
 * @param {number} alpha — 0–1 opacity
 * @returns {string}
 */
function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Generate 400 evenly-spaced {x, y} data points across −2V → +2V.
 * Used as the Chart.js dataset.
 *
 * @param {Object}  mat          — current MATERIALS entry
 * @param {number}  T            — temperature (K)
 * @param {boolean} isReverseMode
 * @returns {Array<{x:number, y:number}>}
 */
function generateIVDataset(mat, T, isReverseMode) {
    const NUM_POINTS = 400;
    const V_MIN = state.vMin;   // dynamic — set by updateVoltageRange()
    const V_MAX = state.vMax;   // dynamic — always reaches past mat.Vcut
    const points = [];

    for (let i = 0; i <= NUM_POINTS; i++) {
        const V = V_MIN + (V_MAX - V_MIN) * (i / NUM_POINTS);
        const I = calcDiodeCurrent(V, mat, T, isReverseMode);
        points.push({
            x: parseFloat(V.toFixed(4)),
            y: parseFloat(I.toFixed(6)),
        });
    }

    return points;
}

/**
 * Custom Chart.js plugin — drawn after every render pass.
 * Renders:
 *   1. Dashed vertical annotation at the cut-in voltage (Vcut)
 *   2. Operating-point dot + crosshair at the current slider voltage
 */
const diodeOverlayPlugin = {
    id: 'diodeOverlay',

    afterDraw(chart) {
        const { ctx, chartArea: ca, scales } = chart;
        const mat = MATERIALS[state.material];

        /* ── Cut-in Voltage Annotation ─────────────────────────────────── */
        const xPixelCutin = scales.x.getPixelForValue(mat.Vcut);

        if (xPixelCutin >= ca.left && xPixelCutin <= ca.right) {
            ctx.save();
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = hexToRgba(mat.color, 0.38);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(xPixelCutin, ca.top);
            ctx.lineTo(xPixelCutin, ca.bottom);
            ctx.stroke();

            // Label
            ctx.setLineDash([]);
            ctx.fillStyle = hexToRgba(mat.color, 0.65);
            ctx.font = 'bold 10px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`Vcut = ${mat.Vcut}V`, xPixelCutin + 4, ca.top + 14);
            ctx.restore();
        }

        /* ── Operating Point (glowing dot + crosshair) ──────────────────── */
        const V_op = state.voltage;
        const I_op = calcDiodeCurrent(V_op, mat, state.temperature, !state.isForwardBias);
        const I_clamped = Math.max(-200, Math.min(200, I_op));

        const xPixelOp = scales.x.getPixelForValue(V_op);
        const yPixelOp = scales.y.getPixelForValue(I_clamped);

        const inChart =
            xPixelOp >= ca.left && xPixelOp <= ca.right &&
            yPixelOp >= ca.top  && yPixelOp <= ca.bottom;

        if (inChart) {
            ctx.save();

            // Dashed crosshair lines
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = hexToRgba(mat.color, 0.45);

            ctx.beginPath();
            ctx.moveTo(xPixelOp, ca.bottom);
            ctx.lineTo(xPixelOp, yPixelOp);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(ca.left, yPixelOp);
            ctx.lineTo(xPixelOp, yPixelOp);
            ctx.stroke();

            // Outer glow halo
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(xPixelOp, yPixelOp, 11, 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(mat.color, 0.15);
            ctx.fill();

            // Solid filled dot with glow shadow
            ctx.beginPath();
            ctx.arc(xPixelOp, yPixelOp, 6, 0, Math.PI * 2);
            ctx.fillStyle = mat.color;
            ctx.shadowBlur = 20;
            ctx.shadowColor = mat.color;
            ctx.fill();

            ctx.restore();
        }
    },
};

/**
 * Initialise a Chart.js line chart on the #ivChart canvas.
 * Called once on DOMContentLoaded.
 */
function initChart() {
    const canvas = document.getElementById('ivChart');
    const ctx = canvas.getContext('2d');
    const mat = MATERIALS[DEFAULT_MATERIAL];

    ivChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'I-V Curve',
                data: [],                                     // populated by updateChart()
                borderColor:     mat.color,
                backgroundColor: hexToRgba(mat.color, 0.08),
                borderWidth:     2.5,
                pointRadius:     0,                           // no dots on every point
                tension:         0.35,                        // smooth spline curve
                fill:            'origin',                    // shade area from y = 0
            }]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,

            // Smooth re-draw animation on every data change
            animation: {
                duration: 450,
                easing:   'easeInOutQuart',
            },

            interaction: {
                mode:      'index',
                intersect: false,
            },

            plugins: {
                legend: { display: false },

                // Tooltip configuration
                tooltip: {
                    backgroundColor: 'rgba(14, 14, 14, 0.96)',
                    borderColor:     'rgba(0, 229, 255, 0.25)',
                    borderWidth:     1,
                    titleColor:      '#00e5ff',
                    bodyColor:       '#e5e2e1',
                    padding:         12,
                    displayColors:   false,
                    callbacks: {
                        title(ctx) {
                            const v = parseFloat(ctx[0].label);
                            return `V = ${v.toFixed(3)} V`;
                        },
                        label(ctx) {
                            const { val, unit } = formatCurrent(ctx.parsed.y);
                            return ` I = ${val} ${unit}`;
                        },
                    },
                },
            },

            scales: {
                x: {
                    type: 'linear',
                    min: -2,
                    max:  2,
                    grid: {
                        color:     'rgba(255, 255, 255, 0.06)',
                        drawTicks: false,
                    },
                    border: { color: 'rgba(255, 255, 255, 0.12)' },
                    ticks: {
                        color:    '#52525b',
                        font:     { family: 'monospace', size: 10 },
                        stepSize: 0.5,
                        callback: v => `${parseFloat(v).toFixed(1)}V`,
                    },
                    title: {
                        display: true,
                        text:    'Voltage (V)',
                        color:   '#52525b',
                        font:    { size: 11 },
                    },
                },
                y: {
                    // Auto-scale — Chart.js determines min/max from the data
                    grid: {
                        color:     'rgba(255, 255, 255, 0.06)',
                        drawTicks: false,
                    },
                    border: { color: 'rgba(255, 255, 255, 0.12)' },
                    ticks: {
                        color:    '#52525b',
                        font:     { family: 'monospace', size: 10 },
                        callback: v => `${parseFloat(v).toFixed(1)} mA`,
                    },
                    title: {
                        display: true,
                        text:    'Current (mA)',
                        color:   '#52525b',
                        font:    { size: 11 },
                    },
                },
            },
        },

        // Attach custom overlay plugin (cut-in line + operating point)
        plugins: [diodeOverlayPlugin],
    });
}

/**
 * Push freshly-computed I-V data into Chart.js and trigger an animated re-draw.
 * This is the single chart refresh point — called from updateAll().
 */
function updateChart() {
    if (!ivChart) return;

    const mat = MATERIALS[state.material];
    const data = generateIVDataset(mat, state.temperature, !state.isForwardBias);

    // Update dataset data and visual style to match the selected material colour
    ivChart.data.datasets[0].data            = data;
    ivChart.data.datasets[0].borderColor     = mat.color;
    ivChart.data.datasets[0].backgroundColor = hexToRgba(mat.color, 0.08);

    ivChart.update(); // triggers animation + custom plugin redraw
}

/* =============================================================================
   6. VALUE FORMATTING HELPERS
   ============================================================================= */

/**
 * Auto-range a current value in mA to the most readable SI unit.
 * Returns { val: string, unit: string }
 *
 * Examples:
 *   formatCurrent(0.0000002) → { val: '0.200', unit: 'nA' }
 *   formatCurrent(15.3)      → { val: '15.300', unit: 'mA' }
 *
 * @param {number} I_mA — current in milliamps
 * @returns {{ val: string, unit: string }}
 */
function formatCurrent(I_mA) {
    const abs = Math.abs(I_mA);
    if      (abs >= 1000)    return { val: (I_mA / 1000).toFixed(3),  unit: 'A'  };
    else if (abs >= 1)       return { val: I_mA.toFixed(3),            unit: 'mA' };
    else if (abs >= 1e-3)    return { val: (I_mA * 1e3).toFixed(3),   unit: 'µA' };
    else if (abs >= 1e-6)    return { val: (I_mA * 1e6).toFixed(3),   unit: 'nA' };
    else if (abs > 0)        return { val: (I_mA * 1e9).toFixed(3),   unit: 'pA' };
    else                     return { val: '0.000',                    unit: 'mA' };
}

/**
 * Auto-range the saturation current Is (given in Amperes) to pA / fA / aA etc.
 * @param {number} Is_A — saturation current in Amperes
 * @returns {{ val: string, unit: string }}
 */
function formatIs(Is_A) {
    if      (Is_A >= 1e-3)   return { val: (Is_A * 1e3).toFixed(2),  unit: 'mA' };
    else if (Is_A >= 1e-6)   return { val: (Is_A * 1e6).toFixed(2),  unit: 'µA' };
    else if (Is_A >= 1e-9)   return { val: (Is_A * 1e9).toFixed(2),  unit: 'nA' };
    else if (Is_A >= 1e-12)  return { val: (Is_A * 1e12).toFixed(2), unit: 'pA' };
    else if (Is_A >= 1e-15)  return { val: (Is_A * 1e15).toFixed(2), unit: 'fA' };
    else if (Is_A >= 1e-18)  return { val: (Is_A * 1e18).toFixed(2), unit: 'aA' };
    else                     return { val: Is_A.toExponential(1),     unit: 'A'  };
}

/* =============================================================================
   7. UI UPDATE FUNCTIONS
   ============================================================================= */

/**
 * Update every text node, badge colour, and card value to reflect current state.
 * Does NOT touch the chart — that is handled separately by updateChart().
 */
function updateUI() {
    const mat = MATERIALS[state.material];
    const T   = state.temperature;
    const V   = state.voltage;
    const Vt  = calcVt(T);

    /* ── Slider live readouts ───────────────────────────────────────────── */
    document.getElementById('voltageDisplay').textContent =
        V >= 0 ? `+${V.toFixed(2)}V` : `${V.toFixed(2)}V`;

    document.getElementById('tempDisplay').textContent = `${T}K`;
    document.getElementById('vtDisplay').textContent   = `Vt = ${(Vt * 1000).toFixed(2)} mV`;

    /* ── Material colour badge ──────────────────────────────────────────── */
    const badge      = document.getElementById('matBadge');
    const badgeDot   = document.getElementById('matBadgeDot');
    const badgeLabel = document.getElementById('matBadgeLabel');

    // Strip the parenthetical symbol — show just the material name
    badgeLabel.textContent = mat.name.split(' (')[0];
    badgeDot.style.backgroundColor = mat.color;
    badge.style.borderColor        = hexToRgba(mat.color, 0.35);
    badge.style.color              = mat.color;
    badge.style.backgroundColor    = hexToRgba(mat.color, 0.1);

    /* ── Band gap & cut-in voltage cards ────────────────────────────────── */
    document.getElementById('bandGapVal').textContent = mat.Eg.toFixed(2);
    document.getElementById('cutInVal').textContent   = mat.Vcut.toFixed(2);

    /* ── Saturation current card ─────────────────────────────────────────── */
    const isFormatted = formatIs(mat.Is);
    document.getElementById('isVal').textContent  = isFormatted.val;
    document.getElementById('isUnit').textContent = isFormatted.unit;

    /* ── Live operating-point current card ──────────────────────────────── */
    // isForwardBias = true means the physics engine uses forward mode
    // toggle is reversed because the physics function takes isReverseMode
    const I_mA = calcDiodeCurrent(V, mat, T, !state.isForwardBias);
    const iFormatted = formatCurrent(I_mA);
    const currentValEl = document.getElementById('currentVal');
    currentValEl.textContent  = iFormatted.val;
    currentValEl.style.color  = mat.color;
    document.getElementById('currentUnit').textContent = iFormatted.unit;

    /* ── Biasing state label ─────────────────────────────────────────────── */
    const biasEl = document.getElementById('biasStateText');
    if (state.isForwardBias) {
        biasEl.textContent = 'FORWARD BIAS';
        biasEl.style.color = '#00e5ff';
    } else {
        biasEl.textContent = 'REVERSE BIAS';
        biasEl.style.color = '#f59e0b';
    }

    /* ── Diode status (ON / OFF) ─────────────────────────────────────────── */
    // Diode is ON when forward-biased above cut-in voltage
    const isOn = state.isForwardBias && V > mat.Vcut;
    const statusDot  = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    if (isOn) {
        statusDot.className  = 'h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#00e5ff]';
        statusText.textContent = 'ON';
        statusText.style.color = '#ffffff';
    } else {
        statusDot.className  = 'h-2 w-2 rounded-full bg-zinc-600';
        statusText.textContent = 'OFF';
        statusText.style.color = '#71717a';
    }

    /* ── Efficiency indicator ────────────────────────────────────────────── */
    // FIX: was (V - mat.Vcut) / (2 - mat.Vcut) — denominator goes NEGATIVE for
    // materials with Vcut > 2V (SiC=2.8, GaN=3.0, ZnO=2.9, Diamond=4.5),
    // producing wrong or NaN efficiency. Now uses state.vMax which is always
    // at least (mat.Vcut + 0.5), so headroom is always positive.
    let efficiency = '0.0%';
    if (state.isForwardBias && V > mat.Vcut) {
        const headroom = state.vMax - mat.Vcut;          // always > 0
        const ratio    = Math.min(1, (V - mat.Vcut) / headroom);
        efficiency     = (85 + ratio * 13.9).toFixed(1) + '%';
    }
    document.getElementById('efficiencyVal').textContent = efficiency;
}

/* =============================================================================
   7a. VOLTAGE RANGE UPDATER
   ─────────────────────────────────────────────────────────────────────────────
   ROOT FIX for "Status / Efficiency don't show for some materials":

   Materials like SiC (Vcut=2.8V), GaN (3.0V), ZnO (2.9V), Diamond (4.5V)
   have cut-in voltages ABOVE the old hardcoded +2V slider max.
   This meant V > mat.Vcut was NEVER true → Status always OFF, Efficiency 0%.

   This function expands the slider + chart x-axis so the max is always
   ≥ (mat.Vcut + 0.5V), rounded to the nearest 0.5V.
   Called on every material change via updateAll().
   ============================================================================= */

/**
 * Recalculate and apply the voltage slider range for the current material.
 * Mutates: state.vMin, state.vMax, slider min/max/value, chart x-axis, UI labels.
 */
function updateVoltageRange() {
    const mat = MATERIALS[state.material];

    // Always reach at least 0.5V above Vcut, minimum 2V, round up to nearest 0.5
    const rawMax  = Math.max(2.0, mat.Vcut + 0.5);
    const newVMax = Math.ceil(rawMax * 2) / 2;
    const newVMin = -2;                        // negative side: fixed at -2V

    state.vMax = newVMax;
    state.vMin = newVMin;

    // Clamp current voltage into new range and sync slider
    const slider  = document.getElementById('voltageSlider');
    state.voltage = Math.max(newVMin, Math.min(newVMax, state.voltage));
    slider.min    = newVMin;
    slider.max    = newVMax;
    slider.value  = state.voltage;

    // Update endpoint labels
    document.getElementById('voltageMinLabel').textContent = `${newVMin.toFixed(1)} V`;
    document.getElementById('voltageMaxLabel').textContent = `+${newVMax.toFixed(1)} V`;

    // Sync chart x-axis and adjust tick density
    if (ivChart) {
        ivChart.options.scales.x.min = newVMin;
        ivChart.options.scales.x.max = newVMax;
        const span = newVMax - newVMin;
        ivChart.options.scales.x.ticks.stepSize = span <= 4 ? 0.5 : 1.0;
    }
}

/* =============================================================================
   7b. GRAPH SUMMARY UPDATE
   Computes live stats about the current I-V curve and pushes them into the
   Graph Summary card in the bottom row. Called from updateAll().
   ============================================================================= */

/**
 * Determine the operating region label and colour for the summary badge.
 * @returns {{ label: string, color: string, bg: string, border: string }}
 */
function getOperatingRegion(mat, V, isForwardBias) {
    if (!isForwardBias && V < -mat.Vbreak) {
        return { label: 'Breakdown',  color: '#ef4444', bg: 'rgba(239,68,68,0.1)',    border: 'rgba(239,68,68,0.35)'  };
    }
    if (!isForwardBias) {
        return { label: 'Reverse',    color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',   border: 'rgba(245,158,11,0.35)' };
    }
    if (V < mat.Vcut) {
        return { label: 'Cut-off',    color: '#71717a', bg: 'rgba(113,113,122,0.1)',  border: 'rgba(113,113,122,0.35)' };
    }
    return     { label: 'Conducting', color: '#00e5ff', bg: 'rgba(0,229,255,0.1)',    border: 'rgba(0,229,255,0.35)'  };
}

/**
 * Update all six stat cells in the Graph Summary card.
 * Called every time state changes (via updateAll).
 */
function updateGraphSummary() {
    const mat = MATERIALS[state.material];
    const T   = state.temperature;
    const V   = state.voltage;
    const Vt  = calcVt(T);

    /* ── Operating region badge ─────────────────────────────────────── */
    const region = getOperatingRegion(mat, V, state.isForwardBias);
    const badge  = document.getElementById('summaryRegionBadge');
    badge.textContent        = region.label;
    badge.style.color        = region.color;
    badge.style.background   = region.bg;
    badge.style.borderColor  = region.border;

    /* ── Operating-point current ────────────────────────────────────── */
    const I_op        = calcDiodeCurrent(V, mat, T, !state.isForwardBias);
    const opFormatted = formatCurrent(I_op);
    document.getElementById('summaryOpIVal').textContent  = opFormatted.val;
    document.getElementById('summaryOpIUnit').textContent = opFormatted.unit;
    document.getElementById('summaryOpIVal').style.color  = mat.color;

    /* ── Peak current (max |I| across the full sweep) ─────── */
    let peakI = 0;
    for (let i = 0; i <= 200; i++) {
        const Vs = state.vMin + (state.vMax - state.vMin) * (i / 200);
        const Is = Math.abs(calcDiodeCurrent(Vs, mat, T, !state.isForwardBias));
        if (Is > peakI) peakI = Is;
    }
    const peakFormatted = formatCurrent(Math.min(200, peakI));
    document.getElementById('summaryPeakIVal').textContent  = peakFormatted.val;
    document.getElementById('summaryPeakIUnit').textContent = peakFormatted.unit;

    /* ── Thermal voltage (mV) ───────────────────────────────────────── */
    document.getElementById('summaryVtVal').textContent = (Vt * 1000).toFixed(2);

    /* ── Bias mode ──────────────────────────────────────────────────── */
    document.getElementById('summaryBiasMode').textContent = state.isForwardBias ? 'Forward' : 'Reverse';

    /* ── Clearance = V − Vcut (how far above/below turn-on) ─────────── */
    const clearance = V - mat.Vcut;
    const clearEl   = document.getElementById('summaryClearanceVal');
    clearEl.textContent = (clearance >= 0 ? '+' : '') + clearance.toFixed(3);
    clearEl.style.color = clearance >= 0 ? '#00e5ff' : '#f59e0b';

    /* ── Material short symbol ─────────────────────────────────────── */
    // Extract the symbol in parentheses, e.g. "Silicon (Si)" → "Si"
    const symbolMatch = mat.name.match(/\(([^)]+)\)/);
    document.getElementById('summaryMaterial').textContent =
        symbolMatch ? symbolMatch[1] : mat.name;
}

/**
 * Master refresh — updates voltage range, UI text, graph summary AND the chart.
 * Call this whenever any state property changes.
 */
function updateAll() {
    updateVoltageRange();   // MUST run first — sets state.vMax used by updateUI + updateChart
    updateUI();
    updateGraphSummary();
    updateChart();
}

/* =============================================================================
   8. DROPDOWN POPULATION
   ─────────────────────────────────────────────────────────────────────────────
   Called once on DOMContentLoaded. Builds <option> elements from MATERIALS,
   ensuring option.value === MATERIALS key. This is the root fix for the bug
   where non-silicon/germanium/gaas materials did not update the UI.
   ============================================================================= */

function populateMaterialSelect() {
    const select = document.getElementById('materialSelect');
    select.innerHTML = ''; // Clear any hard-coded placeholder options

    Object.entries(MATERIALS).forEach(([key, mat]) => {
        const opt = document.createElement('option');
        opt.value       = key;           // MUST match MATERIALS key exactly
        opt.textContent = mat.name;
        if (key === state.material) opt.selected = true;
        select.appendChild(opt);
    });
}

/* =============================================================================
   9. DOCUMENTATION MODAL HELPERS
   ============================================================================= */

/** Populate the material properties reference table inside the docs panel */
function populateMaterialTable() {
    const tbody = document.getElementById('matTableBody');
    tbody.innerHTML = '';

    Object.entries(MATERIALS).forEach(([, mat]) => {
        const isFormatted = formatIs(mat.Is);

        // Compute dynamic slider max — same formula as updateVoltageRange()
        const rawMax = Math.max(2.0, mat.Vcut + 0.5);
        const vMax   = Math.ceil(rawMax * 2) / 2;
        // Colour-code: cyan = standard 2V, amber = auto-expanded, red = ultra-wide
        const vMaxColor = vMax >= 5.0 ? 'color:#ef4444'
                        : vMax >  2.0 ? 'color:#f59e0b'
                        : 'color:#00e5ff';

        const tr = document.createElement('tr');
        tr.className = 'hover:bg-white/[0.025] transition-colors';

        tr.innerHTML = `
            <td class="px-4 py-2.5 text-zinc-300">
                <span class="flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full flex-shrink-0"
                          style="background:${mat.color}; box-shadow:0 0 6px ${mat.color}88;"></span>
                    ${mat.name}
                </span>
            </td>
            <td class="px-3 py-2.5 text-right text-zinc-400">${mat.Eg.toFixed(2)} eV</td>
            <td class="px-3 py-2.5 text-right text-zinc-400">${isFormatted.val} ${isFormatted.unit}</td>
            <td class="px-3 py-2.5 text-right text-zinc-400">${mat.Vcut.toFixed(2)} V</td>
            <td class="px-3 py-2.5 text-right text-zinc-400">${mat.Vbreak.toFixed(1)} V</td>
            <td class="px-3 py-2.5 text-right font-semibold" style="${vMaxColor}">
                +${vMax.toFixed(1)} V
            </td>
        `;

        tbody.appendChild(tr);
    });
}

/** Slide the documentation panel into view */
function openDocModal() {
    const modal = document.getElementById('docModal');
    modal.classList.remove('hidden');
    // Let the browser paint the display:flex before applying the transform
    requestAnimationFrame(() => modal.classList.add('open'));
}

/** Slide the documentation panel back out, then hide it */
function closeDocModal() {
    const modal = document.getElementById('docModal');
    modal.classList.remove('open');
    // Match CSS transition duration (350 ms) before setting display:none
    setTimeout(() => modal.classList.add('hidden'), 350);
}

/* =============================================================================
   10. EXPORT FUNCTIONS
   ============================================================================= */

/**
 * Generate a CSV file of the full I-V curve for the current state
 * and trigger a browser download.
 */
function exportCSV() {
    const mat  = MATERIALS[state.material];
    const T    = state.temperature;
    const mode = state.isForwardBias ? 'Forward' : 'Reverse';
    const Vt   = calcVt(T);

    // Build CSV rows — metadata header then numeric data
    const rows = [
        [`# PN-Sim v2.0 — I-V Data Export`],
        [`# Material: ${mat.name}`],
        [`# Temperature: ${T} K  |  Vt: ${(Vt * 1000).toFixed(3)} mV  |  Bias Mode: ${mode}`],
        [`# Equation: I = Is * (exp(V / (n*Vt)) - 1)  |  n = ${IDEALITY_FACTOR}  |  Is = ${mat.Is} A`],
        [`# Eg: ${mat.Eg} eV  |  Vcut: ${mat.Vcut} V  |  Vbreak: ${mat.Vbreak} V`],
        [],
        ['Voltage (V)', 'Current (mA)'],
    ];

    for (let i = 0; i <= 400; i++) {
        const V = state.vMin + (state.vMax - state.vMin) * (i / 400);
        const I = calcDiodeCurrent(V, mat, T, !state.isForwardBias);
        rows.push([V.toFixed(5), Math.max(-200, Math.min(200, I)).toFixed(6)]);
    }

    const csvString = rows.map(r => r.join(',')).join('\n');
    const blob      = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url       = URL.createObjectURL(blob);

    const link      = document.createElement('a');
    link.href       = url;
    link.download   = `iv_${state.material}_${T}K_${mode.toLowerCase()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast('CSV downloaded ✓');
}

/** Trigger the browser print dialog (CSS @media print hides navigation chrome) */
function exportPDF() {
    window.print();
}

/* =============================================================================
   11. TOAST NOTIFICATION
   ============================================================================= */

/** Brief fade-in / fade-out toast for user feedback after export actions */
function showToast(message, durationMs = 2500) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), durationMs);
}

/* =============================================================================
   12. RESET FUNCTION
   ============================================================================= */

/**
 * Reset all controls and state to their defaults (Silicon, 0.75 V, 300 K, Forward).
 * Syncs DOM controls back to default values, then triggers a full re-render.
 */
function resetAll() {
    // Reset state object
    state.material      = DEFAULT_MATERIAL;
    state.voltage       = 0.75;
    state.temperature   = 300;
    state.isForwardBias = true;
    state.vMin          = -2;
    state.vMax          =  2;

    // Sync DOM controls
    document.getElementById('materialSelect').value = DEFAULT_MATERIAL;
    document.getElementById('voltageSlider').value  = '0.75';
    document.getElementById('tempSlider').value     = '300';
    document.getElementById('biasToggle').checked   = true;

    updateAll();
    showToast('Simulation reset ✓');
}

/* =============================================================================
   13. EVENT LISTENERS
   ─────────────────────────────────────────────────────────────────────────────
   All DOM interaction is wired up here inside a single DOMContentLoaded block.
   This guarantees every element exists before we attach listeners.
   ============================================================================= */

document.addEventListener('DOMContentLoaded', () => {

    /* ── One-time initialisations ─────────────────────────────────────── */
    populateMaterialSelect(); // Build dropdown from MATERIALS (fixes the bug)
    populateMaterialTable();  // Build docs reference table
    initChart();              // Create Chart.js instance
    updateAll();              // Render initial state

    /* ── Material dropdown ────────────────────────────────────────────── */
    document.getElementById('materialSelect').addEventListener('change', (e) => {
        state.material = e.target.value; // value matches a MATERIALS key exactly
        updateAll();
    });

    /* ── Voltage slider — fires on every pixel of movement ───────────── */
    document.getElementById('voltageSlider').addEventListener('input', (e) => {
        state.voltage = parseFloat(e.target.value);
        updateAll();
    });

    /* ── Temperature slider — recalculates Vt and redraws curve ─────── */
    document.getElementById('tempSlider').addEventListener('input', (e) => {
        state.temperature = parseInt(e.target.value, 10);
        updateAll();
    });

    /* ── Bias mode toggle (Forward ↔ Reverse) ───────────────────────── */
    document.getElementById('biasToggle').addEventListener('change', (e) => {
        state.isForwardBias = e.target.checked; // checked = forward
        updateAll();
    });

    /* ── Reset button (header) ───────────────────────────────────────── */
    document.getElementById('resetBtn').addEventListener('click', resetAll);

    /* ── Export Data button (header) → CSV ──────────────────────────── */
    document.getElementById('exportDataBtn').addEventListener('click', exportCSV);

    /* ── Quick Export: CSV card ──────────────────────────────────────── */
    document.getElementById('csvExportBtn').addEventListener('click', exportCSV);

    /* ── Quick Export: PDF card ──────────────────────────────────────── */
    document.getElementById('pdfExportBtn').addEventListener('click', exportPDF);

    /* ── Documentation modal: open via sidebar link ──────────────────── */
    document.getElementById('docLink').addEventListener('click', (e) => {
        e.preventDefault();
        openDocModal();
    });

    /* ── Documentation modal: close — X button ───────────────────────── */
    document.getElementById('closeDocModal').addEventListener('click', closeDocModal);

    /* ── Documentation modal: close — "Close Panel" footer link ─────── */
    document.getElementById('closeDocModal2').addEventListener('click', closeDocModal);

    /* ── Documentation modal: close — clicking the dark backdrop ─────── */
    document.getElementById('docBackdrop').addEventListener('click', closeDocModal);

    /* ── Chart toolbar: toggle grid ──────────────────────────────────── */
    document.getElementById('toggleGridBtn').addEventListener('click', () => {
        state.gridVisible = !state.gridVisible;

        // Toggle the CSS dot-grid background overlay
        document.getElementById('gridOverlay').style.opacity =
            state.gridVisible ? '0.05' : '0';

        // Toggle Chart.js internal grid lines
        ivChart.options.scales.x.grid.display = state.gridVisible;
        ivChart.options.scales.y.grid.display = state.gridVisible;
        ivChart.update('none'); // instant update — no animation needed
    });

    /* ── Chart toolbar: zoom in (narrow x range by 30% centred on voltage) ── */
    document.getElementById('zoomInBtn').addEventListener('click', () => {
        const xScale   = ivChart.options.scales.x;
        const curMin   = xScale.min ?? state.vMin;
        const curMax   = xScale.max ?? state.vMax;
        const centre   = Math.max(curMin, Math.min(curMax, state.voltage));
        const halfSpan = (curMax - curMin) / 2 * 0.70; // shrink 30%

        xScale.min = parseFloat(Math.max(state.vMin, centre - halfSpan).toFixed(3));
        xScale.max = parseFloat(Math.min(state.vMax, centre + halfSpan).toFixed(3));

        // Prevent collapsing below 0.2 V window
        if (xScale.max - xScale.min < 0.2) {
            xScale.min = Math.max(state.vMin, centre - 0.1);
            xScale.max = Math.min(state.vMax, centre + 0.1);
        }

        ivChart.update();
    });

    /* ── Chart toolbar: zoom out (expand x range by 30%, capped at [vMin, vMax]) ── */
    document.getElementById('zoomOutBtn').addEventListener('click', () => {
        const xScale   = ivChart.options.scales.x;
        const curMin   = xScale.min ?? state.vMin;
        const curMax   = xScale.max ?? state.vMax;
        const centre   = (curMin + curMax) / 2;
        const halfSpan = (curMax - curMin) / 2 / 0.70; // expand 30%

        const newMin = parseFloat(Math.max(state.vMin, centre - halfSpan).toFixed(3));
        const newMax = parseFloat(Math.min(state.vMax, centre + halfSpan).toFixed(3));

        xScale.min = newMin;
        xScale.max = newMax;

        // If fully zoomed out, reset to exact dynamic bounds
        if (newMin <= state.vMin && newMax >= state.vMax) {
            xScale.min = state.vMin;
            xScale.max = state.vMax;
        }

        ivChart.update();
    });

    /* ── Mobile sidebar: open ────────────────────────────────────────── */
    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
        document.getElementById('mobileSidebar').classList.add('open');
        document.getElementById('mobileSidebarOverlay').classList.add('open');
        document.body.style.overflow = 'hidden'; // prevent background scroll
    });

    /** Close the mobile sidebar and restore scroll */
    function closeMobileSidebar() {
        document.getElementById('mobileSidebar').classList.remove('open');
        document.getElementById('mobileSidebarOverlay').classList.remove('open');
        document.body.style.overflow = '';
    }

    /* ── Mobile sidebar: close via overlay click ─────────────────────── */
    document.getElementById('mobileSidebarOverlay').addEventListener('click', closeMobileSidebar);

    /* ── Mobile sidebar: close via X button ──────────────────────────── */
    document.getElementById('closeMobileSidebar').addEventListener('click', closeMobileSidebar);

    /* ── Mobile sidebar: Documentation link ──────────────────────────── */
    document.getElementById('docLinkMobile').addEventListener('click', (e) => {
        e.preventDefault();
        closeMobileSidebar();
        openDocModal();
    });

    /* ── Mobile sidebar: Material Library link ───────────────────────── */
    document.getElementById('matLibMobileLink').addEventListener('click', (e) => {
        e.preventDefault();
        closeMobileSidebar();
        openMatLibModal();
    });

    /* ── Footer: Documentation link ──────────────────────────────────── */
    document.getElementById('docLinkFooter').addEventListener('click', (e) => {
        e.preventDefault();
        openDocModal();
    });

    /* ── Header nav: Material Library link ───────────────────────────── */
    document.getElementById('matLibraryNavLink').addEventListener('click', (e) => {
        e.preventDefault();
        openMatLibModal();
    });

    /* ── Material Library modal: close buttons ───────────────────────── */
    document.getElementById('closeMatLibModal').addEventListener('click',  closeMatLibModal);
    document.getElementById('closeMatLibModal2').addEventListener('click', closeMatLibModal);
    document.getElementById('matLibBackdrop').addEventListener('click',    closeMatLibModal);

    /* ── Colour picker: update hex preview label live ─────────────────── */
    document.getElementById('cmColor').addEventListener('input', (e) => {
        document.getElementById('cmColorHex').textContent = e.target.value;
    });

    /* ── Add custom material: form submission ─────────────────────────── */
    document.getElementById('cmAddBtn').addEventListener('click', addCustomMaterial);

});

/* =============================================================================
   14. MATERIAL LIBRARY — Modal open/close + custom material CRUD
   ============================================================================= */

/** Open the Material Library modal and populate the built-in table */
function openMatLibModal() {
    populateMatLibBuiltinTable();
    renderCustomMatTable();
    const modal = document.getElementById('matLibModal');
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('open'));
}

/** Close the Material Library modal */
function closeMatLibModal() {
    const modal = document.getElementById('matLibModal');
    modal.classList.remove('open');
    setTimeout(() => modal.classList.add('hidden'), 350);
}

/**
 * Populate the built-in materials table inside the Material Library modal.
 * Reads from MATERIALS; skips custom entries (_custom flag).
 */
function populateMatLibBuiltinTable() {
    const tbody = document.getElementById('matLibBuiltinTable');
    tbody.innerHTML = '';
    Object.entries(MATERIALS).forEach(([, mat]) => {
        if (mat._custom) return;
        const isFormatted = formatIs(mat.Is);
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-white/[0.025] transition-colors';
        tr.innerHTML = `
            <td class="px-4 py-2.5 text-zinc-300">
                <span class="flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full flex-shrink-0"
                          style="background:${mat.color}; box-shadow:0 0 6px ${mat.color}88;"></span>
                    ${mat.name}
                </span>
            </td>
            <td class="px-4 py-2.5 text-right">${mat.Eg.toFixed(2)}</td>
            <td class="px-4 py-2.5 text-right">${isFormatted.val} ${isFormatted.unit}</td>
            <td class="px-4 py-2.5 text-right">${mat.Vcut.toFixed(2)}</td>
            <td class="px-4 py-2.5 text-right">${mat.Vbreak.toFixed(1)}</td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Validate inputs and add a new custom material to the live MATERIALS database.
 * Immediately updates the simulator dropdown so it's selectable right away.
 */
function addCustomMaterial() {
    const errorEl = document.getElementById('cmError');
    errorEl.classList.add('hidden');

    // Read inputs
    const name     = document.getElementById('cmName').value.trim();
    const symbol   = document.getElementById('cmSymbol').value.trim();
    const Eg       = parseFloat(document.getElementById('cmEg').value);
    const Vcut     = parseFloat(document.getElementById('cmVcut').value);
    const Vbreak   = parseFloat(document.getElementById('cmVbreak').value);
    const mantissa = parseFloat(document.getElementById('cmIsMantissa').value);
    const exponent = parseInt(document.getElementById('cmIsExponent').value, 10);
    const color    = document.getElementById('cmColor').value;

    // Validate
    const errors = [];
    if (!name)                                    errors.push('Material name is required.');
    if (!symbol)                                  errors.push('Chemical symbol is required.');
    if (isNaN(Eg)       || Eg       <= 0)         errors.push('Band gap (Eg) must be a positive number.');
    if (isNaN(Vcut)     || Vcut     <  0)         errors.push('Cut-in voltage must be ≥ 0.');
    if (isNaN(Vbreak)   || Vbreak   <= 0)         errors.push('Breakdown voltage must be positive.');
    if (isNaN(mantissa) || mantissa < 1 || mantissa > 9.99)
                                                  errors.push('Is mantissa must be between 1 and 9.99.');
    if (isNaN(exponent) || exponent > -1)         errors.push('Is exponent must be a negative integer (e.g. −12).');

    if (errors.length > 0) {
        errorEl.textContent = errors[0];
        errorEl.classList.remove('hidden');
        return;
    }

    const Is        = mantissa * Math.pow(10, exponent);
    const baseKey   = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const uniqueKey = `custom_${baseKey}_${Date.now()}`;
    const fullName  = `${name} (${symbol}) ★`;   // ★ marks custom entries in dropdown

    // Inject into live MATERIALS object
    MATERIALS[uniqueKey] = { name: fullName, Eg, Is, Vcut, Vbreak, color, _custom: true };

    // Refresh all dependent UI
    populateMaterialSelect();
    populateMaterialTable();
    populateMatLibBuiltinTable();
    renderCustomMatTable();

    // Clear form fields
    ['cmName','cmSymbol','cmEg','cmVcut','cmVbreak','cmIsMantissa','cmIsExponent']
        .forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('cmColor').value            = '#00e5ff';
    document.getElementById('cmColorHex').textContent   = '#00e5ff';

    showToast(`"${name} (${symbol})" added to database ✓`);
}

/**
 * Render the custom materials list table.
 * Shows an empty-state placeholder when the list is empty.
 */
function renderCustomMatTable() {
    const tbody       = document.getElementById('customMatTableBody');
    const wrap        = document.getElementById('customMatTableWrap');
    const empty       = document.getElementById('customMatEmpty');
    const countEl     = document.getElementById('customMatCount');
    const customList  = Object.entries(MATERIALS).filter(([, m]) => m._custom);

    countEl.textContent = `${customList.length} ${customList.length === 1 ? 'entry' : 'entries'}`;

    if (customList.length === 0) {
        empty.classList.remove('hidden');
        wrap.classList.add('hidden');
        return;
    }

    empty.classList.add('hidden');
    wrap.classList.remove('hidden');
    tbody.innerHTML = '';

    customList.forEach(([key, mat]) => {
        const isFormatted = formatIs(mat.Is);
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-white/[0.025] transition-colors';
        tr.innerHTML = `
            <td class="px-4 py-2.5 text-zinc-300">
                <span class="flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full flex-shrink-0"
                          style="background:${mat.color}; box-shadow:0 0 6px ${mat.color}88;"></span>
                    ${mat.name}
                </span>
            </td>
            <td class="px-4 py-2.5 text-right">${mat.Eg.toFixed(2)}</td>
            <td class="px-4 py-2.5 text-right">${isFormatted.val} ${isFormatted.unit}</td>
            <td class="px-4 py-2.5 text-right">${mat.Vcut.toFixed(2)}</td>
            <td class="px-4 py-2.5 text-right">${mat.Vbreak.toFixed(1)}</td>
            <td class="px-4 py-2.5 text-center">
                <button
                    class="text-red-400 hover:text-red-300 transition-colors p-1 hover:bg-red-400/10 rounded"
                    aria-label="Remove ${mat.name}"
                    onclick="removeCustomMaterial('${key}')">
                    <span class="material-symbols-outlined" style="font-size:16px;">delete</span>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Remove a custom material by its MATERIALS key.
 * Reverts simulator to silicon if the removed material was selected.
 * @param {string} key
 */
function removeCustomMaterial(key) {
    if (!MATERIALS[key] || !MATERIALS[key]._custom) return;
    const matName = MATERIALS[key].name;

    if (state.material === key) {
        state.material = DEFAULT_MATERIAL;
        document.getElementById('materialSelect').value = DEFAULT_MATERIAL;
    }

    delete MATERIALS[key];

    populateMaterialSelect();
    populateMaterialTable();
    populateMatLibBuiltinTable();
    renderCustomMatTable();
    updateAll();

    showToast(`Removed "${matName}" ✓`);
}
