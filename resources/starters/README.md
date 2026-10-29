# Starter routines

Routines made by Doppl ship here, one JSON file per routine (format 2: `inputs`, `outputs`, `settings`, `iterate`,
and `actions` or `script`). Doppl loads them read-only when it starts and shows them under Library → Starter
routines with a "Made by Doppl" badge. Older versions can sit one folder down (e.g. `older/resize-1.json`) so flows
that pin them keep working.

Make a starter from one of your routines with the dev panel (Cmd+Shift+D) → Export as starter, then put the file
here. Tag a routine with one input and one output as a converter (`"starter": { "tags": ["converter"] }`) to offer
it for incompatible connections in flows.

The packaged app copies this folder to `Contents/Resources/starters`.
