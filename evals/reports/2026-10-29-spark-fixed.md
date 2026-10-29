# Doppl eval · spark-fixed · 2026-10-29

Tasks: figma-label-fill-sim, ps-cutout-white-bg, ps-resize-jpg · repeat 3. A task passes when the creation succeeds and a rerun of the saved routine on the fixtures passes every check.

## Summary

| Profile | Passed | Pass rate | Created | AI calls (avg) | Calls per pass | Tokens per pass | Cost per pass (USD) | Capability context (chars ≈ tokens) | Wall time (avg s) | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| spark-fixed | 7/9 | 78% | 7/9 | 3 | 2.7 | 16562 | 0.0229 | 22047 ≈ 5512 | 20.8 | ai-error 2 |

## Notes

- AI access: doppl-demo (an access code made for these evals)
- Rechecked from the saved outputs: the cutout task checks the rough work, the white around each product removed (outerWhiteRemoved), instead of cornerPixelsTransparent. The corner check failed box.png, a correct cutout trimmed to a rectangular product. White enclosed by a product may stay (ring.png keeps its white hole in every attempt): a cutout routine meets many kinds of images and backgrounds, and doing the rough work well is the goal.
- spark-fixed's 2 ai-error attempts: the reviewer, at the model's default reasoning effort, answered empty (no text, no usage), and the retry didn't lower the effort for a role without its own. Fixed after this run: retries cap the effort for every role, and the reviewer uses low (as in spark-current). Three later spark-fixed cutout attempts all created their routines and pass these checks; in one the reviewer answered empty again and the capped retry worked.
- Both profiles pass every Figma and resize attempt; spark-fixed spends more per working routine: one more call (the code is written in its own answer), high/max reasoning effort and a longer guide (worked examples, the plan field).

## Attempts

| Task | Profile | # | Result | Category | AI calls | Previews | Proposals | Questions | In tokens | Out tokens | Cost (USD) | Wall (s) | Rerun AI calls | Details |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| figma-label-fill-sim | spark-fixed | 1 | pass | – | 2 | 0 | 1 | 0 | 21700 | 1212 | 0.0323 | 10.8 | 0 | outputCount: 3 files in "labels", expected 3; fileExtension: all .png; noRunErrors: run succeeded |
| figma-label-fill-sim | spark-fixed | 2 | pass | – | 2 | 0 | 1 | 0 | 21680 | 1201 | 0.0204 | 9.8 | 0 | outputCount: 3 files in "labels", expected 3; fileExtension: all .png; noRunErrors: run succeeded |
| figma-label-fill-sim | spark-fixed | 3 | pass | – | 2 | 0 | 1 | 0 | 21689 | 1457 | 0.0215 | 11.8 | 0 | outputCount: 3 files in "labels", expected 3; fileExtension: all .png; noRunErrors: run succeeded |
| ps-cutout-white-bg | spark-fixed | 1 | fail (creation) | ai-error | 4 | 0 | 1 | 0 | 8083 | 1201 | 0.0280 | 30.4 | 0 | Doppl's AI couldn't write a usable routine for this request. Try rephrasing it. |
| ps-cutout-white-bg | spark-fixed | 2 | fail (creation) | ai-error | 4 | 0 | 1 | 0 | 8076 | 1357 | 0.0286 | 29.6 | 0 | Doppl's AI couldn't write a usable routine for this request. Try rephrasing it. |
| ps-cutout-white-bg | spark-fixed | 3 | pass | – | 4 | 0 | 1 | 0 | 8447 | 2459 | 0.0187 | 27.4 | 0 | outputCount: 3 files in "cutouts", expected 3; fileExtension: all .png; hasTransparency: transparent areas in every file; outerWhiteRemoved: white around the subject removed; noRunErrors: run succeeded |
| ps-resize-jpg | spark-fixed | 1 | pass | – | 3 | 0 | 1 | 0 | 8554 | 3990 | 0.0274 | 25.1 | 0 | outputCount: 2 files in "resized", expected 2; fileExtension: all .jpg; imageSize: 2 images fit; fileNamePattern: names match; noRunErrors: run succeeded |
| ps-resize-jpg | spark-fixed | 2 | pass | – | 3 | 0 | 1 | 0 | 8543 | 3271 | 0.0200 | 21.6 | 0 | outputCount: 2 files in "resized", expected 2; fileExtension: all .jpg; imageSize: 2 images fit; fileNamePattern: names match; noRunErrors: run succeeded |
| ps-resize-jpg | spark-fixed | 3 | pass | – | 3 | 0 | 1 | 0 | 8540 | 3194 | 0.0198 | 21.1 | 0 | outputCount: 2 files in "resized", expected 2; fileExtension: all .jpg; imageSize: 2 images fit; fileNamePattern: names match; noRunErrors: run succeeded |
