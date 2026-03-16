import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from './serve-static.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'output', 'playwright');
const headed = process.argv.includes('--headed');
const providedBaseUrl = process.env.MEDTRACKER_BASE_URL || '';
const liveMode = Boolean(providedBaseUrl);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getLayoutIssues(page) {
  return page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const docWidth = document.documentElement.scrollWidth;
    const candidates = [document.body, ...document.body.querySelectorAll('*')];
    const issues = [];
    const textishTags = new Set(['BUTTON', 'A', 'SPAN', 'P', 'LABEL', 'STRONG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

    const describe = el => {
      const id = el.id ? `#${el.id}` : '';
      const className = typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
        : '';
      const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return `${el.tagName.toLowerCase()}${id}${className}${text ? ` "${text}"` : ''}`;
    };

    const isVisible = el => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left < -1 || rect.right > viewportWidth + 1) {
        issues.push({
          type: 'viewport-overflow',
          node: describe(el),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        });
        continue;
      }

      const style = getComputedStyle(el);
      const leafText = textishTags.has(el.tagName) && el.children.length === 0;
      const contentOverflow = leafText
        && el.clientWidth > 0
        && el.scrollWidth > el.clientWidth + 4
        && style.whiteSpace !== 'normal'
        && style.overflowX === 'visible';
      if (contentOverflow) {
        issues.push({
          type: 'content-overflow',
          node: describe(el),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth
        });
      }
    }

    return {
      viewportWidth,
      docWidth,
      issues: issues.slice(0, 20)
    };
  });
}

async function assertHealthyLayout(page, label) {
  const metrics = await getLayoutIssues(page);
  assert(metrics.docWidth <= metrics.viewportWidth + 1, `${label} should not overflow horizontally (viewport ${metrics.viewportWidth}, scrollWidth ${metrics.docWidth})`);
  assert(metrics.issues.length === 0, `${label} layout issues:\n${metrics.issues.map(issue => {
    if (issue.type === 'viewport-overflow') {
      return `- ${issue.node} extends outside viewport (${issue.left}..${issue.right}, width ${issue.width})`;
    }
    return `- ${issue.node} content overflows its box (${issue.clientWidth}px client / ${issue.scrollWidth}px scroll)`;
  }).join('\n')}`);
}

async function waitForVisible(page, selector, timeout = 15000) {
  await page.waitForSelector(selector, { state: 'visible', timeout });
}

function medicationCard(page, medName) {
  return page.getByLabel(`${medName} medication card`);
}

async function attachErrorTracking(page, errors) {
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', msg => {
    if (liveMode && /Service Worker registration blocked by Playwright/i.test(msg.text())) {
      return;
    }
    if (msg.type() === 'error' || msg.type() === 'warning') {
      errors.push(`console:${msg.type()}: ${msg.text()}`);
    }
  });
}

async function newHarness(browser, name, viewport) {
  const downloadsPath = path.join(outputDir, name, 'downloads');
  await mkdir(downloadsPath, { recursive: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport,
    serviceWorkers: liveMode ? 'block' : 'allow'
  });
  await context.addInitScript(() => {
    if (window.localStorage.getItem('medtracker-bedside') === null) {
      window.localStorage.setItem('medtracker-bedside', '0');
    }
  });
  const page = await context.newPage();
  const errors = [];
  await attachErrorTracking(page, errors);
  return { context, page, errors, downloadsPath };
}

async function saveDownload(download, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const filename = download.suggestedFilename();
  const target = path.join(targetDir, filename);
  await download.saveAs(target);
  return target;
}

async function openSettings(page) {
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.locator('#settings-panel .settings-close').waitFor({ state: 'visible', timeout: 15000 });
}

async function closeSettings(page) {
  await page.locator('#settings-panel .settings-close').click();
}

async function commitFieldChange(page, selector, value) {
  await page.locator(selector).evaluate((el, nextValue) => {
    el.value = nextValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function completeOnboardingSteps(page) {
  // Checklist step: click "I'm Ready" or "Skip for Now"
  const checklistBtn = page.locator('.welcome-checklist').locator('..').locator('button').first();
  if (await checklistBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await checklistBtn.click();
  }
  // Review step: click "Looks Good" for each med
  for (let i = 0; i < 10; i++) {
    const looksGood = page.locator('.review-btn-confirm');
    if (await looksGood.isVisible({ timeout: 2000 }).catch(() => false)) {
      await looksGood.click();
    } else break;
  }
  // Review done: click "Done — Let's Go"
  const reviewDone = page.locator('.review-done .welcome-btn-secondary');
  if (await reviewDone.isVisible({ timeout: 2000 }).catch(() => false)) {
    await reviewDone.click();
  }
}

async function startPostSurgery(page, baseUrl, name = 'QA') {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForVisible(page, 'text=Welcome to Med Tracker');
  await page.getByPlaceholder('Your name (optional)').fill(name);
  await page.getByRole('button', { name: 'Get Started' }).click();
  await waitForVisible(page, 'text=Choose a Starting Point');
  await page.locator('.welcome-tpl').filter({ hasText: 'Post-Surgery Recovery' }).click();
  // New onboarding: click through checklist + review steps
  await completeOnboardingSteps(page);
  await medicationCard(page, 'Oxycodone').waitFor({ state: 'visible', timeout: 15000 });
}

async function startScratch(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  assert(await page.locator('text=Update available').count() === 0, 'First load should not show update banner');
  await waitForVisible(page, 'text=Welcome to Med Tracker');
  await page.getByPlaceholder('Your name (optional)').fill('QA');
  await page.getByRole('button', { name: 'Get Started' }).click();
  await waitForVisible(page, 'text=Choose a Starting Point');
  await page.locator('.welcome-tpl').filter({ hasText: 'Start from Scratch' }).click();
  // New onboarding: click through checklist (no meds = auto-closes after checklist)
  await completeOnboardingSteps(page);
  await waitForVisible(page, 'text=QA\'s Med Tracker');
}

async function addScratchMedication(page) {
  await openSettings(page);
  await page.locator('#settings-panel').getByRole('button', { name: '+ Add Medication' }).click();
  // Quick-Add picker now shows first — click "Custom medication" to get blank form
  const customBtn = page.locator('.quick-add-custom');
  if (await customBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await customBtn.click();
  }
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await waitForVisible(page, 'text=Name is required');

  await page.getByPlaceholder('e.g. Ibuprofen').fill('Ibuprofen');
  await page.getByPlaceholder('e.g. Advil').fill('Advil');
  await page.getByPlaceholder('e.g. 200mg tabs').fill('200mg tablets');
  await page.locator('#mf-perTab').fill('200');
  await page.locator('#mf-maxTabs').fill('2');
  await page.getByPlaceholder('e.g. Pain Relief').fill('Pain relief');
  await page.getByPlaceholder('e.g. 1-2 tabs every 4 hours').fill('1-2 tablets every 4 hours');
  await page.getByRole('button', { name: 'Advanced Options' }).click();
  await page.locator('#mf-maxDoses').fill('4');
  await page.locator('#mf-trackTotal').selectOption('1');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await waitForVisible(page, 'text=Daily max required when tracking totals');
  await page.getByPlaceholder('e.g. 4000').fill('2400');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#settings-panel').getByText('Ibuprofen').waitFor({ state: 'visible', timeout: 15000 });
}

async function runScratchScenario(browser, baseUrl) {
  const { context, page, errors, downloadsPath } = await newHarness(browser, 'scratch', { width: 390, height: 844 });
  let latestBackupPath = '';
  try {
    await startScratch(page, baseUrl);
    await addScratchMedication(page);
    await assertHealthyLayout(page, 'Scratch mobile layout');
    await page.locator('#settings-panel').getByRole('button', { name: '+ Add Warning' }).click();
    await page.getByPlaceholder('e.g. No NSAIDs for 2 weeks').fill('No grapefruit');
    await page.getByPlaceholder('Explain the warning or instruction').fill('Avoid grapefruit while this medication schedule is active.');
    await page.locator('#warning-type').selectOption('danger');
    await page.getByRole('button', { name: 'Save Warning' }).click();
    await page.locator('.med-list-item', { hasText: 'No grapefruit' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.med-list-item', { hasText: 'No grapefruit' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Remove Warning' }).click();
    await page.locator('.med-list-item', { hasText: 'No grapefruit' }).waitFor({ state: 'hidden', timeout: 15000 });

    await closeSettings(page);
    const bedsideToggle = page.getByRole('switch', { name: 'Toggle bedside night mode' });
    const initialBedside = (await bedsideToggle.getAttribute('aria-checked')) === 'true';
    await bedsideToggle.click();
    const toggledBedside = !initialBedside;
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert((await page.locator('body.bedside').count() === 1) === toggledBedside, 'Bedside mode should persist after reload');
    if (await page.locator('body.bedside').count() === 1) {
      await page.getByRole('switch', { name: 'Toggle bedside night mode' }).click();
    }

    await openSettings(page);
    await page.locator('#settings-panel').getByText('Ibuprofen').first().click();
    await waitForVisible(page, 'text=Edit Medication');
    await page.getByPlaceholder('e.g. Advil').fill('Advil PM');
    await page.getByRole('button', { name: 'Save' }).click();
    await closeSettings(page);
    await waitForVisible(page, 'text=Advil PM');

    await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Log Dose' }).click({ force: true });
    await page.getByRole('button', { name: /2 tabs 400mg/ }).click();
    await page.getByRole('button', { name: '30m ago' }).click();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: /^Log/ }).click({ force: true });
    await waitForVisible(page, 'text=Available in');
    await waitForVisible(page, 'text=24hr total: 400mg');

    await page.getByRole('button', { name: /Remove Ibuprofen dose at/ }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await waitForVisible(page, 'text=No doses logged yet');

    await openSettings(page);
    await page.getByRole('button', { name: 'Copy Setup' }).click();
    await waitForVisible(page, 'text=Setup copied to clipboard!');
    await page.getByRole('button', { name: 'Import Setup' }).click();
    await page.getByPlaceholder('Paste the setup code here...').fill('invalid');
    await waitForVisible(page, 'text=Invalid setup code');
    const setupCode = await page.evaluate(() => {
      const exportData = {
        _mt: 1,
        patientName: CONFIG.patientName || '',
        eventDate: CONFIG.eventDate || null,
        profile: CONFIG.profile || {},
        meds: CONFIG.meds,
        warnings: CONFIG.warnings,
        recoveryNotes: CONFIG.recoveryNotes,
        eventLabel: CONFIG.eventLabel || '',
        colorPalette: CONFIG.colorPalette || COLOR_PALETTE
      };
      const json = JSON.stringify(exportData);
      const bytes = new TextEncoder().encode(json);
      let binary = '';
      bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary);
    });
    await page.getByPlaceholder('Paste the setup code here...').fill(setupCode);
    await waitForVisible(page, 'text=Apply This Setup');
    await page.getByRole('button', { name: 'Apply This Setup' }).click();
    await waitForVisible(page, 'text=Setup imported');

    const backupDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Backup' }).click();
    latestBackupPath = await saveDownload(await backupDownload, downloadsPath);

    const supportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Support Export' }).click();
    await saveDownload(await supportDownload, downloadsPath);
    await closeSettings(page);

    await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Log Dose' }).click({ force: true });
    await page.getByRole('button', { name: /1 tab 200mg/ }).click();
    await page.getByRole('button', { name: 'Just now' }).click();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: /^Log/ }).click({ force: true });
    await page.getByRole('button', { name: /Edit Ibuprofen entry at/ }).click();
    await page.locator('#edit-dose-note').fill('With food');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await waitForVisible(page, 'text=With food');

    await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Review Timing' }).click({ force: true });
    await page.getByRole('button', { name: /1 tab 200mg/ }).click();
    await page.getByRole('button', { name: /Other/ }).click();
    const retroTime = await page.evaluate(() => {
      const now = new Date();
      now.setHours(now.getHours() + 1);
      return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    });
    await page.locator('#ts-custom-time').fill(retroTime);
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: /^Log/ }).click({ force: true });
    const retroDose = await page.evaluate(() => {
      const doses = state.doses
        .filter(entry => entry.medId === 'ibuprofen')
        .slice()
        .sort((a, b) => new Date(a.time) - new Date(b.time));
      return doses[0];
    });
    assert(retroDose, 'Retroactive dose should be logged');
    assert(retroDose.overrideType === '', `Retroactive historical dose should not be marked as an early override (found ${retroDose.overrideType || 'none'})`);
    await page.getByRole('button', { name: /Edit Ibuprofen entry at/ }).nth(1).click();
    const olderEditTime = await page.evaluate(() => {
      const target = new Date();
      target.setDate(target.getDate() - 2);
      return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}T${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
    });
    await page.locator('#edit-dose-time').fill(olderEditTime);
    await page.getByRole('button', { name: 'Save Changes' }).click();
    const trackedNotes = await page.locator('.log-tracked-note').allInnerTexts();
    assert(trackedNotes.length >= 2, 'Expected tracked totals in the dose log');
    assert(trackedNotes.every(note => note.trim() === '24hr total: 200mg'), `Dose log should show rolling 24-hour totals, found: ${trackedNotes.join(' | ')}`);

    await openSettings(page);
    const refreshedBackupDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Backup' }).click();
    latestBackupPath = await saveDownload(await refreshedBackupDownload, downloadsPath);
    await closeSettings(page);

    const reminderDownload = page.waitForEvent('download');
    await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Set Reminder' }).click({ force: true });
    await saveDownload(await reminderDownload, downloadsPath);

    const logDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Log' }).click();
    await saveDownload(await logDownload, downloadsPath);

    await page.locator('.actions').getByRole('button', { name: 'Medication List' }).click();
    await page.getByRole('heading', { name: /medication list/i }).waitFor({ state: 'visible', timeout: 15000 });
    const medListDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    await saveDownload(await medListDownload, downloadsPath);
    await page.getByRole('button', { name: 'Close' }).click({ force: true });

    await page.getByRole('button', { name: 'Daily Review' }).click();
    await waitForVisible(page, 'text=Fast caregiver summary');
    await page.getByRole('button', { name: 'Close' }).click({ force: true });

    await page.getByRole('button', { name: 'Clear Dose History' }).click();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Clear Dose History' }).click();
    await waitForVisible(page, 'text=No doses logged yet');

    await openSettings(page);
    await page.getByRole('button', { name: 'Restore Backup' }).click();
    await page.setInputFiles('#backup-import-file', latestBackupPath);
    await page.locator('#backup-import-preview').getByRole('button', { name: 'Restore Backup' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('#backup-import-preview').getByRole('button', { name: 'Restore Backup' }).click();
    await closeSettings(page);
    await waitForVisible(page, 'text=With food');

    await page.getByRole('button', { name: 'Clear Dose History' }).click();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Clear Dose History' }).click();
    await waitForVisible(page, 'text=No doses logged yet');

    if (!liveMode) {
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise(resolve => {
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
          });
        }
        const warmResults = await Promise.all([
          fetch('/manifest.json').then(response => response.ok).catch(() => false),
          fetch('/icon.svg').then(response => response.ok).catch(() => false)
        ]);
        if (warmResults.some(result => !result)) {
          throw new Error('Failed to warm offline assets before switching offline');
        }
      });
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForVisible(page, 'text=QA\'s Med Tracker');
      const offlineAssetResults = await page.evaluate(async () => {
        return Promise.all([
          fetch('/manifest.json').then(response => response.ok).catch(() => false),
          fetch('/icon.svg').then(response => response.ok).catch(() => false)
        ]);
      });
      assert(offlineAssetResults.every(Boolean), 'Offline reload should serve cached manifest and icon');
      await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Log Dose' }).click({ force: true });
      await page.getByRole('button', { name: /1 tab 200mg/ }).click();
      await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: /^Log/ }).click({ force: true });
      await waitForVisible(page, 'text=24hr total: 200mg');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForVisible(page, 'text=24hr total: 200mg');
      await context.setOffline(false);
    }

    await openSettings(page);
    await page.locator('.med-list-item', { hasText: 'Ibuprofen' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete Medication' }).click();
    await closeSettings(page);
    await medicationCard(page, 'Ibuprofen').waitFor({ state: 'hidden', timeout: 15000 });

    assert(errors.length === 0, `Scratch scenario errors:\n${errors.join('\n')}`);
  } finally {
    await context.close();
  }
}

async function runPostSurgeryScenario(browser, baseUrl) {
  const { context, page, errors } = await newHarness(browser, 'post-surgery', { width: 390, height: 844 });
  try {
    await startPostSurgery(page, baseUrl);
    await assertHealthyLayout(page, 'Post-surgery mobile layout');

    await medicationCard(page, 'Oxycodone').getByRole('button', { name: 'Log Dose' }).click({ force: true });
    // Antiemetic pre-dose interstitial may appear first — dismiss it
    const antiemeticModal = page.locator('text=Take anti-nausea medication first?');
    if (await antiemeticModal.isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.getByRole('button', { name: /Skip.*Log.*Now/ }).click({ force: true });
      await page.waitForTimeout(500);
    }
    await waitForVisible(page, 'text=Also log Hydroxyzine');
    const pairedCheckbox = page.locator('[data-paired-med="hydroxyzine"]');
    assert((await pairedCheckbox.isChecked()) === false, 'Paired meds should be opt-in by default');
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: /^Log/ }).click({ force: true });
    await waitForVisible(page, 'text=1 of 6');
    const hydroTimerAfterSoloLog = await medicationCard(page, 'Hydroxyzine').locator('.card-timer').innerText();
    assert(/No doses logged yet/.test(hydroTimerAfterSoloLog), 'Hydroxyzine should not auto-log when the paired checkbox is left unchecked');

    await medicationCard(page, 'Oxycodone').getByRole('button', { name: 'Review Timing' }).click({ force: true });
    await waitForVisible(page, 'text=Also log Hydroxyzine');
    await pairedCheckbox.check({ force: true });
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: /^Log/ }).click({ force: true });
    if (await page.locator('text=Possible duplicate').count()) {
      // Wait for 5-second countdown to enable the button
      await page.waitForFunction(() => {
        const btn = document.getElementById('dup-confirm-btn');
        return btn && !btn.disabled;
      }, { timeout: 10000 });
      await page.locator('#dup-confirm-btn').click();
    }
    await waitForVisible(page, 'text=2 today');
    const hydroTimerAfterPairedLog = await medicationCard(page, 'Hydroxyzine').locator('.card-timer').innerText();
    assert(/Last:/.test(hydroTimerAfterPairedLog), 'Hydroxyzine should log only when the paired checkbox is selected');
    await waitForVisible(page, 'text=Available in');

    const diazepamStatus = await medicationCard(page, 'Diazepam').locator('.card-status').innerText();
    assert(/Wait/.test(diazepamStatus), 'Diazepam should show a wait state after Oxycodone');
    await medicationCard(page, 'Diazepam').getByRole('button', { name: 'Review Timing' }).click({ force: true });
    await waitForVisible(page, 'text=WARNING:');
    await waitForVisible(page, 'text=Override');
    await page.keyboard.press('Escape');

    await medicationCard(page, 'Tylenol').getByRole('button', { name: 'Log Dose' }).click({ force: true });
    await waitForVisible(page, 'text=24hr total so far: 0mg / 4000mg');
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: /^Log/ }).click();
    await waitForVisible(page, 'text=1000mg / 4000mg');

    await page.locator('.actions').getByRole('button', { name: 'Medication List' }).click();
    await page.getByRole('heading', { name: /medication list/i }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: 'Close' }).click({ force: true });

    await page.getByRole('button', { name: 'Daily Review' }).click();
    await waitForVisible(page, 'text=Fast caregiver summary');
    await page.getByRole('button', { name: 'Close' }).click({ force: true });

    await page.getByRole('button', { name: 'Clear Dose History' }).click();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Clear Dose History' }).click();
    await waitForVisible(page, 'text=No doses logged yet');

    assert(errors.length === 0, `Post-surgery scenario errors:\n${errors.join('\n')}`);
  } finally {
    await context.close();
  }
}

async function runMobileLayoutAudit(browser, baseUrl) {
  const viewports = [
    { name: 'android-360', width: 360, height: 780 },
    { name: 'iphone-390', width: 390, height: 844 },
    { name: 'android-412', width: 412, height: 915 }
  ];

  for (const viewport of viewports) {
    const { context, page, errors } = await newHarness(browser, `layout-${viewport.name}`, { width: viewport.width, height: viewport.height });
    try {
      await startPostSurgery(page, baseUrl, viewport.name);
      await assertHealthyLayout(page, `${viewport.name} home`);

      await page.locator('#warn-toggle-btn').click();
      await assertHealthyLayout(page, `${viewport.name} warnings expanded`);

      await page.locator('.actions').getByRole('button', { name: 'Medication List' }).click();
      await page.getByRole('heading', { name: /medication list/i }).waitFor({ state: 'visible', timeout: 15000 });
      await assertHealthyLayout(page, `${viewport.name} medication list modal`);
      await page.getByRole('button', { name: 'Close' }).click({ force: true });

      await page.getByRole('button', { name: 'Daily Review' }).click();
      await waitForVisible(page, 'text=Fast caregiver summary');
      await assertHealthyLayout(page, `${viewport.name} daily review modal`);
      await page.getByRole('button', { name: 'Close' }).click({ force: true });

      await medicationCard(page, 'Oxycodone').getByRole('button', { name: 'Log Dose' }).click({ force: true });
      // Antiemetic pre-dose interstitial may appear first — dismiss it
      const aeModal = page.locator('text=Take anti-nausea medication first?');
      if (await aeModal.isVisible({ timeout: 3000 }).catch(() => false)) {
        await page.getByRole('button', { name: /Skip.*Log.*Now/ }).click({ force: true });
        await page.waitForTimeout(500);
      }
      await waitForVisible(page, 'text=How many tablets?');
      await assertHealthyLayout(page, `${viewport.name} multi-tab modal`);
      await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: /^Log/ }).click({ force: true });

      await medicationCard(page, 'Diazepam').getByRole('button', { name: 'Review Timing' }).click({ force: true });
      await waitForVisible(page, 'text=WARNING:');
      await assertHealthyLayout(page, `${viewport.name} conflict modal`);
      await page.keyboard.press('Escape');

      await openSettings(page);
      await assertHealthyLayout(page, `${viewport.name} settings`);

      await commitFieldChange(page, '#cfg-name', 'Alexandria Catherine Montgomery-Rivera Recovery Tracker');
      await commitFieldChange(page, '#settings-panel input[placeholder="e.g. Post-op recovery"]', 'Post-operative max clarity caregiver handoff mode');
      await commitFieldChange(page, '#settings-panel input[placeholder="Name and phone"]', 'Shaun Montgomery-Rivera • 555-0100 ext 22');
      await assertHealthyLayout(page, `${viewport.name} settings with long patient text`);

      await page.locator('#settings-panel').getByRole('button', { name: '+ Add Warning' }).click();
      await page.locator('#warning-title').fill('Do not combine sedating medications with alcohol, sleep aids, or unapproved supplements');
      await page.locator('#warning-text').fill('If anything seems off, stop and verify the timing before logging another dose. Use the handoff summary to double-check the last action first.');
      await page.locator('#warning-type').selectOption('danger');
      await page.getByRole('button', { name: 'Save Warning' }).click();
      await assertHealthyLayout(page, `${viewport.name} settings with long warning`);

      await page.locator('#settings-panel').getByText('Oxycodone').first().click();
      await waitForVisible(page, 'text=Edit Medication');
      await assertHealthyLayout(page, `${viewport.name} medication form`);

      await page.locator('#mf-brand').fill('Immediate Release Tablet');
      await page.locator('#mf-purpose').fill('Breakthrough pain relief during overnight recovery');
      await page.locator('#mf-instructions').fill('Use only when the pain is not controlled and confirm the last logged sedating medication before taking.');
      await assertHealthyLayout(page, `${viewport.name} medication form with long content`);

      await page.locator('#settings-panel').getByRole('button', { name: 'Advanced Options' }).click();
      await assertHealthyLayout(page, `${viewport.name} medication form advanced`);

      await page.locator('#settings-panel .med-form').getByRole('button', { name: 'Save' }).click();
      await assertHealthyLayout(page, `${viewport.name} settings after long med save`);
      await closeSettings(page);

      const warningsExpanded = await page.locator('#warn-toggle-btn').getAttribute('aria-expanded');
      if (warningsExpanded !== 'true') {
        await page.locator('#warn-toggle-btn').click();
      }
      await assertHealthyLayout(page, `${viewport.name} home with long warning text`);
      await page.locator('#warn-toggle-btn').click();
      await assertHealthyLayout(page, `${viewport.name} home with long med content`);

      await page.getByRole('switch', { name: 'Toggle bedside night mode' }).click();
      await waitForVisible(page, 'text=Next Up');
      await assertHealthyLayout(page, `${viewport.name} bedside mode`);

      assert(errors.length === 0, `${viewport.name} layout audit errors:\n${errors.join('\n')}`);
    } finally {
      await context.close();
    }
  }
}

async function runDesktopSanity(browser, baseUrl) {
  const { context, page, errors } = await newHarness(browser, 'desktop', { width: 1280, height: 900 });
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForVisible(page, 'text=Welcome to Med Tracker');
    await page.getByRole('button', { name: 'Get Started' }).click();
    await waitForVisible(page, 'text=Choose a Starting Point');
    await page.locator('.welcome-tpl').filter({ hasText: 'Daily Routine' }).click();
    await completeOnboardingSteps(page);
    await medicationCard(page, 'Morning Vitamin').waitFor({ state: 'visible', timeout: 15000 });
    const morningStatus = await medicationCard(page, 'Morning Vitamin').locator('.card-status').innerText();
    assert(/due|overdue/i.test(morningStatus), 'Scheduled morning medication should show a due status');
    await page.locator('.actions').getByRole('button', { name: 'Medication List' }).click();
    await page.getByRole('heading', { name: /medication list/i }).waitFor({ state: 'visible', timeout: 15000 });
    await waitForVisible(page, 'text=Active medications');
    await page.getByRole('button', { name: 'Close' }).click({ force: true });

    await medicationCard(page, 'Morning Vitamin').getByRole('button', { name: /Log Dose|Review Timing/ }).click({ force: true });
    // Skip button only shows when the scheduled dose is actually due (time-dependent)
    const skipBtn = page.getByRole('button', { name: 'Skip This Dose' });
    if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipBtn.click();
      await waitForVisible(page, 'text=Skipped scheduled dose');
      await page.getByRole('button', { name: 'Daily Review' }).click();
      await waitForVisible(page, 'text=Skipped doses');
      await page.getByRole('button', { name: 'Close' }).click({ force: true });
    } else {
      // Dose not yet due — close the modal and continue
      await page.getByRole('button', { name: 'Cancel' }).click({ force: true });
    }
    await page.getByRole('button', { name: 'Open settings' }).waitFor({ state: 'visible', timeout: 15000 });

    await openSettings(page);
    await page.locator('.med-list-item', { hasText: 'Morning Vitamin' }).getByRole('button', { name: 'Archive' }).click();
    await closeSettings(page);
    await medicationCard(page, 'Morning Vitamin').waitFor({ state: 'hidden', timeout: 15000 });
    await page.locator('.actions').getByRole('button', { name: 'Medication List' }).click();
    await waitForVisible(page, 'text=Archived medications');
    await waitForVisible(page, 'text=Morning Vitamin');
    await page.getByRole('button', { name: 'Close' }).click({ force: true });

    assert(errors.length === 0, `Desktop scenario errors:\n${errors.join('\n')}`);
  } finally {
    await context.close();
  }
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const server = providedBaseUrl ? null : await startStaticServer({ root: rootDir, port: 4173 });
  const browser = await chromium.launch({ headless: !headed });
  try {
    const baseUrl = providedBaseUrl || server.baseUrl;
    await runScratchScenario(browser, baseUrl);
    await runPostSurgeryScenario(browser, baseUrl);
    await runMobileLayoutAudit(browser, baseUrl);
    await runDesktopSanity(browser, baseUrl);
    console.log('Smoke scenarios passed');
  } finally {
    await browser.close();
    if (server) await server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
