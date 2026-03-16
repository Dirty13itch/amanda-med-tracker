export const APP_VERSION = '2.2.0';
export const APP_SCHEMA = 2;
export const BACKUP_SCHEMA = 1;
export const CONFIG_KEY = 'medtracker-config-v1';
export const DOSES_KEY = 'medtracker-doses-v1';
export const LEGACY_STATE_KEY = 'amanda-meds-v1';
export const LEGACY_BEDSIDE_KEY = 'amanda-meds-bedside';
export const BEDSIDE_KEY = 'medtracker-bedside';
export const DB_NAME = 'medtracker-app-state-v2';
export const DB_VERSION = 1;
export const STORE_NAME = 'kv';
export const COLOR_PALETTE = [
  '#e74c3c',
  '#e84393',
  '#8e44ad',
  '#2980b9',
  '#27ae60',
  '#e67e22',
  '#00b894',
  '#fd79a8',
  '#636e72',
  '#00cec9'
];
export const OVERDUE_GRACE_MIN = 30;
export const DUPLICATE_WINDOW_MIN = 15;
export const INCORRECT_OXY_WARNING = 'Stop day after surgery unless itching or nausea';

const DEFAULT_PROFILE = {
  allergies: [],
  allergiesReviewed: false,
  conditions: [],
  emergencyContact: '',
  careLabel: '',
  defaultLoggerName: '',
  importantInstructions: '',
  bloodType: '',
  dateOfBirth: '',
  weight: '',
  surgeonName: '',
  surgeonPhone: ''
};

const DEFAULT_META = {
  schema: APP_SCHEMA,
  version: APP_VERSION,
  backend: 'localStorage',
  lastSuccessfulBackupAt: null,
  lastIntegrityCheckAt: null,
  lastSnapshotAt: null,
  lastWriteReason: 'initial',
  persistentStorageGranted: false
};

const AMANDA_MEDS = [
  {
    id: 'oxycodone',
    name: 'Oxycodone',
    brand: '',
    dose: '5mg',
    unitLabel: 'mg',
    perTab: 5,
    maxTabs: 2,
    purpose: 'Pain Relief',
    reason: 'Breakthrough pain',
    freq: '1-2 tabs every 4 hrs as needed',
    intervalMin: 240,
    color: 'var(--oxy)',
    bgBadge: '#fde8e8',
    scheduled: false,
    scheduleType: 'prn',
    scheduledTimes: [],
    isPrn: true,
    instructions: 'Use only when pain is not manageable with other options.',
    warns: [],
    category: 'opioid'
  },
  {
    id: 'tylenol',
    name: 'Tylenol',
    brand: 'Acetaminophen',
    dose: '500mg tabs',
    unitLabel: 'mg',
    perTab: 500,
    maxTabs: 2,
    purpose: 'Pain Relief',
    reason: 'Baseline pain control',
    freq: '1000mg four times daily',
    intervalMin: 360,
    color: 'var(--tyl)',
    bgBadge: '#fff3e0',
    scheduled: false,
    scheduleType: 'prn',
    scheduledTimes: [],
    isPrn: true,
    instructions: 'May take with Oxycodone or alternate with it.',
    warns: ['MAX 4000mg in 24 hours', 'May take at same time as Oxy or alternate'],
    category: 'analgesic',
    trackTotal: true,
    maxDaily: 4000
  },
  {
    id: 'hydroxyzine',
    name: 'Hydroxyzine',
    brand: 'Vistaril',
    dose: '25mg',
    unitLabel: 'mg',
    perTab: 25,
    maxTabs: 1,
    purpose: 'Anti-Nausea',
    reason: 'Nausea or itching',
    freq: '1 tab every 4 hrs with Oxycodone',
    intervalMin: 240,
    color: 'var(--hyd)',
    bgBadge: '#fce4ec',
    scheduled: false,
    scheduleType: 'prn',
    scheduledTimes: [],
    isPrn: true,
    instructions: 'Take WITH Oxycodone if experiencing nausea or itching. Only log when actually taken.',
    warns: ['Take together with Oxycodone', 'May add to drowsiness from opioids'],
    category: 'antiemetic',
    pairedWith: 'oxycodone',
    maxDoses: 4
  },
  {
    id: 'diazepam',
    name: 'Diazepam',
    brand: 'Valium',
    dose: '5mg',
    unitLabel: 'mg',
    perTab: 5,
    maxTabs: 1,
    purpose: 'Muscle Relaxer',
    reason: 'Muscle tightness',
    freq: '1 tab every 6 hrs as needed',
    intervalMin: 360,
    color: 'var(--dia)',
    bgBadge: '#f3e5f5',
    scheduled: false,
    scheduleType: 'prn',
    scheduledTimes: [],
    isPrn: true,
    instructions: 'Do not take too close to Oxycodone.',
    warns: ['Opioid + benzodiazepine: FDA black-box warning. Minimum 4-hour separation. Monitor for excessive sedation or slowed breathing.'],
    category: 'benzodiazepine',
    conflictsWith: 'oxycodone',
    conflictMin: 240
  },
  {
    id: 'cephalexin',
    name: 'Cephalexin',
    brand: 'Keflex',
    dose: '500mg',
    unitLabel: 'mg',
    perTab: 500,
    maxTabs: 1,
    purpose: 'Antibiotic',
    reason: 'Prevent infection',
    freq: '1 tab at each meal (4 doses total)',
    intervalMin: 240,
    color: 'var(--ceph)',
    bgBadge: '#e3f2fd',
    scheduled: true,
    scheduleType: 'scheduled',
    scheduledTimes: ['08:00', '12:00', '17:00', '21:00'],
    isPrn: false,
    instructions: 'Keep doses spread through the day.',
    warns: [],
    category: 'antibiotic',
    maxDoses: 4
  },
  {
    id: 'stool',
    name: 'Super Aloe / Senekot S',
    brand: '',
    dose: '1 tab',
    unitLabel: 'tabs',
    perTab: 0,
    maxTabs: 1,
    purpose: 'Stool Softener',
    reason: 'Opioid support',
    freq: 'Twice daily, can reduce to once',
    intervalMin: 600,
    color: 'var(--stool)',
    bgBadge: '#e8f5e9',
    scheduled: true,
    scheduleType: 'scheduled',
    scheduledTimes: ['09:00', '21:00'],
    isPrn: false,
    instructions: 'Use while opioid meds continue.',
    warns: [],
    category: 'stool-softener',
    maxDoses: 2
  }
];

// Common medications database for Quick-Add picker
const COMMON_MEDS = [
  // Opioids
  { id: 'oxycodone', name: 'Oxycodone', brand: '', dose: '5mg', perTab: 5, maxTabs: 2, unitLabel: 'mg', purpose: 'Pain Relief', reason: 'Breakthrough pain', freq: '1-2 tabs every 4 hrs as needed', intervalMin: 240, category: 'opioid', warns: ['May cause drowsiness and constipation', 'Do not take with alcohol'], instructions: 'Use only when pain is not manageable with Tylenol alone.' },
  { id: 'hydrocodone-apap', name: 'Hydrocodone/APAP', brand: 'Norco', dose: '5-325mg', perTab: 5, maxTabs: 2, unitLabel: 'mg', purpose: 'Pain Relief', reason: 'Moderate to severe pain', freq: '1-2 tabs every 4-6 hrs as needed', intervalMin: 240, category: 'opioid', apapPerTab: 325, warns: ['Contains 325mg acetaminophen per tab — counts toward 4000mg daily Tylenol limit', 'May cause drowsiness'], instructions: 'Do not exceed 8 tablets in 24 hours.' },
  { id: 'tramadol', name: 'Tramadol', brand: 'Ultram', dose: '50mg', perTab: 50, maxTabs: 2, unitLabel: 'mg', purpose: 'Pain Relief', reason: 'Moderate pain', freq: '1-2 tabs every 6 hrs as needed', intervalMin: 360, category: 'opioid', warns: ['May cause dizziness', 'Do not take with other opioids'], instructions: '' },
  // Analgesics
  { id: 'tylenol', name: 'Acetaminophen', brand: 'Tylenol', dose: '500mg', perTab: 500, maxTabs: 2, unitLabel: 'mg', purpose: 'Pain / Fever', reason: 'Pain or fever reduction', freq: '1-2 tabs every 4-6 hrs', intervalMin: 240, category: 'analgesic', warns: ['MAX 4000mg in 24 hours — includes combo meds'], instructions: 'Can alternate with ibuprofen if allowed.', trackTotal: true, maxDaily: 4000 },
  { id: 'ibuprofen', name: 'Ibuprofen', brand: 'Advil', dose: '200mg', perTab: 200, maxTabs: 2, unitLabel: 'mg', purpose: 'Pain / Inflammation', reason: 'Pain and swelling', freq: '1-2 tabs every 6 hrs', intervalMin: 360, category: 'nsaid', warns: ['Take with food', 'Avoid after surgery unless cleared by doctor'], instructions: 'Check with surgeon before starting — often restricted post-op.' },
  { id: 'naproxen', name: 'Naproxen', brand: 'Aleve', dose: '220mg', perTab: 220, maxTabs: 1, unitLabel: 'mg', purpose: 'Pain / Inflammation', reason: 'Long-lasting pain relief', freq: '1 tab every 8-12 hrs', intervalMin: 480, category: 'nsaid', warns: ['Take with food', 'Avoid after surgery unless cleared by doctor'], instructions: '' },
  // Nerve / Muscle
  { id: 'gabapentin', name: 'Gabapentin', brand: 'Neurontin', dose: '300mg', perTab: 300, maxTabs: 1, unitLabel: 'mg', purpose: 'Nerve Pain', reason: 'Neuropathic pain management', freq: '1 cap three times daily', intervalMin: 480, category: 'anticonvulsant', warns: ['May cause drowsiness', 'Do not stop abruptly'], instructions: 'Dose may be increased gradually per doctor.' },
  { id: 'diazepam', name: 'Diazepam', brand: 'Valium', dose: '5mg', perTab: 5, maxTabs: 1, unitLabel: 'mg', purpose: 'Muscle Relaxer', reason: 'Muscle spasm or anxiety', freq: '1 tab every 6-8 hrs as needed', intervalMin: 360, category: 'benzodiazepine', warns: ['Do not combine with opioids without doctor approval — respiratory depression risk', 'May cause drowsiness'], instructions: 'Wait at least 2 hours after opioid doses.' },
  { id: 'cyclobenzaprine', name: 'Cyclobenzaprine', brand: 'Flexeril', dose: '10mg', perTab: 10, maxTabs: 1, unitLabel: 'mg', purpose: 'Muscle Relaxer', reason: 'Muscle spasm relief', freq: '1 tab every 8 hrs as needed', intervalMin: 480, category: 'muscle-relaxant', warns: ['May cause drowsiness', 'Avoid with alcohol'], instructions: '' },
  // Anti-nausea
  { id: 'ondansetron', name: 'Ondansetron', brand: 'Zofran', dose: '4mg', perTab: 4, maxTabs: 1, unitLabel: 'mg', purpose: 'Anti-Nausea', reason: 'Nausea from anesthesia or opioids', freq: '1 tab every 6-8 hrs as needed', intervalMin: 360, category: 'antiemetic', warns: [], instructions: 'Dissolves on tongue — no water needed for ODT form.' },
  { id: 'hydroxyzine', name: 'Hydroxyzine', brand: 'Vistaril', dose: '25mg', perTab: 25, maxTabs: 1, unitLabel: 'mg', purpose: 'Anti-Nausea / Itch', reason: 'Nausea, itching, or anxiety', freq: '1 tab every 4-6 hrs as needed', intervalMin: 240, category: 'antiemetic', warns: ['May cause drowsiness'], instructions: 'Can be taken with opioids for nausea prevention.' },
  // Antibiotics
  { id: 'cephalexin', name: 'Cephalexin', brand: 'Keflex', dose: '500mg', perTab: 500, maxTabs: 1, unitLabel: 'mg', purpose: 'Antibiotic', reason: 'Infection prevention', freq: '1 tab four times daily', intervalMin: 360, category: 'antibiotic', scheduled: true, scheduleType: 'scheduled', scheduledTimes: ['08:00', '12:00', '17:00', '21:00'], maxDoses: 4, warns: ['Complete full course even if feeling better'], instructions: 'Take with or without food.' },
  { id: 'amoxicillin', name: 'Amoxicillin', brand: 'Amoxil', dose: '500mg', perTab: 500, maxTabs: 1, unitLabel: 'mg', purpose: 'Antibiotic', reason: 'Infection prevention', freq: '1 tab three times daily', intervalMin: 480, category: 'antibiotic', scheduled: true, scheduleType: 'scheduled', scheduledTimes: ['08:00', '14:00', '20:00'], maxDoses: 3, warns: ['Complete full course even if feeling better'], instructions: 'Take with or without food.' },
  // GI / Stool
  { id: 'docusate', name: 'Docusate Sodium', brand: 'Colace', dose: '100mg', perTab: 100, maxTabs: 1, unitLabel: 'mg', purpose: 'Stool Softener', reason: 'Prevent constipation from opioids', freq: '1 cap twice daily', intervalMin: 720, category: 'stool-softener', warns: [], instructions: 'Start when beginning opioid medications.' },
  { id: 'senna', name: 'Senna', brand: 'Senokot', dose: '8.6mg', perTab: 8.6, maxTabs: 2, unitLabel: 'mg', purpose: 'Laxative', reason: 'Constipation from opioids', freq: '1-2 tabs at bedtime', intervalMin: 1440, category: 'stool-softener', warns: [], instructions: 'Can combine with docusate for best results.' },
  { id: 'omeprazole', name: 'Omeprazole', brand: 'Prilosec', dose: '20mg', perTab: 20, maxTabs: 1, unitLabel: 'mg', purpose: 'Stomach Protection', reason: 'Acid reflux or stomach protection', freq: '1 cap once daily before breakfast', intervalMin: 1440, category: 'gi', warns: [], instructions: 'Take 30 minutes before eating.' },
  // Other
  { id: 'prednisone', name: 'Prednisone', brand: '', dose: '10mg', perTab: 10, maxTabs: 1, unitLabel: 'mg', purpose: 'Anti-Inflammatory', reason: 'Reduce swelling', freq: 'Per taper schedule', intervalMin: 1440, category: 'steroid', warns: ['Do not stop abruptly — follow taper schedule', 'Take with food'], instructions: 'Follow your doctor\'s specific taper instructions.' },
  { id: 'lorazepam', name: 'Lorazepam', brand: 'Ativan', dose: '0.5mg', perTab: 0.5, maxTabs: 1, unitLabel: 'mg', purpose: 'Anti-Anxiety', reason: 'Anxiety or sleep', freq: '1 tab every 8 hrs as needed', intervalMin: 480, category: 'benzodiazepine', warns: ['Do not combine with opioids without doctor approval — respiratory depression risk', 'May cause drowsiness'], instructions: '' }
];

const AMANDA_WARNINGS = [
  { type: 'danger', title: 'No NSAIDs for 2 Weeks', text: 'No Ibuprofen, Advil, Aleve, Aspirin, or Celebrex' },
  { type: 'danger', title: 'Oxycodone + Valium Separation', text: 'Must wait at least 2 hours between these two medications — combined use increases respiratory depression risk' }
];

const AMANDA_RECOVERY_NOTES = [
  { minDay: 14, maxDay: Infinity, noteType: 'rn-success', text: 'Day {day} — Ask your surgeon about NSAID restrictions before taking Ibuprofen or Aspirin.' },
  { minDay: 7, maxDay: 13, noteType: 'rn-info', text: 'Day {day} — Check with your doctor about the Cephalexin course and any medication changes.' },
  { minDay: 7, maxDay: Infinity, noteType: 'rn-warn', text: 'Day {day} — If still using Oxycodone, contact your surgeon. Extended opioid use beyond one week post-surgery warrants clinical review.' },
  { minDay: 4, maxDay: 6, noteType: 'rn-info', text: 'Day {day} — Discuss pain management with your care team. Many patients transition to Tylenol-only by day 4-5.' },
  { minDay: 3, maxDay: 6, noteType: 'rn-info', text: 'Day {day} — Keep up with scheduled Cephalexin doses. Discuss pain management options with your care team.' },
  { minDay: 1, maxDay: 2, noteType: 'rn-warn', text: 'Day {day} — Peak swelling expected. Keep ahead of pain with scheduled meds. Report sudden increase in swelling, fever above 101.5°F, or uncontrolled bleeding to your surgeon.' },
  { minDay: 0, maxDay: 0, noteType: 'rn-warn', text: 'Day {day} — Surgery day. Ice and elevate as directed. Monitor the surgical site for expanding swelling or new bleeding. Drowsiness from anesthesia is normal.' },
  { minDay: 0, maxDay: 2, noteType: 'rn-info', text: 'Day {day} — Use Tylenol as your pain baseline. Oxycodone is for breakthrough pain that Tylenol alone doesn\'t control.' }
];

function cleanArray(values) {
  return Array.isArray(values)
    ? values.map(value => String(value || '').trim()).filter(Boolean)
    : [];
}

function normalizeTimeString(value) {
  return /^\d{2}:\d{2}$/.test(String(value || '').trim()) ? String(value).trim() : '';
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createEmptyProfile(overrides = {}) {
  return {
    ...DEFAULT_PROFILE,
    ...overrides,
    allergies: cleanArray(overrides.allergies ?? DEFAULT_PROFILE.allergies),
    conditions: cleanArray(overrides.conditions ?? DEFAULT_PROFILE.conditions)
  };
}

export function createDefaultMeta(overrides = {}) {
  return {
    ...DEFAULT_META,
    ...overrides
  };
}

export function createDefaultConfig(overrides = {}) {
  return normalizeConfig({
    schema: APP_SCHEMA,
    patientName: '',
    eventDate: null,
    eventLabel: '',
    meds: [],
    warnings: [],
    recoveryNotes: [],
    colorPalette: COLOR_PALETTE,
    profile: createEmptyProfile(),
    ...overrides
  });
}

export function buildAmandaConfig() {
  return normalizeConfig({
    patientName: '',
    eventDate: null,
    eventLabel: 'Surgery',
    meds: deepClone(AMANDA_MEDS),
    warnings: deepClone(AMANDA_WARNINGS),
    recoveryNotes: deepClone(AMANDA_RECOVERY_NOTES),
    profile: createEmptyProfile({
      careLabel: 'Post-op recovery',
      importantInstructions: 'Keep the tracker current so caregivers can trust the next step.'
    })
  });
}

export function createDailyRoutineConfig() {
  return createDefaultConfig({
    meds: [
      normalizeMed({
        id: 'morning-vitamin',
        name: 'Morning Vitamin',
        dose: '1 tablet',
        perTab: 0,
        maxTabs: 1,
        purpose: 'Daily routine',
        reason: 'Daily maintenance',
        freq: '1 tablet every morning',
        intervalMin: 1440,
        color: COLOR_PALETTE[6],
        bgBadge: '#def7f1',
        scheduled: true,
        scheduleType: 'scheduled',
        scheduledTimes: ['08:00'],
        isPrn: false,
        instructions: 'Take with breakfast.'
      }),
      normalizeMed({
        id: 'evening-med',
        name: 'Evening Medication',
        dose: '1 tablet',
        perTab: 0,
        maxTabs: 1,
        purpose: 'Daily routine',
        reason: 'Nightly dose',
        freq: '1 tablet every evening',
        intervalMin: 1440,
        color: COLOR_PALETTE[3],
        bgBadge: '#e8f0fb',
        scheduled: true,
        scheduleType: 'scheduled',
        scheduledTimes: ['20:00'],
        isPrn: false,
        instructions: 'Take after dinner.'
      })
    ],
    warnings: [
      { type: 'warn', title: 'Bring this list to appointments', text: 'Keep prescriptions, OTC meds, and supplements current.' }
    ],
    profile: createEmptyProfile({ careLabel: 'Daily medication routine' })
  });
}

export function createCaregiverHandoffConfig() {
  return createDefaultConfig({
    warnings: [
      { type: 'warn', title: 'Shift handoff', text: 'Review the handoff summary before logging new doses.' }
    ],
    profile: createEmptyProfile({
      careLabel: 'Caregiver recovery handoff',
      importantInstructions: 'Document who logged each dose and any override reason.'
    })
  });
}

export function getTemplates() {
  return {
    'post-surgery': {
      label: 'Post-Surgery Recovery',
      description: 'Preset post-op meds, conflict warnings, and recovery notes.',
      buildConfig: () => buildAmandaConfig()
    },
    'daily-routine': {
      label: 'Daily Routine',
      description: 'Scheduled morning and evening medication tracking.',
      buildConfig: () => createDailyRoutineConfig()
    },
    'caregiver-handoff': {
      label: 'Caregiver Recovery Handoff',
      description: 'Blank handoff-friendly setup focused on caregivers and overrides.',
      buildConfig: () => createCaregiverHandoffConfig()
    },
    scratch: {
      label: 'Start from Scratch',
      description: 'Begin with an empty tracker and build your own list.',
      buildConfig: () => createDefaultConfig()
    },
    restore: {
      label: 'Restore from Backup',
      description: 'Import a previously exported full backup file or code.',
      buildConfig: () => createDefaultConfig()
    }
  };
}

export function normalizeProfile(profile = {}) {
  return createEmptyProfile(profile);
}

export function normalizeMed(med = {}) {
  const scheduledTimes = cleanArray(med.scheduledTimes).map(normalizeTimeString).filter(Boolean);
  const scheduleType = med.scheduleType || (med.scheduled ? 'scheduled' : 'prn');
  const archived = Boolean(med.archived);
  const warns = cleanArray(med.warns).filter(warning => !(String(med.id || '').trim() === 'oxycodone' && warning === INCORRECT_OXY_WARNING));
  return {
    id: String(med.id || `med-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, ''),
    name: String(med.name || '').trim(),
    brand: String(med.brand || '').trim(),
    dose: String(med.dose || '').trim(),
    unitLabel: String(med.unitLabel || 'mg').trim(),
    perTab: Number.isFinite(Number(med.perTab)) ? Number(med.perTab) : 0,
    maxTabs: Math.max(1, Number.isFinite(Number(med.maxTabs)) ? Number(med.maxTabs) : 1),
    purpose: String(med.purpose || '').trim(),
    reason: String(med.reason || '').trim(),
    freq: String(med.freq || '').trim(),
    intervalMin: Math.max(1, Number.isFinite(Number(med.intervalMin)) ? Number(med.intervalMin) : 240),
    color: sanitizeImportedColor(med.color, COLOR_PALETTE[0]),
    bgBadge: sanitizeImportedColor(med.bgBadge, '#f0f0f0'),
    scheduled: scheduleType === 'scheduled',
    scheduleType,
    scheduledTimes,
    isPrn: scheduleType !== 'scheduled',
    instructions: String(med.instructions || '').trim(),
    warns,
    category: String(med.category || '').trim(),
    pairedWith: med.pairedWith ? String(med.pairedWith) : '',
    conflictsWith: med.conflictsWith ? String(med.conflictsWith) : '',
    conflictMin: Number.isFinite(Number(med.conflictMin)) ? Number(med.conflictMin) : 60,
    maxDoses: Number.isFinite(Number(med.maxDoses)) && Number(med.maxDoses) > 0 ? Number(med.maxDoses) : 0,
    trackTotal: Boolean(med.trackTotal),
    maxDaily: Number.isFinite(Number(med.maxDaily)) && Number(med.maxDaily) > 0 ? Number(med.maxDaily) : 0,
    startDate: String(med.startDate || '').trim(),
    endDate: String(med.endDate || '').trim(),
    supplyOnHand: Number.isFinite(Number(med.supplyOnHand)) ? Number(med.supplyOnHand) : 0,
    refillThreshold: Number.isFinite(Number(med.refillThreshold)) ? Number(med.refillThreshold) : 0,
    supplyLabel: String(med.supplyLabel || 'units').trim() || 'units',
    archived,
    pinned: Boolean(med.pinned),
    apapPerTab: Number.isFinite(Number(med.apapPerTab)) ? Number(med.apapPerTab) : 0,
    prescriber: String(med.prescriber || '').trim(),
    pharmacy: String(med.pharmacy || '').trim()
  };
}

export function isMedActiveOnDate(med, dateValue = new Date()) {
  const normalized = normalizeMed(med);
  if (normalized.archived) return false;
  const reference = new Date(dateValue || Date.now());
  const dayKey = `${reference.getFullYear()}-${String(reference.getMonth() + 1).padStart(2, '0')}-${String(reference.getDate()).padStart(2, '0')}`;
  if (normalized.startDate && dayKey < normalized.startDate) return false;
  if (normalized.endDate && dayKey > normalized.endDate) return false;
  return true;
}

export function normalizeConfig(config = {}) {
  return {
    schema: APP_SCHEMA,
    patientName: String(config.patientName || '').trim(),
    eventDate: config.eventDate || null,
    eventLabel: String(config.eventLabel || '').trim(),
    meds: Array.isArray(config.meds) ? config.meds.map(normalizeMed) : [],
    warnings: Array.isArray(config.warnings)
      ? config.warnings.map(warning => ({
          type: warning.type === 'danger' ? 'danger' : 'warn',
          title: String(warning.title || '').trim(),
          text: String(warning.text || '').trim()
        })).filter(warning => warning.title && warning.text)
      : [],
    recoveryNotes: Array.isArray(config.recoveryNotes)
      ? config.recoveryNotes.map(note => ({
          minDay: Number.isFinite(Number(note.minDay)) ? Number(note.minDay) : 0,
          maxDay: (note.maxDay == null || note.maxDay === Infinity || note.maxDay >= 99999) ? Infinity : (Number.isFinite(Number(note.maxDay)) ? Number(note.maxDay) : Infinity),
          noteType: String(note.noteType || 'rn-info'),
          text: String(note.text || '').trim()
        })).filter(note => note.text)
      : [],
    colorPalette: Array.isArray(config.colorPalette) && config.colorPalette.length ? [...config.colorPalette] : [...COLOR_PALETTE],
    scheduleTimezone: config.scheduleTimezone || (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '') || '',
    profile: normalizeProfile(config.profile || {})
  };
}

export function normalizeDose(dose = {}) {
  const time = new Date(dose.time || Date.now());
  const actionType = String(dose.actionType || 'dose').trim() || 'dose';
  const rawTabs = Number.isFinite(Number(dose.tabs)) ? Number(dose.tabs) : (actionType === 'skip' ? 0 : 1);
  const tabs = actionType === 'skip' ? 0 : Math.max(1, rawTabs);
  const mg = Number.isFinite(Number(dose.mg)) ? Number(dose.mg) : 0;
  return {
    id: Number.isFinite(Number(dose.id)) ? Number(dose.id) : Date.now(),
    medId: String(dose.medId || '').trim(),
    time: time.toISOString(),
    actionType,
    tabs,
    mg,
    note: String(dose.note || '').trim(),
    loggedBy: String(dose.loggedBy || '').trim(),
    overrideType: String(dose.overrideType || '').trim(),
    overrideReason: String(dose.overrideReason || '').trim(),
    symptomNote: String(dose.symptomNote || '').trim(),
    scheduledFor: dose.scheduledFor ? new Date(dose.scheduledFor).toISOString() : ''
  };
}

export function normalizeState(state = {}) {
  const doses = Array.isArray(state.doses) ? state.doses.map(normalizeDose).filter(dose => dose.medId) : [];
  const nextId = Number.isFinite(Number(state.nextId))
    ? Number(state.nextId)
    : (doses.reduce((highest, dose) => Math.max(highest, dose.id), 0) + 1);
  return {
    schema: APP_SCHEMA,
    doses,
    nextId,
    lastAction: state.lastAction || null
  };
}

export function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return false;
  if (!bundle.config || !bundle.state) return false;
  try {
    normalizeConfig(bundle.config);
    normalizeState(bundle.state);
    return true;
  } catch (error) {
    return false;
  }
}

export function migrateLegacyBundle(configLike, stateLike) {
  const fallbackConfig = configLike ? normalizeConfig(configLike) : createDefaultConfig();
  const legacyState = normalizeState(stateLike || {});
  return {
    config: fallbackConfig,
    state: legacyState,
    meta: createDefaultMeta({ lastWriteReason: 'migration' })
  };
}

export function buildBackupEnvelope({ config, state, meta }, sourceOrigin = (typeof location !== 'undefined' ? location.origin : 'local')) {
  return {
    kind: 'medtracker-backup-v1',
    schema: BACKUP_SCHEMA,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    sourceOrigin,
    config: normalizeConfig(config),
    state: normalizeState(state),
    meta: createDefaultMeta(meta || {})
  };
}

export function parseBackupEnvelope(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || parsed.kind !== 'medtracker-backup-v1') {
    throw new Error('Invalid Med Tracker backup');
  }
  return {
    envelope: {
      ...parsed,
      config: normalizeConfig(parsed.config),
      state: normalizeState(parsed.state),
      meta: createDefaultMeta(parsed.meta || {})
    },
    bundle: {
      config: normalizeConfig(parsed.config),
      state: normalizeState(parsed.state),
      meta: createDefaultMeta(parsed.meta || {})
    }
  };
}

export function summarizeBundle({ config, state, meta }) {
  const activeMeds = normalizeConfig(config).meds.filter(med => !med.archived);
  const doses = normalizeState(state).doses;
  return {
    patientName: config?.patientName || '',
    medicationCount: activeMeds.length,
    doseCount: doses.length,
    lastDoseAt: doses.length ? doses.slice().sort((a, b) => new Date(b.time) - new Date(a.time))[0].time : null,
    careLabel: config?.profile?.careLabel || '',
    version: meta?.version || APP_VERSION
  };
}

export function buildSupportPayload(bundle, storageHealth, errors = []) {
  return {
    kind: 'medtracker-support-v1',
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'node',
    storageHealth,
    summary: summarizeBundle(bundle),
    config: normalizeConfig(bundle.config),
    state: normalizeState(bundle.state),
    recentErrors: Array.isArray(errors) ? errors.slice(-20) : []
  };
}

export function sanitizeImportedColor(value, fallback = '#999') {
  const candidate = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(candidate)) return candidate;
  if (/^var\(--[a-zA-Z0-9_-]+\)$/.test(candidate)) return candidate;
  if (/^[a-zA-Z]+$/.test(candidate)) return candidate;
  return fallback;
}

export function encodeSetupPayload(value) {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function decodeSetupPayload(raw) {
  const binary = atob(String(raw || '').trim());
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function dosesForMed(state, medId) {
  return normalizeState(state).doses
    .filter(dose => dose.medId === medId)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}

export function getCurrentSupply(med, state) {
  const normalizedMed = normalizeMed(med);
  if (!normalizedMed.supplyOnHand) return null;
  const used = dosesForMed(state, normalizedMed.id).reduce((total, dose) => total + dose.tabs, 0);
  return Math.max(0, normalizedMed.supplyOnHand - used);
}

export function getCommonMeds() {
  return JSON.parse(JSON.stringify(COMMON_MEDS));
}

export function isDuplicateDose(state, medId, tabs, time) {
  const targetTime = new Date(time || Date.now());
  // Flag ANY dose of the same medication within the window, regardless of tab count.
  // A groggy patient logging 1 tab then 2 tabs is still a near-miss double-dose.
  return dosesForMed(state, medId).some(dose => {
    if (dose.actionType && dose.actionType !== 'dose') return false;
    const minutes = Math.abs(targetTime - new Date(dose.time)) / 60000;
    return minutes <= DUPLICATE_WINDOW_MIN;
  });
}
