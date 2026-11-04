/* =========================================================
   CFE Valles - Frontend (ML backend + OSRM dibujo)
   - Optimización: POST /optimize (multi-start + medoid parking)
   - Front: dibuja orden, 1 parking, caminata de un sentido
   ========================================================= */

/* =========================================================
   1. MAP INITIALIZATION
   ========================================================= */
const map = L.map('map', { preferCanvas: true });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
map.setView([21.9960, -99.0105], 12);
setTimeout(() => map.invalidateSize(), 60);
window.addEventListener('resize', () => map.invalidateSize());

/* =========================================================
   2. CONSTANTS & COLORS
   ========================================================= */
const routeColors = [
    '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00',
    '#a65628', '#f781bf', '#999999', '#66c2a5', '#fc8d62',
    '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'
];

const OSRM_URL = 'https://router.project-osrm.org';
const API_BASE = '';
const MAX_WALK_KM_DEFAULT = 0.12; // 120 m entre RPU = caminata

/* División Golfo Centro — zonas y agencias [lat, lon] */
const DIVISION_GOLFO_CENTRO = {
    DU01: {
        nombre: 'TAMPICO',
        agencias: {
            'Tampico': [22.2331, -97.8611],
            'Ciudad Madero': [22.2767, -97.8361],
            'Altamira': [22.3922, -97.9386],
            'González': [22.8281, -98.4306]
        }
    },
    DU02: {
        nombre: 'MANTE',
        agencias: {
            'Ciudad Mante': [22.7431, -98.9736],
            'Xicoténcatl': [22.9956, -98.9442],
            'Ocampo': [22.8450, -99.3380]
        }
    },
    DU03: {
        nombre: 'VICTORIA',
        agencias: {
            'Ciudad Victoria': [23.7369, -99.1411],
            'Jaumave': [23.4061, -99.3806],
            'Tula': [23.0036, -99.7081]
        }
    },
    DU04: {
        nombre: 'MATEHUALA',
        agencias: {
            'Matehuala': [23.6483, -100.6431],
            'Cedral': [23.8428, -100.7256],
            'Villa de la Paz': [23.6856, -100.7131]
        }
    },
    DU05: {
        nombre: 'SAN LUIS',
        agencias: {
            'San Luis Potosí': [22.1565, -100.9855],
            'Soledad de Graciano Sánchez': [22.1831, -100.9400],
            'Mexquitic': [22.2670, -101.1160],
            'Villa de Reyes': [21.8031, -100.9340]
        }
    },
    DU06: {
        nombre: 'RIOVERDE',
        agencias: {
            'Rioverde': [21.9311, -99.9961],
            'Ciudad Fernández': [21.9406, -100.0117],
            'Cárdenas': [22.0010, -99.6420],
            'Rayón': [21.8440, -99.6430]
        }
    },
    DU07: {
        nombre: 'VALLES',
        agencias: {
            'Ciudad Valles': [21.980566, -98.997984],
            'Santos': [21.5980, -98.9680],   // DU07B · Tancanhuitz de Santos (confirmar coordenadas de la oficina)
            'Xilitla': [21.3865, -98.9900],
            'Tamazunchale': [21.2600, -98.7900],
            'Tamuin': [22.0050, -98.7770],
            'Ébano': [22.0830, -98.3770]
        }
    },
    DU08: {
        nombre: 'HUEJUTLA',
        agencias: {
            'Huejutla': [21.1400, -98.4194],
            'Metepec': [20.2112, -98.3178],
            'Orizatlán': [21.1710, -98.6070],
            'Atlapexco': [21.0160, -98.5070]
        }
    }
};

/** Letra de agencia en la Cuenta (09 DU0 7 A …): sirve para filtrar el Dashboard de productividad */
const AGENCY_CODES = {
    DU07: { 'Ciudad Valles': 'A', 'Santos': 'B', 'Tamazunchale': 'D' }
};
function agencyCode(zona, agencia) {
    const z = AGENCY_CODES[zona || CFE_AGENCY.zona] || {};
    const l = z[agencia || CFE_AGENCY.agencia];
    return l ? (zona || CFE_AGENCY.zona) + l : null;
}
/** DU07B → { zona:'DU07', agencia:'Santos' } */
function agencyFromCode(code) {
    const c = String(code || '').toUpperCase();
    const zona = c.slice(0, 4), letra = c.slice(4, 5);
    const z = AGENCY_CODES[zona] || {};
    const agencia = Object.keys(z).find(k => z[k] === letra);
    return agencia ? { zona, agencia } : null;
}

/** Punto de partida CFE (agencia activa) */
let CFE_START = [21.9960, -99.0105];
let CFE_AGENCY = { zona: 'DU07', zonaNombre: 'VALLES', agencia: 'Ciudad Valles' };
let agencyMarker = null;

function getAgencyCoords(zonaCode, agenciaName) {
    const z = DIVISION_GOLFO_CENTRO[zonaCode];
    if (!z || !z.agencias) return null;
    return z.agencias[agenciaName] || null;
}

function setAgency(zonaCode, agenciaName, opts) {
    opts = opts || {};
    const coords = getAgencyCoords(zonaCode, agenciaName);
    if (!coords) {
        console.warn('Agencia no encontrada', zonaCode, agenciaName);
        return false;
    }
    CFE_START = [coords[0], coords[1]];
    const z = DIVISION_GOLFO_CENTRO[zonaCode];
    CFE_AGENCY = {
        zona: zonaCode,
        zonaNombre: z ? z.nombre : zonaCode,
        agencia: agenciaName
    };
    try { localStorage.setItem('cfe_agency', JSON.stringify(CFE_AGENCY)); } catch (e) { }

    if (typeof map !== 'undefined' && map) {
        if (agencyMarker) {
            try { map.removeLayer(agencyMarker); } catch (e) { }
        }
        agencyMarker = L.marker(CFE_START, {
            icon: L.divIcon({
                className: 'cfe-agency-icon',
                html: '<div style="background:#003087;color:#fff;border:2px solid #fff;border-radius:10px;padding:4px 8px;font-size:11px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap;">🏢 CFE ' + agenciaName + '</div>',
                iconSize: [130, 28],
                iconAnchor: [65, 14]
            }),
            zIndexOffset: 1000,
            title: 'Agencia CFE ' + agenciaName
        }).addTo(map);
        agencyMarker.bindPopup(
            '<b>Agencia CFE</b><br/>' +
            (z ? z.nombre : zonaCode) + ' · ' + agenciaName +
            '<br/><small>' + CFE_START[0].toFixed(5) + ', ' + CFE_START[1].toFixed(5) + '</small>'
        );
        if (opts.fly !== false) {
            map.setView(CFE_START, opts.zoom || 13, { animate: true });
        }
        setTimeout(() => map.invalidateSize(), 80);
    }

    const lbl = document.getElementById('agencyLabel');
    if (lbl) {
        lbl.textContent = (z ? z.nombre : zonaCode) + ' · ' + agenciaName;
    }
    console.log('🏢 Agencia activa:', CFE_AGENCY, CFE_START);
    return true;
}

/** Llena #selZona y #selAgencia del HTML (no crea el recuadro) */
function buildAgencySelectors() {
    const selZona = document.getElementById('selZona');
    const selAgencia = document.getElementById('selAgencia');
    if (!selZona || !selAgencia) {
        console.warn('Faltan #selZona / #selAgencia en el HTML');
        return;
    }

    function fillAgencias(zonaCode) {
        const z = DIVISION_GOLFO_CENTRO[zonaCode];
        selAgencia.innerHTML = '';
        if (!z) return;
        Object.keys(z.agencias).forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            selAgencia.appendChild(opt);
        });
    }

    selZona.innerHTML = '';
    Object.keys(DIVISION_GOLFO_CENTRO).forEach(code => {
        const z = DIVISION_GOLFO_CENTRO[code];
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = code + ' - ' + z.nombre;
        selZona.appendChild(opt);
    });

    selZona.onchange = () => {
        fillAgencias(selZona.value);
        if (selAgencia.options.length) setAgency(selZona.value, selAgencia.value);
    };
    selAgencia.onchange = () => {
        setAgency(selZona.value, selAgencia.value);
    };

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('cfe_agency') || 'null'); } catch (e) { }
    const zona0 = (saved && DIVISION_GOLFO_CENTRO[saved.zona]) ? saved.zona : 'DU07';
    selZona.value = zona0;
    fillAgencias(zona0);
    const agencias = DIVISION_GOLFO_CENTRO[zona0].agencias;
    const ag0 = (saved && agencias[saved.agencia]) ? saved.agencia : Object.keys(agencias)[0];
    selAgencia.value = ag0;
    setAgency(zona0, ag0, { fly: true, zoom: 13 });

    const btnProd = document.getElementById('btnVerProductividad');
    if (btnProd) {
        btnProd.onclick = () => {
            const code = agencyCode(selZona.value, selAgencia.value);
            const url = 'dashboard.html' + (code ? '?zona=' + encodeURIComponent(code) : '');
            window.open(url, '_blank', 'noopener');
        };
    }
}

/** Cambia los selectores a la agencia del archivo (según la Cuenta) sin mover el mapa. */
function syncAgencyFromCode(code) {
    const a = agencyFromCode(code);
    if (!a || (a.zona === CFE_AGENCY.zona && a.agencia === CFE_AGENCY.agencia)) return false;
    const selZona = document.getElementById('selZona');
    const selAgencia = document.getElementById('selAgencia');
    if (selZona && selZona.value !== a.zona) { selZona.value = a.zona; if (selZona.onchange) selZona.onchange(); }
    if (selAgencia) selAgencia.value = a.agencia;
    setAgency(a.zona, a.agencia, { fly: false });
    return true;
}

/* =========================================================
   3. DOM ELEMENTS
   ========================================================= */
const fileInput = document.getElementById('fileInput');
const legendEl = document.getElementById('legend');
const filtersEl = document.getElementById('filters');
const qEl = document.getElementById('q');
const qMedEl = document.getElementById('qMedidor');
const btnMedGo = document.getElementById('btnMedidorGo');
const btnClear = document.getElementById('btnClear');
const btnClearMap = document.getElementById('btnClearMap');
const btnResetView = document.getElementById('btnResetView');
const btnToggleAll = document.getElementById('btnToggleAll');
const countEl = document.getElementById('count');
const dropsEl = document.getElementById('drops');

const dwellEl = document.getElementById('dwell');
const walkDefaultEl = document.getElementById('walkDefault');
const walkSpeedEl = document.getElementById('walkSpeed');
const btnBuildTrips = document.getElementById('btnBuildTrips');
const btnTripsCSV = document.getElementById('btnExportTripsCSV');
const btnTripsGJ = document.getElementById('btnExportTripsGJ');
const btnExportPDF = document.getElementById('btnExportPDF');
const btnReportPDF = document.getElementById('btnReportPDF');
const btnStartGPSNavigation = document.getElementById('btnStartGPSNavigation');
const summaryTrips = document.getElementById('summaryTrips');
const daysPanel = document.getElementById('daysPanel');
const decisionPanel = document.getElementById('decisionPanel');
const breakdownPanel = document.getElementById('breakdownPanel');

const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statsEl = document.getElementById('stats');
const etaCanvas = document.getElementById('etaCanvas');
const ctx = etaCanvas ? etaCanvas.getContext('2d') : null;

const concurrencyEl = document.getElementById('concurrency');
const btnClearCache = document.getElementById('btnClearCache');
const osrmStatus = document.getElementById('osrmStatus');

/** Etiqueta legible del origen del orden (no nombres técnicos) */
function friendlyOrderLabel(src) {
    if (!src) return 'Propuesta del sistema';
    const s = String(src);
    if (s.includes('hist:') || s.startsWith('multistart:hist')) {
        const m = s.match(/Detallado[^|\s]*/i);
        return m ? `Orden de un ciclo anterior (${m[0]})` : 'Orden de un ciclo histórico de esta ruta';
    }
    if (s.includes('geographic')) return 'Orden geográfico (por ubicación)';
    if (s.includes('serpentine')) return 'Orden en zigzag por franjas';
    if (s.includes('zones')) return 'Orden por zonas';
    if (s.includes('clusters')) return 'Orden por conjuntos (grupos cercanos)';
    if (s.includes('nn_')) return 'Vecino más cercano';
    if (s.startsWith('multistart:')) return friendlyOrderLabel(s.slice('multistart:'.length));
    return s;
}

/** Rellena el panel “Cómo se eligió esta ruta” (colapsable) */

/* Estilo chevron de paneles colapsables (una sola vez) */
(function ensureCollapsibleCss() {
    if (document.getElementById('cfe-collapsible-css')) return;
    const s = document.createElement('style');
    s.id = 'cfe-collapsible-css';
    s.textContent = `
      details.cfe-collapsible > summary::-webkit-details-marker { display: none; }
      details.cfe-collapsible > summary { outline: none; }
      details.cfe-collapsible[open] > summary .cfe-chevron { transform: rotate(180deg); }
      details.cfe-collapsible > summary:hover { background: rgba(31,91,81,0.06); }
    `;
    document.head.appendChild(s);
})();

function renderDecisionPanel(result) {
    const el = decisionPanel || document.getElementById('decisionPanel');
    if (!el) return;
    const d = result && result.decision;
    if (!d) {
        el.innerHTML = '';
        el.style.display = 'none';
        return;
    }
    el.style.display = 'block';
    const cands = Array.isArray(d.candidates) ? d.candidates : [];
    const rows = cands.map(c => {
        const win = c.is_winner ? 'font-weight:700;background:#ecfdf5;' : '';
        const mark = c.is_winner ? '✓ ' : '';
        return `<tr style="${win}">
            <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${mark}${c.label || c.id}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;">${c.minutes != null ? c.minutes + ' min' : '—'}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;">${c.jumps_over_80m != null ? c.jumps_over_80m : '—'}</td>
        </tr>`;
    }).join('');
    const criteria = (d.criteria || []).map(x => `<li style="margin:4px 0;">${x}</li>`).join('');
    const winShort = d.winner_label || friendlyOrderLabel(d.winner) || 'Propuesta del sistema';
    // ¿De dónde sale la diferencia? (propuesta vs el mes más rápido de la ruta)
    const savings = Array.isArray(d.savings) ? d.savings : [];
    const savingsHtml = savings.length ? `
          <div style="font-size:0.8rem;color:#64748b;margin:8px 0 4px;">¿De dónde sale la diferencia?</div>
          <ul style="margin:0 0 10px 18px;padding:0;font-size:0.8rem;color:#334155;line-height:1.45;">
            ${savings.map(x => `<li style="margin:3px 0;">${x}</li>`).join('')}
          </ul>` : '';
    // Historial de la ruta: todos los meses (agrupados por ruta, no por tarea)
    const hist = Array.isArray(d.route_history) ? d.route_history : [];
    const fmtv = v => (v === null || v === undefined || v === '') ? '—' : v;
    const tdR = 'padding:5px 6px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;';
    const histRows = hist.map(h => {
        const who = String(h.lecturista || '').replace(/"/g, '');
        const extra = (h.vs_mejor_min && h.vs_mejor_min > 0) ? ` <span style="color:#b45309;">(+${h.vs_mejor_min})</span>` : '';
        return `<tr title="${who}" style="${h.es_base ? 'background:#fff7ed;font-weight:600;' : ''}">
            <td style="padding:5px 6px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">${h.es_base ? '★ ' : ''}${fmtv(h.mes)}${h.tarea ? ' · ' + h.tarea : ''}</td>
            <td style="${tdR}">${fmtv(h.real_total_min)}</td>
            <td style="${tdR}">${h.pausas_n != null ? h.pausas_n + ' / ' + fmtv(h.pausas_min) : '—'}</td>
            <td style="${tdR}">${fmtv(h.real_sin_pausas_min)}${extra}</td>
            <td style="${tdR}">${fmtv(h.orden_con_modelo_min)}</td>
            <td style="${tdR}">${fmtv(h.km)}</td>
            <td style="${tdR}">${fmtv(h.anomalias)}</td>
        </tr>`;
    }).join('');
    const histHtml = histRows ? `
          <div style="font-size:0.8rem;color:#64748b;margin:10px 0 4px;">
            Historial de la ruta ${d.ruta_id || ''} <span style="font-size:0.74rem;">(★ = mes usado como base)</span>
          </div>
          <div style="overflow-x:auto;margin-bottom:6px;">
          <table style="width:100%;border-collapse:collapse;font-size:0.76rem;">
            <thead>
              <tr style="background:#eef6f3;color:#1F5B51;">
                <th style="text-align:left;padding:5px 6px;">Mes · tarea</th>
                <th style="text-align:right;padding:5px 6px;">Total real</th>
                <th style="text-align:right;padding:5px 6px;">Pausas n/min</th>
                <th style="text-align:right;padding:5px 6px;">Sin pausas</th>
                <th style="text-align:right;padding:5px 6px;">Orden (modelo)</th>
                <th style="text-align:right;padding:5px 6px;">Km</th>
                <th style="text-align:right;padding:5px 6px;" title="Anomalías">Anom.</th>
              </tr>
            </thead>
            <tbody>${histRows}</tbody>
          </table>
          </div>
          <div style="font-size:0.72rem;color:#64748b;margin-bottom:10px;line-height:1.4;">
            Minutos reales del Detallado. "Orden (modelo)" = cuánto tardaría hoy ese mismo orden según el modelo,
            sin contar al lecturista, el clima ni las pausas: sirve para comparar órdenes entre sí.
          </div>` : '';
    const warns = Array.isArray(d.warnings) ? d.warnings : [];
    const warnHtml = warns.length ? warns.map(w => `
      <div style="margin-top:12px;padding:10px 14px;border-radius:12px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:0.82rem;line-height:1.45;">${w}</div>`).join('') : '';
    el.innerHTML = warnHtml + `
      <details class="cfe-collapsible" style="margin-top:12px;border-radius:14px;border:1px solid #cce3dc;background:linear-gradient(180deg,#f6fbf9,#fff);box-shadow:0 1px 3px rgba(0,0,0,.06);overflow:hidden;">
        <summary style="list-style:none;cursor:pointer;padding:12px 16px;font-weight:700;color:#1F5B51;font-size:0.95rem;display:flex;align-items:center;justify-content:space-between;gap:8px;user-select:none;">
          <span style="display:flex;align-items:center;gap:8px;">
            <span aria-hidden="true">📋</span>
            <span>¿Cómo se eligió esta ruta?</span>
          </span>
          <span class="cfe-chevron" style="font-size:0.75rem;color:#64748b;transition:transform .2s;">▼</span>
        </summary>
        <div style="padding:0 16px 14px 16px;border-top:1px solid #e2e8f0;">
          ${result.poblacion ? `<div style="margin:10px 0 0;">${poblacionBadgeHtml(result.poblacion)}</div>` : ''}
          <div style="font-size:0.88rem;color:#334155;line-height:1.45;margin:10px 0;">
            <strong>Ganó:</strong> ${winShort}
          </div>
          <div style="font-size:0.84rem;color:#475569;line-height:1.5;margin-bottom:12px;">
            ${d.reason || ''}
          </div>
          ${rows ? `
          <div style="font-size:0.8rem;color:#64748b;margin-bottom:4px;">Opciones comparadas (lectura estimada)</div>
          <table style="width:100%;border-collapse:collapse;font-size:0.8rem;margin-bottom:10px;">
            <thead>
              <tr style="background:#eef6f3;color:#1F5B51;">
                <th style="text-align:left;padding:6px 8px;">Opción</th>
                <th style="text-align:right;padding:6px 8px;">Min</th>
                <th style="text-align:right;padding:6px 8px;">Saltos largos</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>` : ''}
          ${savingsHtml}
          ${histHtml}
          ${criteria ? `<div style="font-size:0.78rem;color:#64748b;"><strong>Criterios:</strong><ul style="margin:4px 0 0 18px;padding:0;">${criteria}</ul></div>` : ''}
        </div>
      </details>`;
}


/** Panel territorio: área, densidad, clusters (pasos A–B del asesor) */
function renderSpatialPanel(result) {
    let el = document.getElementById('spatialPanel');
    if (!el) {
        // insertar después de decisionPanel si existe
        const dec = document.getElementById('decisionPanel');
        el = document.createElement('div');
        el.id = 'spatialPanel';
        if (dec && dec.parentNode) {
            dec.parentNode.insertBefore(el, dec.nextSibling);
        } else if (breakdownPanel && breakdownPanel.parentNode) {
            breakdownPanel.parentNode.insertBefore(el, breakdownPanel);
        } else {
            return;
        }
    }
    const s = result && result.spatial;
    if (!s || !s.n_rpu) {
        el.innerHTML = '';
        el.style.display = 'none';
        return;
    }
    el.style.display = 'block';
    const dens = s.density_per_km2 != null ? Number(s.density_per_km2).toFixed(1) : '—';
    const area = s.area_km2 != null ? Number(s.area_km2).toFixed(3) : '—';
    const gapM = s.avg_gap_m != null ? Math.round(s.avg_gap_m) : '—';
    const gapS = s.avg_gap_sec != null ? Math.round(s.avg_gap_sec) : '—';
    const nCl = s.n_clusters != null ? s.n_clusters : '—';
    const thr = s.cluster_threshold_m != null ? s.cluster_threshold_m : '—';
    const nVeh = s.n_vehicle_gaps != null ? s.n_vehicle_gaps : 0;
    const hint = s.profile_hint || result.perfil || '';
    const medNn = s.median_nn_m != null ? Number(s.median_nn_m).toFixed(1) : '—';

    el.innerHTML = `
      <details class="cfe-collapsible" open style="margin-top:10px;border-radius:14px;border:1px solid #d4e8e2;background:linear-gradient(145deg,#f7fcfa,#fff);overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05);">
        <summary style="list-style:none;cursor:pointer;padding:12px 16px;font-weight:700;color:#1F5B51;font-size:0.95rem;display:flex;align-items:center;justify-content:space-between;gap:8px;user-select:none;">
          <span style="display:flex;align-items:center;gap:8px;">
            <span aria-hidden="true">📐</span>
            <span>Territorio y densidad de la ruta</span>
          </span>
          <span class="cfe-chevron" style="transition:transform .2s;color:#64748b;font-size:0.75rem;">▼</span>
        </summary>
        <div style="padding:0 16px 14px 16px;border-top:1px solid #e2e8f0;font-size:0.84rem;color:#334155;line-height:1.55;">
          <div style="margin:10px 0 6px;">
            <strong>Área del contorno:</strong> ${area} km²
            &nbsp;·&nbsp; <strong>Densidad:</strong> ${dens} medidores/km²
          </div>
          <div style="margin:6px 0;">
            <strong>Conjuntos</strong> (medidores a ≤ ${thr} m): <strong>${nCl}</strong>
            &nbsp;·&nbsp; Vecino más cercano (mediana): ${medNn} m
          </div>
          <div style="margin:6px 0;">
            Distancia media entre conjuntos: <strong>${gapM} m</strong>
            (~${gapS} s caminando a 3.5 km/h)
          </div>
          <div style="margin:6px 0;color:#475569;">
            Perfil sugerido por densidad: <strong>${hint}</strong>
            ${nVeh > 0 ? ` · <span style="color:#b45309;">${nVeh} tramos largos entre conjuntos (posible vehículo)</span>` : ''}
          </div>
          <div style="margin-top:8px;font-size:0.78rem;color:#64748b;">
            En zonas densas el lecturista trabaja por bloques; entre bloques se camina o se mueve el vehículo según la distancia.
          </div>
        </div>
      </details>`;
}

/** Dibuja tramos entre conjuntos (vehículo) en el mapa */
function drawInterClusterEdges(result, nodes) {
    if (window._clusterEdgeLayer) {
        try { map.removeLayer(window._clusterEdgeLayer); } catch (e) {}
        window._clusterEdgeLayer = null;
    }
    const edges = result && result.spatial && result.spatial.inter_cluster_edges;
    if (!edges || !edges.length || !nodes || !nodes.length) return;
    const layer = L.layerGroup();
    edges.forEach(e => {
        const a = nodes[e.from_idx];
        const b = nodes[e.to_idx];
        if (!a || !b) return;
        const latlngs = [[a.lat, a.lon], [b.lat, b.lon]];
        L.polyline(latlngs, {
            color: '#b45309',
            weight: 3,
            opacity: 0.75,
            dashArray: '8 6',
            lineCap: 'round',
        }).bindPopup(
            `Tramo entre conjuntos<br/>${Math.round(e.dist_m)} m · posible vehículo`
        ).addTo(layer);
    });
    layer.addTo(map);
    window._clusterEdgeLayer = layer;
}

/** Desglose de distancias y tiempos (colapsable) */
function renderBreakdownPanel(trips) {
    const el = breakdownPanel || document.getElementById('breakdownPanel');
    if (!el || !trips || !trips.length) {
        if (el) { el.innerHTML = ''; el.style.display = 'none'; }
        return;
    }
    const lec = trips.reduce((s, t) => s + (t.lecturaMin != null ? t.lecturaMin : t.timeMin || 0), 0);
    const cfe = trips.reduce((s, t) => s + (t.trasladoCfeMin || 0), 0);
    const totalMin = trips.reduce((s, t) => s + (t.timeMin || 0), 0);
    const walkKm = trips.reduce((s, t) => s + (t.walkKm2Total || 0), 0);
    const vehKm = trips.reduce((s, t) => s + (t.distKm || 0), 0);
    el.style.display = 'block';
    el.innerHTML = `
      <details class="cfe-collapsible" style="margin-top:10px;border-radius:14px;border:1px solid #e2e8f0;background:#fff;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05);">
        <summary style="list-style:none;cursor:pointer;padding:12px 16px;font-weight:700;color:#0f172a;font-size:0.95rem;display:flex;align-items:center;justify-content:space-between;gap:8px;user-select:none;">
          <span style="display:flex;align-items:center;gap:8px;">
            <span aria-hidden="true">ℹ️</span>
            <span>Más información sobre estos números</span>
          </span>
          <span class="cfe-chevron" style="font-size:0.75rem;color:#64748b;transition:transform .2s;">▼</span>
        </summary>
        <div style="padding:0 16px 14px 16px;border-top:1px solid #e2e8f0;font-size:0.86rem;color:#334155;line-height:1.5;">
          <div style="margin:10px 0 8px;">
            <strong style="color:#1d4ed8;">🚗 Kilómetros en vehículo (${vehKm.toFixed(1)} km)</strong><br/>
            Incluyen sobre todo la <strong>ida y el regreso entre la oficina CFE y el punto donde se deja la camioneta (parking)</strong>.
            No significa que el lecturista recorra toda la ruta manejando entre cada medidor.
          </div>
          <div style="margin-bottom:8px;">
            <strong style="color:#047857;">🚶 Kilómetros a pie (${walkKm.toFixed(2)} km)</strong><br/>
            Es el recorrido caminando <strong>entre medidores</strong>, a partir del parking, siguiendo el orden de visita propuesto.
          </div>
          <div style="margin-bottom:8px;">
            <strong style="color:#b45309;">📖 Tiempo de lectura (~${lec.toFixed(0)} min)</strong><br/>
            Estimación de atender los servicios (modelo + historial). Es la parte “de campo” en la colonia.
          </div>
          <div style="margin-bottom:8px;">
            <strong style="color:#7c3aed;">🏢 Traslado CFE (~${cfe.toFixed(0)} min)</strong><br/>
            Tiempo orientativo de ir/volver respecto a la oficina o tramos en vehículo ligados a CFE ↔ parking.
          </div>
          <div>
            <strong>⏱️ Total orientativo (~${totalMin.toFixed(0)} min)</strong> = lectura + traslado CFE.
            Sirve para planear el día; <em>no</em> es el registro oficial de productividad.
          </div>
        </div>
      </details>`;
}




/* =========================================================
   PARKING ELEGIDO POR EL LECTURISTA
   ========================================================= */
window.parkingMode = 'auto';       // 'auto' | 'user'
window.userParking = null;         // { lat, lon, rpu, id, medidor }
window._userParkingMarker = null;
window._pickParkingActive = false;

function clearUserParkingMarker() {
    if (window._userParkingMarker && typeof map !== 'undefined') {
        try { map.removeLayer(window._userParkingMarker); } catch (e) {}
    }
    window._userParkingMarker = null;
}

function setUserParkingFromNode(node, props) {
    if (!node || !isFinite(node.lat) || !isFinite(node.lon)) return;
    const rpu = (props && (props.Rpu || props.rpu)) || node.rpu || null;
    const med = (props && (props.CodigoMedidor || props.Medidor)) || null;
    window.userParking = {
        lat: node.lat,
        lon: node.lon,
        rpu: rpu ? String(rpu).trim() : null,
        medidor: med ? String(med).trim() : null,
        id: node.id != null ? node.id : null
    };
    clearUserParkingMarker();
    window._userParkingMarker = L.marker([node.lat, node.lon], {
        icon: L.divIcon({
            className: 'cfe-user-parking',
            html: '<div style="background:#1d4ed8;color:#fff;border:2px solid #fff;border-radius:12px;padding:5px 10px;font-size:12px;font-weight:800;box-shadow:0 2px 10px rgba(0,0,0,.4);white-space:nowrap;">🅿️ Mi parking</div>',
            iconSize: [110, 30],
            iconAnchor: [55, 15]
        }),
        zIndexOffset: 2000
    }).addTo(map);
    const lab = window.userParking.rpu || window.userParking.medidor || 'punto elegido';
    window._userParkingMarker.bindPopup(
        '<b>Parking elegido</b><br/>RPU: ' + (window.userParking.rpu || '—') +
        (window.userParking.medidor ? '<br/>Medidor: ' + window.userParking.medidor : '') +
        '<br/><small>' + node.lat.toFixed(5) + ', ' + node.lon.toFixed(5) + '</small>'
    );
    updateParkingPanelUI();
    console.log('🅿️ Parking usuario:', window.userParking);
}

function updateParkingPanelUI() {
    const modeAuto = document.getElementById('parkModeAuto');
    const modeUser = document.getElementById('parkModeUser');
    const info = document.getElementById('parkUserInfo');
    const hint = document.getElementById('parkPickHint');
    if (modeAuto) modeAuto.checked = window.parkingMode === 'auto';
    if (modeUser) modeUser.checked = window.parkingMode === 'user';
    if (hint) {
        hint.style.display = (window.parkingMode === 'user' && !window.userParking) ? 'block' : 'none';
    }
    if (info) {
        if (window.userParking) {
            info.innerHTML = '<strong>Elegido:</strong> RPU ' +
                (window.userParking.rpu || '—') +
                (window.userParking.medidor ? ' · Medidor ' + window.userParking.medidor : '') +
                '<br/><span style="color:#64748b;font-size:0.78rem;">Clic en otro medidor para cambiar</span>';
        } else {
            info.innerHTML = window.parkingMode === 'user'
                ? '<span style="color:#b45309;">Aún no has elegido un punto — haz clic en un círculo de color del mapa</span>'
                : '<span style="color:#64748b;">El sistema calculará el punto óptimo (medoid)</span>';
        }
    }
    // Al elegir parking: soltar clusters para ver cada medidor
    try {
        setMarkersUnclustered(window.parkingMode === 'user' && window._pickParkingActive);
    } catch (e) {}
    try {
        if (window.parkingMode === 'user' && window._pickParkingActive) {
            map.getContainer().style.cursor = 'crosshair';
        } else {
            map.getContainer().style.cursor = '';
        }
    } catch (e) {}
}

function renderParkingPanel() {
    let el = document.getElementById('parkingPanel');
    if (!el) {
        const after = document.getElementById('spatialPanel') ||
            document.getElementById('decisionPanel') ||
            document.getElementById('breakdownPanel');
        el = document.createElement('div');
        el.id = 'parkingPanel';
        if (after && after.parentNode) {
            after.parentNode.insertBefore(el, after.nextSibling);
        } else {
            return;
        }
    }
    el.style.display = 'block';
    el.innerHTML = `
      <details class="cfe-collapsible" open style="margin-top:10px;border-radius:14px;border:1px solid #dbeafe;background:linear-gradient(145deg,#eff6ff,#fff);overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05);">
        <summary style="list-style:none;cursor:pointer;padding:12px 16px;font-weight:700;color:#1e40af;font-size:0.95rem;display:flex;align-items:center;justify-content:space-between;gap:8px;user-select:none;">
          <span style="display:flex;align-items:center;gap:8px;">
            <span aria-hidden="true">🅿️</span>
            <span>Punto de camioneta (parking)</span>
          </span>
          <span class="cfe-chevron" style="transition:transform .2s;color:#64748b;font-size:0.75rem;">▼</span>
        </summary>
        <div style="padding:0 16px 14px 16px;border-top:1px solid #e2e8f0;font-size:0.84rem;color:#334155;line-height:1.5;">
          <p style="margin:10px 0 8px;color:#475569;">
            Elige cómo se define el punto donde se deja el vehículo y desde ahí se arma la ruta.
          </p>
          <label style="display:flex;align-items:flex-start;gap:8px;margin:8px 0;cursor:pointer;">
            <input type="radio" name="parkMode" id="parkModeAuto" value="auto" style="margin-top:3px;">
            <span><strong>Sistema recomienda</strong><br/>
            <span style="color:#64748b;font-size:0.8rem;">Calcula el punto central (medoid) y ancla inicio/fin ahí.</span></span>
          </label>
          <label style="display:flex;align-items:flex-start;gap:8px;margin:8px 0;cursor:pointer;">
            <input type="radio" name="parkMode" id="parkModeUser" value="user" style="margin-top:3px;">
            <span><strong>Yo elijo en el mapa</strong><br/>
            <span style="color:#64748b;font-size:0.8rem;">Haz clic en un medidor; la ruta empezará y terminará cerca de ese punto.</span></span>
          </label>
          <div id="parkPickHint" style="display:none;margin:8px 0;padding:8px 10px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:0.82rem;">
            👆 Se muestran todos los medidores sueltos. Haz <strong>clic en un círculo de color</strong> (no en las bolas verdes). Zoom si hace falta.
          </div>
          <div id="parkUserInfo" style="margin:8px 0;padding:8px 10px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;"></div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
            <button type="button" id="btnClearUserPark" style="padding:8px 12px;border-radius:10px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:0.82rem;">
              Quitar mi parking
            </button>
            <button type="button" id="btnOptimizeWithPark" style="padding:8px 12px;border-radius:10px;border:none;background:#1d4ed8;color:#fff;cursor:pointer;font-size:0.82rem;font-weight:600;">
              Generar ruta con esta opción
            </button>
          </div>
        </div>
      </details>`;

    const auto = document.getElementById('parkModeAuto');
    const user = document.getElementById('parkModeUser');
    if (auto) {
        auto.onchange = () => {
            if (auto.checked) {
                window.parkingMode = 'auto';
                window._pickParkingActive = false;
                updateParkingPanelUI();
            }
        };
    }
    if (user) {
        user.onchange = () => {
            if (user.checked) {
                window.parkingMode = 'user';
                window._pickParkingActive = true;
                updateParkingPanelUI();
            }
        };
    }
    const btnClear = document.getElementById('btnClearUserPark');
    if (btnClear) {
        btnClear.onclick = () => {
            window.userParking = null;
            clearUserParkingMarker();
            updateParkingPanelUI();
        };
    }
    const btnOpt = document.getElementById('btnOptimizeWithPark');
    if (btnOpt && btnBuildTrips) {
        btnOpt.onclick = () => {
            if (window.parkingMode === 'user' && !window.userParking) {
                alert('Primero haz clic en un medidor del mapa para elegir el parking.');
                return;
            }
            btnBuildTrips.click();
        };
    }
    updateParkingPanelUI();
}

/** Adjunta clic a un marker de servicio para elegir parking */
function attachParkingClick(marker, nodeLike, props) {
    if (!marker) return;
    marker.on('click', function (e) {
        if (window.parkingMode !== 'user' || !window._pickParkingActive) return;
        if (e && e.originalEvent) {
            try { L.DomEvent.stopPropagation(e); } catch (err) {}
        }
        const lat = marker.getLatLng().lat;
        const lon = marker.getLatLng().lng;
        setUserParkingFromNode({
            lat: lat,
            lon: lon,
            rpu: (props && props.Rpu) || null,
            id: marker.__id
        }, props || marker.__props || {});
    });
}


/* =========================================================
   4. STATE
   ========================================================= */
const markers = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnEveryZoom: true,
    spiderfyDistanceMultiplier: 1.5,
    removeOutsideVisibleBounds: true,
    chunkedLoading: true,
    maxClusterRadius: 80
});
map.addLayer(markers);

/** Capa alternativa: medidores uno por uno (sin bolas verdes) */
const markersLoose = L.layerGroup();
let _markersAreLoose = false;

/**
 * true  → quita el cluster y pinta cada medidor suelto (para elegir parking)
 * false → vuelve al agrupamiento normal
 */
function setMarkersUnclustered(on) {
    try {
        on = !!on;
        _markersAreLoose = on;

        if (on) {
            // Ocultar clusters; dibujar pines grandes clicables (no reutilizar markers del cluster)
            if (map.hasLayer(markers)) map.removeLayer(markers);
            markersLoose.clearLayers();

            allMarkers.forEach(function (m, idx) {
                const ll = m.getLatLng();
                const props = m.__props || {};
                const color = getColor(props.Anomalia || m.__anom || '');
                const pin = L.marker(ll, {
                    icon: makeServicePin(color),
                    zIndexOffset: 500
                });
                pin.__anom = m.__anom;
                pin.__text = m.__text;
                pin.__props = props;
                pin.__medcode = m.__medcode;
                pin.__id = m.__id != null ? m.__id : idx;
                pin.__lat = ll.lat;
                pin.__lon = ll.lng;
                pin.__rpu = m.__rpu || props.Rpu || '';
                pin.__srcMarker = m;

                pin.on('click', function (e) {
                    if (window.parkingMode !== 'user' || !window._pickParkingActive) return;
                    try { L.DomEvent.stopPropagation(e); } catch (err) {}
                    setUserParkingFromNode({
                        lat: ll.lat,
                        lon: ll.lng,
                        rpu: pin.__rpu,
                        id: pin.__id
                    }, props);
                });

                // Popup breve al pasar / clic
                const rpu = props.Rpu || pin.__rpu || '—';
                const med = props.CodigoMedidor || props.Medidor || '';
                pin.bindPopup(
                    '<b>Medidor</b><br/>RPU: ' + rpu +
                    (med ? '<br/>Medidor: ' + med : '') +
                    (props.Anomalia ? '<br/>Anomalía: ' + props.Anomalia : '') +
                    '<br/><small>Clic para usar como parking</small>'
                );

                markersLoose.addLayer(pin);
            });

            if (!map.hasLayer(markersLoose)) map.addLayer(markersLoose);

            try {
                if (allMarkers.length) {
                    const b = L.latLngBounds(allMarkers.map(function (m) { return m.getLatLng(); }));
                    if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 17 });
                }
            } catch (e) {}
            console.log('📍 Pines de servicio visibles (' + allMarkers.length + ') — haz clic para parking');
        } else {
            if (map.hasLayer(markersLoose)) map.removeLayer(markersLoose);
            markersLoose.clearLayers();
            // Restaurar iconos normales en allMarkers y cluster
            allMarkers.forEach(function (m) {
                try {
                    const c = getColor((m.__props && m.__props.Anomalia) || m.__anom || '');
                    m.setIcon(makeDot(c));
                } catch (e) {}
            });
            markers.clearLayers();
            if (allMarkers.length) markers.addLayers(allMarkers);
            if (!map.hasLayer(markers)) map.addLayer(markers);
            console.log('📍 Agrupamiento reactivado');
        }
        setTimeout(function () { try { map.invalidateSize(); } catch (e) {} }, 80);
    } catch (e) {
        console.warn('setMarkersUnclustered:', e);
    }
}

/** Tras filtrar / cargar archivo: respeta si estamos en modo parking suelto */

/** Tras dibujar la ruta optimizada: ocultar pines/clusters base y dejar solo círculos numerados */
function hideBaseMarkersForRouteView() {
    try {
        if (map.hasLayer(markersLoose)) map.removeLayer(markersLoose);
        markersLoose.clearLayers();
        if (map.hasLayer(markers)) map.removeLayer(markers);
        _markersAreLoose = false;
        // Conservar "Mi parking" si existe
        if (window._userParkingMarker && !map.hasLayer(window._userParkingMarker)) {
            window._userParkingMarker.addTo(map);
        }
        console.log('📍 Vista ruta: círculos numerados (pines de selección ocultos)');
    } catch (e) {
        console.warn('hideBaseMarkersForRouteView', e);
    }
}

function refreshMarkersDisplay() {
    if (_markersAreLoose) {
        // Rebuild completo de pines filtrados
        setMarkersUnclustered(true);
    }
}

function getAllowedAnoms() {
    try {
        if (!filtersEl) return null;
        return new Set(
            Array.from(filtersEl.querySelectorAll('input[type="checkbox"]'))
                .filter(cb => cb.checked)
                .map(cb => cb.getAttribute('data-anom') || '')
        );
    } catch (e) {
        return null;
    }
}

let allMarkers = [];
let anomalies = new Set();

const tripLayers = new Map();
let liveLayer = null;
const walkLayers = new Map();

const osrmCacheMem = new Map();
const stats = {
    edgeCalls: 0, polylineCalls: 0, tableCalls: 0,
    memHits: 0, lsHits: 0, fallbacks: 0
};

const prog = { total: 0, done: 0, t0: 0, etaHist: [] };

let MAX_CONCURRENCY = 8;
let running = 0;
const queue = [];
let isPaused = false;

/* =========================================================
   5. UTILITY FUNCTIONS
   ========================================================= */
function lsGet(k) {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); }
    catch (e) { return null; }
}

function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { }
}

function edgeKey(a, b) {
    const r6 = x => Number(x).toFixed(6);
    return `${r6(a[1])},${r6(a[0])}|${r6(b[1])},${r6(b[0])}`;
}

function haversineKm(a, b) {
    const R = 6371.0088;
    const toRad = x => x * Math.PI / 180;
    const [lat1, lon1] = a, [lat2, lon2] = b;
    const dphi = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
    const p1 = toRad(lat1), p2 = toRad(lat2);
    const s = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function fmt(ms) {
    if (!isFinite(ms) || ms <= 0) return '…';
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60), ss = s % 60;
    return `${m}:${(ss < 10 ? '0' : '') + ss}`;
}

function getColor(anomRaw) {
    const a = (anomRaw || '').toString().trim().toUpperCase();
    if (!a || a === '-' || a === '—') return '#1f78b4';
    if (a.includes('SERVICIO SIN USO')) return '#e41a1c';
    if (a.includes('NO HAY MEDIDOR')) return '#7f7f7f';
    if (a.includes('CASA CERRADA')) return '#ff7f00';
    if (a.includes('COMUNICACION INTERRUMPIDA')) return '#6a3d9a';
    if (a.includes('ERROR AL INTERROGAR')) return '#e377c2';
    if (a.includes('FUERA DE RUTA')) return '#a6cee3';
    if (a.includes('RUTA INCOMPLETA')) return '#fb9a99';
    if (a.includes('P. INFRARROJO') || a.includes('MED. DANADO') || a.includes('MEDIDOR DANADO')) return '#b15928';
    return '#2ca02c';
}

function makeDot(color) {
    // Icono autosuficiente (no depende de styles.css)
    const c = color || '#2563eb';
    return L.divIcon({
        className: 'cfe-svc-dot',
        html: `<div style="
            width:14px;height:14px;border-radius:50%;
            background:${c};border:2px solid #fff;
            box-shadow:0 1px 4px rgba(0,0,0,.45);
        "></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
    });
}

/** Pin de ubicación grande (modo elegir parking), estilo tableta lecturista */
function makeServicePin(color, label) {
    const c = color || '#2563eb';
    const lab = (label != null && label !== '') ? String(label) : '';
    const inner = lab
        ? `<div style="min-width:22px;height:22px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);color:#fff;font:700 10px/22px system-ui,sans-serif;text-align:center;">${lab}</div>`
        : `<div style="width:18px;height:18px;border-radius:50% 50% 50% 0;background:${c};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);transform:rotate(-45deg);margin:4px auto 0;"></div>`;
    return L.divIcon({
        className: 'cfe-svc-pin',
        html: `<div style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;">${inner}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
    });
}

function normalizeRpuKey(rpu) {
    let k = String(rpu || '').trim();
    if (k.endsWith('.0')) k = k.slice(0, -2);
    return k;
}

function getReincidentAlerts(rpu) {
    const key = normalizeRpuKey(rpu);
    if (!key || !window.anomalyAlerts) return [];
    const hits = window.anomalyAlerts[key];
    return Array.isArray(hits) ? hits : [];
}

function isSinUsoAlert(alerts) {
    return (alerts || []).some(a => {
        const t = ((a.anomalia || a.alerta || '') + '').toUpperCase();
        return t.includes('SERVICIO SIN USO') || t.includes('SIN USO');
    });
}

function formatReincidentPopup(alerts) {
    if (!alerts || !alerts.length) return '';
    const a = alerts[0];
    const anom = a.anomalia || a.alerta || 'Reincidente';
    const ciclos = (a.ciclos && a.ciclos.length) ? a.ciclos.join(', ') : '';
    const n = a.n || a.n_apariciones || (a.ciclos ? a.ciclos.length : alerts.length);
    const sinUso = isSinUsoAlert(alerts);
    const color = sinUso ? '#b91c1c' : '#b45309';
    let html = `<br><div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:${sinUso ? '#fef2f2' : '#fffbeb'};border:1px solid ${color}">`;
    html += `<b style="color:${color}">⚠️ REINCIDENTE${sinUso ? ' · SERVICIO SIN USO' : ''}</b>`;
    html += `<br><span style="color:${color}">${anom}</span>`;
    if (n) html += `<br><small>Visto en ${n} ciclo(s)</small>`;
    if (ciclos) html += `<br><small>Ciclos: ${ciclos}</small>`;
    if (sinUso) {
        html += `<br><small>Casa posiblemente deshabitada — confirmar y reportar a comercial si aplica.</small>`;
    }
    html += '</div>';
    return html;
}

const normalize = s => (s || '').toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s._]/g, '')
    .toUpperCase()
    .trim();

function detectTareaFromFileName(name) {
    if (!name) return null;
    const s = String(name);
    let m = s.match(/DU\d+[A-Z]?[-_](\d{3,5})[-_]/i);
    if (m) return m[1];
    m = s.match(/[-_](\d{4})[-_]/);
    if (m) return m[1];
    m = s.match(/\b(20\d{2}|11\d{2}|13\d{2}|34\d{2}|78\d{2})\b/);
    return m ? m[1] : null;
}

/* =========================================================
   6. PROGRESS & CONCURRENCY
   ========================================================= */
function progressReset() {
    prog.total = 0; prog.done = 0; prog.t0 = Date.now(); prog.etaHist = [];
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = '0 / 0 — ETA …';
    drawETA();
}

function progressAdd(n) { prog.total += n; progressRender(); }
function progressDone(n) { prog.done += n; if (prog.done > prog.total) prog.total = prog.done; progressRender(); }

function progressRender() {
    if (!progressFill || !progressText) return;
    const pct = prog.total ? (prog.done / prog.total) * 100 : 0;
    const now = Date.now();
    const elapsed = now - (prog.t0 || now);
    const eta = (prog.done > 0 && prog.total > prog.done)
        ? (elapsed / prog.done) * (prog.total - prog.done)
        : 0;
    progressFill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
    progressText.textContent = `${prog.done} / ${prog.total} — ETA ${fmt(eta)}`;
    if (eta > 0) {
        prog.etaHist.push(eta);
        if (prog.etaHist.length > 240) prog.etaHist.shift();
    }
    drawETA();
}

function drawETA() {
    if (!ctx || !etaCanvas) return;
    const w = etaCanvas.width, h = etaCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!prog.etaHist.length) {
        ctx.fillStyle = '#aaa';
        ctx.font = '12px system-ui';
        ctx.fillText('Sin datos', 12, 20);
        return;
    }
    const max = Math.max(...prog.etaHist) * 1.08;
    const min = Math.min(...prog.etaHist) * 0.92;
    const pad = 12;
    const n = prog.etaHist.length;
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const x = pad + (w - 2 * pad) * (i / (n - 1 || 1));
        const v = prog.etaHist[i];
        const y = h - pad - ((v - min) / (max - min || 1)) * (h - 2 * pad);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#166534';
    ctx.font = 'bold 12px system-ui';
    ctx.fillText('ETA ahora: ' + fmt(prog.etaHist[n - 1]), 12, h - 6);
}

function setConcurrency(n) {
    MAX_CONCURRENCY = Math.max(1, Math.min(16, parseInt(n) || 8));
}

function schedule(task) {
    return new Promise((resolve, reject) => {
        const job = async () => {
            try {
                running++;
                resolve(await task());
            } catch (e) {
                reject(e);
            } finally {
                running--;
                pump();
            }
        };
        queue.push(job);
        pump();
    });
}

function pump() {
    while (running < MAX_CONCURRENCY && queue.length) {
        queue.shift()();
    }
}

function renderStats() {
    if (!statsEl) return;
    statsEl.innerHTML =
        `<div>Aristas (route):</div><div><b>${stats.edgeCalls}</b></div>` +
        `<div>Polilíneas:</div><div><b>${stats.polylineCalls}</b></div>` +
        `<div>Cache MEM:</div><div><b>${stats.memHits}</b></div>` +
        `<div>Cache LS:</div><div><b>${stats.lsHits}</b></div>` +
        `<div>Fallbacks:</div><div><b>${stats.fallbacks}</b></div>`;
}

/* =========================================================
   7. OSRM HELPERS
   ========================================================= */
async function osrmEdge(a, b) {
    const k = edgeKey(a, b);
    if (osrmCacheMem.has(k)) {
        stats.memHits++;
        renderStats();
        return osrmCacheMem.get(k);
    }
    const lsk = 'osrm_edge_' + k;
    const hit = lsGet(lsk);
    if (hit && typeof hit.km === 'number' && typeof hit.min === 'number') {
        osrmCacheMem.set(k, hit);
        stats.lsHits++;
        renderStats();
        return hit;
    }
    progressAdd(1);
    const coords = `${a[1]},${a[0]};${b[1]},${b[0]}`;
    const url = `${OSRM_URL}/route/v1/driving/${coords}?overview=false&annotations=distance,duration`;
    try {
        const out = await schedule(async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
            const j = await res.json();
            if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('OSRM bad response');
            const r = j.routes[0];
            const obj = { km: (r.distance || 0) / 1000, min: (r.duration || 0) / 60 };
            stats.edgeCalls++;
            osrmCacheMem.set(k, obj);
            lsSet(lsk, obj);
            renderStats();
            return obj;
        });
        return out;
    } catch (e) {
        const hv = haversineKm(a, b);
        const obj = { km: hv, min: (hv / 25) * 60 }; // ~25 km/h urbano
        stats.fallbacks++;
        osrmCacheMem.set(k, obj);
        lsSet(lsk, obj);
        renderStats();
        return obj;
    } finally {
        progressDone(1);
    }
}

async function osrmPolyline(coords, profile) {
    if (!coords || coords.length < 2) return coords || [];
    const prof = profile || 'driving';
    const q = coords.map(c => `${c[1]},${c[0]}`).join(';');
    const cacheKey = 'poly_' + prof + '_' + q;
    if (osrmCacheMem.has(cacheKey)) {
        stats.memHits++;
        renderStats();
        return osrmCacheMem.get(cacheKey);
    }
    progressAdd(1);
    try {
        const out = await schedule(async () => {
            const url = `${OSRM_URL}/route/v1/${prof}/${q}?overview=full&geometries=geojson`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
            const j = await res.json();
            if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('OSRM bad');
            stats.polylineCalls++;
            renderStats();
            const line = j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
            osrmCacheMem.set(cacheKey, line);
            return line;
        });
        return out;
    } catch (e) {
        stats.fallbacks++;
        renderStats();
        return null;
    } finally {
        progressDone(1);
    }
}

/* =========================================================
   8. COLUMN MAPPING & FILE PARSING
   ========================================================= */
const COLMAP = new Map([
    ['RPU', ['RPU', 'CUENTA_RPU', 'RPUCUENTA', 'NO_RPU', 'RPU_']],
    ['CUENTA', ['CUENTA', 'CODCUENTA', 'NUMEROCUENTA']],
    ['NOMBRE', ['NOMBRE', 'NOM', 'CLIENTE', 'RAZONSOCIAL']],
    ['DIRECCION', ['DIRECCION', 'DOMICILIO', 'DIRECCIONCOMPLETA', 'DOM']],
    ['MEDIDOR', ['MEDIDOR', 'NO_MEDIDOR', 'NOMEDIDOR', 'NUMEROMEDIDOR']],
    ['CODIGOMEDIDOR', ['CODIGOMEDIDOR', 'CODMED', 'COD_MEDIDOR', 'CODIGO_MEDIDOR', 'CODIGO']],
    ['LOTEMEDIDOR', ['LOTEMEDIDOR', 'LOTE_MEDIDOR', 'LOTE']],
    ['ANOMALIA', ['ANOMALIA', 'ANOMALIAS', 'ANOM']],
    ['OBSERVACION', ['OBSERVACION', 'OBSERVACIONES', 'OBS', 'OBSCAMPO']],
    ['LATITUD', ['LATITUD', 'MAPA', 'LAT', 'Y']],   // el Detallado de CFE trae la latitud en "Mapa"
    ['TAREA', ['TAREA', 'CVETAREA']],
    ['LONGITUD', ['LONGITUD', 'LON', 'LNG', 'X']]
]);

function buildHeaderMap(headers) {
    const nh = headers.map(h => normalize(h));
    const out = {};
    for (const k of COLMAP.keys()) out[k] = null;
    for (let i = 0; i < nh.length; i++) {
        for (const [canon, vars] of COLMAP.entries()) {
            if (vars.includes(nh[i])) {
                out[canon] = headers[i];
                break;
            }
        }
    }
    return out;
}

function parseCSV(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: r => resolve(r.data),
            error: reject
        });
    });
}

/**
 * Filas como objetos, buscando la fila de encabezados (la que tiene "Rpu"): el Detallado trae
 * 1-3 renglones de título antes. Las celdas numéricas se leen como número (sin formato), así un
 * RPU 943010600288 no se convierte en "9.43011E+11".
 */
function sheetRowsWithHeader(ws) {
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
    let h = 0;
    for (let i = 0; i < Math.min(aoa.length, 20); i++) {
        const cells = (aoa[i] || []).map(c => normalize(c));
        if (cells.includes('RPU')) { h = i; break; }
    }
    const headers = (aoa[h] || []).map((c, j) => String(c || '').trim() || ('COL' + j));
    const out = [];
    for (let i = h + 1; i < aoa.length; i++) {
        const row = aoa[i] || [];
        if (!row.some(v => v !== '' && v !== null && v !== undefined)) continue;
        const o = {};
        headers.forEach((k, j) => { o[k] = row[j] === undefined ? '' : row[j]; });
        out.push(o);
    }
    return out;
}

/**
 * RPU como lo maneja CFE (12 dígitos de texto).
 *   943010600288 · "943010600288" · "943010600288.0" → "943010600288"
 *   "9.43011E+11" → los últimos dígitos ya se perdieron (Excel lo guardó así): lossy = true
 */
function normRpu(v) {
    if (v === null || v === undefined) return { rpu: '', lossy: false };
    if (typeof v === 'number' && isFinite(v)) return { rpu: String(Math.round(v)), lossy: false };
    let t = String(v).trim().replace(/\s+/g, '');
    if (!t || t === '-' || /^nan$/i.test(t)) return { rpu: '', lossy: false };
    if (/^\d(\.\d+)?e\+?\d+$/i.test(t)) return { rpu: String(Math.round(Number(t))), lossy: true };
    t = t.replace(/\.0+$/, '');
    return { rpu: t, lossy: false };
}

/** Cuenta 40DU07B203201520 → partes; tipo '01' urbana, otro número media urbana, letra rural */
const CUENTA_RE = /^(\d{2})([A-Z]{2}\d)(\d)([A-Z])([A-Z0-9]{2})(\d{3})(\d{4})$/;
function parseCuenta(v) {
    const m = CUENTA_RE.exec(String(v || '').trim().toUpperCase().replace(/\s+/g, ''));
    if (!m) return null;
    return { cuenta: m[0], rutaId: m[0].slice(0, 12), zonaAgencia: m[2] + m[3] + m[4], tipo: m[5], ruta: m[6] };
}
function poblacionPorTipo(t) {
    t = String(t || '').toUpperCase();
    if (/[A-Z]/.test(t)) return 'rural';
    return t === '01' ? 'urbana' : 'media urbana';
}
/** Resumen de la Cuenta de todo el archivo (antes de optimizar; la densidad la confirma el backend) */
function summarizeCuentas(cuentas) {
    const comp = {}, tipos = {}, zonas = {};
    let n = 0;
    cuentas.forEach(c => {
        const p = parseCuenta(c);
        if (!p) return;
        n++;
        const pb = poblacionPorTipo(p.tipo);
        comp[pb] = (comp[pb] || 0) + 1;
        tipos[p.tipo] = (tipos[p.tipo] || 0) + 1;
        zonas[p.zonaAgencia] = (zonas[p.zonaAgencia] || 0) + 1;
    });
    if (!n) return null;
    const top = o => Object.keys(o).sort((a, b) => o[b] - o[a])[0];
    return { n, poblacion: top(comp), composicion: comp, tipos, zonaAgencia: top(zonas) };
}

const POB_STYLE = {
    'urbana': { bg: '#eff6ff', fg: '#1d4ed8', icon: '🏙️' },
    'media urbana': { bg: '#fffbeb', fg: '#b45309', icon: '🏘️' },
    'rural': { bg: '#ecfdf5', fg: '#047857', icon: '🌾' }
};
function pobLabel(p) { return p ? p.charAt(0).toUpperCase() + p.slice(1) : '—'; }
/** Etiqueta "🌾 Rural · Cuenta 20 (64 %) / C4 (36 %) · 26 medidores/km²" */
function poblacionBadgeHtml(info) {
    if (!info || !info.poblacion) return '';
    const st = POB_STYLE[info.poblacion] || { bg: '#f1f5f9', fg: '#334155', icon: '📍' };
    const tipos = info.tipos_cuenta || info.tipos || {};
    const tot = Object.values(tipos).reduce((a, b) => a + b, 0) || 1;
    const tTxt = Object.keys(tipos).slice(0, 3).map(k => `${k} (${Math.round(100 * tipos[k] / tot)} %)`).join(' / ');
    const dens = info.medidores_km2 != null ? ` · ${Math.round(info.medidores_km2).toLocaleString('es-MX')} medidores/km²` : '';
    const za = info.zona_agencia || info.zonaAgencia;
    return `<span class="pob-badge" style="background:${st.bg};color:${st.fg};" title="Tipo de población según la Cuenta (posiciones 8-9: 01 = urbana, otro número = media urbana, letra = rural) y la densidad de medidores">
        ${st.icon} <b>${pobLabel(info.poblacion)}</b>${tTxt ? ' · Cuenta ' + tTxt : ''}${dens}${za ? ' · ' + za : ''}${info.medidores_km2 === undefined ? ' <i style="opacity:.75">(según Cuenta; la densidad lo confirma al optimizar)</i>' : ''}</span>`;
}
function showPoblacion(info) {
    window.currentPoblacion = info || null;
    const el = document.getElementById('poblacionInfo');
    if (!el) return;
    el.innerHTML = poblacionBadgeHtml(info);
    el.style.display = el.innerHTML ? '' : 'none';
}

function parseXLSX(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = e => {
            try {
                // también abre los .xls "formato web" (HTML) que baja el sistema de CFE
                const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', raw: true });
                const ws = wb.Sheets[wb.SheetNames[0]];
                resolve(sheetRowsWithHeader(ws));
            } catch (err) {
                reject(err);
            }
        };
        fr.onerror = reject;
        fr.readAsArrayBuffer(file);
    });
}

/* =========================================================
   9. MARKERS / FILTERS / COUNT
   ========================================================= */
/** "SERVICIO SIN USO | CAUSA CC:CASA VACIA" -> "Servicio sin uso · casa vacia" (para mostrar) */
function anomNice(an) {
    const t = String(an || '').replace(/\s*\|\s*CAUSA\s*CC\s*:\s*/i, ' · ').replace(/\s+/g, ' ').trim().toLowerCase();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Sin anomalía';
}

(function renderLegend() {
    if (!legendEl) return;
    const items = [
        ['SERVICIO SIN USO', getColor('SERVICIO SIN USO')],
        ['NO HAY MEDIDOR', getColor('NO HAY MEDIDOR')],
        ['CASA CERRADA', getColor('CASA CERRADA')],
        ['COMUNICACION INTERRUMPIDA', getColor('COMUNICACION INTERRUMPIDA')],
        ['ERROR AL INTERROGAR', getColor('ERROR AL INTERROGAR')],
        ['FUERA DE RUTA', getColor('FUERA DE RUTA')],
        ['RUTA INCOMPLETA', getColor('RUTA INCOMPLETA')],
        ['OTRAS / SIN ANOMALIA', getColor('')]
    ];
    items.forEach(([label, color]) => {
        const it = document.createElement('span');
        it.className = 'legend-item';
        it.innerHTML = `<i style="background:${color}"></i><span>${anomNice(label)}</span>`;
        legendEl.appendChild(it);
    });
})();

async function handleFile(file) {
    window.lastFileName = file.name;
    window.currentTarea = detectTareaFromFileName(file.name);
    if (window.currentTarea) console.log('📋 Tarea:', window.currentTarea);

    clearTrips();
    markers.clearLayers();
    allMarkers = [];
    anomalies = new Set();
    if (filtersEl) filtersEl.innerHTML = '';
    if (qEl) qEl.value = '';
    if (qMedEl) qMedEl.value = '';
    if (countEl) countEl.textContent = '';
    if (dropsEl) dropsEl.textContent = '';

    stats.edgeCalls = 0; stats.polylineCalls = 0; stats.tableCalls = 0;
    stats.memHits = 0; stats.lsHits = 0; stats.fallbacks = 0;
    renderStats();

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let rows = [];
    try {
        if (ext === 'csv') rows = await parseCSV(file);
        else if (ext === 'xlsx' || ext === 'xls') rows = await parseXLSX(file);
        else throw new Error('Formato no soportado');
    } catch (e) {
        alert('Error al leer archivo: ' + e.message);
        return;
    }
    if (!rows.length) {
        alert('El archivo está vacío');
        return;
    }

    const headers = Object.keys(rows[0] || {});
    const hmap = buildHeaderMap(headers);
    // Encabezado de latitud vacío (columna sin nombre justo antes de Longitud) → usarla como latitud
    if (!hmap['LATITUD'] && hmap['LONGITUD']) {
        const i = headers.indexOf(hmap['LONGITUD']);
        for (const h of [headers[i - 1], headers[i - 2]]) {
            if (!h || !/^(COL\d+|__EMPTY(_\d+)?)$/.test(h)) continue;
            const vals = rows.slice(0, 200).map(r => parseFloat(r[h])).filter(isFinite);
            if (vals.length > 20 && vals.filter(v => v > 14 && v < 33).length / vals.length > 0.9) { hmap['LATITUD'] = h; break; }
        }
    }
    const required = ['RPU', 'NOMBRE', 'DIRECCION', 'LATITUD', 'LONGITUD'];
    const missing = required.filter(k => !hmap[k]);
    if (missing.length) {
        alert('Faltan columnas: ' + missing.join(', '));
        return;
    }

    let dropped = 0;
    let lossyRpu = 0;
    const cuentas = [];
    const layer = L.layerGroup();

    rows.forEach((r, idx) => {
        const lat = parseFloat(r[hmap['LATITUD']]);
        const lon = parseFloat(r[hmap['LONGITUD']]);
        if (!isFinite(lat) || !isFinite(lon)) {
            dropped++;
            return;
        }

        const nr = normRpu(r[hmap['RPU']]);
        if (nr.lossy) lossyRpu++;
        const cuenta = hmap['CUENTA'] ? String(r[hmap['CUENTA']] || '').trim().toUpperCase() : '';
        if (cuenta) cuentas.push(cuenta);
        const props = {
            Rpu: nr.rpu,
            Cuenta: cuenta,
            Nombre: r[hmap['NOMBRE']] || '',
            Direccion: r[hmap['DIRECCION']] || '',
            Medidor: hmap['MEDIDOR'] ? r[hmap['MEDIDOR']] : '',
            CodigoMedidor: hmap['CODIGOMEDIDOR'] ? r[hmap['CODIGOMEDIDOR']] : '',
            LoteMedidor: hmap['LOTEMEDIDOR'] ? r[hmap['LOTEMEDIDOR']] : '',
            Anomalia: hmap['ANOMALIA'] ? r[hmap['ANOMALIA']] : '',
            Observacion: hmap['OBSERVACION'] ? r[hmap['OBSERVACION']] : ''
        };

        let anomRaw = (props.Anomalia || '').toString().trim();
        if (!anomRaw || anomRaw === '-' || anomRaw === '—' || anomRaw.toUpperCase() === 'N/A') anomRaw = '';
        props.Anomalia = anomRaw;

        const color = getColor(anomRaw);
        const m = L.marker([lat, lon], { icon: makeDot(color) });
        m.__anom = anomRaw.toUpperCase();
        m.__text = `${props.Rpu} ${props.Nombre} ${props.Direccion}`.toLowerCase();
        m.__props = props;
        m.__medcode = (props.CodigoMedidor || '').toString().trim().toLowerCase();
        m.__id = idx;
        m.__lat = lat;
        m.__lon = lon;
        m.__rpu = props.Rpu || '';
        try { attachParkingClick(m, { lat, lon, id: idx, rpu: props.Rpu }, props); } catch (e) {}

        anomalies.add(m.__anom);
        allMarkers.push(m);
        layer.addLayer(m);
    });

    markers.addLayer(layer);

    // Tipo de población / agencia según la Cuenta
    const cs = summarizeCuentas(cuentas);
    showPoblacion(cs);
    if (cs && cs.zonaAgencia) {
        window.currentZonaAgencia = cs.zonaAgencia;
        try { syncAgencyFromCode(cs.zonaAgencia); } catch (e) { }
    }
    if (!window.currentTarea && hmap['TAREA'] && rows[0]) {
        const t = String(rows[0][hmap['TAREA']] || '').trim().replace(/\.0$/, '');
        if (/^\d{3,4}$/.test(t)) window.currentTarea = t.padStart(4, '0');
    }
    if (lossyRpu) {
        alert(`⚠️ ${lossyRpu} RPU vienen como "9.43011E+11": Excel ya les borró los últimos dígitos ` +
              `y no se pueden cruzar con el historial.\n\nDescarga otra vez el Detallado del sistema de CFE ` +
              `y cárgalo tal cual (.xls), sin abrirlo y guardarlo como CSV.`);
    }
    setTimeout(() => {
        try {
            if (allMarkers.length) map.fitBounds(markers.getBounds(), { padding: [50, 50] });
            else map.setView(CFE_START, 14);
        } catch (e) {
            map.setView(CFE_START, 14);
        }
        map.invalidateSize();
    }, 150);

    renderFilters();
    updateCount();
    try { renderParkingPanel(); } catch (e) {}
    // Si ya estaba en "Yo elijo", mostrar pines ya
    try {
        if (window.parkingMode === 'user' && window._pickParkingActive) {
            setMarkersUnclustered(true);
        }
    } catch (e) {}
    if (dropped && dropsEl) dropsEl.textContent = `Filas sin coordenadas: ${dropped}`;
}

function renderFilters() {
    if (!filtersEl) return;
    filtersEl.innerHTML = '';
    const sorted = Array.from(anomalies).sort();
    if (!sorted.includes('')) sorted.unshift('');
    // cuántos servicios hay de cada anomalía (para mostrarlo en cada etiqueta)
    const counts = {};
    (allMarkers || []).forEach(m => {
        const k = (m.__anom || '').toUpperCase();
        counts[k] = (counts[k] || 0) + 1;
    });
    // primero las que tienen más servicios
    sorted.sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
    sorted.forEach(an => {
        const id = 'chk_' + (an ? an.replace(/[^A-Z0-9]+/gi, '_') : 'SIN');
        const label = an ? anomNice(an) : 'Sin anomalía / otras';
        const color = getColor(an);
        const chip = document.createElement('label');
        chip.className = 'chip';
        chip.title = an || 'OTRAS / SIN ANOMALIA';
        chip.innerHTML = `<input type="checkbox" id="${id}" data-anom="${an}" checked>`
            + `<i style="background:${color}"></i><span class="chip-txt">${label}</span>`
            + `<b class="chip-n">${(counts[an] || 0).toLocaleString()}</b>`;
        filtersEl.appendChild(chip);
        chip.querySelector('input').addEventListener('change', applyFilter);
    });
}

function applyFilter() {
    const q = (qEl && qEl.value || '').trim().toLowerCase();
    const qMed = (qMedEl && qMedEl.value || '').trim().toLowerCase();
    const allowed = new Set(
        Array.from((filtersEl || document).querySelectorAll('input[type="checkbox"]'))
            .filter(cb => cb.checked)
            .map(cb => cb.getAttribute('data-anom') || '')
    );
    const filtered = allMarkers.filter(m => {
        const anKey = (m.__anom || '').toUpperCase() || '';
        if (!allowed.has(anKey)) return false;
        if (q && !(m.__text || '').includes(q)) return false;
        if (qMed && !(m.__medcode || '').includes(qMed)) return false;
        return true;
    });
    markers.clearLayers();
    markers.addLayers(filtered);
    if (_markersAreLoose) {
        refreshMarkersDisplay();
    }
    updateCount();
    setTimeout(() => map.invalidateSize(), 10);
}


function updateCount() {
    if (!countEl) return;
    countEl.textContent = `${markers.getLayers().length.toLocaleString()} de ${allMarkers.length.toLocaleString()} puntos`;
}

function getVisibleNodes() {
    const nodes = [];
    // Usar allMarkers filtrados por los que están en el cluster visible
    const visibleSet = new Set(markers.getLayers());
    allMarkers.forEach((m) => {
        if (!visibleSet.has(m) && markers.hasLayer(m) === false) {
            // si el filtro los quitó del cluster, no van
            if (!markers.hasLayer(m)) return;
        }
        // Preferir los actualmente en markers
        if (!markers.hasLayer(m) && !visibleSet.has(m)) return;

        const ll = m.getLatLng();
        const props = m.__props || {};
        nodes.push({
            id: nodes.length,
            lat: ll.lat,
            lon: ll.lng,
            rpu: String(props.Rpu || '').trim() || null,
            props: props
        });
    });
    // Fallback: si markers.getLayers vacío por cluster, usar allMarkers filtrados por checkbox
    if (!nodes.length && allMarkers.length) {
        allMarkers.forEach((m) => {
            const ll = m.getLatLng();
            const props = m.__props || {};
            nodes.push({
                id: nodes.length,
                lat: ll.lat,
                lon: ll.lng,
                rpu: String(props.Rpu || '').trim() || null,
                props: props
            });
        });
    }
    return nodes;
}

/* =========================================================
   10. LIVE LAYER + BUILD TRIP (parking medoid + caminata 1 sentido)
   ========================================================= */
function clearLiveLayer() {
    if (liveLayer) {
        map.removeLayer(liveLayer);
        liveLayer = null;
    }
}

function ensureLiveLayer() {
    if (!liveLayer) liveLayer = L.layerGroup().addTo(map);
    return liveLayer;
}

/**
 * Dibuja el orden del backend.
 * opts.parking / opts.dwellMin / opts.backendTimeMin / opts.maxWalkKm
 */
async function buildTripsFromOrder(orderedNodes, dayIndex = 0, onProgress = null, opts = {}) {
    const MAX_WALK_KM = opts.maxWalkKm != null ? opts.maxWalkKm : MAX_WALK_KM_DEFAULT;
    const Vw = Math.max(0.1, parseFloat(walkSpeedEl && walkSpeedEl.value) || 4.0);

    let DW;
    if (dwellEl && dwellEl.value != null && String(dwellEl.value).trim() !== '') {
        DW = Math.max(0, parseFloat(dwellEl.value) || 0);
    } else if (opts.dwellMin != null && isFinite(opts.dwellMin)) {
        DW = Math.max(0, Number(opts.dwellMin));
    } else {
        DW = 0.20;
    }

    const color = routeColors[dayIndex % routeColors.length];
    const layer = ensureLiveLayer();

    const trip = {
        points: [],
        timeMin: 0,
        distKm: 0,
        line: [],
        walkSegments: [],
        walkKm2Total: 0,
        walkMin2Total: 0,
        parkings: [],
        backendTimeMin: opts.backendTimeMin != null ? Number(opts.backendTimeMin) : null,
        dwellUsed: DW,
        orderSource: opts.orderSource || ''
    };

    if (!orderedNodes.length) return { trips: [trip], unassigned: [] };

    const backendPark = opts.parking && isFinite(opts.parking.lat) && isFinite(opts.parking.lon)
        ? { lat: opts.parking.lat, lon: opts.parking.lon, rpu: opts.parking.rpu || null }
        : null;

    const mainParking = backendPark || {
        lat: orderedNodes[0].lat,
        lon: orderedNodes[0].lon,
        rpu: orderedNodes[0].rpu || null
    };
    trip.parkings.push(mainParking);

    L.marker([mainParking.lat, mainParking.lon], {
        icon: L.divIcon({
            className: '',
            html: `<div style="background:#fff;border:2px solid #e74c3c;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;color:#e74c3c;box-shadow:0 1px 4px rgba(0,0,0,.35)">P</div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        })
    }).addTo(layer).bindTooltip('Parking (medoid)', { direction: 'top' });

    // --- Ida CFE → parking (sí cuenta) ---
    L.circleMarker(CFE_START, {
        radius: 8, color: '#003087', fillColor: '#003087', fillOpacity: 1, weight: 2
    }).addTo(layer).bindTooltip('CFE', { permanent: false });

    const vehiclePath = [CFE_START.slice()];
    const driveToPark = await osrmEdge(CFE_START, [mainParking.lat, mainParking.lon]);
    const cfeGoMin = driveToPark.min;
    const cfeGoKm = driveToPark.km;
    vehiclePath.push([mainParking.lat, mainParking.lon]);
    try {
        const polyGo = await osrmPolyline([CFE_START, [mainParking.lat, mainParking.lon]]);
        L.polyline(polyGo, { color, weight: 4, opacity: 0.85 }).addTo(layer);
    } catch (e) {
        L.polyline([CFE_START, [mainParking.lat, mainParking.lon]], {
            color, weight: 4, opacity: 0.7
        }).addTo(layer);
    }

    // Acumulados de campo (solo si no hay backendTimeMin)
    let fieldMin = 0;
    let fieldWalkKm = 0;
    let fieldWalkMin = 0;
    let fieldDriveKm = 0;

    let prevLL = [mainParking.lat, mainParking.lon];
    let doneCount = 0;
    const totalCount = orderedNodes.length;

    for (let i = 0; i < orderedNodes.length; i++) {
        const p = orderedNodes[i];
        const here = [p.lat, p.lon];
        const distKm = haversineKm(prevLL, here);

        if (distKm <= MAX_WALK_KM) {
            const wMin = (distKm / Vw) * 60;
            fieldMin += wMin;
            fieldWalkKm += distKm;
            fieldWalkMin += wMin;
            if (distKm > 0.001) {
                const fromLL = prevLL.slice();
                const toLL = here.slice();
                // 1) Al instante
                const pl = L.polyline([fromLL, toLL], {
                    color: '#ff7f00', weight: 3, opacity: 0.9, dashArray: '6 4'
                }).addTo(layer);
                const seg = { from: fromLL, to: toLL, line: [fromLL, toLL], _layer: pl };
                trip.walkSegments.push(seg);
                // 2) Calles en paralelo (NO await)
                if (distKm > 0.025) {
                    osrmPolyline([fromLL, toLL], 'driving').then(poly => {
                        if (poly && poly.length >= 2 && pl._map) {
                            pl.setLatLngs(poly);
                            seg.line = poly;
                        }
                    }).catch(() => { });
                }
            }
        } else if (distKm > 0.001) {
            const drive = await osrmEdge(prevLL, here);
            fieldMin += drive.min;
            fieldDriveKm += drive.km;
            vehiclePath.push(here);
            try {
                const poly = await osrmPolyline([prevLL, here]);
                L.polyline(poly, { color, weight: 4, opacity: 0.85 }).addTo(layer);
            } catch (e) {
                L.polyline([prevLL, here], { color, weight: 4, opacity: 0.7 }).addTo(layer);
            }
        }

        fieldMin += DW;

        const seqNum = trip.points.length + 1;
        const pr = p.props || {};
        const anomColor = getColor(pr.Anomalia || '');
        const rpuHere = pr.Rpu || p.rpu || '';
        const alertsHere = getReincidentAlerts(rpuHere);
        const reinHere = alertsHere.length > 0;
        const sinUsoHere = isSinUsoAlert(alertsHere);
        L.marker(here, {
            icon: makeSeqIcon(seqNum, anomColor, reinHere, sinUsoHere)
        }).addTo(layer)
            .bindTooltip(
                `${seqNum}. ${rpuHere}` + (reinHere ? ' ⚠ REINCIDENTE' : ''),
                { direction: 'top' }
            )
            .bindPopup(
                `<b>#${seqNum}</b><br>RPU: ${rpuHere}<br>${pr.Nombre || ''}<br>${pr.Direccion || ''}`
                + `<br><small>${pr.Anomalia || 'Sin anomalía'}</small>`
                + formatReincidentPopup(alertsHere)
            );

        trip.points.push({
            ...p,
            props: pr,
            seq: seqNum,
            parking: { lat: mainParking.lat, lon: mainParking.lon },
            walkKmFromPrev: distKm
        });

        prevLL = here;
        doneCount++;
        if (onProgress) onProgress(doneCount, totalCount, dayIndex);
        // Dibujo servicio por servicio
        await new Promise(r => setTimeout(r, 40));
    }

    // Regreso al parking (campo)
    const backKm = haversineKm(prevLL, [mainParking.lat, mainParking.lon]);
    if (backKm > 0.001) {
        if (backKm <= MAX_WALK_KM * 1.5) {
            const wMin = (backKm / Vw) * 60;
            fieldMin += wMin;
            fieldWalkKm += backKm;
            fieldWalkMin += wMin;
            trip.walkSegments.push({
                from: prevLL.slice(),
                to: [mainParking.lat, mainParking.lon]
            });
            L.polyline([prevLL, [mainParking.lat, mainParking.lon]], {
                color: '#ff7f00', weight: 3, opacity: 0.7, dashArray: '6 4'
            }).addTo(layer);
        } else {
            const drive = await osrmEdge(prevLL, [mainParking.lat, mainParking.lon]);
            fieldMin += drive.min;
            fieldDriveKm += drive.km;
            vehiclePath.push([mainParking.lat, mainParking.lon]);
            try {
                const poly = await osrmPolyline([prevLL, [mainParking.lat, mainParking.lon]]);
                L.polyline(poly, { color, weight: 3, opacity: 0.75 }).addTo(layer);
            } catch (e) {
                L.polyline([prevLL, [mainParking.lat, mainParking.lon]], {
                    color, weight: 3, opacity: 0.7
                }).addTo(layer);
            }
        }
    }

    // --- Regreso parking → CFE (sí cuenta) ---
    const driveHome = await osrmEdge([mainParking.lat, mainParking.lon], CFE_START);
    const cfeBackMin = driveHome.min;
    const cfeBackKm = driveHome.km;
    vehiclePath.push(CFE_START.slice());
    try {
        const polyBack = await osrmPolyline([[mainParking.lat, mainParking.lon], CFE_START]);
        L.polyline(polyBack, { color, weight: 4, opacity: 0.85 }).addTo(layer);
    } catch (e) {
        L.polyline([[mainParking.lat, mainParking.lon], CFE_START], {
            color, weight: 4, opacity: 0.7
        }).addTo(layer);
    }

    if (vehiclePath.length >= 2) {
        try { trip.line = await osrmPolyline(vehiclePath); }
        catch (e) { trip.line = vehiclePath; }
    } else {
        trip.line = vehiclePath;
    }

    // Lectura = backend ML (no volver a sumar dwell+walk encima).
    // Total = lectura + ida/vuelta CFE.
    const lecturaMin = (trip.backendTimeMin != null && isFinite(trip.backendTimeMin))
        ? Number(trip.backendTimeMin)
        : fieldMin;
    const trasladoCfeMin = cfeGoMin + cfeBackMin;

    trip.lecturaMin = lecturaMin;
    trip.trasladoCfeMin = trasladoCfeMin;
    trip.timeMin = lecturaMin + trasladoCfeMin;
    trip.walkKm2Total = fieldWalkKm;
    trip.walkMin2Total = fieldWalkMin;
    trip.distKm = cfeGoKm + cfeBackKm + fieldDriveKm;

    console.log(
        `⏱️ Lectura: ${lecturaMin.toFixed(0)} min` +
        (trip.backendTimeMin != null ? ' (backend ML)' : ' (front)') +
        ` | Traslado CFE: ${trasladoCfeMin.toFixed(0)} min` +
        ` | Total: ${trip.timeMin.toFixed(0)} min`
    );

    return { trips: [trip], unassigned: [] };
}

/* =========================================================
   11. CLEAR / RENDER TRIPS
   ========================================================= */
function clearTrips() {
    tripLayers.forEach(g => map.removeLayer(g));
    tripLayers.clear();
    walkLayers.forEach(g => map.removeLayer(g));
    walkLayers.clear();
    clearLiveLayer();
}

function makeSeqIcon(num, anomColor, reincidente, sinUso) {
    let border = '2px solid #fff';
    let shadow = '0 1px 5px rgba(0,0,0,0.45)';
    let badge = '';
    if (sinUso) {
        border = '3px solid #b91c1c';
        shadow = '0 0 0 2px #fecaca, 0 1px 5px rgba(0,0,0,0.45)';
        badge = '<span style="position:absolute;top:-6px;right:-6px;font-size:10px;line-height:1">⚠</span>';
    } else if (reincidente) {
        border = '3px solid #f59e0b';
        shadow = '0 0 0 2px #fde68a, 0 1px 5px rgba(0,0,0,0.45)';
        badge = '<span style="position:absolute;top:-6px;right:-6px;font-size:10px;line-height:1">⚠</span>';
    }
    return L.divIcon({
        className: '',
        html: `<div style="position:relative;width:26px;height:26px;border-radius:50%;background:${anomColor || '#1f78b4'};border:${border};box-shadow:${shadow};color:#fff;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;">${num}${badge}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });
}

function makeParkingIcon() {
    return L.divIcon({
        className: '',
        html: `<div style="font-size:20px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.55));line-height:1;">🅿️</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });
}

function renderTrips(data) {
    clearTrips();
    try { hideBaseMarkersForRouteView(); } catch (e) {}
    if (!data || !data.trips || !data.trips.length) return;

    const { trips } = data;
    let bounds = [];
    let totalPts = 0, totalMin = 0, totalKm = 0, totalWalkKm = 0, totalWalkMin = 0;

    trips.forEach((t, di) => {
        const dayNum = di + 1;
        const dayColor = routeColors[di % routeColors.length];
        const g = L.layerGroup();
        const wg = L.layerGroup();

        if (t.line && t.line.length > 1) {
            L.polyline(t.line, { color: dayColor, weight: 4, opacity: 0.9 }).addTo(g);
            t.line.forEach(ll => bounds.push(L.latLng(ll[0], ll[1])));
        }

        if (t.walkSegments && t.walkSegments.length) {
            t.walkSegments.forEach(seg => {
                const line = (seg.line && seg.line.length >= 2)
                    ? seg.line
                    : [seg.from, seg.to];
                L.polyline(line, {
                    color: '#ff7f00', weight: 3, opacity: 0.85, dashArray: '6, 8'
                }).addTo(wg);
            });
        }

        if (t.points && t.points.length) {
            t.points.forEach((p, i) => {
                const pr = p.props || {};
                const anomColor = getColor(pr.Anomalia || '');
                const num = p.seq || (i + 1);
                const rpuKey = normalizeRpuKey(pr.Rpu || p.rpu || '');
                const alerts = getReincidentAlerts(rpuKey);
                const rein = alerts.length > 0;
                const sinUso = isSinUsoAlert(alerts);
                const marker = L.marker([p.lat, p.lon], {
                    icon: makeSeqIcon(num, anomColor, rein, sinUso)
                });
                marker.bindPopup(
                    `<b>#${num}</b><br>RPU: ${pr.Rpu || p.rpu || ''}<br>${pr.Nombre || ''}<br>${pr.Direccion || ''}`
                    + `<br><small>${pr.Anomalia || 'Sin anomalía'}</small>`
                    + formatReincidentPopup(alerts)
                );
                if (rein) {
                    marker.bindTooltip(
                        `#${num} ⚠ ` + (sinUso ? 'SIN USO reincidente' : 'Reincidente'),
                        { direction: 'top' }
                    );
                }
                marker.addTo(g);
                bounds.push(L.latLng(p.lat, p.lon));
            });
        }

        if (t.parkings && t.parkings.length) {
            t.parkings.forEach(pk => {
                L.marker([pk.lat, pk.lon], { icon: makeParkingIcon(), zIndexOffset: 500 })
                    .bindTooltip('Parking camioneta', { direction: 'top', offset: [0, -8] })
                    .addTo(g);
            });
        }

        g.addTo(map);
        wg.addTo(map);
        tripLayers.set(dayNum, g);
        walkLayers.set(dayNum, wg);

        totalPts += (t.points || []).length;
        totalMin += (t.timeMin || 0);
        totalKm += (t.distKm || 0);
        totalWalkKm += (t.walkKm2Total || 0);
        totalWalkMin += (t.walkMin2Total || 0);
    });

    try {
        if (bounds.length) map.fitBounds(L.latLngBounds(bounds), { padding: [30, 30] });
    } catch (e) { }

    if (daysPanel) {
        daysPanel.innerHTML = '';
        trips.forEach((t, di) => {
            const dayNum = di + 1;
            const dayColor = routeColors[di % routeColors.length];
            const pts = (t.points || []).length;
            const km = (t.distKm || 0).toFixed(1);
            const walk = (t.walkKm2Total || 0).toFixed(2);
            const mins = (t.timeMin || 0).toFixed(1);
            const src = t.orderSource ? String(t.orderSource) : 'ML + OSRM';

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #eee;';
            row.innerHTML = `
            <input type="checkbox" data-day="${dayNum}" checked style="margin-top:4px;width:16px;height:16px;cursor:pointer;">
            <div style="flex:1;font-size:0.92rem;line-height:1.35;">
                <div style="font-weight:700;color:#0f172a;">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dayColor};margin-right:6px;"></span>
                    Día ${dayNum}
                    <span style="font-weight:500;color:#64748b;"> ${pts} pts</span>
                </div>
                <div style="color:#334155;margin-top:4px;font-size:0.86rem;">
                    <div>🚗 Vehículo (CFE ↔ parking, ida y vuelta): <strong>${km} km</strong></div>
                    <div>🚶 A pie entre medidores: <strong>${walk} km</strong></div>
                    <div>⏱️ Total orientativo del día: <strong>${mins} min</strong></div>
                </div>
                <div style="color:#64748b;font-size:0.82rem;margin-top:4px;">
                    📖 Lectura en campo: ${(t.lecturaMin != null ? t.lecturaMin : t.timeMin).toFixed(0)} min
                    ${t.trasladoCfeMin != null ? ' · 🏢 Traslado oficina CFE: ' + t.trasladoCfeMin.toFixed(0) + ' min' : ''}
                </div>
                <div style="color:#1F5B51;font-size:0.8rem;margin-top:4px;">📋 ${friendlyOrderLabel(src)}</div>
            </div>`;
            const chk = row.querySelector('input[type="checkbox"]');
            chk.addEventListener('change', (e) => {
                const layer = tripLayers.get(dayNum);
                const wlayer = walkLayers.get(dayNum);
                if (e.target.checked) {
                    if (layer) map.addLayer(layer);
                    if (wlayer) map.addLayer(wlayer);
                } else {
                    if (layer) map.removeLayer(layer);
                    if (wlayer) map.removeLayer(wlayer);
                }
            });
            daysPanel.appendChild(row);
        });
    }

    if (summaryTrips) {
        const lec = trips.reduce((s, t) => s + (t.lecturaMin != null ? t.lecturaMin : t.timeMin || 0), 0);
        const cfe = trips.reduce((s, t) => s + (t.trasladoCfeMin || 0), 0);
        summaryTrips.innerHTML =
            `<div><strong>${trips.length}</strong> viaje(s) · <strong>${totalPts}</strong> puntos</div>
             <div style="margin-top:4px;">🚗 Vehículo <strong>${totalKm.toFixed(1)} km</strong> <span style="color:#64748b;">(principalmente ida/vuelta CFE ↔ parking)</span></div>
             <div>🚶 A pie <strong>${totalWalkKm.toFixed(2)} km</strong> <span style="color:#64748b;">(entre medidores en la ruta)</span></div>
             <div>📖 Lectura <strong>${lec.toFixed(0)} min</strong> · 🏢 CFE <strong>${cfe.toFixed(0)} min</strong> · ⏱️ Total <strong>${totalMin.toFixed(0)} min</strong></div>`;
        renderBreakdownPanel(trips);
    }

    if (btnTripsCSV) btnTripsCSV.disabled = false;
    if (btnTripsGJ) btnTripsGJ.disabled = false;
    if (btnExportPDF) btnExportPDF.disabled = false;
    if (btnReportPDF) btnReportPDF.disabled = false;
    if (btnStartGPSNavigation) btnStartGPSNavigation.disabled = false;
}

/* =========================================================
   12. EXPORT CSV / GEOJSON / PDF
   ========================================================= */
function exportTrips(data) {
    if (!data || !data.trips || !data.trips.length) {
        btnTripsCSV.disabled = true;
        btnTripsGJ.disabled = true;
        return;
    }

    const start = [20.211155, -98.317830];
    const DW = Math.max(0, parseFloat(dwellEl.value) || 0);
    const Vw = Math.max(0.1, parseFloat(walkSpeedEl.value) || 3.5);

    let csv = 'Dia,Secuencia,RPU,Nombre,Direccion,LAT,LON,Dist_veh_km_desde_anterior,Tiempo_veh_min_desde_anterior,Dwell_min,Walk_km_2way,Walk_min_2way(vel_' + Vw.toFixed(1) + 'kmh),Acumulado_dia_min\n';
    const gj = { type: 'FeatureCollection', features: [] };

    data.trips.forEach((t, di) => {
        let prev = start;
        let cum = 0;

        t.points.forEach((p, idx) => {
            const pr = p.props || {};
            const k = edgeKey(prev, [p.lat, p.lon]);
            const hv = haversineKm(prev, [p.lat, p.lon]);
            const e = (osrmCacheMem.get(k) || lsGet('osrm_edge_' + k) || { km: hv, min: (hv / 90) * 60 });

            const w2 = p.walkKm2 || 0;
            const wMin = (w2 / Vw) * 60;
            cum += e.min + wMin + DW;

            const nom = (pr.Nombre || '').toString().replaceAll('"', '');
            const dir = (pr.Direccion || '').toString().replaceAll('"', '');

            csv += `${di + 1},${idx + 1},"${pr.Rpu ?? ''}","${nom}","${dir}",${p.lat},${p.lon},${e.km.toFixed(3)},${e.min.toFixed(2)},${DW.toFixed(2)},${w2.toFixed(3)},${wMin.toFixed(2)},${cum.toFixed(2)}\n`;

            prev = [p.lat, p.lon];

            gj.features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                properties: {
                    Dia: di + 1, Secuencia: idx + 1,
                    RPU: pr.Rpu ?? '', Nombre: pr.Nombre ?? '', Direccion: pr.Direccion ?? '',
                    Walk_km_2way: w2, Walk_min_2way: wMin
                }
            });
        });

        const backE = osrmCacheMem.get(edgeKey(prev, start)) || { km: haversineKm(prev, start), min: (haversineKm(prev, start) / 90) * 60 };
        cum += backE.min;

        const ls = [[start[1], start[0]], ...t.points.map(p => [p.lon, p.lat]), [start[1], start[0]]];
        gj.features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: ls },
            properties: { Dia: di + 1 }
        });
    });

    const mk = (data, mime, name, btn) => {
        const blob = new Blob([data], { type: mime });
        const url = URL.createObjectURL(blob);
        btn.onclick = () => {
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        };
        btn.disabled = false;
    };

    mk(csv, 'text/csv;charset=utf-8', 'RPUS_Viajes_OSRM_SpeedKTable_itinerario.csv', btnTripsCSV);
    mk(JSON.stringify(gj), 'application/json', 'RPUS_Viajes_OSRM_SpeedKTable.geojson', btnTripsGJ);
}

async function exportRoutePDF(data) {
    if (!data || !data.trips || !data.trips.length) {
        alert("Primero genera las rutas");
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("portrait", "mm", "a4");

    // Columnas fijas (mm) — no se empalman
    const COL = {
        orden: 15,
        rpu: 28,
        nombre: 58,
        direccion: 110,
        caminata: 178
    };
    const W = {
        orden: 12,
        rpu: 28,
        nombre: 50,
        direccion: 62,   // ancho máximo de dirección
        caminata: 22
    };

    let y = 8;

    // Logo
    try {
        const logoImg = await fetch('logo-cfe.png')
            .then(r => r.blob())
            .then(blob => new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            }));
        doc.addImage(logoImg, 'PNG', 10, y, 48, 14);
    } catch (e) { }

    const xDer = 195;
    doc.setTextColor(0);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("Comisión Federal de Electricidad", xDer, y + 5, { align: "right" });
    doc.setFontSize(12);
    doc.text("CFE - CIUDAD VALLES", xDer, y + 12, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("RUTA DE LECTURA DE MEDIDORES", xDer, y + 18, { align: "right" });

    y = 36;
    doc.setFillColor(245, 245, 245);
    doc.rect(15, y - 4, 180, 16, "F");
    doc.setFontSize(10);
    doc.setTextColor(40);
    doc.text(`Fecha: ${new Date().toLocaleDateString('es-MX')}   |   Hora: ${new Date().toLocaleTimeString('es-MX')}`, 18, y + 2);
    doc.text("Inicio: Oficina CFE (20.211155, -98.317830)", 18, y + 8);
    y += 20;

    data.trips.forEach((trip, di) => {
        if (y > 250) {
            doc.addPage();
            y = 20;
        }

        // Título del día
        doc.setFillColor(0, 166, 81);
        doc.rect(15, y - 5, 180, 10, "F");
        doc.setTextColor(255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.text(`RUTA DÍA ${di + 1}  —  ${trip.points.length} VISITAS`, 20, y + 2);
        y += 14;

        // Encabezado de tabla
        doc.setFillColor(230, 230, 230);
        doc.rect(15, y - 5, 180, 8, "F");
        doc.setTextColor(0);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.text("Orden", COL.orden, y);
        doc.text("RPU", COL.rpu, y);
        doc.text("Nombre", COL.nombre, y);
        doc.text("Dirección", COL.direccion, y);
        doc.text("Caminata", COL.caminata, y);
        y += 8;

        trip.points.forEach((p, i) => {
            const pr = p.props || {};
            const orden = String(i + 1).padStart(2, "0");
            const rpu = String(pr.Rpu || "");
            const nombre = String(pr.Nombre || "");
            const direccion = String(pr.Direccion || "");
            // Distancia real entre este punto y el anterior (solo ida en el cluster)
            const walkM = Math.round((p.walkKmFromPrev || 0) * 1000);

            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);

            // ---- Dirección con ajuste de texto (como Excel) ----
            const dirLines = doc.splitTextToSize(direccion, W.direccion);
            const nomLines = doc.splitTextToSize(nombre, W.nombre);
            const linesUsed = Math.max(dirLines.length, nomLines.length, 1);
            const rowH = Math.max(7, linesUsed * 4.2 + 2);

            // Salto de página si no cabe la fila
            if (y + rowH > 280) {
                doc.addPage();
                y = 20;
                // repetir encabezado
                doc.setFillColor(230, 230, 230);
                doc.rect(15, y - 5, 180, 8, "F");
                doc.setFont("helvetica", "bold");
                doc.setFontSize(9);
                doc.setTextColor(0);
                doc.text("Orden", COL.orden, y);
                doc.text("RPU", COL.rpu, y);
                doc.text("Nombre", COL.nombre, y);
                doc.text("Dirección", COL.direccion, y);
                doc.text("Caminata", COL.caminata, y);
                y += 8;
                doc.setFont("helvetica", "normal");
                doc.setFontSize(8);
            }

            // Fondo alternado
            if (i % 2 === 0) doc.setFillColor(248, 248, 248);
            else doc.setFillColor(255, 255, 255);
            doc.rect(15, y - 4, 180, rowH, "F");

            const textY = y + 1;

            doc.setTextColor(0);
            doc.text(orden, COL.orden, textY);
            doc.text(rpu, COL.rpu, textY);

            // Nombre (puede ser 1–2 líneas)
            doc.text(nomLines, COL.nombre, textY);

            // Dirección multilínea
            doc.text(dirLines, COL.direccion, textY);

            // Caminata: solo si hay tramo a pie y sin salirse de columna
            if (walkM > 5) {
                doc.setTextColor(255, 140, 0);
                doc.setFont("helvetica", "bold");
                doc.text(`${walkM} m`, COL.caminata, textY);
                doc.setFont("helvetica", "normal");
                doc.setTextColor(0);
            }

            y += rowH;
        });

        y += 8;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(220, 80, 0);
        doc.text("→ Regresar a la Oficina CFE al finalizar la ruta", 20, y);
        y += 16;
    });

    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.setFont("helvetica", "normal");
    doc.text("Optimizador de Rutas CFE Valles · Generado automáticamente", 105, 290, { align: "center" });

    doc.save(`RUTA_CFE_${new Date().toLocaleDateString('en-CA')}.pdf`);
}


/* =========================================================
   13. GPS NAVIGATION (calles + indicaciones + tarjeta colapsable)
   ========================================================= */
let currentStep = 0;
let allSteps = [];
let watchId = null;
let navMap = null;
let carMarker = null;
let targetMarker = null;
let routePolyline = null;
let segmentPolyline = null;
let isNavigating = false;
let currentDay = 0;
let tripData = null;
let sheetCollapsed = false;


/* ---- Traducir maniobras OSRM a español ---- */
function osrmManeuverToEs(maneuver, streetName) {
    const type = (maneuver && maneuver.type) || '';
    const mod = (maneuver && maneuver.modifier) || '';
    const street = streetName ? ` en ${streetName}` : '';

    const mods = {
        left: 'a la izquierda',
        right: 'a la derecha',
        'slight left': 'ligeramente a la izquierda',
        'slight right': 'ligeramente a la derecha',
        'sharp left': 'cerrada a la izquierda',
        'sharp right': 'cerrada a la derecha',
        straight: 'de frente',
        uturn: 'en U'
    };
    const dir = mods[mod] || '';

    switch (type) {
        case 'depart':
            return streetName ? `Sal hacia ${streetName}` : 'Inicia el recorrido';
        case 'arrive':
            return 'Has llegado al destino';
        case 'turn':
            return `Gira ${dir}${street}`;
        case 'new name':
            return streetName ? `Continúa por ${streetName}` : 'Continúa de frente';
        case 'continue':
            return streetName ? `Sigue por ${streetName}` : 'Continúa de frente';
        case 'merge':
            return `Incorpórate ${dir}${street}`;
        case 'on ramp':
            return `Toma la rampa ${dir}${street}`;
        case 'off ramp':
            return `Sal de la rampa ${dir}${street}`;
        case 'fork':
            return `Toma el camino ${dir}${street}`;
        case 'end of road':
            return `Al final de la calle, gira ${dir}${street}`;
        case 'roundabout':
        case 'rotary':
            return `En la glorieta, toma la salida ${dir}${street}`;
        case 'notification':
            return streetName ? `Continúa por ${streetName}` : 'Continúa';
        default:
            if (streetName) return `Continúa por ${streetName}`;
            return 'Continúa por la ruta';
    }
}

/* ---- Pedir a OSRM la ruta por calles + pasos ---- */
async function fetchOsrmSteps(fromLatLon, toLatLon) {
    // from/to = [lat, lon]
    const coords = `${fromLatLon[1]},${fromLatLon[0]};${toLatLon[1]},${toLatLon[0]}`;
    const url =
        `${OSRM_URL}/route/v1/driving/${coords}` +
        `?overview=full&geometries=geojson&steps=true&annotations=false`;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
        const j = await res.json();
        if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('OSRM bad');

        const route = j.routes[0];
        const leg = route.legs && route.legs[0];
        const steps = [];

        if (leg && leg.steps) {
            for (const s of leg.steps) {
                const name = (s.name || '').trim();
                const text = osrmManeuverToEs(s.maneuver, name);
                const distM = Math.round(s.distance || 0);
                steps.push({
                    text,
                    distanceM: distM,
                    name,
                    location: s.maneuver && s.maneuver.location
                        ? [s.maneuver.location[1], s.maneuver.location[0]]
                        : null
                });
            }
        }

        const line = (route.geometry && route.geometry.coordinates)
            ? route.geometry.coordinates.map(c => [c[1], c[0]])
            : [fromLatLon, toLatLon];

        return {
            line,
            distanceM: Math.round(route.distance || 0),
            durationMin: Math.round((route.duration || 0) / 60),
            steps
        };
    } catch (e) {
        console.warn('OSRM steps fallback', e);
        const d = haversineKm(fromLatLon, toLatLon) * 1000;
        return {
            line: [fromLatLon, toLatLon],
            distanceM: Math.round(d),
            durationMin: Math.round((d / 1000 / 30) * 60),
            steps: [{ text: 'Dirígete al siguiente punto', distanceM: Math.round(d), name: '', location: null }]
        };
    }
}

/* ---- Navegación POR CALLE (no medidor por medidor) ----
   Cada paso = un tramo de calle: los servicios seguidos de la misma calle.
   Se dice UNA sola indicación por tramo ("Gira a la derecha. En calle X toma n lecturas,
   empieza en el número N, medidor M") y luego se guarda silencio mientras se lee la calle. */

const NAV_DRIVE_GAP_M = 250;     // si el siguiente tramo está más lejos, la indicación es en vehículo (OSRM)
const NAV_SPLIT_GAP_M = 120;     // misma calle pero con un hueco mayor = otro tramo
const NAV_STRAY_MAX = 2;         // 1-2 servicios de otra calle en medio (esquinas) no parten el tramo

function _navStreetParse(dir) {
    // "RIO PANUCO 604 CP 79050" -> { key: "PANUCO", name: "Rio Panuco", num: 604 }
    let t = String(dir || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    t = t.replace(/[#.,;:()\/\\-]/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(CALLE|AV|AVENIDA|PRIV|PRIVADA|CDA|CERRADA|C)\s+/, '');
    const m = t.match(/^(.*?)\s+(\d{1,5})\b/);
    let name = m && m[1] ? m[1] : t.split(/\s+(?:NO|NUM|S N|SN|COL|FRACC|CP)\b/)[0];
    const num = m ? parseInt(m[2], 10) : null;
    name = (name || '').trim();
    const words = name.split(' ').filter(w => !['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'RIO', 'NO', 'S', 'N', 'SN'].includes(w));
    const key = words.length ? words.sort((a, b) => b.length - a.length)[0] : '';
    const nice = name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    return { key, name: nice, num: Number.isFinite(num) ? num : null };
}

function _navBearing(a, b) {   // a, b = [lat, lon]  -> grados (0 = norte, 90 = este)
    const r = Math.PI / 180;
    const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
    const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
}

function _navTurnText(fromBrg, toBrg) {
    if (fromBrg == null || toBrg == null) return '';
    const d = ((toBrg - fromBrg + 540) % 360) - 180;   // + = derecha
    const a = Math.abs(d);
    if (a < 30) return 'Sigue de frente';
    if (a < 70) return d > 0 ? 'Ve ligeramente a la derecha' : 'Ve ligeramente a la izquierda';
    if (a < 145) return d > 0 ? 'Gira a la derecha' : 'Gira a la izquierda';
    return 'Da la vuelta y regresa';
}

function _navCardinal(brg) {
    const n = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
    return n[Math.round(brg / 45) % 8];
}

function _navMeterLabel(p) {
    const pr = p.props || {};
    const med = String(pr.Medidor || pr.CodigoMedidor || '').trim();
    return med && med !== 'undefined' ? med : '';
}

/* ---- Construir pasos: un paso por TRAMO DE CALLE ---- */
function buildStepsFromTrip(trip) {
    const points = trip.points || [];
    const info = points.map(p => {
        const pr = p.props || {};
        const st = _navStreetParse(pr.Direccion || '');
        return { p, key: st.key, name: st.name, num: st.num };
    });

    // 1) tramos: servicios seguidos con la misma calle; un hueco grande parte el tramo
    const runs = [];
    info.forEach((it, i) => {
        const last = runs[runs.length - 1];
        const gapM = i > 0 ? haversineKm([info[i - 1].p.lat, info[i - 1].p.lon], [it.p.lat, it.p.lon]) * 1000 : 0;
        if (last && it.key && last.key === it.key && gapM <= NAV_SPLIT_GAP_M) last.items.push(it);
        else if (last && !it.key && gapM <= 40) last.items.push(it);      // sin dirección: se pega al tramo si está junto
        else runs.push({ key: it.key, items: [it] });
    });
    // 2) esquinas: 1-2 servicios de otra calle entre dos tramos de la MISMA calle -> un solo tramo
    for (let i = 1; i < runs.length - 1; i++) {
        const a = runs[i - 1], x = runs[i], b = runs[i + 1];
        if (a && b && a.key && a.key === b.key && x.items.length <= NAV_STRAY_MAX) {
            a.items = a.items.concat(x.items, b.items);
            runs.splice(i, 2);
            i--;
        }
    }
    // 3) tramos sueltos de 1 servicio pegados al anterior (<= 30 m) se suman a él
    for (let i = runs.length - 1; i > 0; i--) {
        const r = runs[i], prev = runs[i - 1];
        if (r.items.length === 1) {
            const a = prev.items[prev.items.length - 1].p, b = r.items[0].p;
            if (haversineKm([a.lat, a.lon], [b.lat, b.lon]) * 1000 <= 30) {
                prev.items = prev.items.concat(r.items);
                runs.splice(i, 1);
            }
        }
    }

    // 4) pasos
    const steps = [];
    let prevEnd = null, prevBrg = null, cum = 0;
    runs.forEach((run, gi) => {
        const items = run.items;
        const pts = items.map(it => it.p);
        const first = pts[0], last = pts[pts.length - 1];
        // nombre de la calle = el que más se repite
        const cnt = {};
        items.forEach(it => { if (it.name) cnt[it.name] = (cnt[it.name] || 0) + 1; });
        const street = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || '';
        // lado de la calle por par/non
        const nums = items.map(it => it.num).filter(n => n != null);
        let side = '';
        if (nums.length >= 3) {
            const ev = nums.filter(n => n % 2 === 0).length;
            if (ev >= 0.8 * nums.length) side = 'pares';
            else if (ev <= 0.2 * nums.length) side = 'nones';
            else side = 'ambos';
        }
        const firstNum = items[0].num, lastNum = items[items.length - 1].num;
        // alertas de reincidencia dentro del tramo
        let nRein = 0, nSinUso = 0;
        const alertIdx = [];
        pts.forEach((p, k) => {
            const al = getReincidentAlerts(String((p.props || {}).Rpu || ''));
            if (al.length) {
                nRein++;
                if (isSinUsoAlert(al)) nSinUso++;
                alertIdx.push(k);
            }
        });
        // cómo llegar: a pie (giro relativo) o en vehículo (OSRM)
        const from = prevEnd || CFE_START;
        const gapM = Math.round(haversineKm(from, [first.lat, first.lon]) * 1000);
        const mode = (!prevEnd || gapM > NAV_DRIVE_GAP_M) ? 'drive' : 'walk';
        const toBrg = _navBearing(from, [first.lat, first.lon]);
        let approach;
        if (mode === 'walk') {
            const turn = prevBrg != null ? _navTurnText(prevBrg, toBrg) : `Camina hacia el ${_navCardinal(toBrg)}`;
            approach = gapM <= 12 ? 'Cruza o sigue' : `${turn} ${gapM} m`;
        } else {
            approach = 'Dirígete';
        }
        // dirección de avance dentro de la calle (para el giro del siguiente tramo)
        const inBrg = pts.length >= 2 ? _navBearing([pts[pts.length - 2].lat, pts[pts.length - 2].lon], [last.lat, last.lon]) : toBrg;

        steps.push({
            isGroup: true,
            groupIndex: gi,
            mode,
            approach,
            gapM,
            street,
            side,
            firstNum,
            lastNum,
            members: pts,
            groupSize: pts.length,
            cumBefore: cum,
            firstMeter: _navMeterLabel(first),
            firstRpu: String((first.props || {}).Rpu || ''),
            firstAddr: String((first.props || {}).Direccion || ''),
            lastAddr: String((last.props || {}).Direccion || ''),
            targetLat: first.lat,
            targetLon: first.lon,
            endLat: last.lat,
            endLon: last.lon,
            reincidente: nRein > 0,
            sinUso: nSinUso > 0,
            nRein, nSinUso, alertIdx,
            phase: 'approach',
            readIdx: 0,
            osrmSteps: [],
            osrmLine: null,
            osrmDistM: null,
            text: ''
        });
        cum += pts.length;
        prevEnd = [last.lat, last.lon];
        prevBrg = inBrg;
    });

    steps.push({
        text: 'Ruta del día terminada. Regresa a la Oficina CFE.',
        mode: 'drive',
        targetLat: CFE_START[0],
        targetLon: CFE_START[1],
        rpu: 'CFE',
        nombre: 'Oficina CFE',
        direccion: 'Oficina CFE Ciudad Valles',
        isReturn: true,
        members: [],
        groupSize: 0,
        cumBefore: cum,
        osrmSteps: [],
        osrmLine: null,
        osrmDistM: null
    });
    return steps;
}

/* Frase principal del tramo (pantalla y voz) */
function _navGroupSentence(step, forVoice) {
    if (step.isReturn) return 'Ruta terminada. Regresa a la oficina CFE.';
    const calle = step.street ? `calle ${step.street}` : 'esta calle';
    const n = step.groupSize;
    let s = `En ${calle} toma ${n} ${n === 1 ? 'lectura' : 'lecturas'}`;
    if (step.side === 'pares' || step.side === 'nones') s += `, del lado de los números ${step.side}`;
    else if (step.side === 'ambos' && n >= 4) s += ', de los dos lados';
    s += '.';
    const start = [];
    if (step.firstNum != null) start.push(`número ${step.firstNum}`);
    if (step.firstMeter) start.push(`medidor ${forVoice ? step.firstMeter.split('').join(' ') : step.firstMeter}`);
    if (start.length) s += ` Empieza en el ${start.join(', ')}.`;
    if (step.nSinUso) s += ` Ojo: ${step.nSinUso} ${step.nSinUso === 1 ? 'servicio sin uso reincidente' : 'servicios sin uso reincidentes'}.`;
    else if (step.nRein) s += ` Ojo: ${step.nRein} con anomalía reincidente.`;
    return s;
}

async function loadSegmentRoute(stepIndex) {
    if (!allSteps.length || stepIndex < 0 || stepIndex >= allSteps.length) return;
    const step = allSteps[stepIndex];
    let from;
    if (stepIndex === 0) from = CFE_START;
    else {
        const prev = allSteps[stepIndex - 1];
        from = prev.endLat != null ? [prev.endLat, prev.endLon] : [prev.targetLat, prev.targetLon];
    }
    const to = [step.targetLat, step.targetLon];

    if (step.mode === 'walk') {
        step.osrmLine = [from, to];
        step.osrmDistM = step.gapM != null ? step.gapM : Math.round(haversineKm(from, to) * 1000);
        step.osrmSteps = [{ text: step.approach, distanceM: step.osrmDistM }];
        step.text = `${step.approach}. ${_navGroupSentence(step, false)}`;
        return;
    }
    const result = await fetchOsrmSteps(from, to);
    step.osrmLine = result.line;
    step.osrmDistM = result.distanceM;
    step.osrmSteps = result.steps;
    const firstMan = (result.steps.find(s => s.text && !s.text.includes('Has llegado')) || result.steps[0] || {}).text || 'Dirígete al siguiente tramo';
    const km = result.distanceM >= 1000 ? `${(result.distanceM / 1000).toFixed(1)} km` : `${result.distanceM} m`;
    step.approach = `${firstMan} (${km})`;
    step.text = step.isReturn ? `${firstMan} (${km}). Regresa a la oficina CFE.` : `${step.approach}. ${_navGroupSentence(step, false)}`;
}

let groupLayer = null;
function drawSegmentLine(step) {
    if (!navMap) return;
    if (segmentPolyline) { navMap.removeLayer(segmentPolyline); segmentPolyline = null; }
    if (groupLayer) { navMap.removeLayer(groupLayer); groupLayer = null; }

    const line = step.osrmLine && step.osrmLine.length >= 2
        ? step.osrmLine
        : [[carMarker ? carMarker.getLatLng().lat : CFE_START[0], carMarker ? carMarker.getLatLng().lng : CFE_START[1]],
            [step.targetLat, step.targetLon]];
    segmentPolyline = L.polyline(line, {
        color: step.mode === 'walk' ? '#ff7f00' : '#00a651', weight: 5, opacity: 0.9,
        dashArray: step.mode === 'walk' ? '8 8' : null
    }).addTo(navMap);

    // los servicios del tramo: el recorrido de la calle y cada medidor numerado
    groupLayer = L.layerGroup().addTo(navMap);
    const mem = step.members || [];
    if (mem.length >= 2) {
        L.polyline(mem.map(p => [p.lat, p.lon]), { color: '#1F5B51', weight: 3, opacity: 0.55 }).addTo(groupLayer);
    }
    mem.forEach((p, k) => {
        const done = step.phase === 'reading' && k < step.readIdx;
        const isAlert = (step.alertIdx || []).includes(k);
        L.circleMarker([p.lat, p.lon], {
            radius: k === 0 ? 9 : 6, color: '#fff', weight: 2,
            fillColor: done ? '#94a3b8' : (isAlert ? '#e31a1c' : (k === 0 ? '#00a651' : '#1F5B51')), fillOpacity: 1
        }).bindTooltip(String(step.cumBefore + k + 1), { permanent: mem.length <= 25, direction: 'top', className: 'nav-num' })
            .addTo(groupLayer);
    });
    try {
        const b = L.latLngBounds(line.concat(mem.map(p => [p.lat, p.lon])));
        navMap.fitBounds(b, { padding: [60, 60], maxZoom: 18 });
    } catch (e) { }
}

/* Aviso corto al llegar al inicio de una calle (sin picarle a "Siguiente") */
function _navArrivalSentence(step) {
    const calle = step.street ? `calle ${step.street}` : 'la calle';
    const n = step.groupSize || (step.members ? step.members.length : 0);
    let s = `Llegaste a ${calle}. Empieza a leer: ${n} ${n === 1 ? 'lectura' : 'lecturas'}`;
    if (step.firstNum != null) s += `, primero el número ${step.firstNum}`;
    s += '.';
    if (step.side === 'pares' || step.side === 'nones') s += ` Del lado de los números ${step.side}.`;
    return s;
}

let _lastSpoken = '';
function _navSay(text) {
    if (!window.speechSynthesis || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-MX';
    u.rate = 0.98;
    speechSynthesis.speak(u);
    _lastSpoken = text;
}

async function updateNavUI(speak, forceSpeak) {
    const step = allSteps[currentStep];
    if (!step) return;
    const inst = document.getElementById('navInstruction');
    if (!step.osrmLine) {
        if (inst) inst.textContent = 'Calculando cómo llegar…';
        await loadSegmentRoute(currentStep);
    }
    drawSegmentLine(step);

    const rpu = document.getElementById('navRpu');
    const addr = document.getElementById('navAddress');
    const modeIcon = document.getElementById('navModeIcon');
    const distEl = document.getElementById('navDistance');
    const distTop = document.getElementById('navDistanceTop');
    const stepCounter = document.getElementById('stepCounter');
    const totalSteps = document.getElementById('totalSteps');
    const navCurrent = document.getElementById('navCurrent');
    const navETA = document.getElementById('navETA');
    const destLabel = document.querySelector('.gmaps-dest-label');
    const totalReads = (allSteps[allSteps.length - 1] || {}).cumBefore || 0;

    if (step.isReturn) {
        if (inst) inst.textContent = step.text;
        if (destLabel) destLabel.textContent = 'Destino';
        if (rpu) rpu.textContent = 'Oficina CFE';
        if (addr) addr.textContent = `Lecturas de la ruta: ${totalReads}`;
    } else if (step.phase === 'reading') {
        const k = Math.min(step.readIdx, step.groupSize - 1);
        const p = step.members[k];
        const left = step.groupSize - k;
        if (inst) inst.textContent = `Leyendo calle ${step.street || ''}: vas en la ${k + 1} de ${step.groupSize} (${left} por leer)`;
        if (destLabel) destLabel.textContent = 'Medidor cercano';
        if (rpu) rpu.textContent = [_navMeterLabel(p) ? `Medidor ${_navMeterLabel(p)}` : '', `RPU ${(p.props || {}).Rpu || ''}`].filter(Boolean).join(' · ');
        if (addr) addr.textContent = String((p.props || {}).Direccion || '');
    } else {
        if (inst) inst.textContent = step.text || _navGroupSentence(step, false);
        if (destLabel) destLabel.textContent = `Siguiente calle · ${step.groupSize} ${step.groupSize === 1 ? 'lectura' : 'lecturas'}`;
        if (rpu) {
            rpu.textContent = [step.street || 'Calle sin nombre',
                step.firstNum != null && step.lastNum != null && step.firstNum !== step.lastNum ? `del ${step.firstNum} al ${step.lastNum}` : ''
            ].filter(Boolean).join(' · ');
        }
        if (addr) {
            const parts = [`Primero: ${step.firstAddr || '—'}`];
            if (step.firstMeter) parts.push(`medidor ${step.firstMeter}`);
            if (step.firstRpu) parts.push(`RPU ${step.firstRpu}`);
            addr.textContent = parts.join(' · ');
        }
    }

    if (modeIcon) {
        const walk = step.mode === 'walk' || step.phase === 'reading';
        modeIcon.textContent = step.phase === 'reading' ? '📋' : (walk ? '🚶' : '🚗');
        modeIcon.classList.toggle('is-walk', walk);
    }
    if (stepCounter) stepCounter.textContent = String(Math.min(currentStep + 1, allSteps.length - 1));
    if (totalSteps) totalSteps.textContent = String(Math.max(1, allSteps.length - 1));
    const progWrap = stepCounter && stepCounter.parentElement;
    if (progWrap) {
        const doneReads = step.isReturn ? totalReads : step.cumBefore + (step.phase === 'reading' ? step.readIdx : 0);
        progWrap.innerHTML = `Calle <strong id="stepCounter">${Math.min(currentStep + 1, allSteps.length - 1)}</strong> de <strong id="totalSteps">${Math.max(1, allSteps.length - 1)}</strong> · ${doneReads} de ${totalReads} lecturas`;
    }
    if (navCurrent) navCurrent.textContent = `Día ${currentDay + 1}`;
    const distM = step.osrmDistM != null ? step.osrmDistM : step.gapM;
    const distTxt = distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${distM != null ? distM : '—'} m`;
    if (distEl && !distEl.dataset.live) distEl.textContent = distTxt;
    if (distTop && !distTop.dataset.live) distTop.textContent = distTxt;
    if (navETA) navETA.textContent = step.phase === 'reading' ? 'Leyendo' : (step.mode === 'walk' ? 'A pie' : 'En vehículo');

    if (navMap && step.targetLat != null) {
        if (targetMarker) navMap.removeLayer(targetMarker);
        targetMarker = null;
        if (step.isReturn) {
            targetMarker = L.circleMarker([step.targetLat, step.targetLon], {
                radius: 11, color: '#fff', weight: 3, fillColor: '#003087', fillOpacity: 1
            }).addTo(navMap);
        }
    }

    // Voz: solo al llegar a un tramo nuevo (no medidor por medidor)
    if (speak && (step.phase !== 'reading' || forceSpeak)) {
        if (step.isReturn) _navSay(step.text || 'Ruta terminada. Regresa a la oficina CFE.');
        else _navSay(`${step.approach}. ${_navGroupSentence(step, true)}`);
    }
}

function onLocationUpdate(position) {
    if (!isNavigating) return;
    const { latitude, longitude } = position.coords;
    const here = [latitude, longitude];
    if (carMarker) carMarker.setLatLng(here);
    const step = allSteps[currentStep];
    if (!step || step.targetLat == null) return;

    const distEl = document.getElementById('navDistance');
    const distTop = document.getElementById('navDistanceTop');
    const setDist = (m) => {
        const txt = m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
        if (distEl) { distEl.textContent = txt; distEl.dataset.live = '1'; }
        if (distTop) { distTop.textContent = txt; distTop.dataset.live = '1'; }
    };
    if (navMap) navMap.setView(here, Math.max(navMap.getZoom(), 17), { animate: true });

    if (step.isReturn) {
        setDist(haversineKm(here, [step.targetLat, step.targetLon]) * 1000);
        return;
    }

    // ya va en las últimas lecturas de esta calle y está en el inicio de la siguiente -> adelantar
    {
        const j = 1;
        const s2 = allSteps[currentStep + j];
        const ok = s2 && !s2.isReturn && s2.members && s2.members.length;
        const d2 = ok ? haversineKm(here, [s2.targetLat, s2.targetLon]) * 1000 : Infinity;
        const stepAlmostDone = step.phase === 'reading' && step.readIdx >= step.groupSize - 3;
        if (ok && d2 < 20 && stepAlmostDone) {
            currentStep += j;
            s2.phase = 'reading';
            s2.readIdx = 0;
            if (distEl) delete distEl.dataset.live;
            if (distTop) delete distTop.dataset.live;
            updateNavUI(true, true);      // dice la calle aunque ya esté en ella (cuántas lecturas, lado, etc.)
            return;
        }
    }

    if (step.phase !== 'reading') {
        const dFirst = haversineKm(here, [step.targetLat, step.targetLon]) * 1000;
        setDist(dFirst);
        // llegó al tramo: cuenta el primer medidor o cualquiera de los primeros (si ya lo pasó)
        let bk = -1, bd = Infinity;
        for (let k = 0; k < Math.min(step.members.length, 12); k++) {
            const d = haversineKm(here, [step.members[k].lat, step.members[k].lon]) * 1000;
            if (d < bd) { bd = d; bk = k; }
        }
        if (bd < 30) {               // llegó: empieza a leer y se lo dice en voz alta
            step.phase = 'reading';
            step.readIdx = Math.max(0, bk);
            updateNavUI(false);
            _navSay(_navArrivalSentence(step));
        }
        return;
    }

    // leyendo la calle: medidor más cercano HACIA ADELANTE (no se regresa en el conteo)
    const mem = step.members;
    let best = step.readIdx, bestD = Infinity;
    const dk = [];
    for (let k = step.readIdx; k < Math.min(mem.length, step.readIdx + 8); k++) {
        const d = haversineKm(here, [mem[k].lat, mem[k].lon]) * 1000;
        dk.push([k, d]);
        if (d < bestD) { bestD = d; best = k; }
    }
    // medidores en el mismo punto (o a pocos metros) cuentan juntos: avanzar al más adelantado
    dk.forEach(([k, d]) => { if (d <= bestD + 8 && k > best) best = k; });
    if (best !== step.readIdx && bestD < 25) {
        step.readIdx = best;
        updateNavUI(false);
    }
    const lastP = mem[mem.length - 1];
    const dLast = haversineKm(here, [lastP.lat, lastP.lon]) * 1000;
    setDist(dLast);
    // terminó la calle: está en el último medidor, o ya se fue rumbo al siguiente tramo
    const next = allSteps[currentStep + 1];
    const dNext = next && next.targetLat != null ? haversineKm(here, [next.targetLat, next.targetLon]) * 1000 : Infinity;
    if ((step.readIdx >= mem.length - 1 && dLast < 30) || (step.readIdx >= mem.length - 2 && dNext < dLast)) {
        if (currentStep < allSteps.length - 1) {
            currentStep++;
            if (distEl) delete distEl.dataset.live;
            if (distTop) delete distTop.dataset.live;
            updateNavUI(true);
        }
    }
}

function toggleNavSheet() {
    const sheet = document.querySelector('.gmaps-sheet');
    if (!sheet) return;
    sheetCollapsed = !sheetCollapsed;
    sheet.classList.toggle('is-collapsed', sheetCollapsed);
    // al mostrar de nuevo, invalidar mapa
    if (!sheetCollapsed && navMap) {
        setTimeout(() => navMap.invalidateSize(true), 300);
    }
}

async function startGPSNavigation(data) {
    if (!data || !data.trips || !data.trips.length) {
        alert('Primero genera las rutas');
        return;
    }

    tripData = data;
    const navScreen = document.getElementById('navigationScreen');
    if (!navScreen) {
        alert('No se encuentra #navigationScreen');
        return;
    }

    navScreen.classList.add('is-open');
    navScreen.style.display = 'block';
    isNavigating = true;
    sheetCollapsed = false;
    const sheet = document.querySelector('.gmaps-sheet');
    if (sheet) sheet.classList.remove('is-collapsed');

    // Handle para colapsar
    const handle = document.querySelector('.gmaps-handle');
    if (handle) {
        handle.onclick = toggleNavSheet;
        handle.title = 'Mostrar / ocultar panel';
    }

    const daySelect = document.getElementById('navDaySelect');
    if (daySelect) {
        daySelect.innerHTML = '';
        data.trips.forEach((t, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            opt.textContent = `Día ${idx + 1} (${t.points.length} visitas)`;
            daySelect.appendChild(opt);
        });
        daySelect.onchange = () => {
            currentDay = parseInt(daySelect.value, 10) || 0;
            startDayNavigation(data.trips[currentDay]);
        };
    }

    const btnNext = document.getElementById('btnNextStep');
    const btnPrev = document.getElementById('btnPrevStep');
    if (btnNext) {
        btnNext.onclick = async () => {
            if (currentStep < allSteps.length - 1) {
                currentStep++;
                await updateNavUI(true);
            } else {
                stopGPSNavigation();
            }
        };
    }
    if (btnPrev) {
        btnPrev.onclick = async () => {
            if (currentStep > 0) {
                currentStep--;
                await updateNavUI(true);
            }
        };
    }

    currentDay = 0;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => startDayNavigation(data.trips[0]));
    });
}

function startDayNavigation(trip) {
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();

    if (navMap) {
        navMap.remove();
        navMap = null;
    }
    carMarker = null;
    targetMarker = null;
    routePolyline = null;
    segmentPolyline = null;
    groupLayer = null;

    allSteps = buildStepsFromTrip(trip);
    currentStep = 0;

    const mapEl = document.getElementById('mapNav');
    if (!mapEl) {
        alert('No existe #mapNav en el HTML');
        return;
    }

    navMap = L.map(mapEl, { zoomControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
    }).addTo(navMap);

    carMarker = L.marker(CFE_START, {
        icon: L.divIcon({
            className: '',
            html: '<div style="font-size:36px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))">🚗</div>',
            iconSize: [40, 40],
            iconAnchor: [20, 20]
        })
    }).addTo(navMap);

    const refreshMap = () => {
        if (!navMap) return;
        navMap.invalidateSize(true);
    };
    setTimeout(refreshMap, 50);
    setTimeout(refreshMap, 250);
    setTimeout(refreshMap, 500);

    if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(
            onLocationUpdate,
            onLocationError,
            { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 }
        );
    }

    updateNavUI(true);
}

function onLocationError(err) {
    console.warn('GPS:', err);
}

window.stopGPSNavigation = function () {
    isNavigating = false;
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (navMap) {
        navMap.remove();
        navMap = null;
    }
    carMarker = null;
    targetMarker = null;
    routePolyline = null;
    segmentPolyline = null;
    groupLayer = null;

    const navScreen = document.getElementById('navigationScreen');
    if (navScreen) {
        navScreen.classList.remove('is-open');
        navScreen.style.display = 'none';
    }
};


/* =========================================================
   14. EVENT LISTENERS
   ========================================================= */
if (btnToggleAll) {
    btnToggleAll.addEventListener('click', () => {
        if (!filtersEl) return;
        const cbs = Array.from(filtersEl.querySelectorAll('input[type="checkbox"]'));
        if (!cbs.length) return;
        const allChecked = cbs.every(cb => cb.checked);
        cbs.forEach(cb => cb.checked = !allChecked);
        applyFilter();
    });
}

if (btnMedGo) {
    btnMedGo.addEventListener('click', () => {
        const needle = (qMedEl && qMedEl.value || '').trim().toLowerCase();
        if (!needle) { applyFilter(); return; }
        const matches = allMarkers.filter(m => (m.__medcode || '') === needle);
        if (matches.length === 1) {
            const m = matches[0];
            map.setView(m.getLatLng(), Math.max(map.getZoom(), 16));
            m.openPopup();
        } else if (matches.length > 1) {
            try { map.fitBounds(L.featureGroup(matches).getBounds(), { padding: [20, 20] }); } catch (e) { }
        } else applyFilter();
    });
}

if (fileInput) {
    fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (f) handleFile(f);
    });
}

if (btnClear) {
    btnClear.addEventListener('click', () => {
        if (qEl) qEl.value = '';
        applyFilter();
    });
}

if (qEl) qEl.addEventListener('input', () => applyFilter());
if (qMedEl) qMedEl.addEventListener('input', () => applyFilter());

if (btnClearMap) {
    btnClearMap.addEventListener('click', () => {
        clearTrips();
        markers.clearLayers();
        allMarkers = [];
        anomalies = new Set();
        if (filtersEl) filtersEl.innerHTML = '';
        if (qEl) qEl.value = '';
        if (qMedEl) qMedEl.value = '';
        if (countEl) countEl.textContent = '';
        if (dropsEl) dropsEl.textContent = '';
        setTimeout(() => map.invalidateSize(), 10);
    });
}

if (btnResetView) {
    btnResetView.addEventListener('click', () => {
        try { map.fitBounds(markers.getBounds(), { padding: [20, 20] }); }
        catch (e) { map.setView(CFE_START, 11); }
        setTimeout(() => map.invalidateSize(), 10);
    });
}

if (btnClearCache) {
    btnClearCache.addEventListener('click', () => {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('osrm_edge_')) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
        osrmCacheMem.clear();
        alert('Cache OSRM limpiada (' + keys.length + ' entradas).');
    });
}

/* =========================================================
   REPORTE DE RESULTADOS (PDF)
   Resumen de lo que calculó el sistema para la ruta generada:
   indicadores, croquis del recorrido, cómo se eligió la ruta,
   historial de la ruta por mes, territorio y anomalías reincidentes.
   ========================================================= */
async function exportResultsReportPDF() {
    const data = window.lastRouteData;
    const res = window.lastOptimizeResult || {};
    const meta = window.lastOptimizeMeta || {};
    if (!data || !data.trips || !data.trips.length) {
        alert('Primero genera la ruta');
        return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('portrait', 'mm', 'a4');
    const PW = 210, PH = 297, M = 14, CW = PW - 2 * M;
    const C_DARK = [31, 91, 81], C_GREEN = [0, 122, 81], C_GRAY = [100, 116, 139], C_TEXT = [30, 41, 59];
    const C_LINE = [226, 232, 240], C_SOFT = [238, 246, 243];
    let y = 0;

    // jsPDF (helvetica) solo maneja Latin-1: quitar emojis y símbolos fuera de ese rango
    const clean = (s) => String(s == null ? '' : s)
        .replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/→/g, '->').replace(/↔/g, '<->')
        .replace(/★/g, '*').replace(/−/g, '-').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
        .replace(/[^\x20-\x7E -ÿ]/g, '')
        .replace(/\s+/g, ' ').trim();
    const num = (v, d = 0) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '-' : Number(v).toFixed(d);

    const header = (first) => {
        if (first) return;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C_GRAY);
        doc.text(clean('CFE Ciudad Valles - Reporte de resultados de la ruta'), M, 10);
        doc.setDrawColor(...C_LINE); doc.setLineWidth(0.3); doc.line(M, 12, PW - M, 12);
    };
    const ensure = (h) => {
        if (y + h > PH - 16) {
            doc.addPage();
            header(false);
            y = 18;
        }
    };
    const section = (title, minAfter = 22) => {
        ensure(14 + minAfter);   // no dejar un título solo al final de la página
        y += 2;
        doc.setFillColor(...C_DARK);
        doc.roundedRect(M, y, CW, 8, 1.5, 1.5, 'F');
        doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5);
        doc.text(clean(title), M + 3, y + 5.5);
        y += 12;
        doc.setTextColor(...C_TEXT);
    };
    const para = (text, opts = {}) => {
        const size = opts.size || 9;
        doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
        doc.setFontSize(size);
        doc.setTextColor(...(opts.color || C_TEXT));
        const lines = doc.splitTextToSize(clean(text), opts.width || CW);
        const lh = size * 0.42;
        lines.forEach(l => { ensure(lh + 1); doc.text(l, (opts.x || M), y); y += lh; });
        y += opts.after != null ? opts.after : 2;
    };
    const bullets = (items) => {
        items.forEach(it => {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...C_TEXT);
            const lines = doc.splitTextToSize(clean(it), CW - 6);
            ensure(lines.length * 3.9 + 1);
            doc.text('-', M + 1, y);
            lines.forEach(l => { doc.text(l, M + 5, y); y += 3.9; });
            y += 0.8;
        });
        y += 1.5;
    };
    // Tabla simple con ajuste de texto; widths en mm, align 'l' | 'r'
    const table = (heads, rows, widths, aligns, opts = {}) => {
        const fs = opts.size || 8;
        const lh = fs * 0.4;
        const drawHead = () => {
            ensure(9);
            doc.setFillColor(...C_SOFT); doc.rect(M, y - 4, CW, 7, 'F');
            doc.setFont('helvetica', 'bold'); doc.setFontSize(fs); doc.setTextColor(...C_DARK);
            let x = M;
            heads.forEach((h, i) => {
                const w = widths[i];
                if (aligns[i] === 'r') doc.text(clean(h), x + w - 1.5, y, { align: 'right' });
                else doc.text(clean(h), x + 1.5, y);
                x += w;
            });
            y += 5.6;
        };
        drawHead();
        rows.forEach((r, ri) => {
            const rowFont = (opts.boldRow && opts.boldRow(ri)) ? 'bold' : 'normal';
            doc.setFont('helvetica', rowFont);
            doc.setFontSize(fs);
            const cells = r.map((c, i) => doc.splitTextToSize(clean(c), widths[i] - 3));
            const nL = Math.max(1, ...cells.map(c => c.length));
            const rh = nL * lh + 2.2;
            if (y + rh > PH - 16) { doc.addPage(); header(false); y = 18; drawHead(); }
            doc.setFont('helvetica', rowFont);   // el encabezado deja la letra en negritas
            doc.setFontSize(fs);
            if (opts.highlight && opts.highlight(ri)) {
                doc.setFillColor(255, 247, 237); doc.rect(M, y - 3.6, CW, rh, 'F');
            }
            doc.setTextColor(...C_TEXT);
            let x = M;
            cells.forEach((lines, i) => {
                const w = widths[i];
                lines.forEach((l, li) => {
                    if (aligns[i] === 'r') doc.text(l, x + w - 1.5, y + li * lh, { align: 'right' });
                    else doc.text(l, x + 1.5, y + li * lh);
                });
                x += w;
            });
            doc.setDrawColor(...C_LINE); doc.setLineWidth(0.2);
            doc.line(M, y - 3.6 + rh, M + CW, y - 3.6 + rh);
            y += rh;
        });
        y += 3;
    };

    // ---------- datos ----------
    const trips = data.trips;
    const allPts = [];
    trips.forEach((t, di) => (t.points || []).forEach((p, i) => allPts.push({ ...p, _day: di, _i: i })));
    const totalPts = allPts.length;
    const kmVeh = trips.reduce((s, t) => s + (t.distKm || 0), 0);
    const kmWalk = trips.reduce((s, t) => s + (t.walkKm2Total || 0), 0);
    const lect = trips.reduce((s, t) => s + (t.lecturaMin != null ? t.lecturaMin : (t.timeMin || 0)), 0);
    const cfe = trips.reduce((s, t) => s + (t.trasladoCfeMin || 0), 0);
    const total = trips.reduce((s, t) => s + (t.timeMin || 0), 0);
    const dec = res.decision || {};
    const sp = res.street_plan || {};
    const park = (res.trips && res.trips[0] && res.trips[0].parking) || {};
    const parkPt = allPts.find(p => String((p.props || {}).Rpu || p.rpu || '') === String(park.rpu || '')) || null;
    const parkDir = parkPt ? ((parkPt.props || {}).Direccion || '') : '';
    const now = new Date();

    // ---------- portada / encabezado ----------
    y = 10;
    try {
        const logoImg = await fetch('logo-cfe.png').then(r => r.blob()).then(blob => new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        }));
        doc.addImage(logoImg, 'PNG', M, y, 44, 13);
    } catch (e) { }
    doc.setTextColor(...C_TEXT); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text(clean('Reporte de resultados de la ruta'), PW - M, y + 5, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...C_GRAY);
    doc.text(clean('CFE - Ciudad Valles - Área comercial (lectura de medidores)'), PW - M, y + 11, { align: 'right' });
    y = 30;

    // ficha de la ruta
    const ficha = [
        ['Fecha del reporte', `${now.toLocaleDateString('es-MX')} ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`],
        ['Archivo cargado', meta.fileName || '-'],
        ['Tarea', meta.tarea || '-'],
        ['Ruta (según Cuenta)', dec.ruta_id || '-'],
        ['Tipo de ruta', `${res.tipo_ruta || '-'}${res.perfil ? ' (perfil ' + res.perfil + ')' : ''}`],
        ['Población', res.poblacion && res.poblacion.poblacion
            ? `${pobLabel(res.poblacion.poblacion)} (Cuenta ${Object.keys(res.poblacion.tipos_cuenta || {}).slice(0, 3).join('/') || '-'}` +
              `${res.poblacion.medidores_km2 != null ? ', ' + Math.round(res.poblacion.medidores_km2) + ' medidores/km²' : ''})`
            : '-'],
        ['Zona · agencia', res.zona_agencia ? `${res.zona_agencia}${agencyFromCode(res.zona_agencia) ? ' · ' + agencyFromCode(res.zona_agencia).agencia : ''}` : '-'],
        ['Punto de camioneta (parking)', park.rpu ? `RPU ${park.rpu}${parkDir ? ' - ' + parkDir : ''} (${park.method === 'usuario_anclado' || (park.method || '').includes('user') ? 'elegido por el lecturista' : (park.method || 'sugerido')})` : '-'],
    ];
    doc.setDrawColor(...C_LINE); doc.setFillColor(248, 250, 252);
    const fichaH = ficha.length * 5.2 + 4;
    doc.roundedRect(M, y, CW, fichaH, 2, 2, 'FD');
    let yy = y + 5;
    ficha.forEach(([k, v]) => {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.6); doc.setTextColor(...C_GRAY);
        doc.text(clean(k), M + 3, yy);
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...C_TEXT);
        const vv = doc.splitTextToSize(clean(v), CW - 58)[0];
        doc.text(vv, M + 55, yy);
        yy += 5.2;
    });
    y += fichaH + 5;

    // ---------- indicadores ----------
    section('1. Resumen de la ruta propuesta');
    const kpis = [
        ['Servicios', String(totalPts)],
        ['Viajes / días', String(trips.length)],
        ['Caminata entre medidores', `${kmWalk.toFixed(2)} km`],
        ['Vehículo (CFE <-> parking)', `${kmVeh.toFixed(1)} km`],
        ['Lectura estimada (sin descansos)', `${lect.toFixed(0)} min`],
        ['Jornada típica (con pausas)', res.estimated_con_pausas_min != null ? `${num(res.estimated_con_pausas_min)} min` : '-'],
        ['Traslado oficina CFE', `${cfe.toFixed(0)} min`],
        ['Total orientativo del día', `${total.toFixed(0)} min`],
    ];
    const bw = (CW - 3 * 3) / 4, bh = 16;
    kpis.forEach((k, i) => {
        const col = i % 4, row = Math.floor(i / 4);
        const bx = M + col * (bw + 3), by = y + row * (bh + 3);
        doc.setFillColor(247, 252, 250); doc.setDrawColor(204, 227, 220);
        doc.roundedRect(bx, by, bw, bh, 1.8, 1.8, 'FD');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.2); doc.setTextColor(...C_GRAY);
        doc.splitTextToSize(clean(k[0]), bw - 4).slice(0, 2).forEach((l, li) => doc.text(l, bx + 2.2, by + 4.2 + li * 3));
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...C_DARK);
        doc.text(clean(k[1]), bx + 2.2, by + 13.2);
    });
    y += 2 * (bh + 3) + 2;
    const tline = [];
    if (dec.winner_label) tline.push(`Método elegido: ${dec.winner_label}.`);
    if (sp.n_streets != null) tline.push(`Calles detectadas: ${sp.n_streets} (${sp.street_source === 'direccion' ? 'por nombre de calle y número de la dirección' : 'por la posición de los puntos'}).`);
    if (dec.jumps_over_80m != null) tline.push(`Saltos de más de 80 m entre servicios seguidos: ${dec.jumps_over_80m}.`);
    if (res.productividad_ok === false) tline.push('La jornada estimada con pausas supera el límite de 390 min.');
    if (tline.length) para(tline.join(' '), { size: 8.8, color: C_TEXT });

    // avisos (p. ej. GPS dudoso)
    (dec.warnings || []).forEach(w => {
        const lines = doc.splitTextToSize(clean(w), CW - 6);
        const h = lines.length * 3.9 + 4;
        ensure(h + 2);
        doc.setFillColor(255, 251, 235); doc.setDrawColor(245, 158, 11);
        doc.roundedRect(M, y - 1, CW, h, 1.5, 1.5, 'FD');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.6); doc.setTextColor(146, 64, 14);
        lines.forEach((l, li) => doc.text(l, M + 3, y + 3 + li * 3.9));
        y += h + 3;
    });

    // ---------- croquis ----------
    // si no cabe un croquis decente en esta página, empezar una nueva (título + mapa juntos)
    if ((PH - 16) - y - 12 - 16 < 80) { doc.addPage(); header(false); y = 18; }
    section('2. Croquis del recorrido propuesto', 80);
    const mapH = Math.min(118, (PH - 16) - y - 16);
    const box = { x: M, y: y, w: CW, h: mapH };
    doc.setDrawColor(...C_LINE); doc.setFillColor(252, 253, 253);
    doc.rect(box.x, box.y, box.w, box.h, 'FD');
    // Coordenadas para dibujar: si el backend corrigió el GPS del archivo, usar las corregidas
    const fixedC = dec.gps_fixed_coords || {};
    const G = allPts.map(p => {
        const f = fixedC[String((p.props || {}).Rpu || p.rpu || '')];
        return f ? { lat: Number(f[0]), lon: Number(f[1]), _day: p._day } : { lat: p.lat, lon: p.lon, _day: p._day };
    });
    const lat0 = G.reduce((s, p) => s + p.lat, 0) / Math.max(1, totalPts);
    const kx = Math.cos(lat0 * Math.PI / 180);
    // Encuadre robusto: percentiles 1-99 (+15%), para que un punto con GPS malo no aplaste el dibujo
    const qtl = (arr, q) => { const a = arr.slice().sort((u, v) => u - v); return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]; };
    const gx = G.map(p => p.lon * kx), gy = G.map(p => p.lat);
    let minX = qtl(gx, 0.01), maxX = qtl(gx, 0.99), minY = qtl(gy, 0.01), maxY = qtl(gy, 0.99);
    const padX = (maxX - minX) * 0.15 + 1e-6, padY = (maxY - minY) * 0.15 + 1e-6;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    if (park.lat != null && park.lon != null) {
        minX = Math.min(minX, park.lon * kx); maxX = Math.max(maxX, park.lon * kx);
        minY = Math.min(minY, park.lat); maxY = Math.max(maxY, park.lat);
    }
    const inside = (p) => p.lon * kx >= minX && p.lon * kx <= maxX && p.lat >= minY && p.lat <= maxY;
    const nOut = G.filter(p => !inside(p)).length;
    const pad = 5;
    const sc = Math.min((box.w - 2 * pad) / Math.max(1e-9, maxX - minX), (box.h - 2 * pad) / Math.max(1e-9, maxY - minY));
    const offX = box.x + (box.w - (maxX - minX) * sc) / 2, offY = box.y + (box.h - (maxY - minY) * sc) / 2;
    const P = (lat, lon) => [offX + (lon * kx - minX) * sc, offY + (maxY - lat) * sc];
    const colorAt = (t) => {   // azul -> verde -> naranja -> rojo, según avance de la ruta
        const stops = [[37, 99, 235], [16, 185, 129], [245, 158, 11], [220, 38, 38]];
        const f = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1), i = Math.floor(f), u = f - i;
        return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * u));
    };
    const distM = (a, b) => {
        const R = 6371008.8, r = Math.PI / 180;
        const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    };
    let nJumps = 0;
    for (let i = 1; i < G.length; i++) {
        const a = G[i - 1], b = G[i];
        if (a._day !== b._day || !inside(a) || !inside(b)) continue;
        const [x1, y1] = P(a.lat, a.lon), [x2, y2] = P(b.lat, b.lon);
        const long = distM(a, b) > 80;
        doc.setDrawColor(...colorAt(i / allPts.length));
        doc.setLineWidth(long ? 0.35 : 0.45);
        if (long) { nJumps++; doc.setLineDashPattern([1.2, 1], 0); }
        doc.line(x1, y1, x2, y2);
        if (long) doc.setLineDashPattern([], 0);
    }
    G.forEach((p, i) => {
        if (!inside(p)) return;
        const [x, yv] = P(p.lat, p.lon);
        doc.setFillColor(...colorAt(i / G.length));
        doc.circle(x, yv, 0.55, 'F');
    });
    // números de orden cada cierto tramo
    const step = totalPts > 600 ? 100 : totalPts > 250 ? 50 : totalPts > 100 ? 25 : 10;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.2); doc.setTextColor(15, 23, 42);
    G.forEach((p, i) => {
        if ((i + 1) % step === 0 && inside(p)) {
            const [x, yv] = P(p.lat, p.lon);
            doc.text(String(i + 1), x + 0.9, yv - 0.9);
        }
    });
    // parking (inicio) y último servicio
    if (park.lat != null && park.lon != null) {
        const [x, yv] = P(park.lat, park.lon);
        doc.setFillColor(...C_GREEN); doc.setDrawColor(255); doc.setLineWidth(0.4);
        doc.circle(x, yv, 2.2, 'FD');
        doc.setTextColor(255); doc.setFontSize(6.5); doc.text('P', x, yv + 0.9, { align: 'center' });
    }
    if (G.length && inside(G[G.length - 1])) {
        const last = G[G.length - 1];
        const [x, yv] = P(last.lat, last.lon);
        doc.setFillColor(15, 23, 42); doc.rect(x - 1.3, yv - 1.3, 2.6, 2.6, 'F');
    }
    // norte
    doc.setDrawColor(...C_GRAY); doc.setLineWidth(0.4);
    doc.line(box.x + box.w - 7, box.y + 11, box.x + box.w - 7, box.y + 5);
    doc.line(box.x + box.w - 7, box.y + 5, box.x + box.w - 8.3, box.y + 7);
    doc.line(box.x + box.w - 7, box.y + 5, box.x + box.w - 5.7, box.y + 7);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...C_GRAY);
    doc.text('N', box.x + box.w - 7, box.y + 14, { align: 'center' });
    y = box.y + box.h + 4;
    // leyenda
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); doc.setTextColor(...C_GRAY);
    let lx = M;
    for (let k = 0; k < 30; k++) { doc.setFillColor(...colorAt(k / 30)); doc.rect(lx + k * 1.1, y - 2.4, 1.1, 2.6, 'F'); }
    doc.text(clean('inicio -> fin del recorrido'), lx + 35, y);
    lx += 78;
    doc.setFillColor(...C_GREEN); doc.circle(lx + 1.5, y - 1, 1.6, 'F'); doc.text('Parking', lx + 4.5, y);
    lx += 22;
    doc.setFillColor(15, 23, 42); doc.rect(lx + 0.4, y - 2.1, 2.2, 2.2, 'F'); doc.text(clean('Último servicio'), lx + 4.5, y);
    lx += 30;
    doc.setDrawColor(...C_GRAY); doc.setLineDashPattern([1.2, 1], 0); doc.line(lx, y - 1, lx + 7, y - 1); doc.setLineDashPattern([], 0);
    doc.text(clean(`Salto > 80 m (${nJumps})`), lx + 9, y);
    y += 4;
    para(`Los números indican el orden de visita cada ${step} servicios. Croquis sin escala de calles: une los servicios en línea recta.`
        + (Object.keys(fixedC).length ? ` Se dibujó con las coordenadas corregidas de ${Object.keys(fixedC).length} servicios (GPS del archivo dudoso).` : '')
        + (nOut ? ` ${nOut} servicio(s) quedan fuera del recuadro por estar muy lejos del resto.` : ''), { size: 7.6, color: C_GRAY });

    // ---------- cómo se eligió ----------
    section('3. ¿Cómo se eligió esta ruta?');
    if (dec.winner_label) para(`Ganó: ${dec.winner_label}`, { bold: true, size: 9.2 });
    if (dec.reason) para(dec.reason, { size: 8.8 });
    const cands = Array.isArray(dec.candidates) ? dec.candidates : [];
    if (cands.length) {
        para('Opciones comparadas (lectura estimada con el mismo modelo, sin descansos):', { size: 8.4, color: C_GRAY, after: 3 });
        table(
            ['Opción', 'Min', 'Km a pie', 'Saltos >80m', 'Regresos'],
            cands.map(c => [(c.is_winner ? '[Elegida] ' : '') + (c.label || c.id), num(c.minutes, 1), num(c.km, 2), num(c.jumps_over_80m), num(c.street_returns)]),
            [96, 18, 22, 24, 22], ['l', 'r', 'r', 'r', 'r'],
            { boldRow: (i) => !!cands[i].is_winner }
        );
    }
    const savings = Array.isArray(dec.savings) ? dec.savings : [];
    if (savings.length) {
        para('¿De dónde sale la diferencia?', { bold: true, size: 9 });
        bullets(savings);
    }

    // ---------- historial ----------
    const hist = Array.isArray(dec.route_history) ? dec.route_history : [];
    if (hist.length) {
        section('4. Historial de la ruta (Detallados de meses anteriores)');
        table(
            ['Mes - tarea', 'Total real', 'Pausas n/min', 'Sin pausas', 'Orden (modelo)', 'Km', 'Anomalías'],
            hist.map(h => [
                (h.es_base ? '* ' : '') + (h.mes || '-') + (h.tarea ? ' - ' + h.tarea : ''),
                num(h.real_total_min), (h.pausas_n != null ? h.pausas_n + ' / ' + num(h.pausas_min) : '-'),
                num(h.real_sin_pausas_min) + (h.vs_mejor_min > 0 ? ` (+${num(h.vs_mejor_min)})` : ''),
                num(h.orden_con_modelo_min, 1), num(h.km, 2), num(h.anomalias),
            ]),
            [30, 22, 24, 28, 30, 20, 28], ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
            { highlight: (i) => !!hist[i].es_base }
        );
        para('Minutos reales tomados de cada Detallado. "* " = mes usado como base. "Orden (modelo)" = cuánto tardaría hoy ese mismo orden según el modelo, sin contar al lecturista, el clima ni las pausas; sirve para comparar órdenes entre sí.', { size: 7.6, color: C_GRAY });
    }

    // ---------- territorio ----------
    const s = res.spatial || {};
    if (s.n_rpu) {
        section(hist.length ? '5. Territorio y densidad' : '4. Territorio y densidad');
        table(
            ['Indicador', 'Valor'],
            [
                ['Área del contorno', `${num(s.area_km2, 3)} km²`],
                ['Densidad', `${num(s.density_per_km2, 1)} medidores/km²`],
                [`Conjuntos (medidores a <= ${num(s.cluster_threshold_m)} m)`, num(s.n_clusters)],
                ['Vecino más cercano (mediana)', `${num(s.median_nn_m, 1)} m`],
                ['Distancia media entre conjuntos', `${num(s.avg_gap_m)} m (~${num(s.avg_gap_sec)} s caminando)`],
                ['Perfil sugerido por densidad', clean(s.profile_hint || res.perfil || '-')],
                ['Tramos largos entre conjuntos (posible vehículo)', num(s.n_vehicle_gaps)],
            ],
            [110, 72], ['l', 'l']
        );
    }

    // ---------- anomalías reincidentes ----------
    const alerts = res.anomaly_alerts || {};
    const aKeys = Object.keys(alerts);
    if (aKeys.length) {
        section('Medidores con anomalía reincidente');
        const posBy = {};
        allPts.forEach((p, i) => { const r = String((p.props || {}).Rpu || p.rpu || ''); if (r && !(r in posBy)) posBy[r] = i + 1; });
        const dirBy = {};
        allPts.forEach(p => { const r = String((p.props || {}).Rpu || p.rpu || ''); if (r) dirBy[r] = (p.props || {}).Direccion || ''; });
        const rows = aKeys
            .map(r => ({ r, pos: posBy[r] || 99999, a: alerts[r] || [] }))
            .sort((u, v) => u.pos - v.pos)
            .slice(0, 40)
            .map(o => [o.pos < 99999 ? String(o.pos) : '-', o.r, dirBy[o.r] || '-',
                o.a.map(x => x.anomalia || x.alerta || '').filter(Boolean).join('; '),
                num(Math.max(0, ...o.a.map(x => Number(x.n_apariciones || (Array.isArray(x.ciclos) ? x.ciclos.length : x.ciclos) || 0))))]);
        para(`${aKeys.length} medidor(es) de esta ruta tuvieron la misma anomalía en 2 o más ciclos.` + (aKeys.length > 40 ? ' Se muestran los primeros 40 en orden de visita.' : ''), { size: 8.6 });
        table(['Orden', 'RPU', 'Dirección', 'Anomalía', 'Veces'], rows, [14, 28, 62, 62, 16], ['r', 'l', 'l', 'l', 'r']);
    }

    // ---------- notas ----------
    section('Notas');
    bullets([
        'Los tiempos son estimaciones del modelo entrenado con los Detallados (Random Forest por tramo). Sirven para planear y comparar opciones; no son el registro oficial de productividad.',
        '"Sin descansos" descuenta las pausas largas que traen los Detallados; "jornada típica" las incluye.',
        `Regla de campo aplicada: cada calle se recorre completa, con un máximo de pasadas por calle; la ruta inicia y termina en el parking.`,
        'Los kilómetros a pie se miden en línea recta entre servicios seguidos; el recorrido real por banqueta puede ser un poco mayor.',
    ]);

    // pie de página
    const nPages = doc.getNumberOfPages();
    for (let i = 1; i <= nPages; i++) {
        doc.setPage(i);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...C_GRAY);
        doc.text(clean(`Generado por el Optimizador de rutas - ${now.toLocaleDateString('es-MX')}`), M, PH - 8);
        doc.text(`${i} / ${nPages}`, PW - M, PH - 8, { align: 'right' });
    }
    const base = (meta.tarea ? 'tarea_' + meta.tarea : (dec.ruta_id || 'ruta'));
    doc.save(`Reporte_resultados_${String(base).replace(/[^\w-]+/g, '_')}_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.pdf`);
}

if (btnReportPDF) {
    btnReportPDF.addEventListener('click', async () => {
        try {
            btnReportPDF.disabled = true;
            await exportResultsReportPDF();
        } catch (e) {
            console.error(e);
            alert('No se pudo generar el reporte: ' + e.message);
        } finally {
            btnReportPDF.disabled = false;
        }
    });
}

if (btnExportPDF) {
    btnExportPDF.addEventListener('click', () => {
        const data = window.lastRouteData;
        if (data) exportRoutePDF(data);
        else alert('Primero genera las rutas');
    });
}

if (btnBuildTrips) {
    btnBuildTrips.addEventListener('click', async () => {
        const nodes = getVisibleNodes();
        if (!nodes.length) {
            alert('No hay puntos visibles');
            return;
        }

        if (osrmStatus) osrmStatus.textContent = 'conectando al backend...';
        btnBuildTrips.disabled = true;
        cfeLoader.show(nodes.length);
        clearLiveLayer();
        progressReset();

        try {
            const fileName = (fileInput && fileInput.files && fileInput.files[0])
                ? fileInput.files[0].name
                : (window.lastFileName || '');
            const tarea = window.currentTarea || detectTareaFromFileName(fileName) || null;

            const dwellRaw = dwellEl && dwellEl.value !== undefined ? String(dwellEl.value).trim() : '';
            const dwellVal = dwellRaw === '' ? null : parseFloat(dwellRaw);

            const response = await fetch(`${API_BASE}/optimize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify((() => {
                    const payload = {
                        start_lat: CFE_START[0],
                        start_lon: CFE_START[1],
                        nodes: nodes.map(n => ({
                            id: n.id,
                            lat: n.lat,
                            lon: n.lon,
                            rpu: n.rpu || null,
                            direccion: (n.props && n.props.Direccion) ? String(n.props.Direccion) : null,
                            cuenta: (n.props && n.props.Cuenta) ? String(n.props.Cuenta) : null
                        })),
                        zona_agencia: window.currentZonaAgencia || agencyCode() || null,
                        dwell_min: dwellVal,
                        budget_min: 390,
                        tarea: tarea,
                        hour: 9,
                        parking_mode: window.parkingMode || 'auto'
                    };
                    if (window.parkingMode === 'user' && window.userParking) {
                        payload.parking_lat = window.userParking.lat;
                        payload.parking_lon = window.userParking.lon;
                        payload.parking_rpu = window.userParking.rpu || null;
                    }
                    return payload;
                })())
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || 'Error en el backend');
            }

            cfeLoader.step(2);
            const result = await response.json();
            if (result.status !== 'ok' || !result.trips) {
                throw new Error('Respuesta inválida del backend');
            }

            window.anomalyAlerts = result.anomaly_alerts || {};
            const nRein = Object.keys(window.anomalyAlerts).length;
            let nSinUso = 0;
            Object.values(window.anomalyAlerts).forEach(list => {
                if (isSinUsoAlert(list)) nSinUso++;
            });
            if (nRein) {
                console.log('⚠️ RPU reincidentes:', nRein, '| SIN USO:', nSinUso, window.anomalyAlerts);
            }

            console.log('ML:', {
                order_source: result.order_source,
                budget_source: result.budget_source,
                suggested_dwell_min: result.suggested_dwell_min,
                total_trips: result.total_trips,
                decision: result.decision
            });
            window.lastOptimizeResult = result;
            window.lastOptimizeMeta = { fileName: fileName, tarea: tarea };
            try { renderDecisionPanel(result); } catch (e) { console.warn(e); }
            try { renderSpatialPanel(result); } catch (e) { console.warn(e); }
            try { renderParkingPanel(); } catch (e) { console.warn(e); }
            try {
                // Solo dibujar gaps naranja si hay pocos (evita mapa saturado en urbana densa)
                const nGaps = (result.spatial && result.spatial.n_vehicle_gaps) || 0;
                if (nGaps > 0 && nGaps <= 80) drawInterClusterEdges(result, nodes);
            } catch (e) { console.warn(e); }
            window.lastOptimizeResult = result;

            // Rellenar dwell sugerido si estaba vacío
            const suggestedDwell = result.suggested_dwell_min != null
                ? Number(result.suggested_dwell_min)
                : null;
            if (dwellEl && dwellRaw === '' && suggestedDwell != null) {
                dwellEl.placeholder = `sugerido ${suggestedDwell}`;
            }

            if (osrmStatus) {
                osrmStatus.textContent =
                    `✅ ${result.total_trips} días | orden: ${result.order_source || '?'} | budget: ${result.budget_source || '?'}`;
            }

            const allTrips = [];
            let totalPoints = 0;

            for (let di = 0; di < result.trips.length; di++) {
                const tripData = result.trips[di];
                const orderedNodes = tripData.order.map(idx => {
                    const n = nodes[idx];
                    return n ? { ...n, props: n.props || {} } : null;
                }).filter(Boolean);

                const data = await buildTripsFromOrder(
                    orderedNodes,
                    di,
                    (done, total, dayIdx) => {
                        if (osrmStatus) {
                            osrmStatus.textContent =
                                `Dibujando día ${dayIdx + 1}: ${done}/${total} puntos...`;
                        }
                        if (progressText) {
                            progressText.textContent = `Día ${dayIdx + 1} — ${done} / ${total}`;
                        }
                        cfeLoader.step(3, `Dibujando en el mapa: ${done} de ${total} medidores`, total ? done / total : null);
                    },
                    {
                        parking: tripData.parking || null,
                        dwellMin: suggestedDwell,
                        backendTimeMin: tripData.total_time_min != null
                            ? Number(tripData.total_time_min)
                            : null,
                        maxWalkKm: MAX_WALK_KM_DEFAULT,
                        orderSource: result.order_source || 'ML'
                    }
                );
                allTrips.push(data.trips[0]);
                totalPoints += tripData.num_points || orderedNodes.length;
            }

            clearLiveLayer();
            const combinedData = { trips: allTrips, unassigned: [] };
            renderTrips(combinedData);
            // Quitar pines de "elegir parking" → se ven los círculos con número (orden de visita)
            try { hideBaseMarkersForRouteView(); } catch (e) {}
            exportTrips(combinedData);
            window.lastRouteData = combinedData;

            if (osrmStatus) {
                const nAl = Object.keys(window.anomalyAlerts || {}).length;
                let nSin = 0;
                Object.values(window.anomalyAlerts || {}).forEach(list => {
                    if (isSinUsoAlert(list)) nSin++;
                });
                osrmStatus.textContent = `✅ ${result.total_trips} días, ${totalPoints} puntos`
                    + (nAl ? ` | ⚠️ ${nAl} reincidentes` : '')
                    + (nSin ? ` (${nSin} sin uso)` : '');
            }
        } catch (e) {
            cfeLoader.hide();
            const sinServidor = window.CFE_SIN_BACKEND || e instanceof TypeError;   // TypeError = fetch sin conexión
            alert(sinServidor
                ? 'No hay conexión con el servidor del optimizador.\n\nEn campo usa "📲 Abrir ruta guardada" con el archivo que guardaste desde la laptop (Exportar → Ruta para campo).'
                : 'Error en la optimización: ' + e.message);
            if (osrmStatus) osrmStatus.textContent = '❌ error';
            clearLiveLayer();
        } finally {
            btnBuildTrips.disabled = false;
            cfeLoader.hide();
        }
    });
}

if (btnStartGPSNavigation) {
    btnStartGPSNavigation.addEventListener('click', async () => {
        const data = window.lastRouteData;
        if (!data) {
            alert('Primero genera las rutas');
            return;
        }
        startGPSNavigation(data);
    });
}

document.getElementById('btnPauseNavigation')?.addEventListener('click', function () {
    isPaused = true;
    this.style.display = 'none';
    const btnResume = document.getElementById('btnResumeNavigation');
    if (btnResume) btnResume.style.display = 'block';
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
    const navInst = document.getElementById('navInstruction');
    if (navInst) navInst.innerHTML = '⏸️ Navegación pausada.';
});

document.getElementById('btnResumeNavigation')?.addEventListener('click', function () {
    isPaused = false;
    this.style.display = 'none';
    const btnPause = document.getElementById('btnPauseNavigation');
    if (btnPause) btnPause.style.display = 'block';
    if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(onLocationUpdate, () => { }, {
            enableHighAccuracy: true, maximumAge: 3000, timeout: 10000
        });
    }
    updateNavUI(true);
});

if (concurrencyEl) {
    concurrencyEl.addEventListener('change', () => setConcurrency(concurrencyEl.value));
}


/* =========================================================
   17. PANEL COLAPSE MOVIL
   ========================================================= */

// Panel colapsable en móvil
(function () {
    const panel = document.getElementById('panel');
    const btn = document.getElementById('btnTogglePanel');
    if (!panel || !btn) return;

    // Celular: el panel arranca ABIERTO (se ven los pasos); al cargar el archivo o al generar la ruta
    // se pliega solo para mostrar el mapa, y abajo queda la barra de acciones grandes.
    const mq = window.matchMedia('(max-width: 768px), (orientation: landscape) and (max-height: 520px)');
    const mActions = document.getElementById('mobileActions');
    function setCollapsed(v) {
        panel.classList.toggle('is-collapsed', v);
        btn.textContent = v ? '☰ Opciones' : '✕ Ver mapa';
        btn.setAttribute('aria-expanded', String(!v));
        document.body.classList.toggle('panel-collapsed', v);
        setTimeout(() => { try { map.invalidateSize(); } catch (e) { } }, 280);
    }
    function applyMobileDefault() {
        setCollapsed(mq.matches && !!(allMarkers && allMarkers.length));
    }
    applyMobileDefault();
    mq.addEventListener?.('change', applyMobileDefault);
    btn.addEventListener('click', () => setCollapsed(!panel.classList.contains('is-collapsed')));
    window.cfePanel = { open: () => setCollapsed(false), close: () => { if (mq.matches) setCollapsed(true); } };

    // barra de acciones del celular: refleja el estado de los botones del panel
    const bBuild = document.getElementById('btnBuildTrips');
    const bNav = document.getElementById('btnStartGPSNavigation');
    const mPanel = document.getElementById('mActPanel');
    const mBuild = document.getElementById('mActBuild');
    const mNav = document.getElementById('mActNav');
    if (mPanel) mPanel.addEventListener('click', () => setCollapsed(!panel.classList.contains('is-collapsed')));
    if (mBuild) mBuild.addEventListener('click', () => { if (bBuild && !bBuild.disabled) bBuild.click(); });
    if (mNav) mNav.addEventListener('click', () => { if (bNav && !bNav.disabled) bNav.click(); });
    let lastN = 0, lastRoute = null;
    setInterval(() => {
        const n = (allMarkers && allMarkers.length) || 0;
        if (mBuild) mBuild.disabled = !n || !bBuild || bBuild.disabled;
        if (mNav) mNav.disabled = !bNav || bNav.disabled;
        if (mPanel) {
            const c = panel.classList.contains('is-collapsed');
            const html = c ? '<span aria-hidden="true">☰</span><span class="lbl"> Opciones</span>' : '<span aria-hidden="true">✕</span><span class="lbl"> Ver mapa</span>';
            if (mPanel.__h !== html) { mPanel.innerHTML = html; mPanel.__h = html; mPanel.setAttribute('aria-label', c ? 'Opciones' : 'Ver mapa'); }
        }
        if (mActions) mActions.classList.toggle('has-route', !!window.lastRouteData);
        // al cargar un archivo nuevo o terminar una ruta: mostrar el mapa (solo celular)
        if (n && n !== lastN) window.cfePanel.close();
        if (window.lastRouteData && window.lastRouteData !== lastRoute) window.cfePanel.close();
        lastN = n; lastRoute = window.lastRouteData || null;
    }, 600);
})();

try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildAgencySelectors);
    } else {
        buildAgencySelectors();
    }
} catch (e) {
    console.warn('agency selectors:', e);
}

console.log('✅ Script CFE Valles (ML) cargado');


/* =========================================================
   18. BOTÓN "EXPORTAR" (menú) y TARJETA "DETALLES DE LA RUTA" (pestañas)
   Solo reacomodan los botones y paneles que ya existían (mismos ids).
   ========================================================= */
(function setupExportMenu() {
    const toggle = document.getElementById('btnExportMenu');
    const menu = document.getElementById('exportMenu');
    if (!toggle || !menu) return;
    const items = Array.from(menu.querySelectorAll('.export-item'));
    const open = (v) => {
        menu.hidden = !v;
        toggle.setAttribute('aria-expanded', v ? 'true' : 'false');
        toggle.classList.toggle('is-open', v);
    };
    toggle.addEventListener('click', (e) => { e.stopPropagation(); open(menu.hidden); });
    // al elegir una opción: se ejecuta su acción normal y se cierra el menú
    items.forEach(it => it.addEventListener('click', () => setTimeout(() => open(false), 0)));
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== toggle) open(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { open(false); toggle.focus(); } });
    // el botón "Exportar" se habilita cuando hay al menos una opción disponible
    const sync = () => { toggle.disabled = !items.some(it => !it.disabled); if (toggle.disabled) open(false); };
    new MutationObserver(sync).observe(menu, { subtree: true, attributes: true, attributeFilter: ['disabled'] });
    sync();
})();

(function setupRouteDetailsTabs() {
    const card = document.getElementById('routeDetails');
    if (!card) return;
    const tabs = Array.from(card.querySelectorAll('.rd-tab'));
    const panes = tabs.map(t => document.getElementById(t.dataset.pane)).filter(Boolean);
    let active = 'decisionPanel';
    const hasContent = (el) => el && el.style.display !== 'none' && el.innerHTML.trim() !== '';
    let busy = false;
    const refresh = () => {
        if (busy) return;
        busy = true;
        try {
            const avail = panes.filter(hasContent).map(p => p.id);
            card.hidden = avail.length === 0;
            const sub = document.getElementById('rdSub');
            if (sub) {
                const warn = document.querySelector('#decisionPanel > div[style*="#fffbeb"]');
                sub.textContent = warn ? '⚠️ hay un aviso' : `${avail.length} ${avail.length === 1 ? 'sección' : 'secciones'}`;
                sub.classList.toggle('is-warn', !!warn);
            }
            if (!avail.includes(active) && avail.length) active = avail[0];
            tabs.forEach(t => {
                const ok = avail.includes(t.dataset.pane);
                t.hidden = !ok;
                const on = t.dataset.pane === active;
                t.classList.toggle('is-active', on);
                t.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            panes.forEach(p => {
                p.classList.toggle('is-active', p.id === active);
                // dentro de la tarjeta el contenido va siempre abierto (la pestaña hace de "plegado")
                p.querySelectorAll('details.cfe-collapsible').forEach(d => { if (!d.open) d.open = true; });
            });
        } finally { busy = false; }
    };
    // plegar / desplegar toda la tarjeta (viene cerrada para no ocupar pantalla)
    const toggle = document.getElementById('rdToggle');
    const setOpen = (v) => {
        card.classList.toggle('is-collapsed', !v);
        if (toggle) toggle.setAttribute('aria-expanded', v ? 'true' : 'false');
    };
    if (toggle) toggle.addEventListener('click', () => setOpen(card.classList.contains('is-collapsed')));
    tabs.forEach(t => t.addEventListener('click', () => { active = t.dataset.pane; setOpen(true); refresh(); }));
    panes.forEach(p => new MutationObserver(refresh).observe(p, { childList: true, attributes: true, attributeFilter: ['style'] }));
    refresh();
})();

/* =========================================================
   19. MODO CAMPO: guardar la ruta y abrirla en el teléfono sin backend
   ---------------------------------------------------------
   La navegación GPS solo necesita la ruta ya armada (puntos, orden, parking), no el servidor.
   En la laptop: "Guardar ruta para campo" descarga un .json.
   En el teléfono (página publicada con HTTPS): "Abrir ruta guardada" lo carga y la navegación
   funciona sin ngrok ni laptop prendida.
   ========================================================= */
const FIELD_ROUTE_VERSION = 1;
const FIELD_LS_KEY = 'cfe_ruta_campo';

/* JSON sin los objetos del mapa (líneas de Leaflet guardadas dentro de la ruta) */
function safeStringify(obj) {
    return JSON.stringify(obj, (k, v) => {
        if (v && typeof v === 'object' && window.L && (v instanceof L.Layer || v instanceof L.Map)) return undefined;
        return v;
    });
}

function _fieldPayload() {
    const route = window.lastRouteData;
    if (!route || !route.trips || !route.trips.length) return null;
    return {
        app: 'cfe-optimizador-rutas',
        version: FIELD_ROUTE_VERSION,
        saved_at: new Date().toISOString(),
        meta: window.lastOptimizeMeta || {},
        agency: { start: CFE_START, agency: CFE_AGENCY },
        result: window.lastOptimizeResult || null,
        anomalyAlerts: window.anomalyAlerts || {},
        route
    };
}

function saveFieldRoute() {
    const p = _fieldPayload();
    if (!p) { alert('Primero genera la ruta.'); return; }
    const meta = p.meta || {};
    const d = new Date();
    const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const base = (meta.tarea ? 'tarea_' + meta.tarea : 'ruta');
    const blob = new Blob([safeStringify(p)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Ruta_campo_${base}_${fecha}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    try { localStorage.setItem(FIELD_LS_KEY, safeStringify(p)); } catch (e) { /* muy grande: solo archivo */ }
}

function applyFieldRoute(p, opts) {
    opts = opts || {};
    if (!p || p.app !== 'cfe-optimizador-rutas' || !p.route || !p.route.trips) {
        throw new Error('El archivo no es una ruta guardada del optimizador.');
    }
    try {
        if (p.agency && p.agency.agency && p.agency.agency.zona && typeof setAgency === 'function') {
            setAgency(p.agency.agency.zona, p.agency.agency.agencia, { fly: false });
        }
        if (p.agency && Array.isArray(p.agency.start)) CFE_START = p.agency.start;
    } catch (e) { }
    window.lastOptimizeResult = p.result || null;
    window.lastOptimizeMeta = p.meta || {};
    window.anomalyAlerts = p.anomalyAlerts || {};
    window.currentTarea = (p.meta && p.meta.tarea) || window.currentTarea;
    clearLiveLayer();
    renderTrips(p.route);
    try { exportTrips(p.route); } catch (e) { }
    window.lastRouteData = p.route;
    if (p.result) {
        try { renderDecisionPanel(p.result); } catch (e) { }
        try { renderSpatialPanel(p.result); } catch (e) { }
        try { renderParkingPanel(); } catch (e) { }
    }
    const n = p.route.trips.reduce((s, t) => s + ((t.points || []).length), 0);
    if (osrmStatus) {
        osrmStatus.textContent = `📲 Ruta guardada: ${n} puntos` +
            (p.meta && p.meta.tarea ? ` · tarea ${p.meta.tarea}` : '') +
            (p.saved_at ? ` · ${new Date(p.saved_at).toLocaleDateString('es-MX')}` : '');
    }
    try { localStorage.setItem(FIELD_LS_KEY, safeStringify(p)); } catch (e) { }
    if (opts.toast !== false) showToast(`Ruta cargada: ${n} medidores. Ya puedes iniciar la navegación GPS.`);
}

function showToast(msg, ms) {
    let t = document.getElementById('cfeToast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'cfeToast';
        t.className = 'cfe-toast';
        t.setAttribute('role', 'status');
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t.__h);
    t.__h = setTimeout(() => t.classList.remove('show'), ms || 4000);
}

(function setupFieldMode() {
    const btnSave = document.getElementById('btnSaveField');
    const btnOpen = document.getElementById('btnOpenField');
    const inp = document.getElementById('fieldFileInput');
    if (btnSave) btnSave.addEventListener('click', saveFieldRoute);
    if (btnOpen && inp) {
        btnOpen.addEventListener('click', () => inp.click());
        inp.addEventListener('change', async () => {
            const f = inp.files && inp.files[0];
            if (!f) return;
            try {
                applyFieldRoute(JSON.parse(await f.text()));
            } catch (e) {
                alert('No se pudo abrir la ruta: ' + e.message);
            } finally { inp.value = ''; }
        });
    }
    // habilitar "Guardar ruta para campo" cuando haya ruta
    const sync = () => { if (btnSave) btnSave.disabled = !(window.lastRouteData && window.lastRouteData.trips); };
    setInterval(sync, 1500);
    // ¿Hay una ruta guardada en este teléfono? ofrecer reabrirla
    const btnLast = document.getElementById('btnLastField');
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(FIELD_LS_KEY) || 'null'); } catch (e) { saved = null; }
    if (btnLast && saved && saved.route) {
        btnLast.hidden = false;
        const n = saved.route.trips.reduce((s, t) => s + ((t.points || []).length), 0);
        btnLast.textContent = `↩ Reabrir última ruta (${saved.meta && saved.meta.tarea ? 'tarea ' + saved.meta.tarea + ', ' : ''}${n} pts)`;
        btnLast.addEventListener('click', () => {
            try { applyFieldRoute(saved); } catch (e) { alert(e.message); }
        });
    }
})();

/* Página publicada sin backend (GitHub Pages, Netlify…): avisar al intentar "Generar" */
window.CFE_SIN_BACKEND = /github\.io$|netlify\.app$|pages\.dev$|vercel\.app$/i.test(location.hostname);

/* App instalable y tolerante a mala señal (service worker): solo en HTTPS o localhost */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e));
    });
}


/* =========================================================
   20. INDICADOR DE CARGA al generar la ruta
   ========================================================= */
const cfeLoader = (() => {
    const STEPS = [
        'Enviando los medidores al servidor',
        'Detectando calles y comparando opciones de ruta',
        'Recibiendo la ruta elegida',
        'Dibujando la ruta en el mapa'
    ];
    let el = null, t0 = 0, timer = null, slowTimer = null, cur = -1;
    function build() {
        if (el) return el;
        el = document.createElement('div');
        el.id = 'cfeLoader';
        el.className = 'cfe-loader';
        el.hidden = true;
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-labelledby', 'cfeLoaderTitle');
        el.innerHTML = `
          <div class="cfe-loader__card">
            <div class="cfe-loader__spin" aria-hidden="true"></div>
            <h3 id="cfeLoaderTitle">Armando la ruta…</h3>
            <p class="cfe-loader__sub" id="cfeLoaderSub"></p>
            <ol class="cfe-loader__steps" aria-live="polite">
              ${STEPS.map((s, i) => `<li data-i="${i}"><span class="dot" aria-hidden="true"></span><span class="txt">${s}</span></li>`).join('')}
            </ol>
            <div class="cfe-loader__bar" aria-hidden="true"><i id="cfeLoaderBar"></i></div>
            <p class="cfe-loader__time"><span id="cfeLoaderTime">0 s</span> · <span id="cfeLoaderHint">rutas grandes tardan hasta 30 s</span></p>
          </div>`;
        document.body.appendChild(el);
        return el;
    }
    function paint(i, text, frac) {
        cur = Math.max(cur, i);
        el.querySelectorAll('li').forEach(li => {
            const k = +li.dataset.i;
            li.classList.toggle('done', k < cur);
            li.classList.toggle('active', k === cur);
            if (k === i && text) li.querySelector('.txt').textContent = text;
        });
        const bar = document.getElementById('cfeLoaderBar');
        const base = [0.08, 0.25, 0.7, 0.75][cur] || 0;
        const p = cur === 3 && frac != null ? 0.75 + 0.25 * frac : base;
        if (bar) bar.style.width = Math.round(p * 100) + '%';
    }
    return {
        show(n) {
            build();
            cur = -1;
            el.querySelectorAll('li .txt').forEach((x, k) => x.textContent = STEPS[k]);
            document.getElementById('cfeLoaderSub').textContent = n ? `${n.toLocaleString('es-MX')} medidores` : '';
            document.getElementById('cfeLoaderHint').textContent = 'rutas grandes tardan hasta 30 s';
            el.hidden = false;
            document.body.classList.add('cfe-busy');
            paint(0);
            t0 = Date.now();
            clearInterval(timer); clearTimeout(slowTimer);
            timer = setInterval(() => {
                const s = Math.round((Date.now() - t0) / 1000);
                const tEl = document.getElementById('cfeLoaderTime');
                if (tEl) tEl.textContent = s + ' s';
                // mientras el servidor calcula, avanzar la barra despacio (máx. 65 %)
                if (cur === 1) {
                    const bar = document.getElementById('cfeLoaderBar');
                    if (bar) bar.style.width = Math.min(65, 25 + s * 1.5) + '%';
                }
            }, 500);
            setTimeout(() => { if (cur === 0) paint(1); }, 1200);
            slowTimer = setTimeout(() => {
                const h = document.getElementById('cfeLoaderHint');
                if (h) h.textContent = 'sigue calculando: compara varias opciones de recorrido';
            }, 25000);
        },
        step(i, text, frac) { if (el && !el.hidden) paint(i, text, frac); },
        hide() {
            if (!el) return;
            clearInterval(timer); clearTimeout(slowTimer);
            el.hidden = true;
            document.body.classList.remove('cfe-busy');
        }
    };
})();
