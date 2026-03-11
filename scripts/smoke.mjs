import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from './serve-static.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'output', 'playwright');
const headed = process.argv.includes('--headed');

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    serviceWorkers: 'allow'
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

async function startScratch(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  assert(await page.locator('text=Update available').count() === 0, 'First load should not show update banner');
  await waitForVisible(page, 'text=Welcome to Med Tracker');
  await page.getByPlaceholder('Your name (optional)').fill('QA');
  await page.getByRole('button', { name: 'Get Started' }).click();
  await page.getByText('Start from Scratch').click();
  await waitForVisible(page, 'text=QA\'s Med Tracker');
}

async function addScratchMedication(page) {
  await openSettings(page);
  await page.locator('#settings-panel').getByRole('button', { name: '+ Add Medication' }).click();
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
  try {
    await startScratch(page, baseUrl);
    await addScratchMedication(page);

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
    await page.locator('#settings-panel button[title="Edit"]').click();
    await waitForVisible(page, 'text=Edit Medication');
    await page.getByPlaceholder('e.g. Advil').fill('Advil PM');
    await page.getByRole('button', { name: 'Save' }).click();
    await closeSettings(page);
    await waitForVisible(page, 'text=Advil PM');

    await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Log Dose' }).click();
    await page.getByRole('button', { name: /2 tabs 400mg/ }).click();
    await page.getByRole('button', { name: '30m ago' }).click();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Log Dose' }).click();
    await waitForVisible(page, 'text=Available in');
    await waitForVisible(page, 'text=Running total: 400mg');

    await page.getByRole('button', { name: /Remove Ibuprofen dose at/ }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await waitForVisible(page, 'text=No doses logged yet');

    await openSettings(page);
    await page.locator('#settings-panel .btn-export').click();
    await waitForVisible(page, 'text=Setup copied to clipboard!');
    await page.locator('#settings-panel .btn-import').click();
    await page.getByPlaceholder('Paste the setup code here...').fill('invalid');
    await waitForVisible(page, 'text=Invalid setup code');
    const setupCode = await page.evaluate(() => {
      const exportData = {
        _mt: 1,
        meds: CONFIG.meds,
        warnings: CONFIG.warnings,
        recoveryNotes: CONFIG.recoveryNotes,
        eventLabel: CONFIG.eventLabel || '',
        colorPalette: CONFIG.colorPalette || COLOR_PALETTE
      };
      return btoa(unescape(encodeURIComponent(JSON.stringify(exportData))));
    });
    await page.getByPlaceholder('Paste the setup code here...').fill(setupCode);
    await waitForVisible(page, 'text=Apply This Setup');
    await page.getByRole('button', { name: 'Apply This Setup' }).click();
    await waitForVisible(page, 'text=Setup imported');
    await closeSettings(page);

    await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Log Dose' }).click();
    await page.getByRole('button', { name: /1 tab 200mg/ }).click();
    await page.getByRole('button', { name: 'Just now' }).click();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Log Dose' }).click();

    const reminderDownload = page.waitForEvent('download');
    await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Set Reminder' }).click();
    await saveDownload(await reminderDownload, downloadsPath);

    const logDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Log' }).click();
    await saveDownload(await logDownload, downloadsPath);

    await page.getByRole('button', { name: 'Clear All Data' }).click();
    await page.getByRole('button', { name: 'Clear Everything' }).click();
    await waitForVisible(page, 'text=No doses logged yet');

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
    await medicationCard(page, 'Ibuprofen').getByRole('button', { name: 'Log Dose' }).click();
    await page.getByRole('button', { name: /1 tab 200mg/ }).click();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Log Dose' }).click();
    await waitForVisible(page, 'text=Running total: 200mg');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForVisible(page, 'text=Running total: 200mg');
    await context.setOffline(false);

    assert(errors.length === 0, `Scratch scenario errors:\n${errors.join('\n')}`);
  } finally {
    await context.close();
  }
}

async function runPostSurgeryScenario(browser, baseUrl) {
  const { context, page, errors } = await newHarness(browser, 'post-surgery', { width: 390, height: 844 });
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForVisible(page, 'text=Welcome to Med Tracker');
    await page.getByRole('button', { name: 'Get Started' }).click();
    await page.getByText('Post-Surgery Recovery').click();
    await medicationCard(page, 'Oxycodone').waitFor({ state: 'visible', timeout: 15000 });

    await medicationCard(page, 'Oxycodone').getByRole('button', { name: 'Log Dose' }).click();
    await waitForVisible(page, 'text=Also log Hydroxyzine');
    const pairedCheckbox = page.locator('[data-paired-med="hydroxyzine"]');
    assert((await pairedCheckbox.isChecked()) === false, 'Paired meds should be opt-in by default');
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Log Dose' }).click();
    await waitForVisible(page, 'text=1 today');
    const hydroTimerAfterSoloLog = await medicationCard(page, 'Hydroxyzine').locator('.card-timer').innerText();
    assert(/No doses logged yet/.test(hydroTimerAfterSoloLog), 'Hydroxyzine should not auto-log when the paired checkbox is left unchecked');

    await medicationCard(page, 'Oxycodone').getByRole('button', { name: 'Review Timing' }).click();
    await waitForVisible(page, 'text=Also log Hydroxyzine');
    await pairedCheckbox.check();
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Log Dose' }).click();
    await waitForVisible(page, 'text=3 today');
    const hydroTimerAfterPairedLog = await medicationCard(page, 'Hydroxyzine').locator('.card-timer').innerText();
    assert(/Last:/.test(hydroTimerAfterPairedLog), 'Hydroxyzine should log only when the paired checkbox is selected');
    await waitForVisible(page, 'text=Available in 3h');

    const diazepamStatus = await medicationCard(page, 'Diazepam').locator('.card-status').innerText();
    assert(/Wait/.test(diazepamStatus), 'Diazepam should show a wait state after Oxycodone');
    await medicationCard(page, 'Diazepam').getByRole('button', { name: 'Review Timing' }).click();
    await waitForVisible(page, 'text=WARNING:');
    await waitForVisible(page, 'text=Log Anyway');
    await page.keyboard.press('Escape');

    await medicationCard(page, 'Tylenol').getByRole('button', { name: 'Log Dose' }).click();
    await waitForVisible(page, 'text=24hr total so far: 0mg / 4000mg');
    await page.getByRole('dialog', { name: 'Medication action' }).getByRole('button', { name: 'Log Dose' }).click();
    await waitForVisible(page, 'text=1000mg / 4000mg');

    await page.getByRole('button', { name: 'Clear All Data' }).click();
    await page.getByRole('button', { name: 'Clear Everything' }).click();
    await waitForVisible(page, 'text=No doses logged yet');

    assert(errors.length === 0, `Post-surgery scenario errors:\n${errors.join('\n')}`);
  } finally {
    await context.close();
  }
}

async function runDesktopSanity(browser, baseUrl) {
  const { context, page, errors } = await newHarness(browser, 'desktop', { width: 1280, height: 900 });
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForVisible(page, 'text=Welcome to Med Tracker');
    await page.getByRole('button', { name: 'Get Started' }).click();
    await page.getByText('Daily Medications').click();
    await page.getByRole('button', { name: 'Open settings' }).waitFor({ state: 'visible', timeout: 15000 });
    assert(errors.length === 0, `Desktop scenario errors:\n${errors.join('\n')}`);
  } finally {
    await context.close();
  }
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const server = await startStaticServer({ root: rootDir, port: 4173 });
  const browser = await chromium.launch({ headless: !headed });
  try {
    await runScratchScenario(browser, server.baseUrl);
    await runPostSurgeryScenario(browser, server.baseUrl);
    await runDesktopSanity(browser, server.baseUrl);
    console.log('Smoke scenarios passed');
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
