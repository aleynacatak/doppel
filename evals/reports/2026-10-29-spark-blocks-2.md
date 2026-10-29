# Doppl eval · spark-blocks · 2026-10-29

Tasks: figma-flavor-labels-clean-sim, figma-flavor-labels-sim, ps-flavor-cards, ps-logo-two-folders · repeat 1. A task passes when the creation succeeds and a rerun of the saved routine on the fixtures passes every check.

## Summary

| Profile | Passed | Pass rate | Created | AI calls (avg) | Calls per pass | Tokens per pass | Cost per pass (USD) | Capability context (chars ≈ tokens) | Wall time (avg s) | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| spark-blocks | 4/4 | 100% | 4/4 | 3.3 | 3.3 | 27917 | 0.0586 | 26083 ≈ 6521 | 73.6 | – |

## Notes

- AI access: doppl-demo
- Machine: 192.168.1.28

## Attempts

| Task | Profile | # | Result | Category | AI calls | Previews | Proposals | Questions | In tokens | Out tokens | Cost (USD) | Wall (s) | Rerun AI calls | Details |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| figma-flavor-labels-clean-sim | spark-blocks | 1 | pass | – | 2 | 0 | 1 | 0 | 22527 | 2762 | 0.0399 | 23.6 | 0 | noQuestions: no questions; pairedWith: 3 items paired as expected; outputCount: 3 files in "labels", expected 3; noRunErrors: run succeeded |
| figma-flavor-labels-sim | spark-blocks | 1 | pass | – | 2 | 0 | 1 | 2 | 22662 | 3214 | 0.0420 | 25 | 0 | Asked (inputs) How should each row in jams.csv find its image in flavor pics? → By “Flavor”; (inputs) 1 of 4 rows has no image in flavor pics: Fig. What should Doppl do with it? → Skip it · askedAbout: asked: How should each row in jams.csv find its image in flavor pics?; askedAbout: asked: 1 of 4 rows has no image in flavor pics: Fig. What should Doppl do with it?; pairedWith: 4 items paired as expected; outputCount: 3 files in "labels", expected 3; noRunErrors: run partial (1 expected) |
| ps-flavor-cards | spark-blocks | 1 | pass | – | 5 | 0 | 2 | 2 | 19557 | 19673 | 0.1081 | 173.6 | 0 | Asked (inputs) How should each row in flavors.csv find its image in flavor pics? → By “Flavor”; (inputs) 1 of 4 rows has no image in flavor pics: Fig. What should Doppl do with it? → Skip it · askedAbout: asked: How should each row in flavors.csv find its image in flavor pics?; outputCount: 3 files in "cards", expected 3; imageSize: 3 images fit; colorAt: 3 outputs have the right color; outputNames: 3 outputs named as expected; noRunErrors: run partial (1 expected) |
| ps-logo-two-folders | spark-blocks | 1 | pass | – | 4 | 0 | 1 | 0 | 13725 | 7546 | 0.0445 | 72.2 | 0 | noQuestions: no questions; outputCount: 3 files in "watermarked", expected 3; fileExtension: all .jpg; colorAt: 3 outputs have the right color; colorAt: 3 outputs have the right color; noRunErrors: run succeeded |
