# Cupel README artwork

- `cupel-logo.png`: assay cup / code-bracket mark with an amber fault marker. The opaque ivory tile works on light and dark backgrounds; the outside is transparent. Created with the built-in imagegen tool (prompt below).
- `protection.png`, `protection-dark.png`: the README hero, "Green tests can hide lost protection", with the measured numbers of the [real-repository Jest acceptance](../../plans/results/2026-10-26-jest-acceptance.md) (51 tests, coverage 92.75% unchanged, critical faults caught 11 → 10, guard fails). The wording of the weakened assertion is illustrative.
- `how-it-works.png`, `how-it-works-dark.png`: Cupel's four stages (collect, plant faults, decide, scale in CI) as of 0.4.0.

## The diagrams are code

The two diagrams are HTML in [`src/`](src) built from the components and tokens of
[Fire](https://github.com/vidhatanand/firedesign) (`fire-design`, MIT, 0.12.3) in its default look:
`fd-pipeline` for the flow, `fd-stats` for the numbers, Fire's type, icons and
colours, and a few lines of frame layout in `src/art.css` that use only Fire
tokens. Render them, light and dark, at twice the CSS size:

```sh
node scripts/render-readme-art.mjs --fire /path/to/firedesign
```

The script needs a Fire checkout (its `fire/` styles, fonts and icons and its
`playwright-core`) and a Chromium (`--browser`, or Playwright's cache). It serves the
pages from disk through request routing, refuses any other request, and writes
`docs/assets/<name>.png` and `<name>-dark.png`. Cupel itself gains no dependency.
Change a number or a capability in the HTML, re-render, and review both images.
`scripts/readme-assets.test.mjs` checks the README's image references, alternative
text and PNG headers and sizes.

The earlier generated explainer (`agentic-test-protection.png`) was replaced by
these diagrams in 0.4.0; its prompts are kept below for the record.

## Generation prompts

### Logo

```text
Use case: logo-brand.
Asset: a final polished standalone app/repository logo mark for Cupel, an open-source developer tool that checks whether tests still detect faults after AI coding agents edit code and tests.
Create ONE clean, distinctive flat vector-style symbol, not a presentation sheet. Square 1024x1024 composition, generously padded, crisp mathematical geometry, legible down to 32px.
The concept is an assayer's small cup/crucible and code: a thick deep-teal U-shaped bowl with angular outward-flaring top ends that subtly suggest code brackets. A small warm amber diamond is suspended above the bowl's inner bottom, representing the fault being examined. Make the geometry intentional and balanced. No checkmark, shield, robot, brain, sparkle, lettering, gradients, shadows, 3D or mockup.
Palette: teal #087F8C and amber #E8A23A. Place the symbol on a warm ivory #F7F4ED rounded-square tile, with transparent pixels OUTSIDE the tile. The tile fills about 86% of the square canvas and has a subtle thin teal border; the mark is centered with ample breathing room. The ivory tile must remain opaque so the logo works on both light and dark GitHub themes.
Output one production-ready PNG with true alpha outside the tile. Do not add any text.
```

### Explainer (retired in 0.4.0)

```text
Use case: infographic-diagram.
Create one polished landscape infographic for the GitHub README of Cupel, a developer tool for reviewing tests changed by coding agents. Intended size around 1800x1200, landscape 3:2. Very crisp, generous whitespace, large perfectly legible sans-serif typography. It must be readable when displayed about 850px wide. Flat editorial vector-style graphics on opaque warm ivory #F7F4ED, charcoal text, deep teal #087F8C, amber #E8A23A, muted red for failure and restrained green for passing tests. No gradients, decorative glow, stock robots, shields, 3D, watermark, invented UI or fake terminal screenshot.
REFERENCE IMAGE: use the supplied Cupel logo as the exact brand mark (teal code-bracket cup holding amber diamond). Preserve its distinctive silhouette. Integrate a small logo next to the word Cupel at the upper left; do not make the entire reference image the composition.
Layout: a strong title, a visual top-row problem with 3 stages connected by arrows, a teal middle-row Cupel flow with 3 stages connected by arrows, and a large concise bottom evidence panel. Use simple code-file, test-file, coverage-grid, small mutation diamond and Git comparison symbols to visually support the story. No photos.
Exact text, do not invent additional claims or statistics:
Top brand: "Cupel"
Title: "Green tests can hide lost protection."
Subheading: "Review what changed when an agent edits your code and tests."
Top row three stage labels:
"Agent edits code + tests"
"Tests still pass"
"An assertion gets weaker"
Use an amber warning symbol on the third stage; green passing tests alone must not look like a safe merge approval.
Middle section label: "CUPEL CHECKS THE PROTECTION"
Middle row three stage labels:
"Collect per-test evidence"
"Introduce small faults"
"Compare with the Git baseline"
Visually connect the last comparison to the bottom red failure result, not directly to an approved merge.
Bottom section label: "REAL JEST VALIDATION"
Three short metric groups:
"51 / 51 tests pass"
"Coverage unchanged: 92.75%"
"Critical mutants caught: 11 → 10"
Main outcome, visually prominent in muted red: "GUARD FAILED · 1 lost critical kill"
Small but legible scope line: "11 tested mutations across 2 declared critical API paths."
Final concise call to action: "Inspect the lost protection before merging."
Make this look like a thoughtfully designed developer product explanation, not a busy marketing poster. Keep all exact words and numbers correct. The only benchmark evidence is the explicitly scoped Jest example. Do not claim automatic test deletion, guaranteed correctness, automatic PR blocking, or faster CI.
```

### Explainer layout correction

```text
Edit this Cupel README infographic. Preserve the logo, typography style, background, colors, all middle and bottom sections, and every benchmark number and word exactly.
Make one targeted correction to the TOP workflow so its arrows show the correct causal sequence:
1. LEFT remains "Agent edits code + tests", with the two source/test files.
2. MIDDLE becomes "An assertion gets weaker", with the existing illustrative assertion-diff graphic.
3. RIGHT becomes "Tests still pass", with the existing green-check test-results window.
Thus the top row reads left-to-right: Agent edits code + tests → An assertion gets weaker → Tests still pass.
Above the small code-diff graphic add the concise label "Illustrative edit" so it is clearly a concept, not an actual screenshot or the exact Jest benchmark assertion.
Keep all three stages comfortably within their columns without overlapping headings or arrows. Keep the main title, the whole teal "CUPEL CHECKS THE PROTECTION" band, and the entire "REAL JEST VALIDATION" panel unchanged. Preserve 51/51, 92.75%, 11→10, one lost critical kill, and the scope line about 2 declared critical API paths. No new claims or embellishments.
```

