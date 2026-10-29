# Doppl eval · spark-blocks · 2026-10-29

Tasks: figma-flavor-labels-clean-sim, figma-flavor-labels-sim, ps-flavor-cards, ps-logo-two-folders · repeat 1. A task passes when the creation succeeds and a rerun of the saved routine on the fixtures passes every check.

## Summary

| Profile | Passed | Pass rate | Created | AI calls (avg) | Calls per pass | Tokens per pass | Cost per pass (USD) | Capability context (chars ≈ tokens) | Wall time (avg s) | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| spark-blocks | 1/2 | 50% | 2/2 | 2 | 2 | 24867 | 0.0381 | 36869 ≈ 9217 | 22.7 | script-error 1 |

## Notes

- AI access: doppl-demo
- Machine: 192.168.1.28
- Stopped after 2 attempt(s): This access code has no routine creations left. Saved routines still rerun without AI, or you can use your own Meta API key in Settings.
- figma-flavor-labels-sim: the input check paired every flavor right (it asked, and skipped Fig as answered), but the rerun left out BLUEBERRY.jpeg: the folder reader took ".jpeg" for another format than the routine's "jpg". Fixed after this run (one format, as everywhere else in Doppl). ps-flavor-cards and ps-logo-two-folders didn't run: the access code had no creations left.

## Attempts

| Task | Profile | # | Result | Category | AI calls | Previews | Proposals | Questions | In tokens | Out tokens | Cost (USD) | Wall (s) | Rerun AI calls | Details |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| figma-flavor-labels-clean-sim | spark-blocks | 1 | pass | – | 2 | 0 | 1 | 0 | 22522 | 2345 | 0.0381 | 19.6 | 0 | noQuestions: no questions; pairedWith: 3 items paired as expected; outputCount: 3 files in "labels", expected 3; noRunErrors: run succeeded |
| figma-flavor-labels-sim | spark-blocks | 1 | fail (rerun) | script-error | 2 | 0 | 1 | 2 | 22662 | 3253 | 0.0422 | 25.7 | 0 | Asked (inputs) How should each row in jams.csv find its image in flavor pics? → By “Flavor”; (inputs) 1 of 4 rows has no image in flavor pics: Fig. What should Doppl do with it? → Skip it · pairedWith: no output for Blueberry \| outputCount: 2 files in "labels", expected 3 \| noRunErrors: Row 4 · Blueberry: No flavor pic for Row 4 · Blueberry: Blueberry not found. |
