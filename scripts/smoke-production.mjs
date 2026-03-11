process.env.MEDTRACKER_BASE_URL = process.env.MEDTRACKER_BASE_URL || 'https://amanda-med-tracker.netlify.app';
await import('./smoke.mjs');
