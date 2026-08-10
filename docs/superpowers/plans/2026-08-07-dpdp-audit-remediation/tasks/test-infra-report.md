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

## Second pass: one server for the whole suite

The first pass's per-process pooling (above) was correct as far as it went,
but it does not hold as a merge gate: it pools one `mongod` per test *file*,
and the file count kept growing as later tasks added test files. By the time
this second pass started, the suite was intermittently failing with
`StdoutInstanceError: Port "61513" already in use` from `MongoMemoryServer.create()`
- 159/159 on one run, 135/160 on the next, same commit. The diagnosis (given,
not re-derived here): a full run started 17 `mongod` instances near
simultaneously - 1 from `pretest`'s warm-up, 11 from `db.js`'s per-process
pool (grown from the 8 measured in the first pass as test files were added),
5 created directly in `test/connection.test.js` - each asking for a random
free port, and `mongodb-memory-server-core`'s `MongoInstance.js` does not
retry a busy port; it fails fatally. Confirmed by reading
`node_modules/mongodb-memory-server-core/lib/util/MongoInstance.js:360-361`
before starting: on `EADDRINUSE` it emits `StdoutInstanceError` with no
retry loop.

The fix: exactly one `mongod` for the entire suite, started once in the
parent process before `node --test` forks any test file, via
`node --test --test-global-setup=<file>`.

### What changed

1. **`scripts/test-setup.js`** (new) - exports `globalSetup`/`globalTeardown`.
   `globalSetup` starts one `MongoMemoryServer` (pinned to version `7.0.24`,
   the version already cached at `~/.cache/mongodb-binaries`) and puts its
   URI on `process.env.MONGO_TEST_URI`. `globalTeardown` stops it.

2. **`test/helpers/db.js`** - no longer creates a server. `withDb` now reads
   `MONGO_TEST_URI` and builds a per-call database URI on it
   (`test/helpers/db.js`'s new `testDbUri(dbName)`, using `URL` to swap in
   the path the same way `MongoMemoryServer.getUri(dbName)` does internally -
   confirmed by reading `uriTemplate()`/`generateDbName()` in
   `mongodb-memory-server-core/lib/util/utils.js`). The per-call `connect()`
   (which applies `sanitizeFilter`) is unchanged, as is `dropDatabase()` +
   `close()` in the `finally`. The `after()` hook that used to stop the
   process's own server is gone - the harness no longer owns one. If
   `MONGO_TEST_URI` is missing, `testDbUri` throws immediately with a message
   telling the caller to use `npm test`, not `node --test` directly.

3. **`test/connection.test.js`** - went from 5 `MongoMemoryServer.create()`
   calls to zero. Checked the brief's reasoning against what each of the 4
   tests actually asserts before changing anything:
   - *"connect returns an isolated connection..."* and *"buildModels binds
     models..."* each only ever needed one URI to connect to. Trivial -
     `testDbUri("isolated")` / `testDbUri("buildModels")`.
   - *"two connects to different URIs yield two independent connections"* -
     previously two separate servers (so, incidentally, two different
     `host:port`s). What it actually checks is that `connect()` doesn't
     return a cached/singleton connection for a second call. I read
     `src/db/connection.js`: `connect()` always calls
     `mongoose.createConnection(uri)` fresh, with no cache of any kind keyed
     on anything. Two different database names on the *same* `host:port`
     (`testDbUri("connA")` / `testDbUri("connB")`) is not a weaker
     substitute - it is a strictly more precise one, since it isolates the
     variable under test (does `connect()` care about the URI at all) from
     an unrelated one (are the ports different). Two different servers would
     also have caught a hypothetical "cache keyed on the whole URI" bug, but
     could have missed a narrower "cache keyed on host:port only, ignoring
     path" bug; two databases on one server cannot miss that narrower case.
   - *"sanitizeFilter is scoped to our connection..."* needs a host
     connection (built with a bare `mongoose.createConnection`, standing in
     for a host app) and a library connection (built with `connect()`), and
     checks that our `sanitizeFilter` doesn't leak onto the host's
     connection. That property is about the connection object, not the
     server process - `testDbUri("host")` / `testDbUri("ours")` on the
     shared server preserves it exactly.

   No test in this file required a second `mongod` process to prove what it
   claims. None were left alone with `MongoMemoryServer.create()` still in
   them.

4. **`scripts/warm-binary.js`** and the `pretest` script - removed. Their
   purpose was to get the binary onto disk before `node --test` forked
   per-file processes that would otherwise race on `~/.cache/mongodb-binaries/<version>.lock`
   on a cold cache. `globalSetup` now runs `MongoMemoryServer.create()` once,
   by itself, before any file is forked - the same race can no longer occur
   by construction, so the separate warm-up step is redundant. Verified this
   holds on an actually cold cache (see below) rather than just asserting it.

5. **Pinned the `mongod` version.** `binary: { version: "7.0.24" }` in
   `scripts/test-setup.js`'s `MongoMemoryServer.create()` call, matching the
   binary already cached at `~/.cache/mongodb-binaries/mongod-arm64-darwin-7.0.24`.

6. **`package.json`** - `"test"` is now
   `"node --test --test-global-setup=scripts/test-setup.js"`. The `"pretest"`
   entry is gone (nothing left for it to do). `npm test` remains the command;
   never invoked as `npm test -- <file>`.

### Verifying the `--test-global-setup` contract before relying on it

Rather than trust the flag's name and my recollection of Node's docs, I
checked both against the actual Node v26.3.1 binary before writing
`test-setup.js` for real. First attempt used a default export
(`module.exports = async function () {...}`), then named exports
`setup`/`teardown` - both loaded (the module's top-level code ran) but the
functions were never called, even when instrumented to throw
unconditionally on entry, which would have surfaced as a hard failure if
they'd run. Only named exports `globalSetup`/`globalTeardown` work on this
Node version. Confirmed with a throwaway setup file and test file: env vars
set inside `globalSetup` (in the parent process) are visible inside a
forked test file's `process.env`, `globalSetup` runs once before any test
file starts, and `globalTeardown` runs once after all test files finish,
still able to see state set during `globalSetup` in the same process. This
matches the task's description exactly, so I did not need to stop and flag
a mismatch - but the exact export names were not something to guess at,
since both wrong guesses failed silently rather than erroring.

### Six consecutive full runs (`npm test`, warm cache)

Confirmed idle first (`ps aux | grep -c "[m]ongod"` and
`ps aux | grep -c "[n]ode --test"` both `0`) before starting, and confirmed
idle again after every run below.

| Run | Result | Wall clock (`time -p`, real) |
|---|---|---|
| 1 | 160/160, 0 failed | 35.38s |
| 2 | 160/160, 0 failed | 35.79s |
| 3 | 160/160, 0 failed | 35.77s |
| 4 | 160/160, 0 failed | 34.12s |
| 5 | 160/160, 0 failed | 35.81s |
| 6 | 160/160, 0 failed | 35.49s |

Six identical green runs, `exit=0` on every one. Each run's raw summary
block:

```
ℹ tests 160
ℹ suites 0
ℹ pass 160
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

### `mongod` instance count, before and after

- **Before**: 17 (per the given diagnosis: 1 `pretest` warm-up + 11 pooled
  in `db.js` + 5 direct in `connection.test.js`).
- **After**: sampled mid-run with `ps aux | grep "[m]ongod-arm64"` while a
  run was in flight (about 4s in, with 9 of the 16 forked test-file
  processes still running per `pgrep -fl "node --test"`): **1**. Sampled
  more than once during the same run; stayed at 1 throughout.

### No `mongod` survives after the suite exits

Checked after every one of the six runs above, plus the standalone mid-run
sample and the cold-cache run below: `ps aux | grep "[m]ongod-arm64"` was
empty within a few seconds of `npm test` exiting, every time. (Note for
whoever reruns this: the naive `ps aux | grep -c "[m]ongod"` from the task's
own idle-check command will self-match if it is executed inside a wrapper
whose own command text contains the unbracketed word "mongod" - e.g. an
echo label in the same script. Hit this once while sampling mid-run and
confirmed it was a false positive, not a leaked process, by rerunning the
check as an isolated command and by grepping for the actual binary name
`mongod-arm64-darwin-7.0.24` instead.)

### Cold-cache first run

```
rm -rf ~/.cache/mongodb-binaries && npm test
```

Passed first time: **160/160**, 42.25s wall clock (includes the actual
binary download, since `globalSetup` is the only thing that touches
`mongod` now). Confirmed the binary that landed at
`~/.cache/mongodb-binaries/mongod-arm64-darwin-7.0.24` afterward matches the
pinned version, by its filename and a fresh mtime. No leftover `mongod`
after this run either.

### What only passed before because each file had its own server

None found. The property every `connection.test.js` test relies on -
`connect()` builds a genuinely new, uncached connection every call - is true
regardless of how many `mongod` processes back the URIs involved, and is
enforced by `src/db/connection.js` itself, not by test isolation. The
concurrent-write races in `consent.test.js` and `principal.test.js` (also
flagged as a risk in the first pass) are unaffected: `withDb` still hands
every call a brand-new connection and a brand-new, empty database, which is
what those tests actually depend on - only the underlying `mongod` process
is now shared, same as after the first pass, just shared suite-wide instead
of per-file. Nothing in the diff changed a database name, connection
lifecycle, or cleanup order that any assertion depends on.

### Files changed

- `data-fiduciary-toolkit/scripts/test-setup.js` (new) - `globalSetup`/`globalTeardown`,
  one pinned `mongod` for the whole suite.
- `data-fiduciary-toolkit/scripts/warm-binary.js` (deleted) - redundant once
  `globalSetup` owns the only pre-fork server start.
- `data-fiduciary-toolkit/test/helpers/db.js` - reads `MONGO_TEST_URI` instead
  of owning a server; added `testDbUri`; dropped the `after()` shutdown hook.
- `data-fiduciary-toolkit/test/connection.test.js` - 5 servers to 0, using
  `testDbUri` for distinct databases on the shared server; no assertions
  changed.
- `data-fiduciary-toolkit/package.json` - `"test"` now wires in
  `--test-global-setup`; `"pretest"` removed.

Not touched: any file under `src/`, and no test's assertions.
