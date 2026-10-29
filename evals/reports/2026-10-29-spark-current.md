# Doppl eval · spark-current · 2026-10-29

Tasks: figma-label-fill-sim, ps-cutout-white-bg, ps-resize-jpg · repeat 3. A task passes when the creation succeeds and a rerun of the saved routine on the fixtures passes every check.

## Summary

| Profile | Passed | Pass rate | Created | AI calls (avg) | Calls per pass | Tokens per pass | Cost per pass (USD) | Capability context (chars ≈ tokens) | Wall time (avg s) | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| spark-current | 9/9 | 100% | 9/9 | 1.7 | 1.7 | 6775 | 0.0075 | 18049 ≈ 4512 | 11.5 | – |

## Notes

- AI access: doppl-demo (an access code made for these evals)
- Rechecked from the saved outputs: the cutout task checks the rough work, the white around each product removed (outerWhiteRemoved), instead of cornerPixelsTransparent. The corner check failed box.png, a correct cutout trimmed to a rectangular product. White enclosed by a product may stay (ring.png keeps its white hole in every attempt): a cutout routine meets many kinds of images and backgrounds, and doing the rough work well is the goal.
- spark-fixed's 2 ai-error attempts: the reviewer, at the model's default reasoning effort, answered empty (no text, no usage), and the retry didn't lower the effort for a role without its own. Fixed after this run: retries cap the effort for every role, and the reviewer uses low (as in spark-current). Three later spark-fixed cutout attempts all created their routines and pass these checks; in one the reviewer answered empty again and the capped retry worked.
- Both profiles pass every Figma and resize attempt; spark-fixed spends more per working routine: one more call (the code is written in its own answer), high/max reasoning effort and a longer guide (worked examples, the plan field).

## Attempts

| Task | Profile | # | Result | Category | AI calls | Previews | Proposals | Questions | In tokens | Out tokens | Cost (USD) | Wall (s) | Rerun AI calls | Details |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| figma-label-fill-sim | spark-current | 1 | pass | – | 1 | 0 | 1 | 0 | 9638 | 860 | 0.0052 | 7.8 | 0 | outputCount: 3 files in "labels", expected 3; fileExtension: all .png; noRunErrors: run succeeded |
| figma-label-fill-sim | spark-current | 2 | pass | – | 1 | 0 | 1 | 0 | 9638 | 963 | 0.0056 | 7 | 0 | outputCount: 3 files in "cards", expected 3; fileExtension: all .png; noRunErrors: run succeeded |
| figma-label-fill-sim | spark-current | 3 | pass | – | 1 | 0 | 1 | 0 | 9638 | 677 | 0.0044 | 4.5 | 0 | outputCount: 3 files in "labels", expected 3; fileExtension: all .png; noRunErrors: run succeeded |
| ps-cutout-white-bg | spark-current | 1 | pass | – | 2 | 0 | 1 | 0 | 3283 | 2219 | 0.0135 | 20.1 | 0 | outputCount: 3 files in "cutouts", expected 3; fileExtension: all .png; hasTransparency: transparent areas in every file; outerWhiteRemoved: white around the subject removed; noRunErrors: run succeeded |
| ps-cutout-white-bg | spark-current | 2 | pass | – | 2 | 0 | 1 | 0 | 3281 | 1664 | 0.0078 | 15.8 | 0 | outputCount: 3 files in "cutouts", expected 3; fileExtension: all .png; hasTransparency: transparent areas in every file; outerWhiteRemoved: white around the subject removed; noRunErrors: run succeeded |
| ps-cutout-white-bg | spark-current | 3 | pass | – | 2 | 0 | 1 | 0 | 3281 | 1690 | 0.0082 | 15.6 | 0 | outputCount: 3 files in "cutouts", expected 3; fileExtension: all .png; hasTransparency: transparent areas in every file; outerWhiteRemoved: white around the subject removed; noRunErrors: run succeeded |
| ps-resize-jpg | spark-current | 1 | pass | – | 2 | 0 | 1 | 0 | 3358 | 1477 | 0.0071 | 11.3 | 0 | outputCount: 2 files in "resized", expected 2; fileExtension: all .jpg; imageSize: 2 images fit; fileNamePattern: names match; noRunErrors: run succeeded |
| ps-resize-jpg | spark-current | 2 | pass | – | 2 | 0 | 1 | 0 | 3358 | 1309 | 0.0095 | 11.1 | 0 | outputCount: 2 files in "resized", expected 2; fileExtension: all .jpg; imageSize: 2 images fit; fileNamePattern: names match; noRunErrors: run succeeded |
| ps-resize-jpg | spark-current | 3 | pass | – | 2 | 0 | 1 | 0 | 3358 | 1284 | 0.0063 | 10.3 | 0 | outputCount: 2 files in "resized", expected 2; fileExtension: all .jpg; imageSize: 2 images fit; fileNamePattern: names match; noRunErrors: run succeeded |
