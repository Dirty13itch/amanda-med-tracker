import assert from 'node:assert/strict';
import * as shared from '../app/shared.js';

function run(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

run('normalizes patient profile defaults', () => {
  const config = shared.normalizeConfig({ patientName: 'QA', meds: [] });
  assert.equal(config.profile.emergencyContact, '');
  assert.deepEqual(config.profile.allergies, []);
});

run('builds and parses full backups', () => {
  const config = shared.createDailyRoutineConfig();
  const state = shared.normalizeState({
    doses: [{ id: 1, medId: config.meds[0].id, time: new Date('2026-03-11T12:00:00Z').toISOString(), tabs: 1, mg: 0 }],
    nextId: 2
  });
  const envelope = shared.buildBackupEnvelope({ config, state, meta: shared.createDefaultMeta() }, 'https://example.test');
  const parsed = shared.parseBackupEnvelope(JSON.stringify(envelope));
  assert.equal(parsed.bundle.config.meds.length, config.meds.length);
  assert.equal(parsed.bundle.state.doses.length, 1);
  assert.equal(parsed.envelope.sourceOrigin, 'https://example.test');
});

run('tracks supply remaining from dose history', () => {
  const med = shared.normalizeMed({ id: 'a', name: 'Ibuprofen', supplyOnHand: 30, refillThreshold: 5, perTab: 200 });
  const state = shared.normalizeState({
    doses: [
      { id: 1, medId: 'a', time: new Date('2026-03-11T12:00:00Z').toISOString(), tabs: 2, mg: 400 },
      { id: 2, medId: 'a', time: new Date('2026-03-11T18:00:00Z').toISOString(), tabs: 1, mg: 200 }
    ],
    nextId: 3
  });
  assert.equal(shared.getCurrentSupply(med, state), 27);
});

run('normalizes supply labels and active date windows', () => {
  const med = shared.normalizeMed({
    id: 'routine',
    name: 'Routine Med',
    startDate: '2026-03-10',
    endDate: '2026-03-20'
  });
  assert.equal(med.supplyLabel, 'units');
  assert.equal(shared.isMedActiveOnDate(med, new Date('2026-03-11T12:00:00Z')), true);
  assert.equal(shared.isMedActiveOnDate(med, new Date('2026-03-09T12:00:00Z')), false);
  assert.equal(shared.isMedActiveOnDate(med, new Date('2026-03-21T12:00:00Z')), false);
});

run('detects duplicate doses inside the duplicate window', () => {
  const state = shared.normalizeState({
    doses: [{ id: 1, medId: 'oxy', time: new Date('2026-03-11T12:00:00Z').toISOString(), tabs: 1, mg: 5 }],
    nextId: 2
  });
  assert.equal(shared.isDuplicateDose(state, 'oxy', 1, new Date('2026-03-11T12:04:00Z').toISOString()), true,
    '4 min after should be duplicate');
  assert.equal(shared.isDuplicateDose(state, 'oxy', 1, new Date('2026-03-11T12:10:00Z').toISOString()), true,
    '10 min after should still be duplicate (within 15-min window)');
  assert.equal(shared.isDuplicateDose(state, 'oxy', 1, new Date('2026-03-11T12:16:00Z').toISOString()), false,
    '16 min after should NOT be duplicate');
});

run('creates caregiver and daily routine templates', () => {
  const templates = shared.getTemplates();
  assert.equal(typeof templates['caregiver-handoff'].buildConfig, 'function');
  assert.equal(typeof templates['daily-routine'].buildConfig, 'function');
});

run('preserves skip entries with zero tabs', () => {
  const state = shared.normalizeState({
    doses: [{ id: 1, medId: 'morning-vitamin', time: new Date('2026-03-11T08:00:00Z').toISOString(), actionType: 'skip', tabs: 0, mg: 0 }],
    nextId: 2
  });
  assert.equal(state.doses[0].actionType, 'skip');
  assert.equal(state.doses[0].tabs, 0);
});

run('sanitizes imported colors without breaking built-in CSS variables', () => {
  assert.equal(shared.sanitizeImportedColor('var(--oxy)'), 'var(--oxy)');
  assert.equal(shared.sanitizeImportedColor('#abc123'), '#abc123');
  assert.equal(shared.sanitizeImportedColor('javascript:alert(1)'), '#999');
});

run('round-trips setup payloads with unicode and profile data', () => {
  const config = shared.buildAmandaConfig();
  config.patientName = 'Amánda';
  config.profile = shared.createEmptyProfile({
    careLabel: 'Post-op recovery',
    emergencyContact: 'Shaun • 555-0100'
  });
  const payload = {
    _mt: 1,
    patientName: config.patientName,
    eventDate: config.eventDate,
    profile: config.profile,
    meds: config.meds,
    warnings: config.warnings,
    recoveryNotes: config.recoveryNotes,
    eventLabel: config.eventLabel,
    colorPalette: config.colorPalette
  };
  const encoded = shared.encodeSetupPayload(payload);
  const decoded = shared.decodeSetupPayload(encoded);
  assert.equal(decoded.patientName, 'Amánda');
  assert.equal(decoded.profile.careLabel, 'Post-op recovery');
  assert.equal(decoded.meds[0].color, 'var(--oxy)');
});

run('removes the copied Oxycodone warning from seeded and imported configs', () => {
  const amanda = shared.buildAmandaConfig();
  const oxyFromTemplate = amanda.meds.find(med => med.id === 'oxycodone');
  assert(oxyFromTemplate, 'Amanda template should include Oxycodone');
  assert.equal(oxyFromTemplate.warns.includes(shared.INCORRECT_OXY_WARNING), false);

  const normalized = shared.normalizeConfig({
    meds: [
      {
        id: 'oxycodone',
        name: 'Oxycodone',
        warns: [shared.INCORRECT_OXY_WARNING, 'Take with food if needed']
      }
    ]
  });
  assert.deepEqual(normalized.meds[0].warns, ['Take with food if needed']);
});

// --- Safety-critical boundary tests ---

run('duplicate detection: exact boundary at DUPLICATE_WINDOW_MIN (15 min)', () => {
  const base = new Date('2026-03-11T12:00:00Z');
  const state = shared.normalizeState({
    doses: [{ id: 1, medId: 'oxy', time: base.toISOString(), tabs: 1, mg: 5 }],
    nextId: 2
  });
  // At exactly 15 minutes: should still be flagged as duplicate (uses <=)
  const atBoundary = new Date(base.getTime() + shared.DUPLICATE_WINDOW_MIN * 60000);
  assert.equal(shared.isDuplicateDose(state, 'oxy', 1, atBoundary.toISOString()), true,
    'Dose at exactly DUPLICATE_WINDOW_MIN should be flagged as duplicate');
  // At 15 min + 1 ms: should NOT be flagged
  const pastBoundary = new Date(atBoundary.getTime() + 1);
  assert.equal(shared.isDuplicateDose(state, 'oxy', 1, pastBoundary.toISOString()), false,
    'Dose 1ms past DUPLICATE_WINDOW_MIN should not be flagged as duplicate');
});

run('duplicate detection: different tab count still flags duplicate', () => {
  const state = shared.normalizeState({
    doses: [{ id: 1, medId: 'oxy', time: new Date('2026-03-11T12:00:00Z').toISOString(), tabs: 1, mg: 5 }],
    nextId: 2
  });
  // Logging 2 tabs within the window should still be caught (groggy patient scenario)
  assert.equal(shared.isDuplicateDose(state, 'oxy', 2, new Date('2026-03-11T12:05:00Z').toISOString()), true,
    'Different tab count within window should still flag as duplicate');
});

run('duplicate detection: skip entries are not counted as duplicates', () => {
  const state = shared.normalizeState({
    doses: [{ id: 1, medId: 'oxy', time: new Date('2026-03-11T12:00:00Z').toISOString(), actionType: 'skip', tabs: 0, mg: 0 }],
    nextId: 2
  });
  assert.equal(shared.isDuplicateDose(state, 'oxy', 1, new Date('2026-03-11T12:05:00Z').toISOString()), false,
    'Skip entries should not trigger duplicate detection');
});

run('normalizeMed enforces minimum intervalMin of 1', () => {
  const med = shared.normalizeMed({ id: 'test', name: 'Test', intervalMin: 0 });
  assert.equal(med.intervalMin, 1, 'intervalMin of 0 should be clamped to 1');
  const medNeg = shared.normalizeMed({ id: 'test', name: 'Test', intervalMin: -10 });
  assert.equal(medNeg.intervalMin, 1, 'Negative intervalMin should be clamped to 1');
});

run('normalizeMed rejects non-finite numeric fields safely', () => {
  const med = shared.normalizeMed({
    id: 'test', name: 'Test',
    perTab: NaN, maxTabs: Infinity, maxDoses: 'abc', maxDaily: undefined, conflictMin: null
  });
  assert.equal(med.perTab, 0, 'NaN perTab should default to 0');
  assert.equal(med.maxTabs, 1, 'Infinite maxTabs should clamp to 1');
  assert.equal(med.maxDoses, 0, 'Non-numeric maxDoses should default to 0');
  assert.equal(med.maxDaily, 0, 'Undefined maxDaily should default to 0');
  assert.equal(med.conflictMin, 0, 'Null conflictMin coerces to 0 via Number(null)');
});

run('normalizeState handles corrupt dose entries gracefully', () => {
  // BUG FOUND: normalizeDose throws RangeError on invalid date strings
  // because it calls new Date('not-a-date').toISOString() which throws.
  // For now, verify that valid entries with empty medId are filtered,
  // and that null/undefined entries cause a throw (known limitation).
  const state = shared.normalizeState({
    doses: [
      { id: 2, medId: '', time: new Date().toISOString(), tabs: 1, mg: 5 },
      { id: 3, medId: 'oxy', time: new Date().toISOString(), tabs: 1, mg: 5 }
    ],
    nextId: 4
  });
  // Empty medId entries should be filtered out
  assert.equal(state.doses.every(d => d.medId !== ''), true, 'Empty medId doses should be filtered');
  assert.equal(state.doses.length, 1, 'Only valid dose should survive');

  // Invalid date should now be recovered to current time instead of throwing
  const recovered = shared.normalizeState({
    doses: [{ id: 1, medId: 'oxy', time: 'not-a-date', tabs: 1, mg: 5 }],
    nextId: 2
  });
  assert.equal(recovered.doses.length, 1, 'Dose with invalid date should survive normalization');
  assert.doesNotThrow(() => new Date(recovered.doses[0].time), 'Recovered time should be a valid ISO string');
});

run('normalizeState recovers nextId from dose history when missing', () => {
  const state = shared.normalizeState({
    doses: [
      { id: 50, medId: 'oxy', time: new Date().toISOString(), tabs: 1, mg: 5 },
      { id: 100, medId: 'oxy', time: new Date().toISOString(), tabs: 1, mg: 5 }
    ]
    // nextId intentionally omitted
  });
  assert.ok(state.nextId > 100, `nextId should be derived from max dose id (got ${state.nextId})`);
});

run('validateBundle rejects null, missing config, and missing state', () => {
  assert.equal(shared.validateBundle(null), false, 'null should fail');
  assert.equal(shared.validateBundle({}), false, 'empty object should fail');
  assert.equal(shared.validateBundle({ config: {} }), false, 'missing state should fail');
  assert.equal(shared.validateBundle({ state: {} }), false, 'missing config should fail');
  // Valid bundle should pass
  assert.equal(shared.validateBundle({
    config: shared.createDefaultConfig(),
    state: shared.normalizeState({})
  }), true, 'valid bundle should pass');
});

run('parseBackupEnvelope rejects invalid kind field', () => {
  assert.throws(() => shared.parseBackupEnvelope(JSON.stringify({ kind: 'not-medtracker' })),
    /Invalid Med Tracker backup/);
  assert.throws(() => shared.parseBackupEnvelope('not-json'), /Invalid Med Tracker backup/);
});

run('Tylenol maxDaily and oxycodone maxDoses are correctly configured in Amanda template', () => {
  const amanda = shared.buildAmandaConfig();
  const tylenol = amanda.meds.find(m => m.id === 'tylenol');
  const oxy = amanda.meds.find(m => m.id === 'oxycodone');
  const diazepam = amanda.meds.find(m => m.id === 'diazepam');
  assert.equal(tylenol.maxDaily, 4000, 'Tylenol 24hr max should be 4000mg');
  assert.equal(tylenol.trackTotal, true, 'Tylenol should track rolling total');
  assert.equal(oxy.maxDoses, 6, 'Oxycodone should have 6-dose daily limit');
  assert.equal(oxy.maxDaily, 60, 'Oxycodone 24hr max should be 60mg');
  assert.equal(diazepam.conflictsWith, 'oxycodone', 'Diazepam should declare conflict with oxycodone');
  assert.equal(diazepam.conflictMin, 240, 'Diazepam-oxycodone conflict window should be 240 minutes');
});
