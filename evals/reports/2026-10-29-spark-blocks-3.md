# Doppl eval · spark-blocks · 2026-10-29

Tasks: figma-flavor-labels-clean-sim, figma-flavor-labels-sim, figma-label-fill-sim · repeat 1. A task passes when the creation succeeds and a rerun of the saved routine on the fixtures passes every check.

## Summary

| Profile | Passed | Pass rate | Created | AI calls (avg) | Calls per pass | Tokens per pass | Cost per pass (USD) | Capability context (chars ≈ tokens) | Wall time (avg s) | Messy versions | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| spark-blocks | 3/3 | 100% | 3/3 | 2 | 2 | 24550 | 0.0334 | 36869 ≈ 9217 | 19.6 | 15/15 | – |

## Notes

- AI access: doppl-demo
- Machine: 192.168.1.28
- Stopped after 3 attempt(s): This access code has no routine creations left. Saved routines still rerun without AI, or you can use your own Meta API key in Settings.
- Variety eval: each saved routine rerun on five messy versions of its fixtures, no AI.
- Re-scored 4 messy versions after fixing the eval's pairedWith check: it compared the renamed partner files ("strawberryvanilla (1).png") with the original names; the pairs themselves were right.

## Messy versions

Each routine that passed, rerun on messy versions of its fixtures (no AI): the same files renamed, saved by other programs, with extra files. They should give the same results.

| Task | Profile | # | Version | Result | Details |
|---|---|---|---|---|---|
| figma-flavor-labels-clean-sim | spark-blocks | 1 | names | pass | – |
| figma-flavor-labels-clean-sim | spark-blocks | 1 | squashed | pass | – |
| figma-flavor-labels-clean-sim | spark-blocks | 1 | spreadsheet | pass | – |
| figma-flavor-labels-clean-sim | spark-blocks | 1 | stray | pass | – |
| figma-flavor-labels-clean-sim | spark-blocks | 1 | everything | pass | – |
| figma-flavor-labels-sim | spark-blocks | 1 | names | pass | – |
| figma-flavor-labels-sim | spark-blocks | 1 | squashed | pass | – |
| figma-flavor-labels-sim | spark-blocks | 1 | spreadsheet | pass | – |
| figma-flavor-labels-sim | spark-blocks | 1 | stray | pass | – |
| figma-flavor-labels-sim | spark-blocks | 1 | everything | pass | – |
| figma-label-fill-sim | spark-blocks | 1 | names | pass | – |
| figma-label-fill-sim | spark-blocks | 1 | squashed | pass | – |
| figma-label-fill-sim | spark-blocks | 1 | spreadsheet | pass | – |
| figma-label-fill-sim | spark-blocks | 1 | stray | pass | – |
| figma-label-fill-sim | spark-blocks | 1 | everything | pass | – |

## Attempts

| Task | Profile | # | Result | Category | AI calls | Previews | Proposals | Questions | In tokens | Out tokens | Cost (USD) | Wall (s) | Rerun AI calls | Details |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| figma-flavor-labels-clean-sim | spark-blocks | 1 | pass | – | 2 | 0 | 1 | 0 | 22527 | 1894 | 0.0362 | 20.1 | 0 | noQuestions: no questions; pairedWith: 3 items paired as expected; outputCount: 3 files in "labels", expected 3; noRunErrors: run succeeded |
| figma-flavor-labels-sim | spark-blocks | 1 | pass | – | 2 | 0 | 1 | 2 | 22645 | 2651 | 0.0396 | 22 | 0 | Asked (inputs) How should each row in jams.csv find its image in flavor pics? → By “Flavor”; (inputs) 1 of 4 rows has no image in flavor pics: Fig. What should Doppl do with it? → Skip it · askedAbout: asked: How should each row in jams.csv find its image in flavor pics?; askedAbout: asked: 1 of 4 rows has no image in flavor pics: Fig. What should Doppl do with it?; pairedWith: 4 items paired as expected; outputCount: 3 files in "labels", expected 3; noRunErrors: run partial (1 expected) |
| figma-label-fill-sim | spark-blocks | 1 | pass | – | 2 | 0 | 1 | 0 | 22066 | 1867 | 0.0243 | 16.6 | 0 | outputCount: 3 files in "labels", expected 3; fileExtension: all .png; noRunErrors: run succeeded |
