# Manual QA Checklist

## Core Workflows
- [ ] Scratch onboarding works on a clean browser profile and does not show a false update banner.
- [ ] Post-surgery onboarding loads the built-in meds, warnings, event date, and tracked totals correctly.
- [ ] Settings can add, edit, and delete medications without losing data or breaking layout.
- [ ] Validation errors appear inline and clear correctly after fixing the field values.
- [ ] Dose logging works for immediate, retroactive, and custom-time entries.
- [ ] Removing a dose and clearing all data fully restore queue order, totals, and status labels.

## Safety and Timing
- [ ] Conflict meds show a wait state in cards and Next Up instead of `Ready now`.
- [ ] Conflict meds do not trigger ready alerts or reminder timing until the safety window expires.
- [ ] Conflict modals still allow an explicit warned override when needed.
- [ ] Track-total meds warn near the limit and stop normal logging at the hard cap.
- [ ] Max-dose scheduled meds stop normal logging once the daily dose count is reached.

## Export, Import, and Downloads
- [ ] Setup export shows success feedback and valid setup imports preview correctly.
- [ ] Invalid setup imports fail safely without mutating current data.
- [ ] Log export downloads a readable `.txt` file with current entries.
- [ ] Reminder downloads generate valid `.ics` files at the recommended next time.

## UX and Visual Pass
- [ ] Alert banner does not block Settings or bedside controls on mobile or desktop.
- [ ] Safe-area spacing looks correct in a narrow mobile viewport.
- [ ] Bedside mode preserves readability, focus order, and persistence across reloads.
- [ ] Desktop layout remains usable at wide viewport widths.
- [ ] Long-session timer updates do not drift or show contradictory queue/card states.

## PWA and Browser-Specific Checks
- [ ] First install is silent; real service-worker updates show a single refresh prompt.
- [ ] After one online load, offline reload still serves the app shell.
- [ ] Notification permission prompt and in-browser alerts behave sensibly after first interaction.
- [ ] Chrome-based browser and Safari/iOS manual pass both look correct for the core workflows.
