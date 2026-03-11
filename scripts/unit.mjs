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
  assert.equal(shared.isDuplicateDose(state, 'oxy', 1, new Date('2026-03-11T12:04:00Z').toISOString()), true);
  assert.equal(shared.isDuplicateDose(state, 'oxy', 1, new Date('2026-03-11T12:10:00Z').toISOString()), false);
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
