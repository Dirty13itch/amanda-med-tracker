import * as shared from './shared.js';
import { createStorageManager } from './storage.js';

// Show an update banner only for real updates, not for first install.
if ('serviceWorker' in navigator) {
  let refreshing = false;
  let updateBanner = null;

  function hideUpdateBanner() {
    if (!updateBanner) return;
    updateBanner.classList.remove('ub-visible');
    setTimeout(() => {
      if (updateBanner && updateBanner.parentNode) updateBanner.parentNode.removeChild(updateBanner);
      updateBanner = null;
    }, 300);
  }

  function showUpdateBanner(reg) {
    if (updateBanner || !reg.waiting || !navigator.serviceWorker.controller) return;
    const banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.innerHTML = '<span>Update available</span><button type="button">Refresh</button>';
    banner.querySelector('button').onclick = () => {
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    };
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('ub-visible'));
    updateBanner = banner;
  }

  navigator.serviceWorker.register('/sw.js').then(reg => {
    const watchForUpdate = worker => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(reg);
        }
      });
    };

    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg);
    if (reg.installing) watchForUpdate(reg.installing);
    reg.addEventListener('updatefound', () => watchForUpdate(reg.installing));

    // Check for updates every 5 minutes.
    setInterval(() => reg.update().catch(() => {}), 5 * 60 * 1000);
    // Check on tab visibility change (e.g. switching back to app).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    hideUpdateBanner();
    window.location.reload();
  });
}

// === Configuration Layer ===
const CONFIG_KEY = 'medtracker-config-v1';
const DOSES_KEY = 'medtracker-doses-v1';
const LEGACY_STATE_KEY = shared.LEGACY_STATE_KEY;
const LEGACY_BEDSIDE_KEY = shared.LEGACY_BEDSIDE_KEY;
const BEDSIDE_KEY = shared.BEDSIDE_KEY;
const CURRENT_SCHEMA = shared.APP_SCHEMA;
const COLOR_PALETTE = [...shared.COLOR_PALETTE];
const APP_VERSION = shared.APP_VERSION;
const OVERDUE_GRACE_MIN = shared.OVERDUE_GRACE_MIN;
const DUPLICATE_WINDOW_MIN = shared.DUPLICATE_WINDOW_MIN;
const clientErrors = [];
const storageManager = createStorageManager({ onError: error => captureError(error, 'storage') });
let storageHealth = null;
let storageMeta = shared.createDefaultMeta();
let _pendingPersist = Promise.resolve();

function captureError(error, context) {
  const entry = {
    context: context || 'runtime',
    message: error?.message || String(error || 'Unknown error'),
    stack: error?.stack ? error.stack.split('\n').slice(0, 4).join('\n') : null,
    time: new Date().toISOString()
  };
  clientErrors.push(entry);
  if (clientErrors.length > 50) clientErrors.shift();
}

window.addEventListener('error', event => captureError(event.error || event.message, 'window'));
window.addEventListener('unhandledrejection', event => captureError(event.reason, 'promise'));

function refreshDerivedConfig() {
  CONFIG = shared.normalizeConfig(CONFIG);
  MEDS = CONFIG.meds;
  WARNINGS = CONFIG.warnings;
  RECOVERY_NOTES = (CONFIG.recoveryNotes || []).filter(n => n && n.text).map(note => ({
    ...note,
    text: typeof note.text === 'function' ? note.text : day => String(note.text || '').replace('{day}', day)
  }));
}

function syncDebugSurface() {
  window.__MT_DEBUG__ = {
    get backupEnvelope() {
      return shared.buildBackupEnvelope({ config: CONFIG, state, meta: storageMeta });
    },
    get supportPayload() {
      return shared.buildSupportPayload({ config: CONFIG, state, meta: storageMeta }, storageHealth, clientErrors);
    }
  };
}

function applyBundle(bundle) {
  CONFIG = shared.normalizeConfig(bundle?.config || shared.createDefaultConfig());
  state = shared.normalizeState(bundle?.state || seedState());
  storageMeta = shared.createDefaultMeta(bundle?.meta || storageMeta);
  refreshDerivedConfig();
  syncDebugSurface();
}

function persistBundle(reason) {
  _pendingPersist = _pendingPersist
    .then(() => storageManager.persistBundle({ config: CONFIG, state, meta: storageMeta }, reason))
    .then(saved => {
      applyBundle(saved);
      return storageManager.getHealth(storageMeta);
    })
    .then(health => {
      storageHealth = health;
      syncDebugSurface();
      return health;
    })
    .catch(error => {
      captureError(error, reason);
      // Show blocking modal when data persistence fails — user must know their dose was NOT durably saved
      try {
        const isQuota = error && (error.name === 'QuotaExceededError' || /quota/i.test(error.message));
        showModal(`<h3>⚠️ Save Failed</h3>
          <p><strong>Your last change was NOT saved to storage.</strong></p>
          <p>${isQuota ? 'Device storage is full. Free up space or download a backup immediately.' : 'A storage error occurred. Download a backup to protect your data.'}</p>
          <div class="modal-actions" style="flex-direction:column;gap:8px">
            <button class="btn-danger" onclick="downloadFullBackup();closeModal()">Download Backup Now</button>
            <button class="btn-cancel" onclick="closeModal()">Dismiss</button>
          </div>`);
      } catch (e) { /* UI error during error handling — swallow */ }
      return null;
    });
  return _pendingPersist;
}

function loadConfig() {
  try {
    const cfg = localStorage.getItem(CONFIG_KEY);
    if (cfg) return shared.normalizeConfig(JSON.parse(cfg));
  } catch (error) {
    captureError(error, 'load-config');
  }
  return localStorage.getItem(LEGACY_STATE_KEY) ? shared.buildAmandaConfig() : shared.createDefaultConfig();
}

function saveConfig(cfg) {
  CONFIG = shared.normalizeConfig(cfg);
  refreshDerivedConfig();
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(CONFIG)); } catch(e) { /* best effort */ }
  persistBundle('save-config');
}

let CONFIG = loadConfig();
let MEDS = CONFIG.meds;
let WARNINGS = CONFIG.warnings;
let RECOVERY_NOTES = [];
const _cssSuccess = 'var(--success)';
let state = loadState();
refreshDerivedConfig();

Object.defineProperties(window, {
  CONFIG: { get: () => CONFIG },
  MEDS: { get: () => MEDS },
  WARNINGS: { get: () => WARNINGS },
  RECOVERY_NOTES: { get: () => RECOVERY_NOTES },
  COLOR_PALETTE: { get: () => COLOR_PALETTE },
  state: { get: () => state }
});

function loadState() {
  const keys = [DOSES_KEY, LEGACY_STATE_KEY];
  for (const key of keys) {
    try {
      const s = localStorage.getItem(key);
      if (s) {
        const parsed = migrateState(JSON.parse(s));
        if (validateState(parsed)) return parsed;
        console.warn('Invalid state in', key, 'trying next');
      }
    } catch (error) {
      captureError(error, 'load-state:' + key);
    }
  }
  return seedState();
}

function migrateState(value) {
  const raw = value || {};
  if (raw.schema && raw.schema > CURRENT_SCHEMA) {
    console.warn(`State schema ${raw.schema} is newer than app schema ${CURRENT_SCHEMA} — normalizing without downgrade`);
    captureError(new Error(`Downgrade detected: state schema ${raw.schema} > app schema ${CURRENT_SCHEMA}`), 'migrate-state');
  }
  // Future migrations go here:
  // if (raw.schema === 1) { raw = migrateV1toV2(raw); }
  return shared.normalizeState(raw);
}

function validateState(value) {
  try {
    const normalized = shared.normalizeState(value || {});
    return Array.isArray(normalized.doses) && Number.isFinite(normalized.nextId);
  } catch (error) {
    return false;
  }
}

function seedState() {
  return shared.normalizeState({ schema: CURRENT_SCHEMA, doses: [], nextId: 1 });
}

function save() {
  persistBundle('save-state');
}

function getMed(id) {
 return MEDS.find(m=>m.id===id); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function now() { return new Date(); }
function todayStr() { return fmt(now(),'date'); }
function fmt(d,type) {
  const dt = new Date(d);
  if(type==='time') return dt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  if(type==='date') return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
  return dt.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
}
function minsToHM(m) {
  if(m<=0) return 'now';
  const h=Math.floor(m/60), mi=Math.floor(m%60);
  return h>0 ? `${h}h ${mi}m` : `${mi}m`;
}
function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return 'Unknown';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function getDisplayMeds(referenceDate) {
  const ref = referenceDate ? new Date(referenceDate) : now();
  return MEDS
    .map((med, index) => ({ med, index }))
    .filter(({ med }) => shared.isMedActiveOnDate(med, ref))
    .sort((a, b) => Number(b.med.pinned) - Number(a.med.pinned) || a.index - b.index)
    .map(entry => entry.med);
}

function getMedicationGroups(referenceDate) {
  const ref = referenceDate ? new Date(referenceDate) : now();
  const active = [];
  const inactive = [];
  const archived = [];
  MEDS.forEach((med, index) => {
    const entry = { med, index };
    if (med.archived) {
      archived.push(entry);
      return;
    }
    if (shared.isMedActiveOnDate(med, ref)) {
      active.push(entry);
      return;
    }
    inactive.push(entry);
  });
  const sortEntries = list => list.sort((a, b) => Number(b.med.pinned) - Number(a.med.pinned) || a.index - b.index).map(entry => entry.med);
  return {
    active: sortEntries(active),
    inactive: sortEntries(inactive),
    archived: sortEntries(archived)
  };
}

function getSupplyLabel(med) {
  return String(med?.supplyLabel || 'units').trim() || 'units';
}

function getMedicationLifecycleLabel(med, referenceDate) {
  const ref = referenceDate ? new Date(referenceDate) : now();
  const dayKey = fmt(ref, 'date');
  if (med.archived) return 'Archived';
  if (med.startDate && dayKey < med.startDate) return `Starts ${med.startDate}`;
  if (med.endDate && dayKey > med.endDate) return `Ended ${med.endDate}`;
  return '';
}

function medEventsForMed(medId, options = {}) {
  const excludeDoseId = options.excludeDoseId;
  return state.doses
    .filter(d => d.medId === medId && d.id !== excludeDoseId)
    .sort((a,b)=>new Date(b.time)-new Date(a.time));
}
function dosesForMed(medId, options = {}) {
  return medEventsForMed(medId, options).filter(d => { const t = d.actionType || 'dose'; return t !== 'skip' && t !== 'removed'; });
}
function lastDose(medId, referenceDate = now(), options = {}) {
  const ref = new Date(referenceDate || now());
  return dosesForMed(medId, options).find(d => new Date(d.time) <= ref) || null;
}
function lastMedEvent(medId, referenceDate = now(), options = {}) {
  const ref = new Date(referenceDate || now());
  return medEventsForMed(medId, options).find(d => new Date(d.time) <= ref) || null;
}
function dosesOnReferenceDay(medId, referenceDate = now(), options = {}) {
  const ref = new Date(referenceDate || now());
  const dayKey = fmt(ref, 'date');
  return dosesForMed(medId, options).filter(d => fmt(d.time,'date')===dayKey && new Date(d.time) <= ref);
}
function todayDoses(medId, referenceDate = now(), options = {}) {
  return dosesOnReferenceDay(medId, referenceDate, options);
}
function rolling24hTotal(medId, referenceDate = now(), options = {}) {
  const ref = new Date(referenceDate || now());
  const cutoff = new Date(ref.getTime() - 24 * 3600000);
  const med = getMed(medId);
  let total = dosesForMed(medId, options)
    .filter(d => { const time = new Date(d.time); return time >= cutoff && time <= ref; })
    .reduce((s,d)=>s+d.mg,0);
  // Cross-medication acetaminophen tracking: if this med is an APAP-tracked med,
  // also count APAP from combination meds (e.g., Hydrocodone/APAP contains 325mg APAP per tab)
  const isApapMed = med && med.trackTotal && (
    med.id === 'tylenol' ||
    med.name.toLowerCase().includes('acetaminophen') ||
    med.name.toLowerCase().includes('tylenol') ||
    (med.category === 'analgesic' && med.maxDaily === 4000)
  );
  if (isApapMed) {
    MEDS.forEach(other => {
      if (other.id === medId || other.archived) return;
      if (other.apapPerTab && other.apapPerTab > 0) {
        total += dosesForMed(other.id, options)
          .filter(d => { const time = new Date(d.time); return time >= cutoff && time <= ref && (d.actionType || 'dose') === 'dose'; })
          .reduce((s,d) => s + (d.tabs * other.apapPerTab), 0);
      }
    });
  }
  return total;
}
function findPairedMeds(medId) { return MEDS.filter(m=>m.pairedWith===medId); }
function getDoseAgeMinutes(dose, referenceDate) {
  return dose ? (referenceDate - new Date(dose.time)) / 60000 : null;
}

function buildScheduledSlots(med, referenceDate) {
  const times = (med.scheduledTimes || []).filter(Boolean).slice().sort();
  if (!times.length) return [];
  const slots = [];
  for (const dayOffset of [-1, 0, 1]) {
    times.forEach(label => {
      const slot = new Date(referenceDate);
      slot.setHours(0, 0, 0, 0);
      slot.setDate(slot.getDate() + dayOffset);
      const [hours, minutes] = label.split(':').map(Number);
      slot.setHours(hours || 0, minutes || 0, 0, 0);
      slots.push({ dueAt: slot, label });
    });
  }
  return slots.sort((a, b) => a.dueAt - b.dueAt);
}

function getScheduledReadiness(med, referenceDate, options = {}) {
  if (med.scheduleType !== 'scheduled' || !med.scheduledTimes || !med.scheduledTimes.length) return null;
  const slots = buildScheduledSlots(med, referenceDate);
  if (!slots.length) return null;
  const todayKey = fmt(referenceDate, 'date');
  const events = medEventsForMed(med.id, options)
    .filter(event => new Date(event.time) <= referenceDate)
    .slice()
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  const windows = slots.map((slot, index) => {
    const end = slots[index + 1] ? slots[index + 1].dueAt : new Date(slot.dueAt.getTime() + Math.max(med.intervalMin || 720, 60) * 60000);
    const completion = events.find(event => {
      const eventTime = new Date(event.scheduledFor || event.time);
      return eventTime >= slot.dueAt && eventTime < end;
    }) || null;
    return { ...slot, end, completion };
  });
  const todaysSlots = windows.filter(slot => fmt(slot.dueAt, 'date') === todayKey);
  const overdueSlot = todaysSlots.filter(slot => slot.dueAt <= referenceDate && !slot.completion).pop() || null;
  const nextSlot = todaysSlots.find(slot => slot.dueAt > referenceDate) || windows.find(slot => slot.dueAt > referenceDate) || null;
  const targetSlot = overdueSlot || nextSlot || todaysSlots[todaysSlots.length - 1] || windows[windows.length - 1];
  if (!targetSlot) return null;
  const targetIndex = windows.findIndex(slot => slot.dueAt.getTime() === targetSlot.dueAt.getTime());
  const previousSlot = targetIndex > 0 ? windows[targetIndex - 1] : null;
  const isDueNow = !!overdueSlot;
  const minutesPastDue = isDueNow ? (referenceDate - targetSlot.dueAt) / 60000 : 0;
  const minutesUntilDue = isDueNow ? 0 : Math.max(0, (targetSlot.dueAt - referenceDate) / 60000);
  const windowStart = previousSlot ? previousSlot.dueAt : new Date(targetSlot.dueAt.getTime() - Math.max(med.intervalMin || 720, 60) * 60000);
  const windowSpan = Math.max((targetSlot.end - (isDueNow ? targetSlot.dueAt : windowStart)) / 60000, 1);
  const progressBase = isDueNow ? minutesPastDue : ((referenceDate - windowStart) / 60000);
  const progressPct = Math.max(0, Math.min(100, (progressBase / windowSpan) * 100));
  return {
    scheduled: true,
    dueAt: targetSlot.dueAt,
    dueLabel: targetSlot.label,
    windowEnd: targetSlot.end,
    minutesUntilDue,
    minutesPastDue,
    isDueNow,
    isOverdue: isDueNow && minutesPastDue > OVERDUE_GRACE_MIN,
    progressPct,
    completion: targetSlot.completion,
    nextSlot
  };
}

function getMedReadiness(med, atDate, options = {}) {
  const referenceDate = atDate ? new Date(atDate) : now();
  const todayCount = todayDoses(med.id, referenceDate, options);
  const todayTabs = todayCount.reduce((s,d)=>s+d.tabs,0);
  const todayMg = todayCount.reduce((s,d)=>s+d.mg,0);
  const rollingTotal = med.trackTotal ? rolling24hTotal(med.id, referenceDate, options) : 0;
  const last = lastDose(med.id, referenceDate, options);
  const ago = getDoseAgeMinutes(last, referenceDate);
  const scheduledInfo = getScheduledReadiness(med, referenceDate, options);
  const scheduleRemaining = scheduledInfo ? scheduledInfo.minutesUntilDue : 0;
  const intervalRemaining = scheduledInfo ? scheduleRemaining : (ago!==null&&ago<med.intervalMin ? med.intervalMin-ago : 0);
  // Bidirectional conflict: check both directions
  // 1) This med declares conflictsWith another med
  // 2) Another med declares conflictsWith THIS med (reverse lookup)
  const forwardConflict = med.conflictsWith ? getMed(med.conflictsWith) : null;
  const reverseConflict = MEDS.find(m => m.id !== med.id && m.conflictsWith === med.id && !m.archived) || null;
  const conflictMed = forwardConflict || reverseConflict;
  const conflictMin = forwardConflict ? med.conflictMin : (reverseConflict ? reverseConflict.conflictMin : med.conflictMin);
  const lastConflict = conflictMed ? lastDose(conflictMed.id, referenceDate, options) : null;
  const conflictAgo = getDoseAgeMinutes(lastConflict, referenceDate);
  const conflictRemaining = conflictAgo!==null&&conflictMin&&conflictAgo<conflictMin ? conflictMin-conflictAgo : 0;
  const maxDoseBlocked = !!(med.maxDoses&&todayCount.length>=med.maxDoses);
  const dailyLimitReached = !!(med.trackTotal&&rollingTotal>=med.maxDaily);
  const minimumDoseExceedsLimit = !!(med.trackTotal&&rollingTotal + med.perTab > med.maxDaily);
  const dailyLimitBlocked = dailyLimitReached || minimumDoseExceedsLimit;
  const hardBlocked = maxDoseBlocked||dailyLimitBlocked;
  const intervalBlocked = intervalRemaining > 0;
  const conflictBlocked = conflictRemaining > 0;
  const baseRemaining = scheduledInfo ? scheduleRemaining : intervalRemaining;
  const minutesUntilEligible = hardBlocked ? Infinity : Math.max(baseRemaining, conflictRemaining, 0);
  const primaryBlock = dailyLimitBlocked ? 'dailyLimit'
    : maxDoseBlocked ? 'maxDose'
    : conflictBlocked && conflictRemaining >= baseRemaining ? 'conflict'
    : intervalBlocked ? (scheduledInfo ? 'scheduled' : 'interval')
    : null;
  const progressWindow = primaryBlock === 'conflict'
    ? Math.max(conflictMin||1, 1)
    : Math.max(med.intervalMin||1, 1);
  const progressPct = hardBlocked ? 100 : conflictBlocked && conflictRemaining > baseRemaining
    ? Math.max(0, Math.min(100, (1 - (conflictRemaining / progressWindow)) * 100))
    : (scheduledInfo ? scheduledInfo.progressPct : (minutesUntilEligible > 0
      ? Math.max(0, Math.min(100, (1 - (minutesUntilEligible / progressWindow)) * 100))
      : 100));
  const isReadyRecommended = !hardBlocked && minutesUntilEligible <= 0;
  // Only scheduled meds can be "overdue" — PRN meds just become "available"
  const isOverdue = scheduledInfo
    ? (!hardBlocked && !conflictBlocked && scheduledInfo.isOverdue)
    : (med.scheduleType === 'scheduled' && !hardBlocked && !intervalBlocked && !conflictBlocked && ago!==null && (ago-med.intervalMin) > OVERDUE_GRACE_MIN);
  const conflictName = conflictMed ? conflictMed.name : med.conflictsWith;
  const blockReason = dailyLimitBlocked
    ? (dailyLimitReached ? `24-hour limit reached (${med.maxDaily}mg)` : `Another dose would exceed the 24-hour maximum`)
    : maxDoseBlocked
      ? `${todayCount.length}/${med.maxDoses} doses already logged today`
      : conflictBlocked
        ? `Wait ${minsToHM(conflictRemaining)} after ${conflictName}`
        : (scheduledInfo && minutesUntilEligible > 0)
          ? `Scheduled for ${fmt(scheduledInfo.dueAt,'time')} (${minsToHM(minutesUntilEligible)} remaining)`
          : intervalBlocked
            ? `Available in ${minsToHM(intervalRemaining)}`
            : '';
  return {
    med,
    last,
    ago,
    todayCount,
    todayTabs,
    todayMg,
    rollingTotal,
    lastConflict,
    conflictMed,
    conflictAgo,
    conflictMin,
    intervalRemaining,
    conflictRemaining,
    intervalBlocked,
    conflictBlocked,
    dailyLimitReached,
    minimumDoseExceedsLimit,
    dailyLimitBlocked,
    maxDoseBlocked,
    hardBlocked,
    minutesUntilEligible,
    nextEligibleAt: hardBlocked ? null : new Date(referenceDate.getTime()+minutesUntilEligible*60000).toISOString(),
    isReadyRecommended,
    isOverdue,
    canOverride: !hardBlocked && (intervalBlocked || conflictBlocked),
    shouldAlert: !hardBlocked && minutesUntilEligible <= 0,
    shouldOfferReminder: !hardBlocked && minutesUntilEligible > 0,
    primaryBlock,
    blockReason,
    progressPct,
    scheduledInfo,
    isScheduled: !!scheduledInfo,
    scheduledDueAt: scheduledInfo ? scheduledInfo.dueAt.toISOString() : '',
    scheduledDueLabel: scheduledInfo ? scheduledInfo.dueLabel : '',
    scheduledWindowEnd: scheduledInfo ? scheduledInfo.windowEnd.toISOString() : ''
  };
}

function format12h(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function renderLoggerField() {
  const defaultName = CONFIG.profile?.defaultLoggerName;
  if (defaultName) {
    return `<div class="settings-field" style="margin-top:8px"><label>Logging as</label><div style="display:flex;align-items:center;gap:8px"><strong>${esc(defaultName)}</strong><button type="button" style="font-size:12px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:var(--card);color:var(--muted);cursor:pointer" onclick="this.parentElement.nextElementSibling.style.display='';this.style.display='none'">Change</button></div><input type="text" id="modal-logger" style="display:none;margin-top:4px" placeholder="Different caregiver name" value=""></div>`;
  }
  return '<div class="settings-field" style="margin-top:8px"><label>Who\'s logging this?</label><input type="text" id="modal-logger" placeholder="Your name" value=""></div>';
}

function getModalLoggerName() {
  const el = document.getElementById('modal-logger');
  const override = el && el.style.display !== 'none' ? el.value.trim() : '';
  return override || (CONFIG.profile?.defaultLoggerName || '');
}

function renderPainScoreField(selected) {
  const val = typeof selected === 'number' && selected >= 0 ? selected : -1;
  let btns = '';
  for (let i = 0; i <= 10; i++) {
    const active = i === val ? ' active' : '';
    const hue = Math.round(120 - (i * 12));
    btns += `<button type="button" class="pain-btn${active}" style="--pain-hue:${hue}" onclick="selectPainScore(${i})" aria-label="Pain ${i}">${i}</button>`;
  }
  return `<div class="settings-field" style="margin-top:10px">
    <label>Pain level <span style="color:var(--muted);font-weight:400">(optional, 0-10)</span></label>
    <div class="pain-score-row" id="pain-score-row">${btns}</div>
    <div class="pain-score-labels"><span>None</span><span>Moderate</span><span>Worst</span></div>
    <input type="hidden" id="modal-pain-score" value="${val}">
  </div>`;
}

function selectPainScore(val) {
  const row = document.getElementById('pain-score-row');
  if (!row) return;
  const hidden = document.getElementById('modal-pain-score');
  const current = hidden ? parseInt(hidden.value, 10) : -1;
  const next = current === val ? -1 : val;
  row.querySelectorAll('.pain-btn').forEach((btn, i) => btn.classList.toggle('active', i === next));
  if (hidden) hidden.value = next;
}

function getModalPainScore() {
  const el = document.getElementById('modal-pain-score');
  const val = el ? parseInt(el.value, 10) : -1;
  return (Number.isFinite(val) && val >= 0 && val <= 10) ? val : -1;
}

function renderSymptomField(existingPain) {
  const painHtml = renderPainScoreField(typeof existingPain === 'number' ? existingPain : -1);
  const chips = ['Nausea','Drowsiness','Itching','Dizziness','Constipation','Headache','Rash','Breathing difficulty'];
  const chipHtml = chips.map(c => `<button type="button" class="symptom-chip" onclick="toggleSymptomChip(this,'${c}')">${c}</button>`).join('');
  return painHtml + `<div class="settings-field" style="margin-top:8px"><label>Symptoms / side effects <span style="color:var(--muted);font-weight:400">(optional)</span></label>
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${chipHtml}</div>
    <input type="text" id="modal-symptom" placeholder="Additional details..." value="">
    <div style="margin-top:6px"><label style="font-size:0.85em">Severity</label>
    <select id="modal-severity" style="width:100%;padding:6px;border-radius:6px;border:1px solid var(--border)">
      <option value="">None</option><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe -- flag as adverse reaction</option>
    </select></div></div>`;
}

function getModalSymptomNote() {
  const el = document.getElementById('modal-symptom');
  return el ? el.value.trim() : '';
}

function toggleSymptomChip(btn, label) {
  btn.classList.toggle('active');
  const input = document.getElementById('modal-symptom');
  if (!input) return;
  const parts = input.value.split(',').map(s => s.trim()).filter(Boolean);
  const idx = parts.findIndex(p => p.toLowerCase() === label.toLowerCase());
  if (idx >= 0) parts.splice(idx, 1); else parts.push(label);
  input.value = parts.join(', ');
}

function getModalSeverity() {
  const el = document.getElementById('modal-severity');
  return el ? el.value : '';
}

function getReadinessStatus(info) {
  if (info.maxDoseBlocked) {
    return { dot:'red', text:`${info.todayCount.length}/${info.med.maxDoses} doses today (complete)`, actionLabel:'Limit Reached', canOpenModal:false, canLogRecommended:false };
  }
  if (info.dailyLimitBlocked) {
    const text = info.dailyLimitReached
      ? `24hr limit reached (${info.med.maxDaily}mg)`
      : `Next dose exceeds 24hr max (${info.rollingTotal}mg of ${info.med.maxDaily}mg)`;
    return { dot:'red', text, actionLabel:'Limit Reached', canOpenModal:false, canLogRecommended:false };
  }
  if (info.isOverdue) {
    if (info.isScheduled && info.scheduledInfo) {
      return { dot:'red', text:`Scheduled dose overdue since ${fmt(info.scheduledInfo.dueAt,'time')}`, actionLabel:'Log Dose', canOpenModal:true, canLogRecommended:true };
    }
    return { dot:'red', text:`Overdue by ${minsToHM(Math.round((info.ago||0)-info.med.intervalMin))}`, actionLabel:'Log Dose', canOpenModal:true, canLogRecommended:true };
  }
  if (info.isReadyRecommended) {
    if (info.isScheduled && info.scheduledInfo) {
      return { dot:'green', text:`Due now (${fmt(info.scheduledInfo.dueAt,'time')})`, actionLabel:'Log Dose', canOpenModal:true, canLogRecommended:true };
    }
    return { dot:'green', text: info.med.scheduleType === 'prn' ? 'Available if needed' : 'Eligible now', actionLabel:'Log Dose', canOpenModal:true, canLogRecommended:true };
  }
  if (info.conflictBlocked) {
    const conflictName = esc(info.conflictMed ? info.conflictMed.name : info.med.conflictsWith);
    return { dot:'gray', text:`Wait ${minsToHM(info.conflictRemaining)} after ${conflictName}`, actionLabel:'Review Timing', canOpenModal:true, canLogRecommended:false };
  }
  if (info.isScheduled && info.scheduledInfo) {
    return { dot:'gray', text:`Due in ${minsToHM(info.minutesUntilEligible)} at ${fmt(info.scheduledInfo.dueAt,'time')}`, actionLabel:'Review Timing', canOpenModal:true, canLogRecommended:false };
  }
  return { dot:'gray', text:`Available in ${minsToHM(info.intervalRemaining)}`, actionLabel:'Review Timing', canOpenModal:true, canLogRecommended:false };
}

function getQueueTimeLabel(info) {
  if (info.isOverdue) return 'Overdue';
  if (info.isReadyRecommended) return 'Eligible';
  if (info.conflictBlocked) return `Wait ${minsToHM(info.minutesUntilEligible)}`;
  if (info.isScheduled && info.scheduledInfo) return `Due ${fmt(info.scheduledInfo.dueAt,'time')}`;
  return minsToHM(info.minutesUntilEligible);
}
// Retroactive time selector
window._doseTimeOffset = 0; // 0=just now, >0=minutes ago, -1=custom time input
function renderTimeSelector() {
  const n=now(), hh=String(n.getHours()).padStart(2,'0'), mm=String(n.getMinutes()).padStart(2,'0');
  return `<div class="time-selector">
    <div class="ts-label">When was it taken? <span style="float:right;color:var(--text);font-weight:700">Now: ${n.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}</span></div>
    <div class="ts-chips">
      <button type="button" class="ts-chip active" onclick="selectTimeChip(this,0)">Just now</button>
      <button type="button" class="ts-chip" onclick="selectTimeChip(this,5)">5m ago</button>
      <button type="button" class="ts-chip" onclick="selectTimeChip(this,15)">15m ago</button>
      <button type="button" class="ts-chip" onclick="selectTimeChip(this,30)">30m ago</button>
      <button type="button" class="ts-chip" onclick="selectTimeChip(this,60)">1hr ago</button>
      <button type="button" class="ts-chip" onclick="showCustomTime(this)">Other\u2026</button>
    </div>
    <div class="ts-custom" id="ts-custom">
      <span class="ts-custom-label">Time taken:</span>
      <input type="time" id="ts-custom-time" value="${hh}:${mm}" onchange="onCustomTimeChange()">
    </div>
  </div>`;
}
function selectTimeChip(el, mins) {
  document.querySelectorAll('.ts-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  window._doseTimeOffset = mins;
  const custom=document.getElementById('ts-custom');
  if(custom) custom.classList.remove('visible');
}
function showCustomTime(el) {
  document.querySelectorAll('.ts-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  window._doseTimeOffset = -1;
  const custom=document.getElementById('ts-custom');
  if(custom) custom.classList.add('visible');
  const n=now(), input=document.getElementById('ts-custom-time');
  if(input) input.value=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
}
function onCustomTimeChange() { window._doseTimeOffset = -1; }
function getDoseTime() {
  if(window._doseTimeOffset===0) return now().toISOString();
  if(window._doseTimeOffset>0) return new Date(Date.now()-window._doseTimeOffset*60000).toISOString();
  // Custom time input
  const input=document.getElementById('ts-custom-time');
  if(input&&input.value){
    const [h,m]=input.value.split(':').map(Number);
    let d=new Date(); d.setHours(h,m,0,0);
    if(d>now()) {
      // If only slightly in the future (< 5 min, e.g. clock skew), clamp to now
      // Otherwise assume yesterday (e.g. entering 11:55 PM when it's 12:05 AM)
      const diffMs = d.getTime() - now().getTime();
      if (diffMs < 5 * 60000) d = now();
      else d.setDate(d.getDate() - 1);
    }
    return d.toISOString();
  }
  return now().toISOString();
}

function showDuplicateDoseModal(medId, tabs, doseTime, options) {
  const med = getMed(medId);
  if (!med) return;
  window._duplicateDoseRequest = { medId, tabs, doseTime, options: options || {} };
  showModal(`<h3>Possible duplicate — ${esc(med.name)}</h3>
    <p>${esc(med.name)} already has a dose logged within ${DUPLICATE_WINDOW_MIN} minutes of ${fmt(doseTime,'time')}.</p>
    <div class="warn-box"><strong>Are you sure this was a separate dose?</strong> Double-dosing can be dangerous, especially with opioids and sedatives.</div>
    <div class="modal-actions">
      <button class="btn-confirm" onclick="closeModal()">No — I Already Took It</button>
      <button class="btn-cancel" id="dup-confirm-btn" disabled onclick="confirmDuplicateDose()" style="opacity:0.5">Yes, This Is a Second Dose (5s)</button>
    </div>`);
  let countdown = 5;
  const dupBtn = document.getElementById('dup-confirm-btn');
  const dupTick = setInterval(() => {
    countdown--;
    if (!dupBtn) { clearInterval(dupTick); return; }
    dupBtn.textContent = countdown > 0 ? `Yes, This Is a Second Dose (${countdown}s)` : 'Yes, This Is a Second Dose';
    if (countdown <= 0) { clearInterval(dupTick); dupBtn.disabled = false; dupBtn.style.opacity = '1'; dupBtn.className = 'btn-danger'; }
  }, 1000);
}

function confirmDuplicateDose() {
  const pending = window._duplicateDoseRequest;
  if (!pending) return closeModal();
  const result = addDose(pending.medId, pending.tabs, pending.doseTime, { ...(pending.options || {}), forceDuplicate: true });
  if (result && Array.isArray(pending.options?.pairedMedIds)) {
    pending.options.pairedMedIds.forEach(pairedMedId => {
      addDose(pairedMedId, 1, pending.doseTime, {
        forceDuplicate: true,
        loggedBy: pending.options.loggedBy || ''
      });
    });
  }
  if (result) closeModal();
}

function addDose(medId, tabs, customTime, options) {
  const opts = options || {};
  let doseId = null;
  try {
    const med = getMed(medId);
    if (!med) { console.error('addDose: unknown med', medId); return false; }
    const mg = med.perTab * tabs;
    const doseTime = customTime || getDoseTime();
    if (!doseTime || isNaN(new Date(doseTime).getTime())) { console.error('addDose: invalid time', doseTime); return false; }
    if (!opts.forceDuplicate && shared.isDuplicateDose(state, medId, tabs, doseTime)) {
      showDuplicateDoseModal(medId, tabs, doseTime, opts);
      return false;
    }
    const readiness = getMedReadiness(med, doseTime);
    const dose = {
      id: state.nextId++,
      medId,
      time: doseTime,
      tabs,
      mg,
      note: String(opts.note || '').trim(),
      loggedBy: String(opts.loggedBy || CONFIG.profile?.defaultLoggerName || '').trim(),
      overrideType: String(opts.overrideType || (readiness.conflictBlocked ? 'conflict' : readiness.intervalBlocked ? 'early' : '')).trim(),
      overrideReason: String(opts.overrideReason || readiness.blockReason || '').trim(),
      symptomNote: String(opts.symptomNote || '').trim(),
      adverseFlag: Boolean(opts.severity === 'severe' || opts.adverseFlag),
      severity: ['mild', 'moderate', 'severe'].includes(opts.severity) ? opts.severity : '',
      painScore: typeof opts.painScore === 'number' ? opts.painScore : -1,
      scheduledFor: readiness.scheduledDueAt || ''
    };
    doseId = dose.id;
    state.doses.push(dose);
    state.lastAction = { type: 'add-dose', doseId: dose.id };
    // Write-ahead to localStorage before async IDB persist — ensures dose survives tab close
    try { localStorage.setItem(DOSES_KEY, JSON.stringify(state)); } catch(e) { /* best effort */ }
    if (navigator.vibrate) navigator.vibrate(50);
    prevAvailability[medId] = false;
    save();
    render();
    maybeRequestNotifications();
    dismissAlertBanner();
    showToast(`✓ ${med.name} logged — ${tabs} tab${tabs>1?'s':''} (${tabs * med.perTab}${med.unitLabel || 'mg'})`, 5000);
    return true;
  } catch (e) {
    console.error('addDose error:', e);
    if (doseId !== null) {
      state.doses = state.doses.filter(d => d.id !== doseId);
    }
    captureError(e, 'addDose');
    try { render(); } catch (e2) { captureError(e2, 'addDose-render-recovery'); }
    return false;
  }
}

function recordSkipEvent(medId, customTime, options) {
  const opts = options || {};
  try {
    const med = getMed(medId);
    if (!med) return false;
    const eventTime = customTime || getDoseTime();
    const readiness = getMedReadiness(med, eventTime);
    const skipEntry = {
      id: state.nextId++,
      medId,
      time: eventTime,
      actionType: 'skip',
      tabs: 0,
      mg: 0,
      note: String(opts.note || 'Scheduled dose skipped').trim(),
      loggedBy: String(opts.loggedBy || CONFIG.profile?.defaultLoggerName || '').trim(),
      overrideType: 'skip',
      overrideReason: 'scheduled-skip',
      symptomNote: String(opts.symptomNote || '').trim(),
      painScore: typeof opts.painScore === 'number' ? opts.painScore : -1,
      scheduledFor: readiness.scheduledDueAt || eventTime
    };
    state.doses.push(skipEntry);
    state.lastAction = { type: 'skip-dose', doseId: skipEntry.id };
    save();
    render();
    showToast(`${med.name} skipped`);
    return true;
  } catch (error) {
    captureError(error, 'skip-dose');
    return false;
  }
}

function skipScheduledDose(medId) {
  const didSkip = recordSkipEvent(medId, getDoseTime(), {
    loggedBy: CONFIG.profile?.defaultLoggerName || ''
  });
  if (didSkip) closeModal();
}

function toDateTimeLocalValue(isoString) {
  const value = new Date(isoString);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function handleEditDose(id) {
  const dose = state.doses.find(entry => entry.id === id);
  const med = dose ? getMed(dose.medId) : null;
  if (!dose || !med) return;
  const tabsValue = dose.actionType === 'skip' ? 0 : Math.max(1, dose.tabs || 1);
  showModal(`<h3>Edit ${esc(med.name)} entry</h3>
    <div class="settings-field"><label>Logged time</label><input type="datetime-local" id="edit-dose-time" value="${toDateTimeLocalValue(dose.time)}"></div>
    ${dose.actionType === 'skip' ? '<p>This is a skipped scheduled dose.</p>' : `<div class="settings-field"><label>Tabs</label><input type="number" id="edit-dose-tabs" min="1" max="${med.maxTabs || 4}" value="${tabsValue}"></div>`}
    <div class="settings-field" style="margin-top:8px"><label>Pain level (0-10)</label>
      <div class="pain-score-row" id="edit-pain-score-row"></div>
      <input type="hidden" id="edit-dose-pain" value="${typeof dose.painScore === 'number' && dose.painScore >= 0 ? dose.painScore : -1}">
    </div>
    <div class="settings-field"><label>Symptoms / side effects</label><input type="text" id="edit-dose-symptom" value="${esc(dose.symptomNote || '')}" placeholder="e.g. nausea, drowsiness, itching"></div>
    <div class="settings-field"><label>Severity</label><select id="edit-dose-severity" style="width:100%;padding:6px;border-radius:6px;border:1px solid var(--border)"><option value="">None</option><option value="mild" ${dose.severity==='mild'?'selected':''}>Mild</option><option value="moderate" ${dose.severity==='moderate'?'selected':''}>Moderate</option><option value="severe" ${dose.severity==='severe'?'selected':''}>Severe -- adverse reaction</option></select></div>
    <div class="settings-field"><label>Note</label><textarea id="edit-dose-note" placeholder="Optional note">${esc(dose.note || '')}</textarea></div>
    <div class="settings-field"><label>Logged By</label><input type="text" id="edit-dose-logger" value="${esc(dose.loggedBy || '')}" placeholder="Who logged this?"></div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" onclick="saveEditedDose(${id})">Save Changes</button>
    </div>`);
  const editPainVal = typeof dose.painScore === 'number' && dose.painScore >= 0 ? dose.painScore : -1;
  initEditPainRow(editPainVal);
}

function initEditPainRow(currentVal) {
  const row = document.getElementById('edit-pain-score-row');
  if (!row) return;
  let btns = '';
  for (let i = 0; i <= 10; i++) {
    const active = i === currentVal ? ' active' : '';
    const hue = Math.round(120 - (i * 12));
    btns += `<button type="button" class="pain-btn${active}" style="--pain-hue:${hue}" onclick="selectEditPainScore(${i})" aria-label="Pain ${i}">${i}</button>`;
  }
  row.innerHTML = btns;
}

function selectEditPainScore(val) {
  const row = document.getElementById('edit-pain-score-row');
  if (!row) return;
  const hidden = document.getElementById('edit-dose-pain');
  const current = hidden ? parseInt(hidden.value, 10) : -1;
  const next = current === val ? -1 : val;
  row.querySelectorAll('.pain-btn').forEach((btn, i) => btn.classList.toggle('active', i === next));
  if (hidden) hidden.value = next;
}

function saveEditedDose(id) {
  const dose = state.doses.find(entry => entry.id === id);
  const med = dose ? getMed(dose.medId) : null;
  if (!dose || !med) return closeModal();
  const timeInput = document.getElementById('edit-dose-time');
  const noteInput = document.getElementById('edit-dose-note');
  const loggerInput = document.getElementById('edit-dose-logger');
  const tabsInput = document.getElementById('edit-dose-tabs');
  const nextTime = timeInput && timeInput.value ? new Date(timeInput.value).toISOString() : dose.time;
  const nextTabs = dose.actionType === 'skip' ? 0 : Math.max(1, parseInt(tabsInput.value, 10) || dose.tabs || 1);
  const readiness = getMedReadiness(med, nextTime, { excludeDoseId: id });
  dose.time = nextTime;
  dose.tabs = nextTabs;
  dose.mg = dose.actionType === 'skip' ? 0 : med.perTab * nextTabs;
  const symptomInput = document.getElementById('edit-dose-symptom');
  dose.symptomNote = symptomInput ? symptomInput.value.trim() : (dose.symptomNote || '');
  const painInput = document.getElementById('edit-dose-pain');
  if (painInput) {
    const pv = parseInt(painInput.value, 10);
    dose.painScore = (Number.isFinite(pv) && pv >= 0 && pv <= 10) ? pv : -1;
  }
  const sevInput = document.getElementById('edit-dose-severity');
  dose.severity = sevInput ? sevInput.value : (dose.severity || '');
  dose.adverseFlag = dose.severity === 'severe';
  dose.note = noteInput ? noteInput.value.trim() : dose.note;
  dose.loggedBy = loggerInput ? loggerInput.value.trim() : dose.loggedBy;
  dose.scheduledFor = med.scheduleType === 'scheduled' ? (readiness.scheduledDueAt || dose.scheduledFor || '') : '';
  dose.overrideType = dose.actionType === 'skip'
    ? 'skip'
    : (readiness.conflictBlocked ? 'conflict' : readiness.intervalBlocked ? 'early' : (dose.overrideType === 'edited' ? 'edited' : ''));
  dose.overrideReason = readiness.blockReason || (dose.overrideType === 'edited' ? dose.overrideReason : '');
  state.lastAction = { type: 'edit-dose', doseId: dose.id };
  save();
  render();
  closeModal();
  showToast(`${med.name} updated`);
}

function undoLastDose() {
  const action = state.lastAction;
  if (!action || action.type !== 'add-dose') {
    showToast('Nothing to undo');
    return;
  }
  const dose = state.doses.find(d => d.id === action.doseId);
  if (!dose) {
    showToast('Nothing to undo');
    return;
  }
  // Soft-delete: mark as removed rather than hard-deleting for audit trail
  dose.actionType = 'removed';
  dose.removedAt = now().toISOString();
  state.lastAction = { type: 'undo-add', doseId: action.doseId };
  save();
  render();
  showToast('Last dose removed');
}

function removeDose(id) {
  try {
    const removed = state.doses.find(d => d.id === id) || null;
    if (removed) {
      removed.actionType = 'removed';
      removed.removedAt = now().toISOString();
    }
    state.lastAction = removed ? { type: 'remove-dose', dose: {...removed} } : null;
    save(); render();
  } catch(e) { console.error('removeDose error:',e); captureError(e, 'removeDose'); try{save();render();}catch(e2){ captureError(e2, 'removeDose-recovery'); } }
}
// Rendering: each call is isolated so one failure doesn't break the whole refresh.
function updateDocTitle() {
  try {
    const queue = getNextUpQueue();
    const overdueCount = queue.filter(q => q.isOverdue).length;
    const nextReady = queue.find(q => q.isReady && !q.isOverdue);
    const bits = [];
    if (overdueCount) bits.push(overdueCount + ' overdue');
    if (nextReady) bits.push(nextReady.med.name + ' ready');
    if (isQuietHours()) bits.push('quiet');
    document.title = bits.length ? '(' + bits.join(' | ') + ') Med Tracker' : 'Med Tracker';
  } catch(e) {}
}
function render() {
  const parts = [renderClock,renderDayCounter,renderTrackedTotals,renderWarnings,renderRecoveryNote,renderCareSummary,renderNextUp,renderCards,renderLog,updateDocTitle];
  for (const fn of parts) { try { fn(); } catch(e) { captureError(e, 'render:' + fn.name); } }
}

function renderClock() {
  document.getElementById('clock').textContent = now().toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'});
}
function renderDayCounter() {
  const el=document.getElementById('day-counter');
  if(!CONFIG.eventDate){el.textContent='';return;}
  const diff = Math.floor((now()-new Date(CONFIG.eventDate+'T00:00:00'))/86400000);
  const evtLabel = CONFIG.eventLabel || 'Event';
  el.textContent = diff===0 ? evtLabel+' Day' : `Day ${diff} post-${evtLabel.toLowerCase()}`;
}
function renderTrackedTotals() {
  const container=document.getElementById('tracked-totals');
  const trackedMeds=getDisplayMeds().filter(m=>m.trackTotal);
  if(!trackedMeds.length){container.innerHTML='';return;}
  container.innerHTML=trackedMeds.map(med=>{
    const amt=rolling24hTotal(med.id);
    const pct=Math.min(100,amt/med.maxDaily*100);
    const id='tt-'+med.id;
    return `<div class="tracked-total-section">
      <div class="tracked-total-header">
        <h3>${esc(med.name)} (rolling 24hrs)</h3>
        <div><span class="tracked-total-amount" id="${id}-amount">${amt}</span><span style="font-size:14px;color:var(--muted)">mg / ${med.maxDaily}mg</span></div>
      </div>
      <div class="tracked-total-bar"><div class="tracked-total-fill" id="${id}-fill" style="width:${pct}%;background:${amt<=med.maxDaily*0.5?_cssSuccess:amt<=med.maxDaily*0.75?'#f39c12':'var(--danger-border)'}"></div></div>
    </div>`;
  }).join('');
  // Update colors on amount spans
  trackedMeds.forEach(med=>{
    const amt=rolling24hTotal(med.id);
    const amtEl=document.getElementById('tt-'+med.id+'-amount');
    if(amtEl){
      if(amt<=med.maxDaily*0.5) amtEl.style.color='var(--success)';
      else if(amt<=med.maxDaily*0.75) amtEl.style.color='#f39c12';
      else amtEl.style.color='var(--danger-border)';
    }
  });
}
function renderCareSummary() {
  const container = document.getElementById('care-summary');
  if (!container) return;

  const profile = CONFIG.profile || shared.createEmptyProfile();
  const activeMeds = getDisplayMeds();
  const lowSupply = activeMeds
    .map(med => ({ med, remaining: shared.getCurrentSupply(med, state) }))
    .filter(item => item.remaining !== null && item.remaining <= (item.med.refillThreshold || 0));
  const lastDoseEntry = [...state.doses].sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;

  // Caregiver active-duration: how long the current logger has been on duty today
  const currentLogger = CONFIG.profile?.defaultLoggerName || '';
  let caregiverDurationHtml = '';
  if (currentLogger && state.doses.length) {
    const todayStart = new Date(now()); todayStart.setHours(0,0,0,0);
    const loggerDoses = state.doses.filter(d => d.loggedBy === currentLogger && new Date(d.time) >= todayStart).sort((a,b) => new Date(a.time) - new Date(b.time));
    if (loggerDoses.length) {
      const firstLog = new Date(loggerDoses[0].time);
      const hoursActive = Math.round((now() - firstLog) / 3600000 * 10) / 10;
      const warnClass = hoursActive >= 12 ? 'color:var(--danger)' : hoursActive >= 8 ? 'color:var(--warn-border)' : '';
      caregiverDurationHtml = ` • <span style="${warnClass}">${esc(currentLogger)} on duty ${hoursActive}h (${loggerDoses.length} logs)</span>`;
      if (hoursActive >= 12) caregiverDurationHtml += ' <strong style="color:var(--danger)"> — consider a break</strong>';
    }
  }

  const health = storageHealth || {
    backend: storageMeta.backend || 'localStorage',
    bestEffort: true,
    persisted: false,
    usage: null,
    quota: null,
    lastSuccessfulBackupAt: storageMeta.lastSuccessfulBackupAt,
    lastIntegrityCheckAt: storageMeta.lastIntegrityCheckAt,
    lastSnapshotAt: storageMeta.lastSnapshotAt
  };

  container.innerHTML = `<section class="care-summary" aria-label="Patient and caregiver summary">
    <div class="care-summary-header">
      <div>
        <h2>${esc(profile.careLabel || 'Care Summary')}</h2>
        <div class="care-summary-sub">${activeMeds.length} active medication${activeMeds.length !== 1 ? 's' : ''}${lastDoseEntry ? ` • Last dose ${fmt(lastDoseEntry.time)}` : ' • No doses logged yet'}${caregiverDurationHtml}</div>
      </div>
      <div class="care-summary-actions">
        <button class="summary-action" onclick="openHandoffSummary()">Open handoff</button>
        <button class="summary-action" onclick="openMedicationList()">Medication list</button>
        <button class="summary-action" onclick="downloadFullBackup()">Backup</button>
        ${activeMeds.length ? '<button class="summary-action" onclick="prepareForNewSurgery()" style="border-color:var(--warn-border)">New Surgery</button>' : ''}
      </div>
    </div>
    <div class="summary-grid">
      <div class="summary-panel">
        <h3>Profile</h3>
        <div class="summary-item"><strong>Patient</strong>${esc(CONFIG.patientName || 'Not set')}</div>
        ${profile.dateOfBirth ? `<div class="summary-item" style="margin-top:8px"><strong>DOB</strong>${esc(profile.dateOfBirth)}${profile.dateOfBirth ? ` (age ${Math.floor((now() - new Date(profile.dateOfBirth)) / 31557600000)})` : ''}</div>` : ''}
        ${profile.bloodType ? `<div class="summary-item" style="margin-top:8px"><strong>Blood Type</strong>${esc(profile.bloodType)}</div>` : ''}
        ${profile.weight ? `<div class="summary-item" style="margin-top:8px"><strong>Weight</strong>${esc(profile.weight)}</div>` : ''}
        ${profile.surgeonName ? `<div class="summary-item" style="margin-top:8px"><strong>Surgeon</strong>${esc(profile.surgeonName)}${profile.surgeonPhone ? ` — ${esc(profile.surgeonPhone)}` : ''}</div>` : ''}
        <div class="summary-item" style="margin-top:8px"><strong>Emergency Contact</strong>${profile.emergencyContact ? esc(profile.emergencyContact) : '<span style="color:var(--danger)">⚠️ NOT SET</span>'}</div>
        ${profile.importantInstructions ? `<div class="summary-item" style="margin-top:8px"><strong>Important Instructions</strong>${esc(profile.importantInstructions)}</div>` : ''}
      </div>
      <div class="summary-panel">
        <h3>Key Safety Context</h3>
        <div class="summary-item"><strong>Allergies</strong>${profile.allergies.length ? `<div class="summary-list">${profile.allergies.map(item => `<span class="summary-chip">${esc(item)}</span>`).join('')}</div>` : (profile.allergiesReviewed ? '<span style="color:var(--success)">NKDA (No Known Drug Allergies)</span>' : '<span style="color:var(--danger)">⚠️ NOT REVIEWED</span>')}</div>
        <div class="summary-item" style="margin-top:8px"><strong>Conditions</strong>${profile.conditions.length ? `<div class="summary-list">${profile.conditions.map(item => `<span class="summary-chip">${esc(item)}</span>`).join('')}</div>` : 'None listed'}</div>
        ${lowSupply.length ? `<div class="summary-item" style="margin-top:8px"><strong>Low Supply</strong>${lowSupply.map(item => `${esc(item.med.name)} (${item.remaining} ${esc(getSupplyLabel(item.med))} left)`).join(', ')}</div>` : ''}
        ${(() => { const oc = state.doses.filter(d => d.overrideType && d.actionType !== 'removed').length; return oc ? `<div class="summary-item" style="margin-top:8px"><strong>Safety Overrides</strong><span style="color:var(--warn-border)">${oc} dose${oc !== 1 ? 's' : ''} logged with override</span></div>` : ''; })()}
      </div>
    </div>
    <div class="card-warn" style="margin-top:10px;font-size:12px">⚠️ <strong>Single-device tracker.</strong> Data is stored only on this device. If multiple caregivers log doses, use one shared device to prevent double-dosing.</div>
    <div class="storage-health">
      <div class="storage-tile"><strong>Version</strong><span>${esc(APP_VERSION)}</span></div>
      <div class="storage-tile"><strong>Storage</strong><span>${esc(String(health.backend || 'localStorage'))}</span></div>
      <div class="storage-tile"><strong>Persistence</strong><span>${health.persisted ? 'Protected' : 'Best effort'}</span></div>
      <div class="storage-tile"><strong>Origin</strong><span>${esc(String(health.origin || location.origin))}</span></div>
      <div class="storage-tile"><strong>Usage</strong><span>${health.usage !== null ? `${formatBytes(health.usage)} / ${formatBytes(health.quota)}` : 'Unknown'}</span></div>
      <div class="storage-tile"><strong>Integrity Check</strong><span>${health.lastIntegrityCheckAt ? fmt(health.lastIntegrityCheckAt) : 'Not yet'}</span></div>
      <div class="storage-tile"><strong>Last Backup</strong><span>${health.lastSuccessfulBackupAt ? fmt(health.lastSuccessfulBackupAt) : 'Not yet'}</span></div>
    </div>
    ${(() => {
      if (!state.doses.length) return '';
      const lastBackup = health.lastSuccessfulBackupAt ? new Date(health.lastSuccessfulBackupAt) : null;
      const daysSince = lastBackup ? Math.floor((now() - lastBackup) / 86400000) : null;
      if (!lastBackup || daysSince >= 7) {
        return '<div class="card-warn" style="margin-top:10px">' +
          (lastBackup ? `No backup in ${daysSince} days. ` : 'No backup yet. ') +
          '<a href="#" onclick="downloadFullBackup();return false" style="color:inherit;text-decoration:underline">Back up now</a></div>';
      }
      return '';
    })()}
    <div class="disclaimer" style="margin-top:12px;padding:8px 12px;font-size:11px;color:var(--muted);border-top:1px solid var(--border);line-height:1.4">
      <strong>Not medical advice.</strong> This app is a personal tracking tool only. Always follow your doctor&rsquo;s instructions. Timing suggestions are based on your configured intervals, not clinical judgment. All medication parameters (doses, intervals, maximums, conflicts) were entered by the user and have not been verified by any medical professional. If in doubt, call your care team.
    </div>
  </section>`;
}
function renderWarnings() {
  const container=document.getElementById('warnings-content');
  if(!container) return;
  // Static warnings from WARNINGS array
  let html=WARNINGS.map(w=>`<div class="alert alert-${w.type}"><strong>${esc(w.title)}</strong>${esc(w.text)}</div>`).join('');
  // Auto-generate conflict warnings from med config
  MEDS.filter(m=>m.conflictsWith).forEach(med=>{
    const other=getMed(med.conflictsWith);
    if(!other) return;
    const existsAlready=WARNINGS.some(w=>{
      const t=w.title.toLowerCase();
      const matchMed=t.includes(med.name.toLowerCase())||(med.brand&&t.includes(med.brand.toLowerCase()));
      const matchOther=t.includes(other.name.toLowerCase())||(other.brand&&t.includes(other.brand.toLowerCase()));
      return matchMed&&matchOther;
    });
    if(!existsAlready) {
      html+=`<div class="alert alert-warn"><strong>${esc(other.name)} + ${esc(med.name)} Separation</strong>Must wait at least ${med.conflictMin} minutes between these two medications</div>`;
    }
  });
  // FDA Black Box: warn if both opioids and benzodiazepines are active
  const activeNonArchived = MEDS.filter(m => !m.archived);
  const hasOpioid = activeNonArchived.some(m => m.category === 'opioid');
  const hasBenzo = activeNonArchived.some(m => m.category === 'benzodiazepine');
  if (hasOpioid && hasBenzo) {
    const bbExists = WARNINGS.some(w => w.title.toLowerCase().includes('respiratory') || w.title.toLowerCase().includes('black box'));
    if (!bbExists) {
      html += `<div class="alert alert-danger"><strong>⚠️ FDA Black Box Warning: Opioid + Benzodiazepine</strong>Concurrent use of opioids and benzodiazepines increases risk of respiratory depression, sedation, and death. Use the lowest effective doses and shortest duration. Monitor for unusual drowsiness or slow breathing.</div>`;
    }
  }
  // FDA warning: opioid + gabapentin/pregabalin
  const hasGaba = activeNonArchived.some(m => m.category === 'anticonvulsant' || ['gabapentin','pregabalin'].includes(m.id));
  if (hasOpioid && hasGaba) {
    html += `<div class="alert alert-warn"><strong>⚠️ FDA Warning: Opioid + Gabapentinoid</strong>Concurrent use of opioids and gabapentin/pregabalin may increase risk of respiratory depression. Monitor for unusual drowsiness, slow or difficult breathing.</div>`;
  }
  // Naloxone advisory when opioids are active
  if (hasOpioid) {
    html += `<div class="alert alert-warn"><strong>Naloxone (Narcan) Advisory</strong>Keep naloxone available when opioids are in use. Signs to administer: very slow or stopped breathing, blue lips, unresponsive. Naloxone is available OTC at most pharmacies.</div>`;
  }
  // Alcohol warning when any CNS depressant is active
  const hasCNSDepressant = hasOpioid || hasBenzo || hasGaba;
  if (hasCNSDepressant) {
    html += `<div class="alert alert-warn"><strong>No Alcohol</strong>Do not drink alcohol while taking opioids, benzodiazepines, or gabapentinoids. Alcohol increases the risk of dangerous sedation and respiratory depression.</div>`;
  }
  // Warn if combination APAP meds are used alongside Tylenol
  const hasTylenol = MEDS.some(m => !m.archived && m.trackTotal && (m.id === 'tylenol' || m.name.toLowerCase().includes('acetaminophen')));
  const hasApapCombo = MEDS.some(m => !m.archived && m.apapPerTab > 0);
  if (hasTylenol && hasApapCombo) {
    const apapMeds = MEDS.filter(m => !m.archived && m.apapPerTab > 0).map(m => m.name);
    html += `<div class="alert alert-danger"><strong>⚠️ Acetaminophen in Multiple Meds</strong>${esc(apapMeds.join(', '))} contain${apapMeds.length===1?'s':''} acetaminophen. This is automatically counted toward the Tylenol 24-hour limit (4000mg max). Do not take additional Tylenol without checking your total.</div>`;
  }
  container.innerHTML=html;
  // Hide warnings section if nothing to show
  const section=document.getElementById('warnings-section');
  if(section) section.style.display=(WARNINGS.length||MEDS.some(m=>m.conflictsWith))?'':'none';
}
function renderLog() {
  const previewEl=document.getElementById('log-preview');
  const fullEl=document.getElementById('log-full');
  const countEl=document.getElementById('log-count');
  const activeDoses = state.doses.filter(d => (d.actionType || 'dose') !== 'removed');
  const sorted=[...activeDoses].sort((a,b)=>new Date(b.time)-new Date(a.time));
  const t=todayStr();
  const todayTotal=activeDoses.filter(d=>fmt(d.time,'date')===t).reduce((s,d)=>s+d.tabs,0);
  countEl.textContent = todayTotal > 0 ? `(${todayTotal} today)` : '';
  if(!sorted.length){previewEl.innerHTML='<div class="log-empty">No doses logged yet</div>';fullEl.innerHTML='';return;}
  const trackedTotals={};
  activeDoses.forEach(d => {
    const med = getMed(d.medId);
    if (med && med.trackTotal && (d.actionType || 'dose') !== 'skip') {
      trackedTotals[d.id] = rolling24hTotal(d.medId, d.time);
    }
  });
  const renderEntry = d => {
    const med=getMed(d.medId);
    const isSkip = (d.actionType || 'dose') === 'skip';
    const tabLabel=isSkip ? 'Skipped scheduled dose' : (d.tabs>1?`${d.tabs} tabs`:'1 tab');
    const mgLabel=!isSkip&&d.mg?` (${d.mg}mg)`:''; 
    const trackedNote=(med&&med.trackTotal&&!isSkip)?`<div class="log-tracked-note" style="color:${med.color}">24hr total: ${trackedTotals[d.id]||0}mg</div>`:'';
    const auditBits = [];
    if (d.loggedBy) auditBits.push(`Logged by ${esc(d.loggedBy)}`);
    if (d.overrideType) auditBits.push(`Override: ${esc(d.overrideType)}`);
    if (d.overrideReason) auditBits.push(`Reason: ${esc(d.overrideReason)}`);
    if (d.adverseFlag) auditBits.push('<span style="color:#e74c3c;font-weight:600">ADVERSE REACTION</span>');
    if (d.severity) auditBits.push(`Severity: ${esc(d.severity)}`);
    if (d.painScore >= 0) auditBits.push(`Pain: ${d.painScore}/10`);
    if (d.symptomNote) auditBits.push(`Symptom: ${esc(d.symptomNote)}`);
    if (d.note) auditBits.push(esc(d.note));
    const auditHtml = auditBits.length ? `<div class="card-note">${auditBits.join(' • ')}</div>` : '';
    return `<div class="log-entry">
      <div class="log-time">${fmt(d.time,'time')}</div>
      <div class="log-dot" style="background:${med?med.color:'#999'}"></div>
      <div class="log-detail">
        <div><strong>${esc(med?med.name:d.medId)}</strong> &mdash; ${tabLabel}${mgLabel}</div>
        ${trackedNote}
        ${auditHtml}
      </div>
      <button class="log-remove" onclick="handleEditDose(${d.id})" title="Edit this entry" aria-label="Edit ${esc(med?med.name:d.medId)} entry at ${fmt(d.time,'time')}">Edit</button>
      <button class="log-remove" onclick="handleRemove(${d.id})" title="Remove this entry" aria-label="Remove ${esc(med?med.name:d.medId)} dose at ${fmt(d.time,'time')}">&times;</button>
    </div>`;
  };
  // Partition into current (active/unarchived meds) and archived entries
  const archivedMedIds = new Set(CONFIG.meds.filter(m => m.archived).map(m => m.id));
  const currentEntries = sorted.filter(d => !archivedMedIds.has(d.medId));
  const archivedEntries = sorted.filter(d => archivedMedIds.has(d.medId));

  // Show last 3 current entries as preview (always visible)
  const preview = currentEntries.slice(0, 3);
  const rest = currentEntries.slice(3);
  previewEl.innerHTML = preview.length
    ? preview.map(renderEntry).join('')
    : (archivedEntries.length ? '<div class="log-empty">No new doses logged yet</div>' : '');

  let archivedHtml = '';
  if (archivedEntries.length) {
    // Store entries for lazy rendering on toggle (avoids hidden DOM interfering with selectors)
    window._archivedLogEntries = archivedEntries;
    window._archivedLogRenderer = renderEntry;
    archivedHtml = `<div class="log-archived-section">
      <div class="log-archived-toggle" onclick="toggleArchivedLog()" style="cursor:pointer;padding:10px 0;border-top:1px solid var(--border);margin-top:8px;color:var(--muted);font-size:13px;">
        <span id="archived-log-chevron">&#9654;</span> Previous entries (${archivedEntries.length})
      </div>
      <div id="archived-log-entries" style="display:none"></div>
    </div>`;
  }
  fullEl.innerHTML = rest.map(renderEntry).join('') + archivedHtml;
}

// === Alert & Reminder System ===
let prevAvailability = {};
let alertsInitialized = false;
let alertBannerTimeout = null;
let _lastChimeMs = 0;

function isQuietHours() {
  const qs = CONFIG.profile?.quietStart;
  const qe = CONFIG.profile?.quietEnd;
  if (!qs || !qe) return false;
  const n = now();
  const hhmm = n.getHours() * 60 + n.getMinutes();
  const [sh, sm] = qs.split(':').map(Number);
  const [eh, em] = qe.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start < end ? (hhmm >= start && hhmm < end) : (hhmm >= start || hhmm < end);
}

function playChime() {
  try {
    if (isQuietHours()) return;
    // Rate-limit: at most one chime per 5 minutes to prevent alert fatigue
    const chimeNow = Date.now();
    if (chimeNow - _lastChimeMs < 300000) return;
    _lastChimeMs = chimeNow;
    // Bedside mode: vibrate only, skip audio to avoid startling at night
    if (document.body.classList.contains('bedside')) {
      if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // Samsung Internet / iOS may start context in 'suspended' state
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    // Gentle ascending two-tone chime.
    [523.25, 659.25].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const start = t + i * 0.2;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
      osc.start(start);
      osc.stop(start + 0.45);
    });
    // Close context after tones finish to free resources and avoid hitting browser limits
    setTimeout(() => ctx.close().catch(() => {}), 1500);
  } catch(e) {}
}

function positionAlertBanner() {
  const header = document.querySelector('header');
  const top = header ? Math.ceil(header.getBoundingClientRect().bottom + 12) : 96;
  document.documentElement.style.setProperty('--alert-banner-top', top + 'px');
}

function showAlertBanner(text, isOverdue, medId) {
  const banner = document.getElementById('alert-banner');
  const textEl = document.getElementById('ab-text');
  const logBtn = document.getElementById('ab-log-btn');
  positionAlertBanner();
  textEl.textContent = text;
  banner.className = 'alert-banner ab-visible ' + (isOverdue ? 'ab-overdue' : 'ab-ready');
  const med = getMed(medId);
  logBtn.textContent = med ? `Open ${med.name}` : 'Open';
  logBtn.onclick = () => { dismissAlertBanner(); handleLog(medId); };
  clearTimeout(alertBannerTimeout);
  // Overdue banners persist until tapped (critical for adherence — shouldn't silently disappear)
  // Bedside mode: all banners persist (patient may be groggy)
  // Normal mode: only eligible banners auto-dismiss after 30s
  if (!isOverdue && !document.body.classList.contains('bedside')) {
    alertBannerTimeout = setTimeout(dismissAlertBanner, 30000);
  }
}

function dismissAlertBanner() {
  const banner = document.getElementById('alert-banner');
  banner.classList.remove('ab-visible');
  clearTimeout(alertBannerTimeout);
}

function fireNotification(medName, isOverdue) {
  if (isQuietHours()) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    const title = isOverdue ? medName + ' — scheduled dose overdue' : medName + ' is now eligible';
    const opts = {
      body: 'Check tracker before taking — verify no conflicts or limits',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'med-reminder-' + medName,
      renotify: true
    };
    try {
      // Prefer SW notification — works when page is backgrounded on Android
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts)).catch(() => {
          new Notification(title, opts);
        });
      } else {
        new Notification(title, opts);
      }
    } catch(e) {}
  }
}

// Request notification permission on first interaction
function maybeRequestNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    // Safari <15.4 uses callback form; modern browsers return a Promise
    const result = Notification.requestPermission(() => {});
    if (result && result.catch) result.catch(() => {});
  }
}

// Overdue detection on app resume + timezone/clock drift detection
let _lastMonotonicMs = performance.now();
let _lastWallMs = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Clock drift detection: compare wall-clock jump vs monotonic jump
    const monoElapsed = performance.now() - _lastMonotonicMs;
    const wallElapsed = Date.now() - _lastWallMs;
    const driftMin = Math.abs(wallElapsed - monoElapsed) / 60000;
    if (driftMin > 5) {
      showToast(`Phone clock shifted ~${Math.round(driftMin)}min — dose timers updated`, 5000);
    }
    // Timezone change detection
    const currentTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (CONFIG.scheduleTimezone && currentTz && CONFIG.scheduleTimezone !== currentTz) {
      const banner = document.getElementById('tz-change-banner');
      if (!banner) {
        const div = document.createElement('div');
        div.id = 'tz-change-banner';
        div.className = 'card-warn';
        div.style.cssText = 'margin:8px 12px;padding:10px;font-size:13px';
        div.innerHTML = `⚠️ <strong>Timezone changed</strong> from ${esc(CONFIG.scheduleTimezone)} to ${esc(currentTz)}. Scheduled medication times may be shifted. <button onclick="CONFIG.scheduleTimezone='${currentTz}';save();this.parentElement.remove()" style="margin-left:8px;font-size:12px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:var(--card);cursor:pointer">Update to ${esc(currentTz)}</button>`;
        document.body.querySelector('.header')?.after(div) || document.body.prepend(div);
      }
    }
    _lastMonotonicMs = performance.now();
    _lastWallMs = Date.now();
    render();
    checkAlerts(true);
    // Re-acquire wake lock if in bedside mode (Chrome releases on visibility loss)
    if (document.body.classList.contains('bedside')) acquireWakeLock();
  } else {
    _lastMonotonicMs = performance.now();
    _lastWallMs = Date.now();
  }
});

// Safety net: flush state + config to localStorage on tab close/hide (IDB write may be in-flight)
window.addEventListener('pagehide', () => {
  try {
    // Only write if there's meaningful data (doses exist or config has been personalized)
    const hasData = (state && state.doses && state.doses.length > 0) || (CONFIG && CONFIG.patientName);
    if (hasData) {
      localStorage.setItem(DOSES_KEY, JSON.stringify(state));
      localStorage.setItem(CONFIG_KEY, JSON.stringify(CONFIG));
    }
  } catch (e) { /* best effort */ }
});

// Start alert check loop (every 30 seconds)
checkAlerts(false); // initialize state
setInterval(() => checkAlerts(false), 30000);

// Modal
let _modalReturnFocus = null;
function showModal(html){
  window._doseTimeOffset = 0; // Reset time selector for each new modal
  _modalReturnFocus = document.activeElement;
  document.getElementById('modal').innerHTML='<div class="modal-handle" aria-hidden="true"></div>'+html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  // Enable time selector and focus after modal animation settles (prevents phantom taps during slide-up)
  setTimeout(() => {
    const ts = document.querySelector('.time-selector');
    if (ts) ts.classList.add('ts-ready');
    const btn = document.querySelector('.modal .btn-confirm, .modal .btn-cancel, .modal .btn-danger');
    if (btn) btn.focus();
  }, 400);
}
function closeModal(){
  document.getElementById('modal-overlay').classList.add('hidden');
  window._pendingModalAction = null;
  _lastLogTap = 0; // Reset debounce so next handleLog isn't blocked
  if (_modalReturnFocus) { _modalReturnFocus.focus(); _modalReturnFocus = null; }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('modal-overlay').classList.contains('hidden')) {
    closeModal();
  }
});
function selectTab(el, groupId, val) {
  document.querySelectorAll('#'+groupId+' .modal-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  window._modalTabVal=val;
}

function handleRemove(id) {
  const d=state.doses.find(x=>x.id===id);
  if(!d) return;
  const med=getMed(d.medId);
  const actionLabel = (d.actionType || 'dose') === 'skip' ? 'skip entry' : 'dose';
  showModal(`<h3>Remove dose?</h3>
    <p>Remove ${esc(med?med.name:d.medId)} ${actionLabel} (${fmt(d.time,'time')}) from the log?</p>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Keep</button>
      <button class="btn-danger" onclick="removeDose(${id});closeModal()">Remove</button>
    </div>`);
}

function handleExport() {
  const lines=[...state.doses].sort((a,b)=>new Date(a.time)-new Date(b.time)).map(d=>{
    const med=getMed(d.medId);
    const extras = [d.loggedBy ? `logged by ${d.loggedBy}` : '', d.overrideType ? `override ${d.overrideType}` : '', d.overrideReason ? d.overrideReason : ''].filter(Boolean).join(' | ');
    const action = (d.actionType || 'dose') === 'skip' ? 'SKIPPED' : `${d.tabs} tab(s)\t${d.mg}mg`;
    return `${fmt(d.time)}\t${med?med.name:d.medId}\t${action}${extras ? `\t${extras}` : ''}`;
  });
  let header=(CONFIG.patientName?CONFIG.patientName+' ':'')+'Medication Log';
  if(CONFIG.eventDate) header+='\n'+CONFIG.eventLabel+': '+CONFIG.eventDate;
  header+='\nExported: '+now().toLocaleString()+' ('+Intl.DateTimeFormat().resolvedOptions().timeZone+')';
  const text=header+'\n\n'+lines.join('\n');
  const blob=new Blob([text],{type:'text/plain'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='med-log-'+todayStr()+'.txt';
  a.style.display='none';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},100);
}
function handleClear() {
  showModal(`<h3>Clear dose history?</h3>
    <p>This will remove all logged doses. This cannot be undone.</p>
    <div class="modal-actions" style="flex-direction:column;gap:8px">
      <button class="btn-confirm" onclick="handleExport();closeModal()">Export Log First</button>
      <button class="btn-danger" onclick="confirmClearAllData()">Clear Dose History</button>
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
    </div>`);
}

async function confirmClearAllData() {
  if (state.doses.length > 0) {
    try { downloadFullBackup(); } catch(e) { console.warn('Auto-backup before clear failed:', e); }
  }
  state = seedState();
  save();
  render();
  closeModal();
  showToast('Dose history cleared');
}
function handlePurgeSoftDeleted() {
  const removedCount = state.doses.filter(d => d.actionType === 'removed').length;
  if (removedCount === 0) {
    showToast('No deleted records to purge');
    return;
  }
  showModal(`<h3>Purge ${removedCount} deleted record${removedCount !== 1 ? 's' : ''}?</h3>
    <p>This will permanently erase all dose records previously marked as removed. This cannot be undone.</p>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-danger" onclick="confirmPurgeSoftDeleted()">Purge Permanently</button>
    </div>`);
}
async function confirmPurgeSoftDeleted() {
  const before = state.doses.length;
  const saved = await storageManager.purgeSoftDeleted(CONFIG, state, storageMeta);
  applyBundle(saved);
  closeModal();
  render();
  renderSettingsPanel();
  showToast(`${before - state.doses.length} deleted record(s) permanently erased`);
}


function handleFactoryReset() {
  showModal(`<h3>Delete all data?</h3>
    <p><strong>This will permanently erase everything:</strong> all medications, dose history, patient profile, and settings.</p>
    <p>Consider downloading a backup first.</p>
    <div class="modal-actions" style="flex-direction:column;gap:8px">
      <button class="btn-confirm" onclick="downloadFullBackup();closeModal()">Download Backup First</button>
      <button class="btn-danger" onclick="confirmFactoryReset()">Delete Everything</button>
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
    </div>`);
}
async function confirmFactoryReset() {
  try {
    // Clear all localStorage keys used by the app
    [CONFIG_KEY, DOSES_KEY, BEDSIDE_KEY, 'amanda-meds-v1', 'medtracker-bedside-v1'].forEach(k => {
      try { localStorage.removeItem(k); } catch(e) {}
    });
    // Delete the IndexedDB database entirely
    if (window.indexedDB) {
      try { indexedDB.deleteDatabase('medtracker'); } catch(e) {}
      try { indexedDB.deleteDatabase('medtracker-app-state-v2'); } catch(e) {}
    }
    // Unregister service worker
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) { await reg.unregister(); }
    }
    // Clear caches
    if (window.caches) {
      const keys = await caches.keys();
      for (const key of keys) { await caches.delete(key); }
    }
  } catch(e) { console.warn('Factory reset cleanup error:', e); }
  closeModal();
  location.reload();
}

// === New Surgery Flow ===
function prepareForNewSurgery() {
  const activeMeds = getDisplayMeds();
  if (!activeMeds.length) {
    showToast('No active medications to archive');
    return;
  }
  showModal(`<h3>Prepare for New Surgery</h3>
    <p>This will:</p>
    <ul style="margin:0 0 12px 18px;font-size:14px;color:var(--muted);line-height:1.6">
      <li>Download a full backup of your current data</li>
      <li>Archive all ${activeMeds.length} current medications</li>
      <li>Keep your dose history (collapsed in the log)</li>
    </ul>
    <p>You can then reactivate the meds you still need or add new ones.</p>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-danger" onclick="confirmNewSurgeryPrep()">Archive &amp; Continue</button>
    </div>`);
}

async function confirmNewSurgeryPrep() {
  closeModal();
  // Step 1: Auto-backup
  await downloadFullBackup();
  // Step 2: Archive all active meds
  CONFIG.meds.forEach(med => { med.archived = true; });
  CONFIG.eventDate = null;
  CONFIG.eventLabel = 'Surgery';
  saveConfig(CONFIG);
  render();
  // Step 3: Show reactivation wizard
  showNewSurgeryWizard();
}

function showNewSurgeryWizard() {
  const allMeds = CONFIG.meds;
  const checksHtml = allMeds.map((med, i) => {
    const isLikelySame = ['opioid', 'analgesic', 'antiemetic', 'benzodiazepine', 'stool-softener'].includes(med.category);
    return `<label class="modal-check">
      <input type="checkbox" data-med-index="${i}" ${isLikelySame ? 'checked' : ''}>
      <span>${esc(med.name)}${med.brand ? ' (' + esc(med.brand) + ')' : ''} &mdash; ${esc(med.dose)}</span>
    </label>`;
  }).join('');

  const tomorrow = new Date(Date.now() + 86400000);
  const tomorrowStr = fmt(tomorrow, 'date');

  showModal(`<h3>Set Up New Recovery</h3>
    <p style="font-size:14px;color:var(--muted);margin-bottom:14px">Your backup was downloaded. Select which medications to keep active for this surgery:</p>
    <div style="max-height:240px;overflow-y:auto;margin-bottom:14px">${checksHtml}</div>
    <div class="settings-field">
      <label>Surgery Date</label>
      <input type="date" id="new-surgery-date" value="${tomorrowStr}">
    </div>
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn-cancel" onclick="closeModal();openSettings()">Skip &mdash; I'll set up manually</button>
      <button class="btn-confirm" onclick="applyNewSurgeryWizard()">Activate Selected</button>
    </div>`);
}

function applyNewSurgeryWizard() {
  // Reactivate checked meds
  const checkboxes = document.querySelectorAll('#modal [data-med-index]');
  checkboxes.forEach(cb => {
    const idx = parseInt(cb.dataset.medIndex, 10);
    if (Number.isFinite(idx) && CONFIG.meds[idx]) {
      CONFIG.meds[idx].archived = !cb.checked;
    }
  });
  // Set surgery date
  const dateInput = document.getElementById('new-surgery-date');
  if (dateInput && dateInput.value) {
    CONFIG.eventDate = dateInput.value;
  }
  saveConfig(CONFIG);
  initAppHeader();
  render();
  closeModal();
  const activeCount = CONFIG.meds.filter(m => !m.archived).length;
  showToast(`${activeCount} medication${activeCount !== 1 ? 's' : ''} activated`);
}

function formatIntervalLabel(minutes) {
  return minutes >= 60 ? Math.round(minutes / 60) + ' hour' + (minutes >= 120 ? 's' : '') : minutes + ' minutes';
}

function buildIntervalWarning(info) {
  if (!info.intervalBlocked) return '';
  if (info.isScheduled && info.scheduledInfo) {
    return `<div class="warn-box">This medication is scheduled for ${fmt(info.scheduledInfo.dueAt,'time')}. It becomes due in ${minsToHM(info.minutesUntilEligible)}.</div>`;
  }
  return `<div class="warn-box">Last ${esc(info.med.name)} was ${minsToHM(info.ago)} ago. Recommended interval: ${formatIntervalLabel(info.med.intervalMin)}. Available in ${minsToHM(info.intervalRemaining)}.</div>`;
}

function buildConflictWarning(info) {
  if (!info.conflictBlocked) return '';
  const conflictName = info.conflictMed ? info.conflictMed.name : info.med.conflictsWith;
  return `<div class="warn-box"><strong>⛔ Too soon after ${esc(conflictName)}</strong><div style="font-size:20px;font-weight:800;margin:8px 0">Wait ${minsToHM(Math.ceil(info.conflictRemaining))} more</div><div>Taking these together increases the risk of breathing problems.</div></div>`;
}
function renderScheduledSkipButton(med, info) {
  if (!med || med.scheduleType !== 'scheduled' || !info || !info.isScheduled || info.minutesUntilEligible > 0) return '';
  return `<button class="btn-cancel" onclick="skipScheduledDose('${med.id}')">Skip This Dose</button>`;
}

function getNextUpQueue(referenceDate) {
  const queue = [];
  const displayMeds = getDisplayMeds(referenceDate);
  displayMeds.forEach(med => {
    const info = getMedReadiness(med, referenceDate);
    if (info.hardBlocked) return;
    queue.push(info);
  });
  queue.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    if (a.shouldAlert !== b.shouldAlert) return a.shouldAlert ? -1 : 1;
    const timeDiff = a.minutesUntilEligible - b.minutesUntilEligible;
    if (Math.abs(timeDiff) > 0.5) return timeDiff;
    if (a.med.scheduled !== b.med.scheduled) return a.med.scheduled ? -1 : 1;
    const aOpioid = a.med.category === 'opioid' ? 1 : 0;
    const bOpioid = b.med.category === 'opioid' ? 1 : 0;
    if (aOpioid !== bOpioid) return aOpioid - bOpioid;
    return displayMeds.indexOf(a.med) - displayMeds.indexOf(b.med);
  });
  return queue;
}

function renderNextUp() {
  const container = document.getElementById('next-up');
  const queue = getNextUpQueue();
  if (queue.length === 0) {
    container.innerHTML = '<div class="next-up-clear"><div class="nuc-calm">All caught up!</div><div class="nuc-detail">Every scheduled medication is on track. Great job.</div></div>';
    return;
  }
  const primary = queue[0];
  const primaryStatus = getReadinessStatus(primary);
  const rest = queue.slice(1, 4);
  if (!primary.isReadyRecommended && !primary.isOverdue && primary.minutesUntilEligible > 120) {
    container.innerHTML = `<div class="next-up-clear"><div class="nuc-calm">All clear - you're on track</div><div class="nuc-detail">Next up: ${esc(primary.med.name)} in ${minsToHM(primary.minutesUntilEligible)}. Relax until then.</div></div>`;
    return;
  }
  const cardClass = primary.isOverdue ? 'nuc-overdue' : primary.isReadyRecommended ? 'nuc-available' : '';
  const fillColor = primary.isReadyRecommended ? 'var(--success)' : primary.med.color;
  const btnLabel = primaryStatus.canLogRecommended ? 'Log Dose Now' : primaryStatus.actionLabel;
  let html = `<div class="next-up-label">Next Up</div>
    <div class="next-up-card ${cardClass}">
      <div class="nuc-header">
        <div>
          <div class="nuc-name" style="color:${primary.med.color}">${esc(primary.med.name)}</div>
          ${primary.med.brand ? `<div class="nuc-brand">${esc(primary.med.brand)}</div>` : ''}
        </div>
        <div class="card-badge" style="background:${primary.med.bgBadge};color:${primary.med.color}">${esc(primary.med.purpose)}</div>
      </div>
      <div class="nuc-dose">${esc(primary.med.dose)} &mdash; ${esc(primary.med.freq)}</div>
      <div class="nuc-status"><span class="dot ${primaryStatus.dot}"></span>${primaryStatus.text}</div>
      <div class="nuc-timer-bar"><div class="nuc-timer-fill" style="width:${primary.progressPct}%;background:${fillColor}"></div></div>
      ${primary.conflictBlocked ? `<div class="warn-box" style="margin:8px 0;font-size:13px"><strong>⚠️ Conflict:</strong> Wait ${minsToHM(primary.conflictRemaining)} — ${esc(primary.conflictMed?.name || '')} interaction window</div>` : ''}
      ${primary.med.trackTotal && primary.rollingTotal >= primary.med.maxDaily * 0.75 ? `<div class="warn-box" style="margin:8px 0;font-size:13px"><strong>⚠️ 24h total:</strong> ${primary.rollingTotal}${primary.med.unitLabel || 'mg'} of ${primary.med.maxDaily}${primary.med.unitLabel || 'mg'} max</div>` : ''}
      ${primary.shouldOfferReminder ? `<button class="btn-reminder" onclick="event.stopPropagation();downloadReminder('${primary.med.id}')" style="margin-bottom:12px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 1.5"/><path d="M5 3L2 6M22 6l-3-3"/></svg>Set phone alarm for when it's due</button>` : ''}
      <button class="btn-log-next" style="background:${primary.med.color}" onclick="handleLog('${primary.med.id}')">${btnLabel}</button>
    </div>`;
  if (nqiExpandedMedId && !rest.find(i => i.med.id === nqiExpandedMedId)) nqiExpandedMedId = null;
  if (rest.length > 0) {
    const secOpen = !nqiSectionCollapsed;
    html += `<button class="nqi-section-toggle" onclick="toggleNqiSection()" aria-expanded="${secOpen}" aria-controls="nqi-queue-wrap">
      <span>Then (${rest.length} more)</span>
      <span class="chevron ${secOpen ? 'open' : ''}">&#9660;</span>
    </button>`;
    html += `<div id="nqi-queue-wrap" class="nqi-queue-wrap ${nqiSectionCollapsed ? 'collapsed' : ''}"><div class="next-up-queue">`;
    rest.forEach(item => {
      const itemStatus = getReadinessStatus(item);
      const isExp = nqiExpandedMedId === item.med.id;
      html += `<div class="nqi" onclick="toggleNqiItem('${item.med.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleNqiItem('${item.med.id}')}" role="button" tabindex="0" aria-expanded="${isExp}">
        <div class="nqi-dot" style="background:${item.med.color}"></div>
        <div class="nqi-name">${esc(item.med.name)}</div>
        <div class="nqi-time">${getQueueTimeLabel(item)}</div>
        <span class="nqi-chevron ${isExp ? 'open' : ''}">&#9660;</span>
      </div>`;
      html += `<div class="nqi-detail ${isExp ? 'open' : ''}">
        <div class="nqi-detail-dose">${esc(item.med.dose)} &mdash; ${esc(item.med.freq)}</div>
        <div class="nqi-detail-status"><span class="dot ${itemStatus.dot}"></span>${itemStatus.text}</div>
        <button class="nqi-btn-log" style="background:${item.med.color}" onclick="event.stopPropagation();handleLog('${item.med.id}')">${itemStatus.canLogRecommended ? 'Log Dose' : itemStatus.actionLabel}</button>
        ${item.shouldOfferReminder ? `<button class="nqi-btn-reminder" onclick="event.stopPropagation();downloadReminder('${item.med.id}')">&#9200; Set alarm</button>` : ''}
      </div>`;
    });
    html += '</div></div>';
  }
  container.innerHTML = html;
}

function renderCards() {
  const container=document.getElementById('med-cards');
  const activeMeds = getDisplayMeds();
  if(activeMeds.length===0){
    container.innerHTML='<div class="empty-state"><p>No medications added yet.<br>Tap the gear icon to add your first one.</p><button onclick="openSettings();startAddMed()">+ Add Medication</button></div>';
    return;
  }
  container.innerHTML=activeMeds.map(med=>{
    const info=getMedReadiness(med);
    const status=getReadinessStatus(info);
    const warnsHtml=(med.warns||[]).map(w=>`<div class="card-warn">${esc(w)}</div>`).join('');
    const scheduleText = med.scheduleType === 'scheduled' && med.scheduledTimes && med.scheduledTimes.length
      ? `Scheduled: ${med.scheduledTimes.map(format12h).join(', ')}`
      : (med.reason || med.instructions || '');
    const supplyRemaining = shared.getCurrentSupply(med, state);
    const supplyPct = supplyRemaining === null || !med.supplyOnHand ? null : Math.max(0, Math.min(100, (supplyRemaining / med.supplyOnHand) * 100));
    const supplyTone = supplyRemaining !== null && supplyRemaining <= (med.refillThreshold || 0) ? 'var(--danger-border)' : 'var(--success)';
    const trackedPct = med.trackTotal && med.maxDaily ? Math.min(100, (info.rollingTotal / med.maxDaily) * 100) : null;
    return `<div class="card" role="listitem" aria-label="${esc(med.name)} medication card" data-med-id="${esc(med.id)}">
      <div class="card-accent" style="background:${med.color}"></div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <div class="card-name" style="color:${med.color}">${esc(med.name)}</div>
            ${med.brand?`<div class="card-brand">${esc(med.brand)}</div>`:''}
          </div>
          <div class="card-badge" style="background:${med.bgBadge};color:${med.color}">${esc(med.purpose)}</div>
          <button class="card-edit-btn" onclick="event.stopPropagation();quickEditMed('${med.id}')" title="Edit ${esc(med.name)}" aria-label="Edit ${esc(med.name)} settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        </div>
        <div class="card-dose">${esc(med.dose)} &mdash; ${esc(med.freq)}</div>
        ${scheduleText ? `<div class="card-note">${esc(scheduleText)}</div>` : ''}
        <div class="card-status"><span class="dot ${status.dot}"></span>${status.text}</div>
        <div class="card-timer">${info.last?`Last: ${fmt(info.last.time,'time')} (${minsToHM(info.ago)} ago)`:'No doses logged yet'}</div>
        <div class="timer-bar"><div class="timer-fill" style="width:${info.progressPct}%;background:${info.isReadyRecommended?'var(--success)':med.color}"></div></div>
        ${trackedPct !== null ? `<div class="metric-group"><div class="metric-label"><span>24h total</span><span>${info.rollingTotal}mg / ${med.maxDaily}mg</span></div><div class="metric-bar"><div class="metric-bar-fill" style="width:${trackedPct}%;background:${trackedPct >= 90 ? 'var(--danger-border)' : trackedPct >= 70 ? 'var(--warn-border)' : 'var(--success)'}"></div></div></div>` : ''}
        ${supplyPct !== null ? `<div class="metric-group"><div class="metric-label"><span>Supply left</span><span>${supplyRemaining} / ${med.supplyOnHand} ${esc(getSupplyLabel(med))}</span></div><div class="metric-bar"><div class="metric-bar-fill" style="width:${supplyPct}%;background:${supplyTone}"></div></div></div>` : ''}
        ${med.maxDoses ? `<div class="completion-dots">${Array.from({length:med.maxDoses},(_,i)=>`<span class="cd-dot" style="border-color:${med.color};${i<info.todayCount.length?'background:'+med.color:''}"></span>`).join('')}<span class="cd-label">${info.todayCount.length >= med.maxDoses ? (med.scheduleType === 'prn' ? med.maxDoses+' of '+med.maxDoses+' used (limit)' : 'All done!') : info.todayCount.length === 0 ? '0 of '+med.maxDoses+' today' : info.todayCount.length+' of '+med.maxDoses+(med.scheduleType === 'prn' ? ' used' : ' - '+(med.maxDoses-info.todayCount.length)+' to go')}</span></div>` : `<div class="card-today">Today: ${info.todayTabs} tab${info.todayTabs!==1?'s':''}${info.todayMg?' ('+info.todayMg+'mg)':''}</div>`}
        ${warnsHtml}
        ${info.hardBlocked ? '' : `<button class="btn-reminder" onclick="event.stopPropagation();downloadReminder('${med.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 1.5"/><path d="M5 3L2 6M22 6l-3-3"/></svg>Set Reminder</button>`}
        <button class="btn-log" style="background:${med.color}" onclick="handleLog('${med.id}')" ${status.canOpenModal ? '' : 'disabled'}>${status.actionLabel}</button>
      </div>
    </div>`;
  }).join('');
}

function checkAlerts(forceOverdueCheck) {
  const queue = getNextUpQueue();
  if (!alertsInitialized) {
    queue.forEach(item => { prevAvailability[item.med.id] = item.shouldAlert; });
    alertsInitialized = true;
    if (forceOverdueCheck) {
      const overdue = queue.filter(q => q.isOverdue);
      if (overdue.length > 0) showAlertBanner(overdue[0].med.name + ' is overdue - tap to log', true, overdue[0].med.id);
    }
    return;
  }
  const newlyAvailable = [];
  queue.forEach(item => {
    const wasAvailable = prevAvailability[item.med.id] || false;
    prevAvailability[item.med.id] = item.shouldAlert;
    if (item.shouldAlert && !wasAvailable && item.med.scheduleType !== 'prn') newlyAvailable.push(item);
  });
  if (newlyAvailable.length > 0) {
    const primary = newlyAvailable[0];
    showAlertBanner(primary.med.name + ' is now eligible', false, primary.med.id);
    playChime();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    fireNotification(primary.med.name, false);
  }
  if (forceOverdueCheck) {
    const overdue = queue.filter(q => q.isOverdue);
    if (overdue.length > 0 && newlyAvailable.length === 0) {
      showAlertBanner(overdue[0].med.name + ' is overdue - tap to log', true, overdue[0].med.id);
      playChime();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
      fireNotification(overdue[0].med.name, true);
    }
  }
}

function downloadReminder(medId) {
  const med = getMed(medId);
  if (!med) return;
  const info = getMedReadiness(med);
  if (info.hardBlocked) {
    const blockText = info.dailyLimitBlocked
      ? `No reminder set for ${esc(med.name)} because another dose would exceed the 24-hour maximum.`
      : `No reminder set for ${esc(med.name)} because all doses for today are already logged.`;
    showModal(`<h3>Reminder unavailable</h3>
      <p>${blockText}</p>
      <div class="modal-actions">
        <button class="btn-confirm" onclick="closeModal()">OK</button>
      </div>`);
    return;
  }
  let nextTime;
  if (info.shouldOfferReminder && info.nextEligibleAt) {
    nextTime = new Date(info.nextEligibleAt);
  } else if (info.last) {
    nextTime = new Date(new Date(info.last.time).getTime() + med.intervalMin * 60000);
    if (nextTime < now()) nextTime = new Date(now().getTime() + 5 * 60000);
  } else {
    nextTime = new Date(now().getTime() + 30 * 60000);
  }
  const end = new Date(nextTime.getTime() + 5 * 60000);
  const pad = n => String(n).padStart(2, '0');
  const icsDate = d => d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const icsEsc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
  const tzid = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const ics = [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//MedTracker//EN',
    'BEGIN:VEVENT',
    'UID:' + Date.now() + '-' + medId + '@medtracker',
    'DTSTART;TZID=' + tzid + ':' + icsDate(nextTime),
    'DTEND;TZID=' + tzid + ':' + icsDate(end),
    'SUMMARY:' + icsEsc(med.name) + ' — check tracker' + (med.brand ? ' (' + icsEsc(med.brand) + ')' : ''),
    'DESCRIPTION:' + icsEsc(med.dose) + ' - ' + icsEsc(med.freq) + '. Check Med Tracker app before taking — verify no conflicts or limits.',
    'BEGIN:VALARM','TRIGGER:-PT0M','ACTION:DISPLAY',
    'DESCRIPTION:' + icsEsc(med.name) + ' is now eligible — check tracker',
    'END:VALARM',
    'BEGIN:VALARM','TRIGGER:-PT5M','ACTION:DISPLAY',
    'DESCRIPTION:' + icsEsc(med.name) + ' eligible in 5 minutes',
    'END:VALARM',
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'reminder-' + med.name.toLowerCase().replace(/\s+/g, '-') + '.ics';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

let _lastLogTap = 0;
function handleLog(medId) {
  try {
    const tapNow = Date.now();
    if (tapNow - _lastLogTap < 1500) return;
    _lastLogTap = tapNow;
    const med=getMed(medId);
    if(!med){console.error('handleLog: unknown med',medId);return;}
    const info = getMedReadiness(med);
    if (info.hardBlocked) {
      const blockText = info.dailyLimitBlocked
        ? `Another dose would exceed the ${med.maxDaily}mg 24-hour maximum for ${esc(med.name)}.`
        : `${esc(med.name)} already has all ${med.maxDoses} doses logged for today.`;
      showModal(`<h3>${esc(med.name)} unavailable</h3>
        <p>${blockText}</p>
        <div class="modal-actions">
          <button class="btn-confirm" onclick="closeModal()">OK</button>
        </div>`);
      return;
    }
    // NSAID restriction: block during first 14 recovery days
    if (med.category === 'nsaid') {
      const day = getRecoveryDay();
      if (day >= 0 && day < 14) {
        showModal(`<h3>⛔ ${esc(med.name)} blocked</h3>
          <p><strong>No NSAIDs for 14 days after surgery.</strong></p>
          <p>NSAIDs (ibuprofen, naproxen, aspirin) increase bleeding risk at the surgical site. You are on post-op day ${day}.</p>
          <p>Use Tylenol for pain instead. Contact your surgeon if you need stronger pain relief.</p>
          <div class="modal-actions"><button class="btn-confirm" onclick="closeModal()">OK</button></div>`);
        return;
      }
    }
    // Opioid tapering prompt: day 4+ soft interstitial
    if (med.category === 'opioid') {
      const day = getRecoveryDay();
      if (day >= 4 && !window._opioidTaperAcked) {
        window._opioidTaperAcked = true; // Only show once per session to avoid fatigue
        showModal(`<h3>Day ${day} — Have you tried Tylenol first?</h3>
          <p>Many patients manage pain with Tylenol alone by day 4-5 of recovery.</p>
          <p>${esc(med.name)} is available if Tylenol isn't enough for breakthrough pain.</p>
          ${day >= 7 ? `<p style="color:var(--danger-border)"><strong>Day 7+:</strong> If still needing opioids regularly, contact your surgeon.</p>` : ''}
          <div class="modal-actions">
            <button class="btn-cancel" onclick="closeModal()">Go Back</button>
            <button class="btn-confirm" onclick="closeModal();handleLog('${medId}')">I Need ${esc(med.name)}</button>
          </div>`);
        return;
      }
    }
    // Antiemetic pre-dose suggestion: if logging an opioid, check if there's an antiemetic
    // that should be taken first (30 min before) and hasn't been taken recently
    if (med.category === 'opioid' && !window._antiemeticPreDoseShown) {
      const antiemeticMeds = MEDS.filter(m => !m.archived && m.category === 'antiemetic' && (m.pairedWith === med.id || m.pairedWith === ''));
      const recentAntiemetic = antiemeticMeds.some(am => {
        const amLast = lastDose(am.id, now());
        return amLast && getDoseAgeMinutes(amLast, now()) < (am.intervalMin || 240);
      });
      if (antiemeticMeds.length > 0 && !recentAntiemetic) {
        window._antiemeticPreDoseShown = true;
        const aeNames = antiemeticMeds.map(m => m.name).join(' or ');
        showModal(`<h3>Take anti-nausea medication first?</h3>
          <p>Antiemetics like <strong>${esc(aeNames)}</strong> work best when taken <strong>30 minutes before</strong> an opioid dose.</p>
          <p>If you're prone to nausea from ${esc(med.name)}, consider logging your antiemetic now and waiting 30 minutes before taking ${esc(med.name)}.</p>
          <div class="modal-actions">
            <button class="btn-cancel" onclick="closeModal();handleLog('${antiemeticMeds[0].id}')">Log ${esc(antiemeticMeds[0].name)} First</button>
            <button class="btn-confirm" onclick="closeModal();window._antiemeticPreDoseShown=true;handleLog('${medId}')">Skip — Log ${esc(med.name)} Now</button>
          </div>`);
        return;
      }
    }
    if(med.conflictsWith) return showConflictModal(med);
    if(med.trackTotal) return showTrackedModal(med);
    if(med.maxTabs>1||findPairedMeds(medId).length>0) return showMultiTabModal(med);
    showModal(`<h3>Log ${esc(med.name)}${med.brand?' ('+esc(med.brand)+')':''}</h3>
      <p>${esc(med.dose)}</p>${buildIntervalWarning(info)}
      ${renderTimeSelector()}
      ${renderLoggerField()}
      ${renderSymptomField()}
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        ${renderScheduledSkipButton(med, info)}
        <button class="btn-confirm" onclick="confirmSingleDose('${medId}',1)">Log ${esc(med.name)}</button>
      </div>`);
  } catch(e) { console.error('handleLog error:',e); }
}

function showMultiTabModal(med) {
  const info = getMedReadiness(med);
  let tabsHtml='';
  if(med.maxTabs>1){
    tabsHtml=`<p style="font-weight:600;margin-bottom:6px">How many tablets?</p><div class="modal-tabs" id="modal-tab-group">`;
    for(let i=1;i<=med.maxTabs;i++){
      const active=i===1?'active':'';
      const mg=i*med.perTab;
      tabsHtml+=`<button type="button" class="modal-tab ${active}" onclick="selectTab(this,'modal-tab-group',${i})">${i} tab${i>1?'s':''}<span class="sub">${mg}mg</span></button>`;
    }
    tabsHtml+='</div>';
  }
  const paired=findPairedMeds(med.id);
  let pairedHtml='';
  paired.forEach(pm=>{
    pairedHtml+=`<label class="modal-check"><input type="checkbox" data-paired-med="${pm.id}"> Also log ${esc(pm.name)}${pm.brand?' ('+esc(pm.brand)+')':''} ${esc(pm.dose)} if it was taken now for ${esc(pm.purpose.toLowerCase())}</label>`;
  });
  window._modalMedId=med.id;
  window._modalTabVal=1;
  showModal(`<h3>Log ${esc(med.name)}</h3>${buildIntervalWarning(info)}
    ${tabsHtml}${pairedHtml}
    ${renderTimeSelector()}
    ${renderLoggerField()}
    ${renderSymptomField()}
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      ${renderScheduledSkipButton(med, info)}
      <button class="btn-confirm" onclick="confirmMultiTab()">Log Dose</button>
    </div>`);
}

function disableModalConfirmButtons() {
  document.querySelectorAll('#modal .btn-confirm, #modal .btn-danger').forEach(b => b.disabled = true);
}
function confirmMultiTab() {
  try {
    disableModalConfirmButtons();
    const doseTime = getDoseTime();
    const pairedMedIds = [...document.querySelectorAll('[data-paired-med]')].filter(cb => cb.checked).map(cb => cb.dataset.pairedMed);
    const loggedBy = CONFIG.profile?.defaultLoggerName || getModalLoggerName();
    const symptomNote = getModalSymptomNote();
    const severity = getModalSeverity();
    const painScore = getModalPainScore();
    const primaryAdded = addDose(window._modalMedId, window._modalTabVal||1, doseTime, {
      loggedBy, symptomNote, severity, painScore,
      pairedMedIds
    });
    if (!primaryAdded) return;
    pairedMedIds.forEach(pairedMedId => addDose(pairedMedId,1,doseTime, { loggedBy }));
    closeModal();
  } catch(e) { console.error('confirmMultiTab error:',e); closeModal(); }
}

function showTrackedModal(med) {
  const info = getMedReadiness(med);
  const cautionThreshold=med.maxDaily*0.75;
  const allowedTabs = [];
  for (let i = 1; i <= med.maxTabs; i++) {
    if (info.rollingTotal + (i * med.perTab) <= med.maxDaily) allowedTabs.push(i);
  }
  const defaultTabs = allowedTabs.includes(2) ? 2 : (allowedTabs[allowedTabs.length - 1] || 1);
  let tabsHtml='<p style="font-weight:600;margin-bottom:6px">How many tablets?</p><div class="modal-tabs" id="modal-tab-group">';
  for(let i=1;i<=med.maxTabs;i++){
    const mg=i*med.perTab;
    const projected=info.rollingTotal+mg;
    let warnSpan='';
    if(projected>med.maxDaily) warnSpan='<span style="color:var(--danger-border)"> (exceeds limit!)</span>';
    else if(projected>cautionThreshold) warnSpan='<span style="color:var(--warn-border)"> (caution)</span>';
    const disabled = projected > med.maxDaily;
    const active=i===defaultTabs&&!disabled?'active':'';
    tabsHtml+=`<button type="button" class="modal-tab ${active}" onclick="${disabled ? '' : `selectTab(this,'modal-tab-group',${i})`}" ${disabled ? 'disabled' : ''}>${i} tab${i>1?'s':''}<span class="sub">${mg}mg &rarr; ${projected}mg total${warnSpan}</span></button>`;
  }
  tabsHtml+='</div>';
  const maxTabMg=info.rollingTotal+med.maxTabs*med.perTab;
  const exceedWarn=maxTabMg>med.maxDaily?`<div class="warn-box">Taking ${med.maxTabs} tablets would exceed the ${med.maxDaily}mg daily maximum!</div>`:'';
  // Paired meds (same as multi-tab modal)
  const paired=findPairedMeds(med.id);
  let pairedHtml='';
  paired.forEach(pm=>{
    pairedHtml+=`<label class="modal-check"><input type="checkbox" data-paired-med="${pm.id}"> Also log ${esc(pm.name)}${pm.brand?' ('+esc(pm.brand)+')':''} ${esc(pm.dose)} if it was taken now for ${esc(pm.purpose.toLowerCase())}</label>`;
  });
  window._modalMedId=med.id;
  window._modalTabVal=defaultTabs;
  showModal(`<h3>Log ${esc(med.name)}${med.brand?' ('+esc(med.brand)+')':''}</h3>${buildSameDayComboWarning(med)}${buildIntervalWarning(info)}
    ${tabsHtml}${pairedHtml}
    ${exceedWarn}
    <p style="font-size:13px;color:var(--muted)">24hr total so far: ${info.rollingTotal}mg / ${med.maxDaily}mg <span style="font-size:11px">(only doses logged here)</span></p>
    ${renderTimeSelector()}
    ${renderLoggerField()}
    ${renderSymptomField()}
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      ${renderScheduledSkipButton(med, info)}
      <button class="btn-confirm" onclick="confirmTracked()" ${allowedTabs.length ? '' : 'disabled'}>Log ${esc(med.name)}</button>
    </div>`);
}

function confirmSingleDose(medId, tabs, userOverrideReason) {
  try {
    disableModalConfirmButtons();
    const med = getMed(medId);
    const doseTime = getDoseTime();
    const info = med ? getMedReadiness(med, doseTime) : null;
    const overrideReason = userOverrideReason
      ? `[USER] ${userOverrideReason} | [SYSTEM] ${info?.blockReason || ''}`
      : (info ? info.blockReason : '');
    const added = addDose(medId, tabs||1, doseTime, {
      loggedBy: CONFIG.profile?.defaultLoggerName || getModalLoggerName(),
      symptomNote: getModalSymptomNote(),
      severity: getModalSeverity(),
      painScore: getModalPainScore(),
      overrideType: info && (info.conflictBlocked ? 'conflict' : info.intervalBlocked ? 'early' : ''),
      overrideReason
    });
    if (added) closeModal();
  }
  catch(e) { console.error('confirmSingleDose error:',e); closeModal(); }
}

function confirmTracked() {
  try {
    disableModalConfirmButtons();
    const med = getMed(window._modalMedId);
    const tabs = window._modalTabVal||1;
    if (!med) return closeModal();
    const doseTime = getDoseTime();
    const info = getMedReadiness(med, doseTime);
    const projected = info.rollingTotal + (tabs * med.perTab);
    if (projected > med.maxDaily) {
      showModal(`<h3>${esc(med.name)} limit reached</h3>
        <p>That dose would bring the 24-hour total to ${projected}mg, above the ${med.maxDaily}mg maximum.</p>
        <div class="modal-actions">
          <button class="btn-confirm" onclick="closeModal()">OK</button>
        </div>`);
      return;
    }
    const loggedBy = CONFIG.profile?.defaultLoggerName || getModalLoggerName();
    const pairedMedIds = [...document.querySelectorAll('[data-paired-med]')].filter(cb => cb.checked).map(cb => cb.dataset.pairedMed);
    const added = addDose(window._modalMedId, tabs, doseTime, {
      loggedBy,
      symptomNote: getModalSymptomNote(),
      severity: getModalSeverity(),
      painScore: getModalPainScore(),
      overrideType: info.intervalBlocked ? 'early' : '',
      overrideReason: info.blockReason,
      pairedMedIds
    });
    if (!added) return;
    pairedMedIds.forEach(pairedMedId => addDose(pairedMedId, 1, doseTime, { loggedBy }));
    closeModal();
  }
  catch(e) { console.error('confirmTracked error:',e); closeModal(); }
}

function buildSameDayComboWarning(med) {
  // Warn about same-day opioid+benzo even when timing conflict has cleared
  const isOpioid = med.category === 'opioid';
  const isBenzo = med.category === 'benzodiazepine';
  if (!isOpioid && !isBenzo) return '';
  const t = todayStr();
  const otherCat = isOpioid ? 'benzodiazepine' : 'opioid';
  const otherToday = state.doses.some(d => {
    const m = getMed(d.medId);
    return m && m.category === otherCat && (d.actionType || 'dose') !== 'skip' && d.actionType !== 'removed' && fmt(d.time, 'date') === t;
  });
  if (!otherToday) return '';
  return `<div class="warn-box" style="background:var(--warn-bg);border-color:var(--warn-border)"><strong>⚠️ Opioid + benzodiazepine today</strong><div style="font-size:13px;margin-top:4px">Both have been taken today. Even with doses separated by hours, the combination increases sedation and respiratory depression risk. Monitor for excessive drowsiness or slow breathing.</div></div>`;
}
function showConflictModal(med) {
  const info = getMedReadiness(med);
  const confirmLabel = info.canOverride ? `Override — Log ${esc(med.name)}` : `Log ${esc(med.name)}`;
  const confirmClass = info.canOverride ? 'btn-danger' : 'btn-confirm';
  const needsAck = info.conflictBlocked && info.canOverride;
  showModal(`<h3>Log ${esc(med.name)}${med.brand?' ('+esc(med.brand)+')':''} ${esc(med.dose)}</h3>${buildConflictWarning(info)}${buildSameDayComboWarning(med)}${buildIntervalWarning(info)}
    <p>${esc(med.purpose)} &mdash; 1 tablet</p>
    ${renderTimeSelector()}
    ${renderLoggerField()}
    ${renderSymptomField()}
    ${needsAck ? `<div style="margin-top:10px;padding:8px;border:1px solid var(--danger);border-radius:6px;background:var(--danger-bg,rgba(231,76,60,0.1))">
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;line-height:1.4">
        <input type="checkbox" id="conflict-ack" onchange="document.getElementById('conflict-override-btn').disabled=!this.checked" style="margin-top:3px;min-width:20px;min-height:20px">
        I understand this overrides a drug interaction safety window. I accept responsibility for this decision.
      </label>
      <div class="settings-field" style="margin-top:8px"><label style="font-size:12px">Reason for override (required)</label><input type="text" id="conflict-reason" placeholder="e.g. Doctor advised OK, patient in acute pain" oninput="document.getElementById('conflict-override-btn').disabled=!(document.getElementById('conflict-ack').checked && this.value.trim().length>=3)" style="font-size:14px"></div>
    </div>` : ''}
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      ${renderScheduledSkipButton(med, info)}
      <button id="conflict-override-btn" class="${confirmClass}" ${needsAck ? 'disabled' : ''} onclick="confirmSingleDose('${med.id}',1${needsAck ? `,document.getElementById('conflict-reason')?.value` : ''})">${confirmLabel}</button>
    </div>`);
}

// === Phase 4: Progressive Disclosure ===
function getRecoveryDay() {
  if(!CONFIG.eventDate) return -1;
  // Use noon-to-noon to avoid DST off-by-one (23h or 25h days)
  const eventNoon = new Date(CONFIG.eventDate + 'T12:00:00');
  const todayNoon = new Date(now()); todayNoon.setHours(12, 0, 0, 0);
  return Math.round((todayNoon - eventNoon) / 86400000);
}

let warningsCollapsed = false;
let logCollapsed = false;
let nqiSectionCollapsed = false;
let nqiExpandedMedId = null;
let _nqiTick = 0;

function toggleWarnings() {
  warningsCollapsed = !warningsCollapsed;
  const content = document.getElementById('warnings-content');
  const chevron = document.getElementById('warn-chevron');
  const btn = document.getElementById('warn-toggle-btn');
  content.classList.toggle('collapsed', warningsCollapsed);
  chevron.classList.toggle('open', !warningsCollapsed);
  if (btn) btn.setAttribute('aria-expanded', !warningsCollapsed);
}
function toggleArchivedLog() {
  const entries = document.getElementById('archived-log-entries');
  const chevron = document.getElementById('archived-log-chevron');
  if (!entries) return;
  const hidden = entries.style.display === 'none';
  // Lazy render on first expand
  if (hidden && !entries.children.length && window._archivedLogEntries && window._archivedLogRenderer) {
    entries.innerHTML = window._archivedLogEntries.map(window._archivedLogRenderer).join('');
  }
  entries.style.display = hidden ? '' : 'none';
  chevron.innerHTML = hidden ? '&#9660;' : '&#9654;';
}

function toggleLog() {
  logCollapsed = !logCollapsed;
  const full = document.getElementById('log-full');
  const chevron = document.getElementById('log-chevron');
  const h2 = full.parentElement.querySelector('h2');
  full.classList.toggle('collapsed', logCollapsed);
  chevron.classList.toggle('open', !logCollapsed);
  if (h2) h2.setAttribute('aria-expanded', !logCollapsed);
}
function toggleNqiSection() {
  nqiSectionCollapsed = !nqiSectionCollapsed;
  const wrap = document.getElementById('nqi-queue-wrap');
  if (wrap) wrap.classList.toggle('collapsed', nqiSectionCollapsed);
  const btn = document.querySelector('.nqi-section-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', !nqiSectionCollapsed);
    const chev = btn.querySelector('.chevron');
    if (chev) chev.classList.toggle('open', !nqiSectionCollapsed);
  }
}
function toggleNqiItem(medId) {
  nqiExpandedMedId = (nqiExpandedMedId === medId) ? null : medId;
  try { renderNextUp(); } catch(e) { console.error('renderNextUp:', e); }
}

// Auto-collapse warnings after day 2
function initWarningsState() {
  const day = getRecoveryDay();
  // Don't auto-collapse if danger-level warnings exist (e.g. opioid+benzo)
  const hasDangerWarnings = WARNINGS.some(w => w.type === 'danger') ||
    (MEDS.some(m => !m.archived && m.category === 'opioid') && MEDS.some(m => !m.archived && m.category === 'benzodiazepine'));
  if (!hasDangerWarnings && (day >= 2 || day < 0)) {
    warningsCollapsed = true;
    const content = document.getElementById('warnings-content');
    const chevron = document.getElementById('warn-chevron');
    const btn = document.getElementById('warn-toggle-btn');
    if (content) { content.classList.add('collapsed'); }
    if (chevron) { chevron.classList.remove('open'); }
    if (btn) { btn.setAttribute('aria-expanded', 'false'); }
  }
}

// Recovery phase notes driven by RECOVERY_NOTES.
function renderRecoveryNote() {
  const el = document.getElementById('recovery-note');
  const day = getRecoveryDay();
  if(day<0){
    // Show prompt only if no event date is configured at all (not for future dates)
    if (!CONFIG.eventDate) {
      const activeMeds = getDisplayMeds();
      if (activeMeds.length > 0 && !sessionStorage.getItem('dismissed-date-prompt')) {
        el.innerHTML = '<div class="recovery-note rn-info" style="display:flex;align-items:center;justify-content:space-between">' +
          '<span>Set your surgery date in Settings to enable recovery day tracking</span>' +
          '<button onclick="sessionStorage.setItem(\'dismissed-date-prompt\',\'1\');renderRecoveryNote()" style="background:none;border:none;color:inherit;font-size:18px;cursor:pointer;padding:0 4px" aria-label="Dismiss">&times;</button>' +
          '</div>';
        return;
      }
    }
    el.innerHTML = '';
    return;
  }
  let html = '';
  for(const note of RECOVERY_NOTES){
    if(day>=note.minDay&&day<=note.maxDay){
      html='<div class="recovery-note '+note.noteType+'">'+esc(note.text(day))+'</div>';
      break;
    }
  }
  el.innerHTML = html;
}

// Bedside / Night Mode
let _wakeLockSentinel = null;
async function acquireWakeLock() {
  if ('wakeLock' in navigator && document.body.classList.contains('bedside')) {
    try {
      _wakeLockSentinel = await navigator.wakeLock.request('screen');
      _wakeLockSentinel.addEventListener('release', () => { _wakeLockSentinel = null; });
    } catch(e) { /* battery saver may deny */ }
  }
}
function releaseWakeLock() {
  if (_wakeLockSentinel) { _wakeLockSentinel.release().catch(() => {}); _wakeLockSentinel = null; }
}
function toggleBedside() {
  const active = document.body.classList.toggle('bedside');
  const btn = document.getElementById('bedside-btn');
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-checked', active);
  localStorage.setItem(BEDSIDE_KEY, active ? '1' : '0');
  // Update browser chrome color
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', active ? '#000000' : '#2d3436');
  // Wake Lock: keep screen on in bedside mode for alerts
  if (active) { acquireWakeLock(); } else { releaseWakeLock(); }
}
function initBedside() {
  const saved = localStorage.getItem(BEDSIDE_KEY) || localStorage.getItem(LEGACY_BEDSIDE_KEY);
  const hour = new Date().getHours();
  const btn = document.getElementById('bedside-btn');
  if (saved === '1' || (saved === null && (hour >= 22 || hour < 6))) {
    document.body.classList.add('bedside');
    btn.classList.add('active');
    btn.setAttribute('aria-checked', 'true');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#000000');
    acquireWakeLock();
  }
}
// === Settings UI ===
let _editingMedIndex = -1; // -1 = not editing, -2 = adding new
function openSettings() {
  document.getElementById('settings-overlay').classList.add('open');
  renderSettingsPanel();
}
function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
  _editingMedIndex = -1;
}
function renderPatientSettingsSection() {
  const profile = CONFIG.profile || shared.createEmptyProfile();
  return `<div class="settings-section"><h3>Patient</h3>
    <div class="settings-field"><label>Your Name</label><input type="text" id="cfg-name" value="${esc(CONFIG.patientName)}" placeholder="Leave blank for generic" onchange="updateConfigField('patientName',this.value)"><div class="hint">Shown in the header, handoff summary, and exports.</div></div>
    <div class="med-form-row">
      <div class="settings-field"><label>Event Date</label><input type="date" id="cfg-event-date" value="${CONFIG.eventDate||''}" onchange="updateConfigField('eventDate',this.value||null)"></div>
      <div class="settings-field"><label>Event Label</label><input type="text" id="cfg-event-label" value="${esc(CONFIG.eventLabel)}" placeholder="e.g. Surgery" onchange="updateConfigField('eventLabel',this.value)"></div>
    </div>
    <div class="med-form-row">
      <div class="settings-field"><label>Care Label</label><input type="text" value="${esc(profile.careLabel)}" placeholder="e.g. Post-op recovery" onchange="updateProfileField('careLabel',this.value)"></div>
      <div class="settings-field"><label>Default Logger Name</label><input type="text" value="${esc(profile.defaultLoggerName)}" placeholder="Who usually logs doses?" onchange="updateProfileField('defaultLoggerName',this.value)"></div>
    </div>
    <div class="med-form-row">
      <div class="settings-field"><label>Date of Birth</label><input type="date" value="${profile.dateOfBirth||''}" onchange="updateProfileField('dateOfBirth',this.value||'')"></div>
      <div class="settings-field"><label>Blood Type</label><select onchange="updateProfileField('bloodType',this.value)"><option value="">Unknown</option>${['A+','A-','B+','B-','AB+','AB-','O+','O-'].map(t=>`<option value="${t}"${profile.bloodType===t?' selected':''}>${t}</option>`).join('')}</select></div>
      <div class="settings-field"><label>Weight</label><input type="text" value="${esc(profile.weight)}" placeholder="e.g. 145 lbs" onchange="updateProfileField('weight',this.value)"></div>
    </div>
    <div class="med-form-row">
      <div class="settings-field"><label>Surgeon / Doctor</label><input type="text" value="${esc(profile.surgeonName)}" placeholder="Name" onchange="updateProfileField('surgeonName',this.value)"></div>
      <div class="settings-field"><label>Surgeon Phone</label><input type="text" value="${esc(profile.surgeonPhone)}" placeholder="Phone number" onchange="updateProfileField('surgeonPhone',this.value)"></div>
    </div>
    <div class="settings-field"><label>Emergency Contact</label><input type="text" value="${esc(profile.emergencyContact)}" placeholder="Name and phone" onchange="updateProfileField('emergencyContact',this.value)"></div>
    <div class="med-form-row">
      <div class="settings-field"><label>Allergies</label><textarea placeholder="One per line" onchange="updateProfileListField('allergies',this.value);updateProfileField('allergiesReviewed',true)">${esc((profile.allergies||[]).join('\n'))}</textarea></div>
      <div class="settings-field"><label>Conditions</label><textarea placeholder="One per line" onchange="updateProfileListField('conditions',this.value)">${esc((profile.conditions||[]).join('\n'))}</textarea></div>
    </div>
    <div class="settings-field" style="margin-bottom:4px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" ${profile.allergiesReviewed?'checked':''} onchange="updateProfileField('allergiesReviewed',this.checked)"> I have reviewed allergies (${profile.allergies?.length ? profile.allergies.length + ' listed' : 'none'})</label><div class="hint">Check this even if patient has no known allergies, so handoff shows "NKDA" instead of "NOT REVIEWED".</div></div>
    <div class="settings-field"><label>Important Instructions</label><textarea placeholder="What should every caregiver know?" onchange="updateProfileField('importantInstructions',this.value)">${esc(profile.importantInstructions)}</textarea></div>
    <div class="med-form-row">
      <div class="settings-field"><label>Quiet Hours Start</label><input type="time" value="${profile.quietStart||''}" onchange="updateProfileField('quietStart',this.value)"><div class="hint">Suppress chimes and notifications during these hours.</div></div>
      <div class="settings-field"><label>Quiet Hours End</label><input type="time" value="${profile.quietEnd||''}" onchange="updateProfileField('quietEnd',this.value)"></div>
    </div>
  </div>`;
}

function renderMedicationSettingsSection() {
  const activeCount = getDisplayMeds().length;
  let html = `<div class="settings-section"><h3>Medications (${activeCount} active / ${MEDS.length} total)</h3>`;
  MEDS.forEach((med, i) => {
    const isActiveToday = shared.isMedActiveOnDate(med);
    const statusBits = [
      med.pinned ? 'Pinned' : '',
      med.archived ? 'Archived' : '',
      !med.archived && !isActiveToday ? 'Inactive today' : ''
    ].filter(Boolean).join(' • ');
    html += `<div class="med-list-item" onclick="editMed(${i})">
      <div class="med-list-swatch" style="background:${med.color}"></div>
      <div class="med-list-info"><div class="med-list-name">${esc(med.name)}${med.brand?' ('+esc(med.brand)+')':''}</div><div class="med-list-dose">${esc(med.dose)} - ${esc(med.freq)}${statusBits ? ` • ${esc(statusBits)}` : ''}</div></div>
      <div class="med-list-actions"><button onclick="event.stopPropagation();moveMed(${i},-1)" title="Move up" ${i===0?'disabled':''}>↑</button><button onclick="event.stopPropagation();moveMed(${i},1)" title="Move down" ${i===MEDS.length-1?'disabled':''}>↓</button><button onclick="event.stopPropagation();toggleMedPinned(${i})" title="${med.pinned ? 'Unpin' : 'Pin'}">${med.pinned ? 'Unpin' : 'Pin'}</button><button onclick="event.stopPropagation();toggleMedArchived(${i})" title="${med.archived ? 'Restore' : 'Archive'}">${med.archived ? 'Restore' : 'Archive'}</button><button onclick="event.stopPropagation();deleteMed(${i})" title="Delete">Delete</button></div>
    </div>`;
  });
  if (_editingMedIndex === -3) html += renderSettingsQuickAdd();
  else if (_editingMedIndex === -2) html += renderMedForm(null);
  else html += `<button class="btn-add-med" onclick="startAddMed()">+ Add Medication</button>`;
  if (_editingMedIndex >= 0 && _editingMedIndex < MEDS.length) html += renderMedForm(MEDS[_editingMedIndex]);
  html += '</div>';
  return html;
}

function renderSafetySettingsSection() {
  let html = `<div class="settings-section"><h3>Safety</h3>
    <div class="summary-panel" style="margin-bottom:12px"><h3>Guardrails</h3><div class="summary-item">Duplicate doses within ${DUPLICATE_WINDOW_MIN} minutes require confirmation. Conflict and interval warnings stay overrideable, but hard limits remain blocked.</div></div>`;
  CONFIG.warnings.forEach((warning, index) => {
    html += `<div class="med-list-item"><div style="flex:1"><strong>${esc(warning.title)}</strong><div style="font-size:13px;color:var(--muted)">${esc(warning.text)}</div></div><button style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:6px" onclick="deleteWarning(${index})" title="Remove">Delete</button></div>`;
  });
  html += `<button class="btn-add-med" onclick="addWarning()">+ Add Warning</button></div>`;
  return html;
}

function renderDataSettingsSection() {
  const health = storageHealth || {
    backend: storageMeta.backend || 'localStorage',
    persisted: false,
    usage: null,
    quota: null,
    lastSuccessfulBackupAt: storageMeta.lastSuccessfulBackupAt,
    lastIntegrityCheckAt: storageMeta.lastIntegrityCheckAt,
    lastSnapshotAt: storageMeta.lastSnapshotAt
  };
  return `<div class="settings-section"><h3>Data</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:10px">Back up the full tracker, restore it on another device, and verify whether storage is durable enough for offline use.</p>
    <div class="storage-health">
      <div class="storage-tile"><strong>Version</strong><span>${esc(APP_VERSION)}</span></div>
      <div class="storage-tile"><strong>Backend</strong><span>${esc(String(health.backend || 'localStorage'))}</span></div>
      <div class="storage-tile"><strong>Persistence</strong><span>${health.persisted ? 'Protected' : 'Best effort'}</span></div>
      <div class="storage-tile"><strong>Origin</strong><span>${esc(String(health.origin || location.origin))}</span></div>
      <div class="storage-tile"><strong>Usage</strong><span>${health.usage !== null ? `${formatBytes(health.usage)} / ${formatBytes(health.quota)}` : 'Unknown'}</span></div>
      <div class="storage-tile"><strong>Integrity Check</strong><span>${health.lastIntegrityCheckAt ? fmt(health.lastIntegrityCheckAt) : 'Not yet'}</span></div>
      <div class="storage-tile"><strong>Last Snapshot</strong><span>${health.lastSnapshotAt ? fmt(health.lastSnapshotAt) : 'Not yet'}</span></div>
    </div>
    <div class="config-share" style="margin-top:12px">
      <button class="btn-export" onclick="exportConfig()">Copy Setup</button>
      <button class="btn-import" onclick="showImportField()">Import Setup</button>
    </div>
    <div class="config-share">
      <button class="btn-import" onclick="downloadFullBackup()">Download Backup</button>
      <button class="btn-import" style="width:100%;font-size:13px;margin-bottom:8px" onclick="handlePurgeSoftDeleted()">Permanently Purge Deleted Records</button>
      <p style="font-size:11px;color:var(--muted);margin-top:0;margin-bottom:12px">Hard-deletes dose records previously marked as removed. Cannot be undone.</p>
      <button class="btn-import" onclick="showBackupImportField()">Restore Backup</button>
    </div>
    <div class="config-share">
      <button class="btn-import" onclick="downloadSupportBundle()">Support Export</button>
      <button class="btn-import" onclick="requestPersistentStorage()">Request Storage Protection</button>
    </div>
    <div class="config-share">
      <button class="btn-import" onclick="recoverSnapshot()">Recover Last Snapshot</button>
      <button class="btn-import" onclick="openHandoffSummary()">Preview Handoff</button>
    </div>
    <div id="import-area"></div>
    <div id="backup-import-area"></div>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
      <button class="btn-danger" style="width:100%;font-size:13px" onclick="handleFactoryReset()">Delete All My Data</button>
      <p style="font-size:11px;color:var(--muted);margin-top:4px">Permanently erases all data from this device. Cannot be undone.</p>
    </div>
  </div>`;
}

function renderSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  panel.innerHTML = `<div class="settings-header"><h2>Settings</h2><button class="settings-close" onclick="closeSettings()" aria-label="Close settings">&times;</button></div>${renderPatientSettingsSection()}${renderMedicationSettingsSection()}${renderSafetySettingsSection()}${renderDataSettingsSection()}`;
}

function renderMedForm(med) {
  const isNew = !med;
  const m = med || { id:'', name:'', brand:'', dose:'', perTab:0, maxTabs:1, purpose:'', reason:'', freq:'', intervalMin:240, color:nextColor(), bgBadge:'#f0f0f0', scheduled:false, scheduleType:'prn', scheduledTimes:[], instructions:'', warns:[], category:'', supplyOnHand:0, refillThreshold:0, supplyLabel:'units', startDate:'', endDate:'', prescriber:'', pharmacy:'', archived:false, pinned:false };
  const colorOptions = COLOR_PALETTE;
  return `<div class="med-form"><h3>${isNew?'Add':'Edit'} Medication</h3>
    <div class="settings-field"><label>Name *</label><input type="text" id="mf-name" value="${esc(m.name)}" placeholder="e.g. Ibuprofen"></div>
    <div class="med-form-row">
      <div class="settings-field"><label>Brand</label><input type="text" id="mf-brand" value="${esc(m.brand)}" placeholder="e.g. Advil"></div>
      <div class="settings-field"><label>Dose Description</label><input type="text" id="mf-dose" value="${esc(m.dose)}" placeholder="e.g. 200mg tabs"></div>
    </div>
    <div class="med-form-row">
      <div class="settings-field"><label>Mg per Tablet</label><input type="number" id="mf-perTab" value="${m.perTab}" min="0"></div>
      <div class="settings-field"><label>Max Tablets/Dose</label><input type="number" id="mf-maxTabs" value="${m.maxTabs}" min="1"></div>
    </div>
    <div class="med-form-row">
      <div class="settings-field"><label>Interval</label>
        <select id="mf-interval" onchange="toggleCustomInterval()"><option value="120"${m.intervalMin===120?' selected':''}>Every 2 hours</option><option value="240"${m.intervalMin===240?' selected':''}>Every 4 hours</option><option value="360"${m.intervalMin===360?' selected':''}>Every 6 hours</option><option value="480"${m.intervalMin===480?' selected':''}>Every 8 hours</option><option value="720"${m.intervalMin===720?' selected':''}>Every 12 hours</option><option value="1440"${m.intervalMin===1440?' selected':''}>Once daily</option><option value="custom"${![120,240,360,480,720,1440].includes(m.intervalMin)?' selected':''}>Custom</option></select>
        <input type="number" id="mf-customInterval" min="1" placeholder="Minutes" value="${![120,240,360,480,720,1440].includes(m.intervalMin)?m.intervalMin:''}" style="margin-top:4px;${[120,240,360,480,720,1440].includes(m.intervalMin)?'display:none':''}">
      </div>
      <div class="settings-field"><label>Purpose</label><input type="text" id="mf-purpose" value="${esc(m.purpose)}" placeholder="e.g. Pain Relief"></div>
    </div>
    <div class="settings-field"><label>Frequency Description</label><input type="text" id="mf-freq" value="${esc(m.freq)}" placeholder="e.g. 1-2 tabs every 4 hours"></div>
    <div class="settings-field"><label>Color</label><div class="color-swatches">${colorOptions.map(c=>`<div class="color-swatch${resolveColor(m.color)===c?' active':''}" style="background:${c}" onclick="selectMedColor(this,'${c}')"></div>`).join('')}</div></div>
    <button class="advanced-toggle" onclick="toggleAdvanced()"><span class="chevron" id="adv-chevron">&#9654;</span> Advanced Options</button>
    <div class="advanced-content" id="adv-content">
      <div class="med-form-row">
        <div class="settings-field"><label>Reason</label><input type="text" id="mf-reason" value="${esc(m.reason||'')}" placeholder="Why is it taken?"></div>
        <div class="settings-field"><label>Instructions</label><input type="text" id="mf-instructions" value="${esc(m.instructions||'')}" placeholder="Helpful note for caregiver"></div>
      </div>
      <div class="med-form-row">
        <div class="settings-field"><label>Schedule Type</label><select id="mf-scheduled"><option value="0"${!m.scheduled?' selected':''}>PRN / As Needed</option><option value="1"${m.scheduled?' selected':''}>Scheduled</option></select></div>
        <div class="settings-field"><label>Max Daily Doses</label><input type="number" id="mf-maxDoses" value="${m.maxDoses||0}" min="0" placeholder="0 = unlimited"></div>
      </div>
      <div class="settings-field"><label>Scheduled Times (comma separated)</label><input type="text" id="mf-scheduledTimes" value="${esc((m.scheduledTimes||[]).join(', '))}" placeholder="08:00, 12:00, 18:00"></div>
      <div class="med-form-row">
        <div class="settings-field"><label>Track 24h Total?</label><select id="mf-trackTotal"><option value="0"${!m.trackTotal?' selected':''}>No</option><option value="1"${m.trackTotal?' selected':''}>Yes</option></select></div>
        <div class="settings-field"><label>Daily Max (mg)</label><input type="number" id="mf-maxDaily" value="${m.maxDaily||0}" min="0" placeholder="e.g. 4000"></div>
      </div>
      <div class="med-form-row">
        <div class="settings-field"><label>APAP per Tab (mg)</label><input type="number" id="mf-apapPerTab" value="${m.apapPerTab||0}" min="0" placeholder="e.g. 325 for combo meds"></div>
        <div class="settings-field"><label></label><div class="hint" style="padding-top:12px">For combination meds containing acetaminophen (e.g. Norco 5-325). This amount counts toward the Tylenol daily max.</div></div>
      </div>
      <div class="med-form-row">
        <div class="settings-field"><label>Supply On Hand</label><input type="number" id="mf-supplyOnHand" value="${m.supplyOnHand||0}" min="0" placeholder="How many remain?"></div>
        <div class="settings-field"><label>Supply Label</label><input type="text" id="mf-supplyLabel" value="${esc(m.supplyLabel||'units')}" placeholder="e.g. tablets"></div>
      </div>
      <div class="med-form-row">
        <div class="settings-field"><label>Refill Threshold</label><input type="number" id="mf-refillThreshold" value="${m.refillThreshold||0}" min="0" placeholder="Alert when at or below"></div>
        <div class="settings-field"><label></label><div class="hint" style="padding-top:12px">Supply tracking uses the logged quantity, so labels like <strong>tablets</strong> or <strong>capsules</strong> are clearer than <strong>doses</strong>.</div></div>
      </div>
      <div class="med-form-row">
        <div class="settings-field"><label>Paired With</label><select id="mf-pairedWith"><option value="">None</option>${MEDS.filter(x=>x.id!==m.id).map(x=>`<option value="${esc(x.id)}"${m.pairedWith===x.id?' selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
        <div class="settings-field"><label>Conflicts With</label><select id="mf-conflictsWith"><option value="">None</option>${MEDS.filter(x=>x.id!==m.id).map(x=>`<option value="${esc(x.id)}"${m.conflictsWith===x.id?' selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
      </div>
      <div class="med-form-row">
        <div class="settings-field"><label>Prescriber</label><input type="text" id="mf-prescriber" value="${esc(m.prescriber||'')}" placeholder="Doctor or clinic"></div>
        <div class="settings-field"><label>Pharmacy</label><input type="text" id="mf-pharmacy" value="${esc(m.pharmacy||'')}" placeholder="Pharmacy name"></div>
      </div>
      <div class="med-form-row">
        <div class="settings-field"><label>Start Date</label><input type="date" id="mf-startDate" value="${esc(m.startDate||'')}"></div>
        <div class="settings-field"><label>End Date</label><input type="date" id="mf-endDate" value="${esc(m.endDate||'')}"></div>
      </div>
      <div class="settings-field"><label>Conflict Wait (minutes)</label><input type="number" id="mf-conflictMin" value="${m.conflictMin||60}" min="0"></div>
      <div class="settings-field"><label>Warnings (one per line)</label><textarea id="mf-warns" placeholder="e.g. Do not exceed 4000mg in 24 hours">${esc((m.warns||[]).join('\n'))}</textarea></div>
      <div class="settings-field"><label>Category</label><input type="text" id="mf-category" value="${esc(m.category)}" placeholder="e.g. analgesic"></div>
      <div class="med-form-row">
        <div class="settings-field"><label>Pinned</label><select id="mf-pinned"><option value="0"${!m.pinned?' selected':''}>No</option><option value="1"${m.pinned?' selected':''}>Yes</option></select></div>
        <div class="settings-field"><label>Archived</label><select id="mf-archived"><option value="0"${!m.archived?' selected':''}>No</option><option value="1"${m.archived?' selected':''}>Yes</option></select></div>
      </div>
    </div>
    <div class="med-form-actions">
      <button class="btn-cancel" onclick="cancelMedForm()">Cancel</button>
      ${!isNew?'<button class="btn-danger" onclick="deleteMed('+_editingMedIndex+')">Delete</button>':''}
      <button class="btn-confirm" onclick="saveMedForm(${isNew?-1:_editingMedIndex})">${isNew?'Add':'Save'}</button>
    </div>
  </div>`;
}
// Map CSS variable colors to hex for comparison (legacy Amanda meds use var(--oxy) etc.)
const _cssVarMap={'var(--oxy)':'#e74c3c','var(--hyd)':'#e84393','var(--dia)':'#8e44ad','var(--ceph)':'#2980b9','var(--stool)':'#27ae60','var(--tyl)':'#e67e22'};
function resolveColor(c) { return _cssVarMap[c] || c; }
function nextColor() {
  const used = new Set(MEDS.map(m=>resolveColor(m.color)));
  return COLOR_PALETTE.find(c=>!used.has(c)) || COLOR_PALETTE[MEDS.length % COLOR_PALETTE.length];
}
let _selectedMedColor = null;
function selectMedColor(el, color) {
  document.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('active'));
  el.classList.add('active');
  _selectedMedColor = color;
}
function toggleAdvanced() {
  const content = document.getElementById('adv-content');
  const chevron = document.getElementById('adv-chevron');
  content.classList.toggle('open');
  if(chevron) chevron.style.transform = content.classList.contains('open') ? 'rotate(90deg)' : '';
}
function toggleCustomInterval() {
  const sel = document.getElementById('mf-interval');
  const inp = document.getElementById('mf-customInterval');
  if(sel && inp) { inp.style.display = sel.value==='custom' ? '' : 'none'; }
}
function startAddMed() { _editingMedIndex = -3; _quickAddSource = 'settings'; _quickAddSearch = ''; _quickAddSelected = null; renderSettingsPanel(); }
function editMed(i) { _editingMedIndex = i; _selectedMedColor = resolveColor(MEDS[i].color); renderSettingsPanel(); }
function quickEditMed(medId) {
  const i = MEDS.findIndex(m => m.id === medId);
  if (i === -1) return;
  openSettings();
  editMed(i);
  // Auto-expand advanced section when editing, then scroll to form
  setTimeout(() => {
    const adv = document.getElementById('adv-content');
    const chevron = document.getElementById('adv-chevron');
    if (adv && !adv.classList.contains('open')) { adv.classList.add('open'); if(chevron) chevron.style.transform='rotate(90deg)'; }
    const form = document.querySelector('.med-form');
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}
function cancelMedForm() { _editingMedIndex = -1; renderSettingsPanel(); }
function updateConfigField(field, value) {
  CONFIG[field] = value;
  saveConfig(CONFIG);
  initAppHeader();
  render();
}
function updateProfileField(field, value) {
  CONFIG.profile = shared.normalizeProfile({
    ...(CONFIG.profile || {}),
    [field]: value
  });
  saveConfig(CONFIG);
  render();
}
function updateProfileListField(field, value) {
  updateProfileField(field, String(value || '').split('\n').map(item => item.trim()).filter(Boolean));
}
function toggleMedArchived(index) {
  const med = MEDS[index];
  if (!med) return;
  med.archived = !med.archived;
  if (med.archived) { med.archivedAt = now().toISOString(); } else { delete med.archivedAt; }
  CONFIG.meds = MEDS;
  saveConfig(CONFIG);
  showToast(`${med.name} ${med.archived ? 'archived' : 'restored'}`);
  renderSettingsPanel();
  render();
}
function toggleMedPinned(index) {
  const med = MEDS[index];
  if (!med) return;
  med.pinned = !med.pinned;
  CONFIG.meds = MEDS;
  saveConfig(CONFIG);
  showToast(`${med.name} ${med.pinned ? 'pinned' : 'unpinned'}`);
  renderSettingsPanel();
  render();
}
function moveMed(index, delta) {
  const target = index + delta;
  if (index < 0 || target < 0 || index >= MEDS.length || target >= MEDS.length) return;
  const [item] = MEDS.splice(index, 1);
  MEDS.splice(target, 0, item);
  CONFIG.meds = MEDS;
  saveConfig(CONFIG);
  renderSettingsPanel();
  render();
}
function clearFieldErrors() {
  document.querySelectorAll('.field-error').forEach(el=>el.classList.remove('field-error'));
  document.querySelectorAll('.error-msg').forEach(el=>el.remove());
}
function showFieldError(fieldId, msg) {
  const el = document.getElementById(fieldId);
  if(el) {
    el.classList.add('field-error');
    const err = document.createElement('div');
    err.className = 'error-msg';
    err.textContent = msg;
    el.parentElement.appendChild(err);
  }
}
function saveMedForm(index) {
  clearFieldErrors();
  let hasErrors = false;
  const name = document.getElementById('mf-name').value.trim();
  if(!name){ showFieldError('mf-name','Name is required'); hasErrors=true; }
  const perTab = parseFloat(document.getElementById('mf-perTab').value);
  if(isNaN(perTab)||perTab<0){ showFieldError('mf-perTab','Must be 0 or more'); hasErrors=true; }
  const maxTabs = parseInt(document.getElementById('mf-maxTabs').value);
  if(isNaN(maxTabs)||maxTabs<1){ showFieldError('mf-maxTabs','Must be at least 1'); hasErrors=true; }
  const intervalSelect = document.getElementById('mf-interval');
  let intervalMin;
  if(intervalSelect.value==='custom') {
    intervalMin = parseInt(document.getElementById('mf-customInterval').value);
    if(isNaN(intervalMin)||intervalMin<=0){ showFieldError('mf-customInterval','Enter interval in minutes (must be > 0)'); hasErrors=true; intervalMin=240; }
  } else {
    intervalMin = parseInt(intervalSelect.value);
    if(isNaN(intervalMin)||intervalMin<=0){ showFieldError('mf-interval','Select a valid interval'); hasErrors=true; intervalMin=240; }
  }
  // Validate track total
  const trackTotal = document.getElementById('mf-trackTotal').value==='1';
  if(trackTotal) {
    const maxDaily = parseInt(document.getElementById('mf-maxDaily').value);
    if(isNaN(maxDaily)||maxDaily<=0){ showFieldError('mf-maxDaily','Daily max required when tracking totals'); hasErrors=true; }
  }
  // Validate conflict minutes
  const conflictsWith = document.getElementById('mf-conflictsWith').value;
  if(conflictsWith) {
    const conflictMin = parseInt(document.getElementById('mf-conflictMin').value);
    if(isNaN(conflictMin)||conflictMin<=0){ showFieldError('mf-conflictMin','Conflict wait must be > 0'); hasErrors=true; }
  }
  if(hasErrors) return;

  const color = _selectedMedColor || nextColor();
  const scheduled = document.getElementById('mf-scheduled').value==='1';
  const scheduledTimes = document.getElementById('mf-scheduledTimes').value.split(',').map(s=>s.trim()).filter(Boolean);
  const med = {
    id: index >= 0 ? MEDS[index].id : (name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'') || 'med-'+Date.now()),
    name, brand: document.getElementById('mf-brand').value.trim(),
    dose: document.getElementById('mf-dose').value.trim(),
    perTab: perTab||0,
    maxTabs: maxTabs||1,
    purpose: document.getElementById('mf-purpose').value.trim(),
    reason: document.getElementById('mf-reason').value.trim(),
    freq: document.getElementById('mf-freq').value.trim(),
    instructions: document.getElementById('mf-instructions').value.trim(),
    intervalMin, color, bgBadge: color+'20',
    scheduled,
    scheduleType: scheduled ? 'scheduled' : 'prn',
    scheduledTimes,
    warns: document.getElementById('mf-warns').value.split('\n').map(s=>s.trim()).filter(Boolean),
    category: document.getElementById('mf-category').value.trim(),
    supplyOnHand: parseInt(document.getElementById('mf-supplyOnHand').value, 10) || 0,
    refillThreshold: parseInt(document.getElementById('mf-refillThreshold').value, 10) || 0,
    supplyLabel: document.getElementById('mf-supplyLabel').value.trim() || 'units',
    prescriber: document.getElementById('mf-prescriber').value.trim(),
    pharmacy: document.getElementById('mf-pharmacy').value.trim(),
    startDate: document.getElementById('mf-startDate').value || '',
    endDate: document.getElementById('mf-endDate').value || '',
    pinned: document.getElementById('mf-pinned').value==='1',
    archived: document.getElementById('mf-archived').value==='1'
  };
  const maxDoses = parseInt(document.getElementById('mf-maxDoses').value);
  if(maxDoses > 0) med.maxDoses = maxDoses;
  if(trackTotal) {
    med.trackTotal = true;
    med.maxDaily = parseInt(document.getElementById('mf-maxDaily').value)||0;
  }
  const apapPerTab = parseInt(document.getElementById('mf-apapPerTab').value);
  if(apapPerTab > 0) med.apapPerTab = apapPerTab;
  const pairedWith = document.getElementById('mf-pairedWith').value;
  if(pairedWith) med.pairedWith = pairedWith;
  if(conflictsWith) {
    med.conflictsWith = conflictsWith;
    med.conflictMin = parseInt(document.getElementById('mf-conflictMin').value)||60;
  }
  // Ensure unique ID for new meds
  if(index < 0) {
    let baseId = med.id;
    let suffix = 1;
    while(MEDS.some(m=>m.id===med.id)) { med.id = baseId+'-'+suffix++; }
    MEDS.push(med);
  } else {
    med.id = MEDS[index].id; // preserve original ID
    MEDS[index] = med;
  }
  CONFIG.meds = MEDS;
  saveConfig(CONFIG);
  _editingMedIndex = -1;
  showToast(index>=0 ? med.name+' updated' : med.name+' added');
  renderSettingsPanel();
  render();
}
function openConfirmModal({ title, body, confirmLabel = 'Confirm', confirmClass = 'btn-danger', action }) {
  window._pendingModalAction = typeof action === 'function' ? action : null;
  showModal(`<h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="${confirmClass}" onclick="confirmPendingAction()">${esc(confirmLabel)}</button>
    </div>`);
}
function confirmPendingAction() {
  const action = window._pendingModalAction;
  window._pendingModalAction = null;
  _modalReturnFocus = null;
  closeModal();
  if (typeof action === 'function') action();
}
function deleteMed(index) {
  const med = MEDS[index];
  if (!med) return;
  openConfirmModal({
    title: `Delete ${med.name}?`,
    body: 'Historical dose entries will be preserved.',
    confirmLabel: 'Delete Medication',
    action: () => {
      const liveIndex = MEDS.findIndex(entry => entry.id === med.id);
      if (liveIndex === -1) return;
      MEDS.splice(liveIndex, 1);
      CONFIG.meds = MEDS;
      saveConfig(CONFIG);
      _editingMedIndex = -1;
      renderSettingsPanel();
      render();
      showToast(`${med.name} deleted`);
    }
  });
}
function addWarning() {
  showModal(`<h3>Add safety warning</h3>
    <div class="settings-field"><label>Title</label><input type="text" id="warning-title" placeholder="e.g. No NSAIDs for 2 weeks"></div>
    <div class="settings-field"><label>Details</label><textarea id="warning-text" rows="3" placeholder="Explain the warning or instruction"></textarea></div>
    <div class="settings-field"><label>Severity</label><select id="warning-type"><option value="warn">Warning</option><option value="danger">Danger</option></select></div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" onclick="saveWarning()">Save Warning</button>
    </div>`);
  setTimeout(() => {
    const input = document.getElementById('warning-title');
    if (input) input.focus();
  }, 450);
}
function saveWarning() {
  const titleInput = document.getElementById('warning-title');
  const textInput = document.getElementById('warning-text');
  const typeInput = document.getElementById('warning-type');
  const title = titleInput ? titleInput.value.trim() : '';
  const text = textInput ? textInput.value.trim() : '';
  const type = typeInput ? typeInput.value : 'warn';
  if (!title) {
    showToast('Warning title is required');
    titleInput?.focus();
    return;
  }
  if (!text) {
    showToast('Warning details are required');
    textInput?.focus();
    return;
  }
  CONFIG.warnings.push({ type, title, text });
  WARNINGS = CONFIG.warnings;
  saveConfig(CONFIG);
  renderSettingsPanel();
  render();
  closeModal();
  showToast('Warning added');
}
function deleteWarning(index) {
  const warning = CONFIG.warnings[index];
  if (!warning) return;
  openConfirmModal({
    title: `Remove ${warning.title}?`,
    body: 'This warning will be removed from the active safety list.',
    confirmLabel: 'Remove Warning',
    action: () => {
      const liveIndex = CONFIG.warnings.findIndex(entry => entry.title === warning.title && entry.text === warning.text);
      if (liveIndex === -1) return;
      CONFIG.warnings.splice(liveIndex, 1);
      WARNINGS = CONFIG.warnings;
      saveConfig(CONFIG);
      renderSettingsPanel();
      render();
      showToast('Warning removed');
    }
  });
}

// === Config Export/Import ===
function showToast(msg, duration = 3500) {
  let toast = document.querySelector('.toast');
  if(!toast) { toast = document.createElement('div'); toast.className='toast'; toast.setAttribute('role','status'); toast.setAttribute('aria-live','polite'); document.body.appendChild(toast); }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._tid);
  toast._tid = setTimeout(()=>toast.classList.remove('show'), duration);
}
function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, (k, v) => v === Infinity ? 99999 : v, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 100);
}
async function downloadFullBackup() {
  const envelope = shared.buildBackupEnvelope({ config: CONFIG, state, meta: storageMeta });
  storageMeta = shared.createDefaultMeta({ ...storageMeta, lastSuccessfulBackupAt: envelope.exportedAt });
  await persistBundle('backup-export');
  downloadJsonFile(`medtracker-backup-${todayStr()}.json`, envelope);
  renderSettingsPanel();
  renderCareSummary();
  showToast('Backup downloaded — contains sensitive health data, store securely', 5000);
}
function showBackupImportField() {
  const area = document.getElementById('backup-import-area');
  if (!area) return;
  area.innerHTML = `<div class="import-area">
    <input type="file" id="backup-import-file" accept=".json,application/json,text/plain" onchange="loadBackupImportFile(event)">
    <textarea id="backup-import-input" placeholder="Paste a full backup JSON file or code here..." rows="5" oninput="previewBackupImport()"></textarea>
    <div id="backup-import-preview"></div>
  </div>`;
}
async function loadBackupImportFile(event) {
  const file = event?.target?.files?.[0];
  const input = document.getElementById('backup-import-input');
  if (!file || !input) return;
  try {
    input.value = await file.text();
    previewBackupImport();
    showToast(`Loaded ${file.name}`);
  } catch (error) {
    captureError(error, 'backup-file-load');
    showToast('Could not read backup file');
  }
}
function parseBackupInput(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Backup is empty');
  try {
    return shared.parseBackupEnvelope(input);
  } catch (jsonError) {
    try {
      return shared.parseBackupEnvelope(atob(input));
    } catch (decodeError) {
      throw new Error('Could not parse backup. Check the format and try again.');
    }
  }
}
function previewBackupImport() {
  const input = document.getElementById('backup-import-input');
  const box = document.getElementById('backup-import-preview');
  if (!input || !box) return;
  if (!input.value.trim()) {
    box.innerHTML = '';
    return;
  }
  try {
    const { envelope } = parseBackupInput(input.value);
    const summary = shared.summarizeBundle({ config: envelope.config, state: envelope.state, meta: envelope.meta });
    box.innerHTML = `<div class="import-preview">
      <strong>${esc(summary.patientName || 'Unnamed patient')}</strong>
      <div>${summary.medicationCount} medication(s), ${summary.doseCount} logged dose(s)</div>
      <div style="margin-top:4px;color:var(--muted)">Exported ${fmt(envelope.exportedAt)}</div>
      <div class="import-actions">
        <button class="btn-cancel" onclick="cancelBackupImport()">Cancel</button>
        <button class="btn-confirm" onclick="applyBackupImport()">Restore Backup</button>
      </div>
    </div>`;
  } catch (error) {
    box.innerHTML = '<div style="color:var(--danger-border);font-size:13px;margin-top:4px">Invalid backup. Paste the full backup JSON or backup code.</div>';
  }
}
function cancelBackupImport() {
  const area = document.getElementById('backup-import-area');
  if (area) area.innerHTML = '';
}
async function applyBackupImport() {
  const input = document.getElementById('backup-import-input');
  if (!input) return;
  try {
    const parsed = parseBackupInput(input.value);
    const saved = await storageManager.replaceFromBackup(parsed.bundle);
    applyBundle(saved);
    storageHealth = await storageManager.getHealth(storageMeta);
    initAppHeader();
    renderSettingsPanel();
    render();
    cancelBackupImport();
    showToast('Backup restored');
  } catch (error) {
    captureError(error, 'backup-import');
    showToast('Backup restore failed');
  }
}
function downloadSupportBundle() {
  const payload = shared.buildSupportPayload({ config: CONFIG, state, meta: storageMeta }, storageHealth, clientErrors);
  downloadJsonFile(`medtracker-support-${todayStr()}.json`, payload);
  showToast('Support export downloaded');
}
async function requestPersistentStorage() {
  try {
    storageMeta = await storageManager.requestPersistence(storageMeta);
    await persistBundle('request-persistence');
    renderSettingsPanel();
    renderCareSummary();
    showToast(storageMeta.persistentStorageGranted ? 'Storage protection requested' : 'Storage remains best effort');
  } catch (error) {
    captureError(error, 'request-persistence');
    showToast('Storage request failed');
  }
}
async function recoverSnapshot() {
  try {
    const saved = await storageManager.recoverSnapshot();
    if (!saved) {
      showToast('No snapshot available');
      return;
    }
    applyBundle(saved);
    storageHealth = await storageManager.getHealth(storageMeta);
    initAppHeader();
    renderSettingsPanel();
    render();
    showToast('Recovered last snapshot');
  } catch (error) {
    captureError(error, 'recover-snapshot');
    showToast('Snapshot recovery failed');
  }
}
function buildHandoffSummaryText() {
  const profile = CONFIG.profile || shared.createEmptyProfile();
  const lines = [];
  lines.push(`${CONFIG.patientName || 'Patient'} Medication Handoff`);
  lines.push(`Generated: ${fmt(now())} (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local'})`);
  if (CONFIG.eventDate) {
    const day = getRecoveryDay();
    lines.push(`${CONFIG.eventLabel || 'Surgery'}: ${CONFIG.eventDate} (Post-op day ${day >= 0 ? day : 'pre-op'})`);
  }
  if (profile.careLabel) lines.push(profile.careLabel);
  if (profile.dateOfBirth) lines.push(`DOB: ${profile.dateOfBirth} (age ${Math.floor((now() - new Date(profile.dateOfBirth)) / 31557600000)})`);
  if (profile.bloodType) lines.push(`Blood type: ${profile.bloodType}`);
  if (profile.weight) lines.push(`Weight: ${profile.weight}`);
  if (profile.surgeonName) lines.push(`Surgeon: ${profile.surgeonName}${profile.surgeonPhone ? ` — ${profile.surgeonPhone}` : ''}`);
  lines.push(`Emergency contact: ${profile.emergencyContact || 'NOT SET'}`);
  lines.push(`Allergies: ${profile.allergies.length ? profile.allergies.join(', ') : (profile.allergiesReviewed ? 'NKDA' : 'NOT REVIEWED')}`);
  if (profile.conditions.length) lines.push(`Conditions: ${profile.conditions.join(', ')}`);
  if (profile.importantInstructions) lines.push(`Instructions: ${profile.importantInstructions}`);
  lines.push('');
  getDisplayMeds().forEach(med => {
    const info = getMedReadiness(med);
    const status = getReadinessStatus(info);
    const supply = shared.getCurrentSupply(med, state);
    lines.push(`${med.name}: ${status.text}`);
    lines.push(`  Dose: ${med.dose} | Frequency: ${med.freq}`);
    if (med.scheduleType === 'scheduled' && med.scheduledTimes?.length) lines.push(`  Scheduled: ${med.scheduledTimes.map(format12h).join(', ')}`);
    if (info.last) lines.push(`  Last logged: ${fmt(info.last.time)}${info.last.loggedBy ? ' by ' + info.last.loggedBy : ''}`);
    if (supply !== null) lines.push(`  Supply left: ${supply} ${getSupplyLabel(med)}`);
    if (med.prescriber) lines.push(`  Prescriber: ${med.prescriber}`);
    if (med.instructions) lines.push(`  Instructions: ${med.instructions}`);
  });
  // Archived medications — important for ER/provider context
  const archivedMeds = CONFIG.meds.filter(m => m.archived);
  if (archivedMeds.length) {
    lines.push('');
    lines.push('DISCONTINUED / ARCHIVED MEDICATIONS');
    lines.push('-'.repeat(40));
    archivedMeds.forEach(m => {
      const archDate = m.archivedAt ? ` [stopped ${new Date(m.archivedAt).toLocaleDateString()}]` : '';
      lines.push(`  ${m.name} — ${m.dose || 'no dose info'}${archDate}${m.prescriber ? ' (prescribed by ' + m.prescriber + ')' : ''}`);
    });
  }
  // Recent dose history (last 48 hours) — critical for ER visits
  const cutoff48h = new Date(now().getTime() - 48 * 3600000);
  const recentDoses = [...state.doses]
    .filter(d => new Date(d.time) >= cutoff48h)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  if (recentDoses.length) {
    lines.push('');
    lines.push('RECENT DOSE HISTORY (last 48 hours)');
    lines.push('-'.repeat(40));
    recentDoses.forEach(d => {
      const med = getMed(d.medId);
      const name = med ? med.name : d.medId;
      const action = d.actionType === 'skip' ? '[SKIPPED]' : `${d.tabs} tab${d.tabs !== 1 ? 's' : ''} (${d.mg}mg)`;
      const override = d.overrideType ? ` [OVERRIDE: ${d.overrideType}]` : '';
      const logger = d.loggedBy ? ` by ${d.loggedBy}` : '';
      lines.push(`  ${fmt(d.time)} — ${name}: ${action}${override}${logger}`);
      if (d.adverseFlag) lines.push('    *** ADVERSE REACTION FLAGGED ***');
      if (d.severity) lines.push(`    Severity: ${d.severity}`);
      if (d.painScore >= 0) lines.push(`    Pain: ${d.painScore}/10`);
      if (d.symptomNote) lines.push(`    Symptom: ${d.symptomNote}`);
      if (d.note) lines.push(`    Note: ${d.note}`);
    });
  }
  lines.push('');
  lines.push('---');
  lines.push('NOT MEDICAL ADVICE. This is a personal tracking tool. Timing data is self-reported.');
  lines.push('Always verify with prescribing physician. Generated by Med Tracker v' + APP_VERSION);
  return lines.join('\n');
}
function downloadHandoffSummary() {
  const blob = new Blob([buildHandoffSummaryText()], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `medtracker-handoff-${todayStr()}.txt`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 100);
}
function openHandoffSummary() {
  const profile = CONFIG.profile || shared.createEmptyProfile();
  const medsHtml = getDisplayMeds().map(med => {
    const info = getMedReadiness(med);
    const status = getReadinessStatus(info);
    const supply = shared.getCurrentSupply(med, state);
    return `<div class="summary-panel" style="margin-bottom:8px">
      <h3>${esc(med.name)}</h3>
      <div class="summary-item"><strong>Status</strong>${esc(status.text)}</div>
      <div class="summary-item" style="margin-top:6px"><strong>Dose</strong>${esc(med.dose)} • ${esc(med.freq)}</div>
      ${med.scheduleType === 'scheduled' && med.scheduledTimes?.length ? `<div class="summary-item" style="margin-top:6px"><strong>Scheduled</strong>${esc(med.scheduledTimes.map(format12h).join(', '))}</div>` : ''}
      ${info.last ? `<div class="summary-item" style="margin-top:6px"><strong>Last logged</strong>${esc(fmt(info.last.time))}${info.last.loggedBy ? ' by ' + esc(info.last.loggedBy) : ''}</div>` : ''}
      ${supply !== null ? `<div class="summary-item" style="margin-top:6px"><strong>Supply left</strong>${supply} ${esc(getSupplyLabel(med))}</div>` : ''}
      ${med.instructions ? `<div class="summary-item" style="margin-top:6px"><strong>Instructions</strong>${esc(med.instructions)}</div>` : ''}
    </div>`;
  }).join('');
  showModal(`<h3>${esc(CONFIG.patientName || 'Patient')} handoff summary</h3>
    ${CONFIG.eventDate ? `<p><strong>${esc(CONFIG.eventLabel || 'Surgery')}:</strong> ${esc(CONFIG.eventDate)} (Post-op day ${getRecoveryDay() >= 0 ? getRecoveryDay() : 'pre-op'})</p>` : ''}
    <p>${esc(profile.careLabel || 'Care summary')}</p>
    ${profile.dateOfBirth ? `<p><strong>DOB:</strong> ${esc(profile.dateOfBirth)} (age ${Math.floor((now() - new Date(profile.dateOfBirth)) / 31557600000)}) ${profile.bloodType ? `&nbsp;|&nbsp;<strong>Blood:</strong> ${esc(profile.bloodType)}` : ''} ${profile.weight ? `&nbsp;|&nbsp;<strong>Wt:</strong> ${esc(profile.weight)}` : ''}</p>` : ''}
    ${profile.surgeonName ? `<p><strong>Surgeon:</strong> ${esc(profile.surgeonName)}${profile.surgeonPhone ? ` — ${esc(profile.surgeonPhone)}` : ''}</p>` : ''}
    <div class="warn-box"><strong>Emergency contact:</strong> ${profile.emergencyContact ? esc(profile.emergencyContact) : '<span style="color:var(--danger)">NOT SET</span>'}</div>
    <p><strong>Allergies:</strong> ${profile.allergies.length ? esc(profile.allergies.join(', ')) : (profile.allergiesReviewed ? '<span style="color:var(--success)">NKDA</span>' : '<span style="color:var(--danger)">NOT REVIEWED</span>')}</p>
    ${profile.conditions.length ? `<p><strong>Conditions:</strong> ${esc(profile.conditions.join(', '))}</p>` : ''}
    ${profile.importantInstructions ? `<p><strong>Instructions:</strong> ${esc(profile.importantInstructions)}</p>` : ''}
    <div style="max-height:45vh;overflow:auto">${medsHtml || '<p>No active medications.</p>'}</div>
    <div style="margin-top:10px;padding:8px;font-size:11px;color:var(--muted);border-top:1px solid var(--border);line-height:1.4"><strong>Not medical advice.</strong> This is a personal tracking tool. Timing data is self-reported. Always verify with prescribing physician.</div>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-cancel" onclick="closeModal()">Close</button>
      <button class="btn-confirm" onclick="downloadHandoffSummary()">Download</button>
    </div>`);
}
function buildMedicationListText() {
  const profile = CONFIG.profile || shared.createEmptyProfile();
  const groups = getMedicationGroups();
  const lines = [];
  lines.push(`${CONFIG.patientName || 'Patient'} Medication List`);
  lines.push(`Generated: ${fmt(now())} (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local'})`);
  if (CONFIG.eventDate) {
    const day = getRecoveryDay();
    lines.push(`${CONFIG.eventLabel || 'Surgery'}: ${CONFIG.eventDate} (Post-op day ${day >= 0 ? day : 'pre-op'})`);
  }
  if (profile.dateOfBirth) lines.push(`DOB: ${profile.dateOfBirth} (age ${Math.floor((now() - new Date(profile.dateOfBirth)) / 31557600000)})`);
  if (profile.bloodType) lines.push(`Blood type: ${profile.bloodType}`);
  if (profile.weight) lines.push(`Weight: ${profile.weight}`);
  lines.push(`Allergies: ${profile.allergies.length ? profile.allergies.join(', ') : (profile.allergiesReviewed ? 'NKDA' : 'NOT REVIEWED')}`);
  if (profile.conditions.length) lines.push(`Conditions: ${profile.conditions.join(', ')}`);
  lines.push(`Emergency contact: ${profile.emergencyContact || 'NOT SET'}`);
  if (profile.surgeonName) lines.push(`Surgeon: ${profile.surgeonName}${profile.surgeonPhone ? ` — ${profile.surgeonPhone}` : ''}`);
  if (profile.importantInstructions) lines.push(`Instructions: ${profile.importantInstructions}`);
  const overrideCount = state.doses.filter(d => d.overrideType && d.actionType !== 'removed').length;
  if (overrideCount) lines.push(`Safety overrides: ${overrideCount} dose${overrideCount !== 1 ? 's' : ''} logged with override`);
  lines.push('');
  const appendMedGroup = (label, meds) => {
    if (!meds.length) return;
    lines.push(label);
    meds.forEach(med => {
      const info = getMedReadiness(med);
      const supply = shared.getCurrentSupply(med, state);
      const lifecycleLabel = getMedicationLifecycleLabel(med);
      lines.push(`- ${med.name}${med.brand ? ` (${med.brand})` : ''}: ${med.dose}`);
      lines.push(`  Purpose: ${med.purpose || med.reason || 'Not set'}`);
      lines.push(`  Frequency: ${med.freq || 'Not set'}`);
      if (med.scheduleType === 'scheduled' && med.scheduledTimes?.length) lines.push(`  Scheduled: ${med.scheduledTimes.map(format12h).join(', ')}`);
      if (info.last) lines.push(`  Last logged: ${fmt(info.last.time)}`);
      lines.push(`  Next status: ${lifecycleLabel || getReadinessStatus(info).text}`);
      if (med.instructions) lines.push(`  Instructions: ${med.instructions}`);
      if (med.prescriber) lines.push(`  Prescriber: ${med.prescriber}`);
      if (med.pharmacy) lines.push(`  Pharmacy: ${med.pharmacy}`);
      if (supply !== null) lines.push(`  Supply left: ${supply} ${getSupplyLabel(med)}`);
    });
    lines.push('');
  };
  appendMedGroup('Active medications', groups.active);
  appendMedGroup('Inactive medications', groups.inactive);
  appendMedGroup('Archived medications', groups.archived);
  lines.push('');
  lines.push('NOT MEDICAL ADVICE. Personal tracking tool only. Verify with prescribing physician.');
  return lines.join('\n').trim();
}
function downloadMedicationList() {
  const blob = new Blob([buildMedicationListText()], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `medtracker-medication-list-${todayStr()}.txt`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 100);
}
function openMedicationList() {
  const groups = getMedicationGroups();
  const renderGroup = (title, meds, emptyText) => `<div class="summary-panel" style="margin-bottom:8px">
    <h3>${title}</h3>
    ${meds.length ? meds.map(med => {
      const info = getMedReadiness(med);
      const status = getMedicationLifecycleLabel(med) || getReadinessStatus(info).text;
      const supply = shared.getCurrentSupply(med, state);
      return `<div class="summary-item" style="margin-bottom:10px">
        <strong>${esc(med.name)}${med.brand ? ` (${esc(med.brand)})` : ''}</strong>
        <div>${esc(med.dose)} • ${esc(med.freq || 'No frequency listed')}</div>
        <div style="margin-top:4px;color:var(--muted)">${esc(status)}</div>
        ${med.reason ? `<div style="margin-top:4px"><strong>Reason:</strong> ${esc(med.reason)}</div>` : ''}
        ${med.instructions ? `<div style="margin-top:4px"><strong>Instructions:</strong> ${esc(med.instructions)}</div>` : ''}
        ${med.scheduleType === 'scheduled' && med.scheduledTimes?.length ? `<div style="margin-top:4px"><strong>Scheduled:</strong> ${esc(med.scheduledTimes.map(format12h).join(', '))}</div>` : ''}
        ${(med.prescriber || med.pharmacy) ? `<div style="margin-top:4px"><strong>Care team:</strong> ${esc([med.prescriber, med.pharmacy].filter(Boolean).join(' • '))}</div>` : ''}
        ${supply !== null ? `<div style="margin-top:4px"><strong>Supply:</strong> ${supply} ${esc(getSupplyLabel(med))} left</div>` : ''}
      </div>`;
    }).join('') : `<div class="summary-item">${emptyText}</div>`}
  </div>`;
  showModal(`<h3>${esc(CONFIG.patientName || 'Patient')} medication list</h3>
    <p>Use this at appointments, pharmacies, or handoff moments when someone needs the full active list fast.</p>
    <div style="max-height:45vh;overflow:auto">
      ${renderGroup('Active medications', groups.active, 'No active medications.')}
      ${renderGroup('Inactive medications', groups.inactive, 'No inactive medications.')}
      ${renderGroup('Archived medications', groups.archived, 'No archived medications.')}
    </div>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-cancel" onclick="closeModal()">Close</button>
      <button class="btn-confirm" onclick="downloadMedicationList()">Download</button>
    </div>`);
}
function openDailyReview() {
  const todayKey = todayStr();
  const todaysEvents = [...state.doses]
    .filter(entry => fmt(entry.time, 'date') === todayKey)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  const overrides = todaysEvents.filter(entry => entry.overrideType && entry.overrideType !== 'skip');
  const skips = todaysEvents.filter(entry => (entry.actionType || 'dose') === 'skip');
  const lowSupply = getDisplayMeds()
    .map(med => ({ med, remaining: shared.getCurrentSupply(med, state) }))
    .filter(entry => entry.remaining !== null && entry.remaining <= (entry.med.refillThreshold || 0));
  const nextUp = getNextUpQueue().slice(0, 3);
  const eventHtml = todaysEvents.length ? todaysEvents.map(entry => {
    const med = getMed(entry.medId);
    const label = (entry.actionType || 'dose') === 'skip'
      ? 'Skipped scheduled dose'
      : `${entry.tabs} tab${entry.tabs === 1 ? '' : 's'}${entry.mg ? ` (${entry.mg}mg)` : ''}`;
    const auditBits = [entry.loggedBy ? `Logged by ${entry.loggedBy}` : '', entry.overrideType ? `Override ${entry.overrideType}` : '', entry.overrideReason || '', entry.note || ''].filter(Boolean);
    return `<div class="summary-item" style="margin-bottom:8px">
      <strong>${esc(med ? med.name : entry.medId)}</strong> • ${esc(label)} • ${esc(fmt(entry.time, 'time'))}
      ${auditBits.length ? `<div class="card-note">${esc(auditBits.join(' • '))}</div>` : ''}
    </div>`;
  }).join('') : '<div class="summary-item">No entries yet today.</div>';
  showModal(`<h3>Daily review</h3>
    <p>Fast caregiver summary for what changed today, what was overridden, and what still needs attention.</p>
    <div class="summary-grid">
      <div class="summary-panel">
        <h3>Today</h3>
        <div class="summary-item"><strong>Entries</strong>${todaysEvents.length}</div>
        <div class="summary-item" style="margin-top:6px"><strong>Overrides</strong>${overrides.length}</div>
        <div class="summary-item" style="margin-top:6px"><strong>Skipped doses</strong>${skips.length}</div>
      </div>
      <div class="summary-panel">
        <h3>Needs attention</h3>
        <div class="summary-item"><strong>Low supply</strong>${lowSupply.length ? lowSupply.map(entry => `${esc(entry.med.name)} (${entry.remaining} ${esc(getSupplyLabel(entry.med))} left)`).join(', ') : 'None'}</div>
        <div class="summary-item" style="margin-top:6px"><strong>Next up</strong>${nextUp.length ? nextUp.map(entry => `${esc(entry.med.name)}: ${esc(getReadinessStatus(entry).text)}`).join(' | ') : 'Nothing due soon'}</div>
      </div>
    </div>
    <div class="summary-panel" style="margin-top:10px;max-height:32vh;overflow:auto">
      <h3>Timeline</h3>
      ${eventHtml}
    </div>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-cancel" onclick="closeModal()">Close</button>
    </div>`);
}
function exportConfig() {
  try {
    // Export shareable setup, not dose data.
    const exportData = {
      _mt:1,
      patientName: CONFIG.patientName || '',
      eventDate: CONFIG.eventDate || null,
      profile: { careLabel: (CONFIG.profile || {}).careLabel || '', importantInstructions: (CONFIG.profile || {}).importantInstructions || '' },
      meds: CONFIG.meds,
      warnings: CONFIG.warnings,
      recoveryNotes: CONFIG.recoveryNotes,
      eventLabel: CONFIG.eventLabel || '',
      colorPalette: CONFIG.colorPalette || COLOR_PALETTE
    };
    const b64 = shared.encodeSetupPayload(exportData);
    if(navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(b64).then(()=>showToast('Setup copied to clipboard!')).catch(()=>fallbackCopy(b64));
    } else {
      fallbackCopy(b64);
    }
  } catch(e) { console.error('exportConfig error:', e); showToast('Export failed'); }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText='position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast('Setup copied to clipboard!'); }
  catch(e) { showToast('Copy failed - try manually'); }
  document.body.removeChild(ta);
}
function showImportField() {
  const area = document.getElementById('import-area');
  area.innerHTML = `<div class="import-area">
    <textarea id="import-input" placeholder="Paste the setup code here..." rows="3" oninput="previewImport()"></textarea>
    <div id="import-preview-box"></div>
  </div>`;
  setTimeout(()=>{const el=document.getElementById('import-input');if(el)el.focus();},50);
}
function previewImport() {
  const input = document.getElementById('import-input');
  const box = document.getElementById('import-preview-box');
  if(!input||!box) return;
  const raw = input.value.trim();
  if(!raw){box.innerHTML='';return;}
  try {
    const data = shared.decodeSetupPayload(raw);
    if(!data._mt || !Array.isArray(data.meds)) throw new Error('Invalid format');
    const patientBits = [data.patientName || '', data.profile?.careLabel || ''].filter(Boolean).join(' • ');
    box.innerHTML = `<div class="import-preview">
      <strong>Found ${data.meds.length} medication${data.meds.length!==1?'s':''}:</strong>
      ${patientBits ? `<div style="margin-top:4px;color:var(--muted)">${esc(patientBits)}</div>` : ''}
      ${data.meds.map(m=>`<div style="display:flex;align-items:center;gap:6px;margin:4px 0"><span style="width:10px;height:10px;border-radius:50%;background:${esc(shared.sanitizeImportedColor(m.color,'#999'))}"></span>${esc(m.name)} (${esc(m.dose)})</div>`).join('')}
      ${Array.isArray(data.warnings) && data.warnings.length ? '<div style="margin-top:4px;color:var(--muted)">'+data.warnings.length+' warning(s)</div>' : ''}
      <div class="import-actions">
        <button class="btn-cancel" onclick="cancelImport()">Cancel</button>
        <button class="btn-confirm" onclick="applyImport()">Apply This Setup</button>
      </div>
    </div>`;
  } catch(e) {
    box.innerHTML = '<div style="color:var(--danger-border);font-size:13px;margin-top:4px">Invalid setup code. Make sure you pasted the full text.</div>';
  }
}
function cancelImport() {
  const area = document.getElementById('import-area');
  if(area) area.innerHTML = '';
}
function applyImport() {
  const input = document.getElementById('import-input');
  if(!input) return;
  try {
    const data = shared.decodeSetupPayload(input.value.trim());
    if(!data._mt || !Array.isArray(data.meds)) throw new Error('Invalid');
    data.meds.forEach(m=>{ m.color=shared.sanitizeImportedColor(m.color); m.bgBadge=shared.sanitizeImportedColor(m.bgBadge,'#f0f0f0'); });
    if (typeof data.patientName === 'string') CONFIG.patientName = data.patientName;
    if (Object.prototype.hasOwnProperty.call(data, 'eventDate')) CONFIG.eventDate = data.eventDate || null;
    if (data.profile) CONFIG.profile = shared.createEmptyProfile(data.profile);
    CONFIG.meds = data.meds;
    CONFIG.warnings = data.warnings || [];
    CONFIG.recoveryNotes = data.recoveryNotes || [];
    if(data.eventLabel) CONFIG.eventLabel = data.eventLabel;
    MEDS = CONFIG.meds;
    WARNINGS = CONFIG.warnings;
    RECOVERY_NOTES = (CONFIG.recoveryNotes||[]).filter(n=>n&&n.text).map(n=>({
      ...n, text: typeof n.text === 'function' ? n.text : day => (n.text||'').replace('{day}', day)
    }));
    saveConfig(CONFIG);
    showToast('Setup imported - '+data.meds.length+' meds loaded!');
    renderSettingsPanel();
    initAppHeader();
    render();
  } catch(e) { showToast('Import failed - invalid code'); }
}

// === First-Run Experience ===
const TEMPLATES = shared.getTemplates();

let _welcomeStep = 1;
let _welcomeName = '';
let _welcomeTemplateKey = null;
let _welcomeConfig = null;
let _reviewMeds = [];
let _reviewIndex = 0;
let _reviewEditing = false;
let _reviewAddingNote = false;
let _quickAddSearch = '';
let _quickAddSource = 'welcome'; // 'welcome' or 'settings'
let _quickAddSelected = null;

function showWelcome() {
  const overlay = document.getElementById('welcome-overlay');
  overlay.style.display = 'flex';
  renderWelcomeStep();
}

function renderWelcomeStep() {
  const overlay = document.getElementById('welcome-overlay');

  if (_welcomeStep === 1) {
    overlay.innerHTML = `<div class="welcome-card">
      <h2>Welcome to Med Tracker</h2>
      <p>Keep track of medications, dosing intervals, and daily limits, all on your phone.</p>
      <input type="text" id="welcome-name" value="${esc(_welcomeName)}" placeholder="Your name (optional)" onkeydown="if(event.key==='Enter')welcomeNext()">
      <button class="welcome-btn" onclick="welcomeNext()">Get Started</button>
    </div>`;
    setTimeout(()=>{const el=document.getElementById('welcome-name');if(el)el.focus();},100);

  } else if (_welcomeStep === 2) {
    overlay.innerHTML = `<div class="welcome-card">
      <h2>Choose a Starting Point</h2>
      <p>You can always customize medications later in Settings.</p>
      <div class="welcome-templates">
        ${Object.entries(TEMPLATES).map(([key,tpl])=>`<div class="welcome-tpl" onclick="selectTemplate('${key}')"><strong>${tpl.label}</strong><span>${tpl.description}</span></div>`).join('')}
      </div>
    </div>`;

  } else if (_welcomeStep === 3) {
    // Info Checklist
    overlay.innerHTML = `<div class="welcome-card">
      <h2>Before You Start</h2>
      <p>It helps to have these handy &mdash; but you can always come back and edit later.</p>
      <div class="welcome-checklist">
        <div class="welcome-checklist-item"><span class="wci-icon">&#x1F48A;</span><span>Prescription bottles (for exact doses)</span></div>
        <div class="welcome-checklist-item"><span class="wci-icon">&#x1F4CB;</span><span>Discharge or post-op instructions</span></div>
        <div class="welcome-checklist-item"><span class="wci-icon">&#x1F9D1;&#x200D;&#x2695;&#xFE0F;</span><span>Doctor or surgeon&rsquo;s contact info</span></div>
        <div class="welcome-checklist-item"><span class="wci-icon">&#x1F3EA;</span><span>Pharmacy name and phone number</span></div>
        <div class="welcome-checklist-item"><span class="wci-icon">&#x26A0;&#xFE0F;</span><span>Known allergies or drug sensitivities</span></div>
      </div>
      <div class="welcome-btn-row">
        <button class="welcome-btn" onclick="welcomeChecklist()">I&rsquo;m Ready</button>
        <button class="welcome-btn-secondary" onclick="welcomeSkipReview()">Skip for Now</button>
      </div>
    </div>`;

  } else if (_welcomeStep === 4) {
    // Guided Med Review
    renderReviewStep();

  } else if (_welcomeStep === 5) {
    // Quick-Add Picker
    renderQuickAddInWelcome();
  }
}

function welcomeNext() {
  const nameInput = document.getElementById('welcome-name');
  _welcomeName = nameInput ? nameInput.value.trim() : '';
  _welcomeStep = 2;
  renderWelcomeStep();
}

function selectTemplate(key) {
  const tpl = TEMPLATES[key];
  if (!tpl) return;
  if (key === 'restore') {
    document.getElementById('welcome-overlay').style.display = 'none';
    openSettings();
    showBackupImportField();
    return;
  }
  _welcomeTemplateKey = key;
  _welcomeConfig = tpl.buildConfig ? tpl.buildConfig() : shared.createDefaultConfig();
  _welcomeStep = 3;
  renderWelcomeStep();
}

function applyWelcomeTemplate() {
  CONFIG.patientName = _welcomeName;
  CONFIG.meds = (_welcomeConfig.meds || []).map(m=>({...m}));
  CONFIG.warnings = (_welcomeConfig.warnings || []).map(w=>({...w}));
  CONFIG.recoveryNotes = (_welcomeConfig.recoveryNotes || []).map(n=>({...n}));
  CONFIG.profile = shared.normalizeProfile({
    ...(_welcomeConfig.profile || {}),
    defaultLoggerName: CONFIG.profile?.defaultLoggerName || _welcomeConfig.profile?.defaultLoggerName || '',
    careLabel: _welcomeConfig.profile?.careLabel || CONFIG.profile?.careLabel || ''
  });
  if (_welcomeTemplateKey === 'post-surgery') {
    CONFIG.eventDate = CONFIG.eventDate || _welcomeConfig.eventDate || null;
    CONFIG.eventLabel = _welcomeConfig.eventLabel || 'Surgery';
  }
  refreshDerivedConfig();
  saveConfig(CONFIG);
}

function welcomeChecklist() {
  // Apply the template config
  applyWelcomeTemplate();
  // If template has meds, go to review flow
  if (CONFIG.meds.length > 0) {
    _reviewMeds = CONFIG.meds.map((m, i) => ({ ...m, _originalIndex: i }));
    _reviewIndex = 0;
    _reviewEditing = false;
    _reviewAddingNote = false;
    _welcomeStep = 4;
  } else {
    // No meds — close welcome and show main app
    closeWelcome();
    return;
  }
  renderWelcomeStep();
}

function welcomeSkipReview() {
  // Apply template but skip the per-med review — go straight to main app
  applyWelcomeTemplate();
  closeWelcome();
}

function closeWelcome() {
  document.getElementById('welcome-overlay').style.display = 'none';
  initAppHeader();
  render();
}

// === Guided Med Review (Step 4) ===

function renderReviewStep() {
  const overlay = document.getElementById('welcome-overlay');
  const activeMeds = _reviewMeds.filter(m => !m.archived);

  if (_reviewIndex >= _reviewMeds.length) {
    // All reviewed — show summary
    const activeCount = activeMeds.length;
    const removedCount = _reviewMeds.length - activeCount;
    overlay.innerHTML = `<div class="welcome-card">
      <h2>All medications reviewed!</h2>
      <div class="review-done">
        <div class="review-done-count">${activeCount} active${removedCount ? ', ' + removedCount + ' removed' : ''}</div>
        <button class="welcome-btn" onclick="reviewAddAnother()" style="margin-bottom:8px">+ Add Another Medication</button>
        <button class="welcome-btn-secondary" onclick="reviewDone()">Done &mdash; Let&rsquo;s Go</button>
      </div>
    </div>`;
    return;
  }

  const med = _reviewMeds[_reviewIndex];
  const warns = (med.warns || []).map(w => `<div class="review-card-warn">${esc(w)}</div>`).join('');
  const schedInfo = med.scheduleType === 'scheduled' && med.scheduledTimes && med.scheduledTimes.length
    ? `<div class="review-card-detail"><strong>Schedule:</strong> ${med.scheduledTimes.map(format12h).join(', ')}</div>` : '';

  let editHtml = '';
  if (_reviewEditing) {
    editHtml = `<div class="review-inline-edit">
      <div class="settings-field"><label>Name</label><input type="text" id="review-edit-name" value="${esc(med.name)}"></div>
      <div class="settings-field"><label>Dose</label><input type="text" id="review-edit-dose" value="${esc(med.dose)}"></div>
      <div class="settings-field"><label>Frequency</label><input type="text" id="review-edit-freq" value="${esc(med.freq)}"></div>
      <div class="settings-field"><label>Instructions</label><input type="text" id="review-edit-instructions" value="${esc(med.instructions || '')}" placeholder="Helpful note for caregiver"></div>
      <div class="welcome-btn-row" style="margin-top:12px">
        <button class="welcome-btn" onclick="reviewSaveEdit()">Save</button>
        <button class="welcome-btn-secondary" onclick="reviewCancelEdit()">Cancel</button>
      </div>
    </div>`;
  }

  let noteHtml = '';
  if (_reviewAddingNote) {
    noteHtml = `<div class="review-inline-edit" style="margin-top:12px">
      <div class="settings-field"><label>Add a note</label><input type="text" id="review-note-input" placeholder="e.g. Take with food" autofocus></div>
      <div class="welcome-btn-row">
        <button class="welcome-btn" onclick="reviewSaveNote()">Save Note</button>
        <button class="welcome-btn-secondary" onclick="reviewCancelNote()">Cancel</button>
      </div>
    </div>`;
  }

  overlay.innerHTML = `<div class="welcome-card">
    <div class="review-progress">Reviewing medication ${_reviewIndex + 1} of ${_reviewMeds.length}</div>
    <div class="review-card" style="border-left-color:${med.color || 'var(--success)'}">
      <div class="review-card-name" style="color:${med.color || 'var(--text)'}">${esc(med.name)}</div>
      ${med.brand ? `<div class="review-card-brand">${esc(med.brand)}</div>` : ''}
      <div class="review-card-dose">${esc(med.dose)} &mdash; ${esc(med.freq)}</div>
      ${med.purpose ? `<div class="review-card-detail"><strong>Purpose:</strong> ${esc(med.purpose)}</div>` : ''}
      ${med.reason ? `<div class="review-card-detail"><strong>Reason:</strong> ${esc(med.reason)}</div>` : ''}
      ${med.instructions ? `<div class="review-card-detail"><strong>Instructions:</strong> ${esc(med.instructions)}</div>` : ''}
      ${schedInfo}
      ${warns}
      ${editHtml}
      ${noteHtml}
    </div>
    ${!_reviewEditing && !_reviewAddingNote ? `<div class="review-actions">
      <button class="review-btn-confirm" onclick="reviewConfirm()">Looks Good</button>
      <button class="review-btn-edit" onclick="reviewEdit()">Edit</button>
      <button class="review-btn-remove" onclick="reviewRemove()">Remove</button>
      <button class="review-btn-note" onclick="reviewAddNote()">Add Note</button>
    </div>` : ''}
  </div>`;
}

function reviewConfirm() {
  _reviewIndex++;
  _reviewEditing = false;
  _reviewAddingNote = false;
  renderWelcomeStep();
}

function reviewEdit() {
  _reviewEditing = true;
  _reviewAddingNote = false;
  renderWelcomeStep();
}

function reviewCancelEdit() {
  _reviewEditing = false;
  renderWelcomeStep();
}

function reviewSaveEdit() {
  const med = _reviewMeds[_reviewIndex];
  const name = (document.getElementById('review-edit-name')?.value || '').trim();
  const dose = (document.getElementById('review-edit-dose')?.value || '').trim();
  const freq = (document.getElementById('review-edit-freq')?.value || '').trim();
  const instructions = (document.getElementById('review-edit-instructions')?.value || '').trim();
  if (name) med.name = name;
  if (dose) med.dose = dose;
  if (freq) med.freq = freq;
  med.instructions = instructions;
  // Sync back to CONFIG
  const configMed = CONFIG.meds[med._originalIndex];
  if (configMed) {
    configMed.name = med.name;
    configMed.dose = med.dose;
    configMed.freq = med.freq;
    configMed.instructions = med.instructions;
    saveConfig(CONFIG);
  }
  _reviewEditing = false;
  _reviewIndex++;
  renderWelcomeStep();
}

function reviewRemove() {
  const med = _reviewMeds[_reviewIndex];
  med.archived = true;
  const configMed = CONFIG.meds[med._originalIndex];
  if (configMed) {
    configMed.archived = true;
    saveConfig(CONFIG);
  }
  _reviewIndex++;
  _reviewEditing = false;
  _reviewAddingNote = false;
  renderWelcomeStep();
}

function reviewAddNote() {
  _reviewAddingNote = true;
  _reviewEditing = false;
  renderWelcomeStep();
  setTimeout(()=>{const el=document.getElementById('review-note-input');if(el)el.focus();},100);
}

function reviewCancelNote() {
  _reviewAddingNote = false;
  renderWelcomeStep();
}

function reviewSaveNote() {
  const med = _reviewMeds[_reviewIndex];
  const note = (document.getElementById('review-note-input')?.value || '').trim();
  if (note) {
    med.instructions = med.instructions ? med.instructions + '. ' + note : note;
    const configMed = CONFIG.meds[med._originalIndex];
    if (configMed) {
      configMed.instructions = med.instructions;
      saveConfig(CONFIG);
    }
  }
  _reviewAddingNote = false;
  _reviewIndex++;
  renderWelcomeStep();
}

function reviewAddAnother() {
  _quickAddSource = 'welcome';
  _quickAddSearch = '';
  _quickAddSelected = null;
  _welcomeStep = 5;
  renderWelcomeStep();
}

function reviewDone() {
  refreshDerivedConfig();
  closeWelcome();
}

// === Quick-Add Common Meds (Step 5 / Settings) ===

function getFilteredCommonMeds() {
  const all = shared.getCommonMeds();
  const existingIds = new Set(CONFIG.meds.map(m => m.id));
  const available = all.filter(m => !existingIds.has(m.id));
  if (!_quickAddSearch) return available;
  const q = _quickAddSearch.toLowerCase();
  return available.filter(m =>
    m.name.toLowerCase().includes(q) ||
    (m.brand && m.brand.toLowerCase().includes(q)) ||
    m.purpose.toLowerCase().includes(q) ||
    m.category.toLowerCase().includes(q)
  );
}

function renderQuickAddList() {
  const filtered = getFilteredCommonMeds();
  let html = filtered.map(m =>
    `<div class="quick-add-item" onclick="quickAddSelect('${esc(m.id)}')">
      <div class="quick-add-item-name">${esc(m.name)}${m.brand ? ` <span style="font-weight:400;color:var(--muted)">(${esc(m.brand)})</span>` : ''}</div>
      <div class="quick-add-item-info">${esc(m.dose)} &middot; ${esc(m.purpose)}</div>
    </div>`
  ).join('');
  html += `<button class="quick-add-custom" onclick="quickAddCustom()">+ Custom medication &mdash; enter details manually</button>`;
  return html;
}

function renderQuickAddConfirmForm() {
  const med = _quickAddSelected;
  if (!med) return '';
  return `<div class="quick-add-confirm">
    <h3 style="margin:0 0 12px;font-size:17px">Add ${esc(med.name)}?</h3>
    <div class="settings-field"><label>Name</label><input type="text" id="qa-name" value="${esc(med.name)}"></div>
    <div class="med-form-row">
      <div class="settings-field"><label>Dose</label><input type="text" id="qa-dose" value="${esc(med.dose)}"></div>
      <div class="settings-field"><label>Purpose</label><input type="text" id="qa-purpose" value="${esc(med.purpose)}"></div>
    </div>
    <div class="settings-field"><label>Frequency</label><input type="text" id="qa-freq" value="${esc(med.freq)}"></div>
    <div class="settings-field"><label>Instructions</label><input type="text" id="qa-instructions" value="${esc(med.instructions || '')}" placeholder="Helpful note for caregiver"></div>
    <div class="welcome-btn-row" style="margin-top:12px">
      <button class="welcome-btn" onclick="quickAddConfirm()">Add Medication</button>
      <button class="welcome-btn-secondary" onclick="quickAddBack()">Back</button>
    </div>
  </div>`;
}

function renderQuickAddInWelcome() {
  const overlay = document.getElementById('welcome-overlay');
  let content;
  if (_quickAddSelected) {
    content = renderQuickAddConfirmForm();
  } else {
    content = `<h2>Add a Medication</h2>
      <input class="quick-add-search" type="text" placeholder="Search medications..." value="${esc(_quickAddSearch)}" oninput="quickAddFilter(this.value)" id="qa-search">
      <div class="quick-add-list">${renderQuickAddList()}</div>
      <button class="welcome-btn-secondary" onclick="quickAddCancel()" style="margin-top:8px">Back to Review</button>`;
  }
  overlay.innerHTML = `<div class="welcome-card">${content}</div>`;
  if (!_quickAddSelected) {
    setTimeout(()=>{const el=document.getElementById('qa-search');if(el)el.focus();},100);
  }
}

function quickAddFilter(value) {
  _quickAddSearch = value;
  const listEl = document.querySelector('.quick-add-list');
  if (listEl) listEl.innerHTML = renderQuickAddList();
}

function quickAddSelect(medId) {
  const meds = shared.getCommonMeds();
  _quickAddSelected = meds.find(m => m.id === medId) || null;
  if (_quickAddSource === 'welcome') {
    renderQuickAddInWelcome();
  } else {
    renderSettingsPanel();
  }
}

function quickAddBack() {
  _quickAddSelected = null;
  if (_quickAddSource === 'welcome') {
    renderQuickAddInWelcome();
  } else {
    renderSettingsPanel();
  }
}

function quickAddConfirm() {
  const name = (document.getElementById('qa-name')?.value || '').trim();
  if (!name) { showToast('Name is required'); return; }
  const baseMed = _quickAddSelected || {};
  const newMed = shared.normalizeMed({
    ...baseMed,
    name: name,
    dose: (document.getElementById('qa-dose')?.value || '').trim() || baseMed.dose,
    purpose: (document.getElementById('qa-purpose')?.value || '').trim() || baseMed.purpose,
    freq: (document.getElementById('qa-freq')?.value || '').trim() || baseMed.freq,
    instructions: (document.getElementById('qa-instructions')?.value || '').trim(),
    color: nextColor()
  });
  // Ensure unique ID
  let id = newMed.id;
  let suffix = 2;
  while (CONFIG.meds.some(m => m.id === id)) { id = newMed.id + '-' + suffix++; }
  newMed.id = id;
  CONFIG.meds.push(newMed);
  saveConfig(CONFIG);
  refreshDerivedConfig();
  _quickAddSelected = null;
  _quickAddSearch = '';
  if (_quickAddSource === 'welcome') {
    // Update review meds list and go back to review summary
    _reviewMeds = CONFIG.meds.map((m, i) => ({ ...m, _originalIndex: i }));
    _reviewIndex = _reviewMeds.length; // Jump to summary
    _welcomeStep = 4;
    renderWelcomeStep();
    showToast(name + ' added');
  } else {
    _editingMedIndex = -1;
    renderSettingsPanel();
    render();
    showToast(name + ' added');
  }
}

function quickAddCustom() {
  _quickAddSelected = null;
  _quickAddSearch = '';
  if (_quickAddSource === 'welcome') {
    // Close welcome and open settings with blank med form
    closeWelcome();
    openSettings();
    startAddMed();
  } else {
    // In settings — show the blank form (original startAddMed behavior)
    _editingMedIndex = -2;
    _selectedMedColor = nextColor();
    renderSettingsPanel();
  }
}

function renderSettingsQuickAdd() {
  if (_quickAddSelected) {
    return renderQuickAddConfirmForm();
  }
  return `<div style="margin-top:12px">
    <h3>Add a Medication</h3>
    <input class="quick-add-search" type="text" placeholder="Search medications..." value="${esc(_quickAddSearch)}" oninput="quickAddFilter(this.value)" id="qa-search-settings">
    <div class="quick-add-list">${renderQuickAddList()}</div>
    <button class="welcome-btn-secondary" onclick="cancelMedForm()" style="margin-top:8px">Cancel</button>
  </div>`;
}

function quickAddCancel() {
  _quickAddSelected = null;
  _quickAddSearch = '';
  if (_quickAddSource === 'welcome') {
    _welcomeStep = 4;
    _reviewIndex = _reviewMeds.length; // back to summary
    renderWelcomeStep();
  } else {
    _editingMedIndex = -1;
    renderSettingsPanel();
  }
}

// Check for first-run
let _isFirstRun = !localStorage.getItem(CONFIG_KEY) && !localStorage.getItem(LEGACY_STATE_KEY);

// Dynamic header based on config
function initAppHeader() {
  const title = (CONFIG.patientName ? CONFIG.patientName+"'s" : 'My') + ' Med Tracker';
  document.title = title;
  const h1 = document.getElementById('app-title');
  if(h1) h1.textContent = title;
  const appleTitle = document.getElementById('apple-title');
  if(appleTitle) appleTitle.setAttribute('content', CONFIG.patientName ? CONFIG.patientName+"'s Meds" : 'Med Tracker');
  const eventInfo = document.getElementById('event-info');
  if(eventInfo) {
    if(CONFIG.eventDate) {
      const d=new Date(CONFIG.eventDate+'T00:00:00');
      const formatted=d.toLocaleDateString([],{month:'long',day:'numeric',year:'numeric'});
      eventInfo.textContent=(CONFIG.eventLabel||'Event')+': '+formatted;
    } else {
      eventInfo.textContent='';
    }
  }
}
async function initApp() {
  try {
    const hadExistingData = !!localStorage.getItem(CONFIG_KEY) || !!localStorage.getItem(LEGACY_STATE_KEY);
    const bundle = await storageManager.loadBundle();
    applyBundle(bundle);
    storageHealth = await storageManager.getHealth(storageMeta);
    _isFirstRun = !hadExistingData && !CONFIG.patientName && !CONFIG.meds.length && !state.doses.length;
  } catch (error) {
    captureError(error, 'init-app');
  }
  initAppHeader();
  initBedside();
  initWarningsState();
  positionAlertBanner();
  if (_isFirstRun) showWelcome();
  render();
  // Auto-request persistent storage for PWA data safety
  if (storageHealth && !storageHealth.persisted) {
    storageManager.requestPersistence(storageMeta).then(meta => {
      storageMeta = meta;
      try { renderCareSummary(); } catch(e) {}
    }).catch(() => {});
  }
}

window.addEventListener('resize', positionAlertBanner);
initApp();

// Midnight rollover detection: full re-render when the day changes.
let _lastRenderDay = todayStr();

// Timer loop: isolate failures so one update path does not break the interval.
setInterval(()=>{
  // If the day changed (midnight rollover), do a full re-render to reset card counts, completion dots, etc.
  try {
    const currentDay = todayStr();
    if (currentDay !== _lastRenderDay) {
      _lastRenderDay = currentDay;
      render();
      return; // full render already updated everything
    }
  } catch(e) {}
  try{renderClock();}catch(e){}
  try{renderDayCounter();}catch(e){}
  try{renderTrackedTotals();}catch(e){}
  if(++_nqiTick % 10 === 0){try{renderNextUp();}catch(e){}}
  // Update status text on cards without full re-render
  try{
    document.querySelectorAll('.card[data-med-id]').forEach(card=>{
      const med=getMed(card.getAttribute('data-med-id')); if(!med || !shared.isMedActiveOnDate(med)) return;
      const info=getMedReadiness(med);
      const status=getReadinessStatus(info);
      const statusEl=card.querySelector('.card-status');
      const timerEl=card.querySelector('.card-timer');
      const fillEl=card.querySelector('.timer-fill');
      const logBtn=card.querySelector('.btn-log');
      if(statusEl){
        statusEl.innerHTML=`<span class="dot ${status.dot}"></span>${status.text}`;
      }
      if(timerEl) timerEl.textContent=info.last?`Last: ${fmt(info.last.time,'time')} (${minsToHM(info.ago)} ago)`:'No doses logged yet';
      if(fillEl){fillEl.style.width=info.progressPct+'%';fillEl.style.background=info.isReadyRecommended?_cssSuccess:med.color;}
      if(logBtn){
        logBtn.textContent=status.actionLabel;
        logBtn.disabled=!status.canOpenModal;
      }
    });
  }catch(e){}
},1000);

// Init
Object.assign(window, {
  addDose,
  addWarning,
  applyImport,
  applyBackupImport,
  cancelImport,
  cancelBackupImport,
  cancelMedForm,
  closeModal,
  selectPainScore,
  selectEditPainScore,
  closeSettings,
  confirmClearAllData,
  confirmFactoryReset,
  confirmPendingAction,
  confirmDuplicateDose,
  confirmMultiTab,
  confirmSingleDose,
  confirmTracked,
  deleteMed,
  deleteWarning,
  dismissAlertBanner,
  handlePurgeSoftDeleted,
  confirmPurgeSoftDeleted,
  downloadFullBackup,
  downloadMedicationList,
  downloadReminder,
  downloadSupportBundle,
  downloadHandoffSummary,
  editMed,
  quickEditMed,
  exportConfig,
  handleClear,
  handleFactoryReset,
  handleEditDose,
  handleExport,
  handleLog,
  handleRemove,
  loadBackupImportFile,
  moveMed,
  openDailyReview,
  openHandoffSummary,
  openMedicationList,
  onCustomTimeChange,
  openSettings,
  previewBackupImport,
  previewImport,
  recoverSnapshot,
  removeDose,
  requestPersistentStorage,
  saveWarning,
  saveEditedDose,
  saveMedForm,
  selectMedColor,
  selectTab,
  selectTemplate,
  selectTimeChip,
  showBackupImportField,
  showCustomTime,
  showImportField,
  skipScheduledDose,
  startAddMed,
  toggleAdvanced,
  toggleBedside,
  toggleCustomInterval,
  toggleLog,
  toggleMedArchived,
  toggleMedPinned,
  toggleNqiItem,
  toggleNqiSection,
  toggleWarnings,
  updateConfigField,
  updateProfileField,
  updateProfileListField,
  undoLastDose,
  welcomeNext,
  prepareForNewSurgery,
  confirmNewSurgeryPrep,
  showNewSurgeryWizard,
  applyNewSurgeryWizard,
  toggleArchivedLog,
  renderRecoveryNote,
  welcomeChecklist,
  welcomeSkipReview,
  reviewConfirm,
  reviewEdit,
  reviewCancelEdit,
  reviewSaveEdit,
  reviewRemove,
  reviewAddNote,
  reviewCancelNote,
  reviewSaveNote,
  reviewAddAnother,
  reviewDone,
  quickAddFilter,
  quickAddSelect,
  quickAddBack,
  quickAddConfirm,
  quickAddCustom,
  quickAddCancel,
  toggleSymptomChip,
  getModalSeverity
});



