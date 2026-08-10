# Task 1 Report: Repo hygiene, packaging, and license

## Status: DONE

## What I implemented

Followed the brief step by step, no deviations:

1. **Created `repo-root:.gitignore`** - exact content from the brief (`node_modules/`, `.env`, `.env.*`, `!.env.example`, `*.log`, `npm-debug.log*`, `.DS_Store`, `coverage/`, `.superpowers/`).
2. **Created `data-fiduciary-toolkit/.env.example`** - exact content from the brief, all six vars (`MONGO_URI`, `PRINCIPAL_ID_SECRET`, `FIDUCIARY_NAME`, `FIDUCIARY_DPO_NAME`, `FIDUCIARY_DPO_EMAIL`, `GRIEVANCE_SLA_DAYS`, `PORT` - seven lines, six of which are the code-facing config vars plus `PORT` for the example server). Confirmed by grep that `process.env.*` reads in `src/` and `examples/` match every variable except `PRINCIPAL_ID_SECRET`, which the brief says T4 adds.
3. **Rewrote `data-fiduciary-toolkit/package.json`** - exact content from the brief: version bumped to `0.2.0`, description restates the Act by full name, `license: Apache-2.0`, `repository` block added, `engines.node: >=20`, `files` allowlist (`src/`, `README.md`, `LICENSE`), `test` script (`node --test test/`), `express` moved from `dependencies` to `peerDependencies`, `mongodb-memory-server` added as a `devDependency`.
4. **Copied `../LICENSE` to `data-fiduciary-toolkit/LICENSE`** (Apache License 2.0, matches root).
5. **Fixed the nested README** - statute citation (2025 to 2023), Obligation 1 (language rule), Obligation 13 (Significant Data Fiduciary test), Setup snippet (removed top-level `await`, wrapped in `async function main()`, added `resolvePrincipal` and `express` peer-dependency note), and two new bullets in "What this is not" (opaque `principalId`, three consent-ledger states).
6. **Rewrote `repo-root:README.md`** - exact content from the brief: mentions the nested package, links to `data-fiduciary-toolkit/README.md` and `reviews.md`, states the Act is the 2023 statute, adds a License section.
7. Staged and committed everything in one commit.

All content matches the brief's code blocks verbatim - no rewording, no "improvements" beyond what was specified.

## Verification

### `npm pack --dry-run` (Step 8)

```
$ cd data-fiduciary-toolkit && npm pack --dry-run
npm notice
npm notice 📦  dpdp-fiduciary-toolkit@0.2.0
npm notice Tarball Contents
npm notice 11.4kB LICENSE
npm notice 7.6kB README.md
npm notice 924B package.json
npm notice 3.3kB src/config/catalog.js
npm notice 392B src/db/connection.js
npm notice 3.9kB src/http/forms.js
npm notice 3.3kB src/http/router.js
npm notice 1.2kB src/index.js
npm notice 918B src/models/ConsentManagerRequest.js
npm notice 1.6kB src/models/ConsentRecord.js
npm notice 846B src/models/Grievance.js
npm notice 721B src/models/RightsRequest.js
npm notice 2.6kB src/services/complaintToTheBoard.js
npm notice 1.2kB src/services/consentManagerRequest.js
npm notice 1.6kB src/services/dataPrincipalRights.js
npm notice 2.4kB src/services/persistPIIwithconsent.js
npm notice 2.0kB src/services/withdrawConsent.js
npm notice 810B src/utils/principalId.js
npm notice Tarball Details
npm notice name: dpdp-fiduciary-toolkit
npm notice version: 0.2.0
npm notice package size: 15.2 kB
npm notice unpacked size: 46.8 kB
npm notice total files: 18
```

Confirmed: only `LICENSE`, `README.md`, `package.json`, and everything under `src/` (18 files total). No `.env`, no `test/`, no `examples/`. Matches the brief's expectation exactly.

Did not run `npm install` (per instructions - Task 2 needs the new devDependencies; `npm pack --dry-run` doesn't require them and worked fine unstalled).

### `git status` for `LICENSE` tracking (Step 3 of the "Your Job" list)

```
$ git status
On branch fix/dpdp-audit-remediation
Changes to be committed:
	new file:   .gitignore
	modified:   README.md
	new file:   data-fiduciary-toolkit/.env.example
	new file:   data-fiduciary-toolkit/LICENSE
	modified:   data-fiduciary-toolkit/README.md
	modified:   data-fiduciary-toolkit/package.json
```

`data-fiduciary-toolkit/LICENSE` shows as a tracked new file, not ignored. Double-checked with `git check-ignore -v` (no match, exit 1 = not ignored) and `git add --dry-run` (reports `add 'data-fiduciary-toolkit/LICENSE'`). `.env.example` also confirmed not ignored - `git check-ignore -v` shows it matches the `!.env.example` negation pattern in `.gitignore`, and `git status --porcelain --ignored=matching` reports it as `??` (untracked-but-trackable), not `!!` (ignored).

### Statute citation check

```
$ grep -rn "2025" README.md data-fiduciary-toolkit/README.md data-fiduciary-toolkit/package.json data-fiduciary-toolkit/.env.example
(no matches)

$ grep -rn "2023" README.md data-fiduciary-toolkit/README.md data-fiduciary-toolkit/package.json
README.md:9:Act, 2023.
data-fiduciary-toolkit/package.json:4:  "description": "Reference implementation of Digital Personal Data Protection Act, 2023 ..."
data-fiduciary-toolkit/README.md:4:Digital Personal Data Protection Act, 2023 (DPDP Act): capturing consent,
```

No stray "2025" statute references remain; all three citations I touched correctly say "2023".

### Em dash / en dash check on my additions

```
$ git show <commit> --unified=0 | grep '^+' | grep -v '^+++' | grep -P '[\x{2013}\x{2014}]'
(no matches)
```

No em dash or en dash introduced in any added line. (Pre-existing em dashes already in `data-fiduciary-toolkit/README.md`, e.g. in the API section headers and existing bullets, were left untouched - out of scope, not something the brief asked me to fix.)

## Files changed

- `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/.gitignore` (new)
- `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/README.md` (rewritten)
- `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/.env.example` (new)
- `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/LICENSE` (new, copied from root)
- `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/README.md` (edited: lines 1-46 and 130-141 equivalent regions)
- `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/package.json` (rewritten)

## Commit

`3dad92c` - "chore: fix packaging, license, and statute citations" (6 files changed, 320 insertions, 14 deletions), with the exact commit body and trailers specified in the brief's Step 9.

## Self-review findings

- Completeness: all 9 brief steps done, plus the 5 verification items in "Your Job" and both self-review checks in "Before Reporting Back."
- No em dash or en dash introduced (checked above).
- No statute citation changed to anything other than 2023 (checked above); no remaining "2025" reference to the Act.
- Discipline (YAGNI): did not touch `src/` logic, did not touch `examples/`, did not add a `test/` directory (Task 2's job), did not run `npm install` (per instructions), did not "fix" the pre-existing em dashes or other prose issues outside the brief's specified line ranges.
- Scope note, not fixed (intentionally, since it's outside the brief's specified line ranges 1-46/130-141): the nested README's "The five APIs" section (originally lines ~48-121, now ~67-139) still describes `principalId` as "derived from the email (SHA-256)" in five places (the `persistPIIwithconsent` example response and prose, plus repeated `"principalId": "sha256..."` examples in the other four endpoint snippets). This now visibly contradicts the new "What this is not" bullet I added at the brief's direction, which says `principalId` is "a random opaque identifier, not a hash of anything." This is expected and presumably intentional: the brief scoped my edits to lines 1-46 and 130-141 only, and Task 4 (which introduces `PRINCIPAL_ID_SECRET`-based random ids per the task list) is the natural owner of updating those API examples. Flagging this so it isn't missed - it should be corrected when Task 4's source change lands, or whichever task rewrites "The five APIs" section.
- Pre-existing, unrelated commits `e22b0db` and `db6a65d` already existed on this branch before I started (planning-doc additions from an earlier setup step) - confirmed they don't touch any file in my scope, no conflict.

## Concerns

None blocking. One informational note carried forward above: the "five APIs" section's `principalId`/SHA-256 language is now inconsistent with the corrected "What this is not" bullet, but fixing it is out of this task's scope per the brief's line-range restriction and belongs to a later task (likely Task 4).

---

## Fix round 1 of 5: `test` script does not run the suite (Critical)

### Finding

The coordinator's adversarial plan review found that `"test": "node --test test/"` fails on Node v26.3.1 (this machine's version, which satisfies the `engines.node: >=20` floor I set): `node --test` treats a positional argument as a module path to load, not a directory to scan for test files, so it errors with `Cannot find module .../test` and reports a failing suite regardless of what the real tests contain. This would have made every one of the 13 remaining tasks' `npm test` verification step fail for a reason unrelated to their own work.

### What I changed

`data-fiduciary-toolkit/package.json`, one line:

```diff
-    "test": "node --test test/",
+    "test": "node --test",
```

Nothing else in the file touched.

### Verification

Confirmed no `test/` directory exists yet (Task 2 creates it):

```
$ ls -la data-fiduciary-toolkit | grep -i test
(no output - directory does not exist)
```

Ran the corrected script in that state:

```
$ cd data-fiduciary-toolkit && npm test; echo "EXIT_CODE=$?"

> dpdp-fiduciary-toolkit@0.2.0 test
> node --test

ℹ tests 0
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9.47875
EXIT_CODE=0
```

Bare `node --test` does not error when `test/` is absent - it reports zero tests/suites found and exits 0. This is the sane state: Task 2, which creates `test/`, will start from a script that already works rather than one that needs a workaround.

### Commit

`fix: run node --test without a positional path` (see commit list below) - single-line change to `data-fiduciary-toolkit/package.json`, plus this report update.
