# G-pass benchmark

Measures the FluxOS domain-manager's g: app selection pass before and after the
concurrency work, against a synthetic FluxOS fleet.

## Why these numbers

The scenario is shaped from a measurement of **fdm-eu-1-03** (subset O-U) on
2026-09-01:

| | |
|---|---|
| G pass duration | 443-479s, back to back, no idle |
| g: apps in the pass | 336 |
| resolved to an IP | 308 |
| resolved to nothing | 28 |
| `processApplications` (cert/DNS) | 15ms |
| **time spent sleeping between retries** | **390s of 479s (81%)** |

The 28 dead-ending apps took 74% of the pass. The nodes they were retrying were
not down - all 14 probed directly answered HTTP 200 in 0.06-0.55s. They simply
were not running the component, which is a definitive answer that the old
`checkAppRunningWithRetries` re-asked twice more, three seconds apart, because
`checkAppRunning` returned the same `false` for "not there" and "could not ask".

## Running it

The "before" side is a real checkout of the base commit, so the comparison is
against committed code:

```sh
git worktree add /tmp/fdm-before <base-sha>
ln -s "$PWD/node_modules" /tmp/fdm-before/node_modules   # local runs only

node poc/fleet.js &                                       # 2000 fake nodes
node poc/bench.js --impl-root=/tmp/fdm-before --apps=336 --nodes=2000
node poc/bench.js --impl-root="$PWD"          --apps=336 --nodes=2000
```

Or in docker:

```sh
export BEFORE_ROOT=/tmp/fdm-before APPS=336 FLEET_NODES=2000
docker compose -f poc/docker-compose.yml build
docker compose -f poc/docker-compose.yml up -d fleet
docker compose -f poc/docker-compose.yml run --rm bench-before
docker compose -f poc/docker-compose.yml run --rm bench-after
```

The bench feature-detects: a checkout exporting `selectGPrimaries` is driven
through it, one that does not is driven through the serial per-app loop the old
`generateAndReplaceMainApplicationHaproxyGAppsConfig` ran.

## Results

336 apps, 2000-node fleet:

| | before | after |
|---|---|---|
| wall clock | 631.7s | **5.75s** |
| HTTP probes | 647 | 878* |

\* at a 200-node fleet, where nodes are candidates for many apps, the snapshot
dedup shows properly: 647 -> 271.

Scaling the new pass (2000-node fleet, so distinct nodes saturate at 2000):

| apps | elapsed | distinct nodes |
|---|---|---|
| 336 | 5.8s | 795 |
| 1,000 | 17.0s | 1,552 |
| 2,500 | 21.1s | 1,959 |
| 5,000 | 23.2s | 2,000 |
| 10,000 | **26.2s** | 2,000 |

The curve flattens because probe count now scales with **fleet size, not app
count** - each node is asked once per pass and every app is answered from that.
