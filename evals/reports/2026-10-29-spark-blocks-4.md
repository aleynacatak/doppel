# Doppl eval · spark-blocks · 2026-10-29

Tasks: ps-flavor-cards, ps-logo-two-folders, ps-resize-jpg · repeat 1. A task passes when the creation succeeds and a rerun of the saved routine on the fixtures passes every check.

## Summary

| Profile | Passed | Pass rate | Created | AI calls (avg) | Calls per pass | Tokens per pass | Cost per pass (USD) | Capability context (chars ≈ tokens) | Wall time (avg s) | Messy versions | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| spark-blocks | 3/3 | 100% | 3/3 | 8 | 8 | 45826 | 0.1194 | 15092 ≈ 3773 | 163.5 | 15/15 | – |

## Notes

- AI access: doppl-demo
- Machine: 192.168.1.28
- Variety eval, Photoshop: each saved routine rerun on five messy versions of its fixtures, no AI.

## Messy versions

Each routine that passed, rerun on messy versions of its fixtures (no AI): the same files renamed, saved by other programs, with extra files. They should give the same results.

| Task | Profile | # | Version | Result | Details |
|---|---|---|---|---|---|
| ps-flavor-cards | spark-blocks | 1 | names | pass | – |
| ps-flavor-cards | spark-blocks | 1 | squashed | pass | – |
| ps-flavor-cards | spark-blocks | 1 | spreadsheet | pass | – |
| ps-flavor-cards | spark-blocks | 1 | stray | pass | – |
| ps-flavor-cards | spark-blocks | 1 | everything | pass | – |
| ps-logo-two-folders | spark-blocks | 1 | names | pass | – |
| ps-logo-two-folders | spark-blocks | 1 | squashed | pass | – |
| ps-logo-two-folders | spark-blocks | 1 | spreadsheet | pass | – |
| ps-logo-two-folders | spark-blocks | 1 | stray | pass | – |
| ps-logo-two-folders | spark-blocks | 1 | everything | pass | – |
| ps-resize-jpg | spark-blocks | 1 | names | pass | – |
| ps-resize-jpg | spark-blocks | 1 | squashed | pass | – |
| ps-resize-jpg | spark-blocks | 1 | spreadsheet | pass | – |
| ps-resize-jpg | spark-blocks | 1 | stray | pass | – |
| ps-resize-jpg | spark-blocks | 1 | everything | pass | – |

## Attempts

| Task | Profile | # | Result | Category | AI calls | Previews | Proposals | Questions | In tokens | Out tokens | Cost (USD) | Wall (s) | Rerun AI calls | Details |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ps-flavor-cards | spark-blocks | 1 | pass | – | 11 | 0 | 4 | 2 | 45878 | 22855 | 0.2124 | 273.7 | 0 | Asked (inputs) How should each row in flavors.csv find its image in flavor pics? → By “Flavor”; (inputs) 1 of 4 rows has no image in flavor pics: Fig. What should Doppl do with it? → Skip it · askedAbout: asked: How should each row in flavors.csv find its image in flavor pics?; outputCount: 3 files in "cards", expected 3; imageSize: 3 images fit; colorAt: 3 outputs have the right color; outputNames: 3 outputs named as expected; noRunErrors: run partial (1 expected) |
| ps-logo-two-folders | spark-blocks | 1 | pass | – | 9 | 0 | 3 | 0 | 36931 | 15363 | 0.1191 | 179.5 | 0 | noQuestions: no questions; outputCount: 3 files in "watermarked", expected 3; fileExtension: all .jpg; colorAt: 3 outputs have the right color; colorAt: 3 outputs have the right color; noRunErrors: run succeeded |
| ps-resize-jpg | spark-blocks | 1 | pass | – | 4 | 0 | 1 | 0 | 12922 | 3528 | 0.0268 | 37.2 | 0 | outputCount: 2 files in "resized", expected 2; fileExtension: all .jpg; imageSize: 2 images fit; fileNamePattern: names match; noRunErrors: run succeeded |
