# Local characterization net (not CI)

The committed CI floor is `tests/unit/characterization.test.js` + its 30-spec
**anonymized** fixture. This directory holds the exhaustive, real-data net used
while rewriting config generation for v9. The corpus and sweep output are
gitignored — they are real production spec data.

## Files

- `corpus-raw.json` *(gitignored)* — the full real corpus. Pull it with:

  ```sh
  curl -s https://api.runonflux.io/apps/globalappsspecifications > tests/local/corpus-raw.json
  ```

- `locations.json` *(gitignored)* — live app→backend-IP assignments. Pull it with:

  ```sh
  curl -s https://api.runonflux.io/apps/locations > tests/local/locations.json
  ```

- `sweep.js` — run FDM's pure spec-shape functions over **every** real spec and
  write `sweep-output.json`.
- `live-render-check.js` — render the full haproxy config over the live population
  using each app's **real** location IPs (exercises the multi-IP branches the fixed-IP
  sweep can't), then validate it against real **haproxy 2.9** (needs docker).
- `haproxy-check.js` — validate rendered v9 backend variants against haproxy 2.9
  (needs docker).
- `curate.js` — regenerate the committed 30-spec anonymized fixture from the corpus
  (greedy branch-coverage select + owner/domain anonymization).
- `sweep-output.json` *(gitignored)* — the sweep result.

## Workflow during the rewrite

```sh
node tests/local/sweep.js            # baseline
cp tests/local/sweep-output.json /tmp/sweep-before.json
# ...make a rewrite change...
node tests/local/sweep.js            # re-run
git diff --no-index /tmp/sweep-before.json tests/local/sweep-output.json
npm test                             # the committed golden must stay green
```

Any change to a real spec's routing output surfaces in the diff. When a change is
**intentional**, regenerate the golden: `node tests/unit/fixtures/generate-golden.js`.

## Regenerating the committed fixture

```sh
node tests/local/curate.js
node tests/unit/fixtures/generate-golden.js
npm test
```
