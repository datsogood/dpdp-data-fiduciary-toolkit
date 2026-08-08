# Test infrastructure report

Standalone piece of work pulled forward from Task 14. Branch
`fix/dpdp-audit-remediation`. Work performed from `data-fiduciary-toolkit/`.

## What changed

1. **`test/helpers/db.js`** - `withDb` now starts one `MongoMemoryServer` per
   process (module-level, lazily created on first use) instead of one per
   call. Since `node --test` forks one process per test file, this drops the
   server count from 76 (one per `withDb` call) to 8 (one per file). Each
   `withDb` call still gets its own fresh, isolated MongoDB **database** on
   that shared server (`t${process.pid}_${counter++}`), and drops it in a
   `finally` block after the callback runs. The connection itself is also new
   per call - only the underlying `mongod` process is shared.

   Server shutdown uses `node:test`'s `after()` hook, not
   `process.on("exit")`. `exit` handlers can only do synchronous work -
   stopping `mongod` is async - and `after()` is guaranteed by the test
   runner to run exactly once, after every test in that file has settled,
   before the process moves on. Verified this works as expected with a
   standalone experiment before wiring it into `db.js`.

2. **`scripts/warm-binary.js`** (new) - downloads/extracts the `mongod`
   binary once before `node --test` forks per-file processes, wired via a
   new `pretest` script in `package.json`. This is the sketch from the task
   brief, with one deliberate change: **location**. The brief suggested
   `test/helpers/warm-binary.js`; I put it at `scripts/warm-binary.js`
   instead. Reason below, under Findings.

3. **`package.json`** - added `"pretest": "node scripts/warm-binary.js"`
   ahead of the existing `"test": "node --test"`. `npm test` now runs both
   in sequence; a direct `node --test <file>` (unaffected by `pretest`) is
   unchanged, per the global constraint to never invoke it via `npm test --`.

4. **`test/connection.test.js`** - left untouched. It creates
   `MongoMemoryServer` instances directly in each of its four tests because
   it is specifically testing connection/server isolation: that this
   library's connection is not the global mongoose singleton, that two
   `connect()` calls to different URIs don't collide, and that a host
   application's own connection to the same server is undisturbed by this
   library's `sanitizeFilter`. Sharing the new pooled server here would
   weaken exactly the property under test (multiple independent servers is
   the point, not an implementation detail to optimize away), so I kept its
   direct `MongoMemoryServer.create()` calls as they were.

## Finding: `warm-binary.js` needed to live outside `test/`

`node --test`'s default file-discovery glob treats **any file inside a
directory literally named `test`, at any depth**, as a test file in its own
right - regardless of filename or whether it calls `test()` at all. I
verified this with a throwaway file that had no `require("node:test")` and
no test-shaped name; it still showed up in the TAP output as
`ok N - test/helpers/plain-file.js`.

This means `test/helpers/db.js` was already being counted as a phantom
passing "test" before any of my changes - the pre-existing 105 baseline is
104 real `test()` calls (confirmed by `grep -c "^test(" test/*.test.js`,
which sums to 104) plus 1 phantom entry for `db.js` itself. Had I placed
`warm-binary.js` at the brief's suggested `test/helpers/warm-binary.js`, it
would have added a second phantom entry, changing the total from 105 to 106
- not a real regression (nothing failed), but a needless drift from the
stated "105/105" baseline and a confusing thing for the next person to debug.
I moved it to `scripts/warm-binary.js` instead, which is outside any
directory named `test` and doesn't match the runner's `test-*`/`*-test`/
`*.test` naming patterns either, so it is not picked up. Confirmed: after the
move, `node --test` reports exactly `tests 105`.

I left `test/helpers/db.js` itself in place - moving it was out of scope
(not part of what I was asked to fix, and it's required by all 8 test files
by relative path), and its phantom entry is unchanged, pre-existing
behavior, not something my change introduced.

## Model.init() verification (the task's flagged highest-risk item)

Confirmed there is no leaked index or model state across databases sharing
one server. `buildModels(connection)` caches models on the connection object
itself (`connection.$dpdpModels`), and each `withDb` call creates a **new**
`mongoose.createConnection(...)` - never reuses one - so `buildModels` always
runs fresh per call, and each model class (and thus each model's
`Model.init()` index-build promise) is brand new per call too. There is
nothing global or server-scoped in that caching path for state to leak
through.

Verified this concretely, not just by reading the code, with a standalone
script (not a `node:test` file, so it wouldn't itself become a phantom test)
that:
1. In one `withDb` call, inserted a `Principal` with `emailHash: "sharedhash"`,
   then asserted a second insert with the same `emailHash` was rejected
   (`E11000`, the unique index enforced).
2. In a second `withDb` call - same shared server, brand-new database -
   asserted an insert with that **same** `emailHash` value succeeded (proving
   the fresh database was truly empty and no stale uniqueness state carried
   over), then asserted a second insert with that value in *this* database
   was rejected (proving the unique index is rebuilt and enforced per
   database, not skipped because `init()` "already ran" on a previous
   connection).

Both rounds behaved correctly. `Principal`, `ConsentRecord`, and
`NoticeVersion` all call `Model.init()` this same way (via `buildModels` +
a fresh connection), so this result generalizes to all three.

## Cold-cache check

The task's literal command:

```
rm -rf ~/.cache/mongodb-binaries && npm test
```

Passed first time: **105/105**.

Digging further, I found `mongodb-memory-server` 10.4.3 (the version
actually installed, per `^10.1.2` in `package.json`) prefers a
project-local cache at `node_modules/.cache/mongodb-memory-server/` over
`~/.cache/mongodb-binaries` *when that project-local directory already
exists*. On a truly fresh clone neither exists, so the first-ever download
does land in `~/.cache/mongodb-binaries` (matching the task's description
exactly) - but once that directory has been created by any earlier run,
clearing only `~/.cache/mongodb-binaries` doesn't reproduce a genuinely cold
cache. To be thorough, I re-ran the check clearing **both** locations
together (simulating a true fresh clone):

```
rm -rf ~/.cache/mongodb-binaries node_modules/.cache/mongodb-memory-server
npm test
```

Also passed first time: **105/105**, 26.76s wall clock (includes the actual
binary download in the `pretest` step).

I also tried to directly reproduce the race the task described (3 first-run
tests failing at ~11ms each) by clearing both caches and running
`node --test` **without** `pretest** - i.e., the old failure mode, minus my
server-count reduction from 76 to 8. I could not reproduce a failure this
way, even across a genuinely cold cache. Reading
`node_modules/mongodb-memory-server-core/lib/util/lockfile.js`, this
version's lock acquisition has a `waitForLock` path (built on `async-mutex`)
- concurrent processes queue for the lock rather than failing fast when they
lose it. That's a plausible explanation for why I couldn't reproduce the
originally-observed failure here: either the library's locking behavior has
improved since that observation, or the race window is narrower than what
was hit before. I'm reporting this rather than claiming I proved the bug -
the `pretest` step is still correct to keep regardless, since it removes the
download-time race by construction (nothing forks concurrently until the
binary is already on disk), independent of whether the library's own
lock-waiting is reliable.

## Wall clock, before and after

Both measured with `time`, full suite, `node --test`, warm cache.

- **Before** (server per `withDb` call, 76 servers/run): **38.364s** total
  (105/105 pass).
- **After** (server per process, 8 servers/run): **18.590s-19.519s** across
  five runs, mean ~18.95s.

Roughly a 2x wall-clock improvement, on top of removing the port-collision
flake risk.

## Five consecutive runs (`node --test`, warm cache)

| Run | Result | Wall clock (`time`, total) |
|---|---|---|
| 1 | 105/105 | 18.590s |
| 2 | 105/105 | 19.519s |
| 3 | 105/105 | 18.667s |
| 4 | 105/105 | 19.334s |
| 5 | 105/105 | 18.651s |

No flakes across all five. Raw `node --test` summary block was identical in
shape on every run:

```
ℹ tests 105
ℹ suites 0
ℹ pass 105
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## Orphan process check

After the five runs, the cold-cache runs, and the index-isolation
verification script, checked for any surviving `mongod`:

```
pgrep -fl "mongod-arm64-darwin"
```

No matches. Confirms the `after()`-hook shutdown in `db.js` is sufficient -
no `mongod` process from any of these runs was left running.

## What only passed before because of the old per-call server

None found. Every uniqueness/isolation-sensitive test (the concurrent-write
races in `consent.test.js` and `principal.test.js`, and all four
`connection.test.js` tests) still passes under the new architecture, and the
standalone index-isolation script above specifically targeted the scenario
most likely to hide a false pass (a unique-index check that only worked
because each test previously got a brand-new server with no index history at
all). No such case turned up.

## Files changed

- `data-fiduciary-toolkit/test/helpers/db.js` - server pooling, database-per-call
  isolation, `after()`-hook shutdown.
- `data-fiduciary-toolkit/scripts/warm-binary.js` (new) - binary pre-warm script.
- `data-fiduciary-toolkit/package.json` - added `pretest` script.

Not touched: `test/connection.test.js` (deliberately, see above), any file
under `src/`, and any test assertion.
