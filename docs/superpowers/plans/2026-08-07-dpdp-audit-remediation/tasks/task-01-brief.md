# Task 1 brief

Extracted from `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/plan.md`. Do not edit - regenerate if the plan changes.

## Global Constraints

These bind this task even where its steps do not repeat them.

- **Writing style:** always use a hyphen ( - ). Never an em dash or en dash. Applies to all code comments, prose, docs, and commit messages.
- **Statute citations:** the Act is the **Digital Personal Data Protection Act, 2023**. Never write "DPDP Act, 2025". The DPDP Rules, 2025 are a separate instrument and must be cited by their own name where referenced.
- **License:** `Apache-2.0`. The root `LICENSE` file (Apache 2.0) is authoritative; `package.json` must declare `"license": "Apache-2.0"`.
- **No secrets in source:** every org-specific value comes from an env var with a documented default. A placeholder default that would be shown to a data principal must fail startup instead.
- **`principalId` is never read from `req.body` or `req.query` on any route.** It comes only from `resolvePrincipal(req)`. Services still accept it as a parameter so they stay framework-agnostic.
- **Every value that reaches a Mongoose query filter must be validated as a primitive first.** Per-field validation in `src/utils/validate.js` is the primary control. `sanitizeFilter` is defence in depth and **must be set on the library's own connection only** - `connection.set("sanitizeFilter", true)`. **Never `mongoose.set("sanitizeFilter", true)`**: verified against mongoose 8.24 by executing real queries, that global setting makes a host application's own `Model.find({ age: { $gt: 5 } })` throw `CastError`, which is precisely the global-singleton hijack H8 exists to eliminate. Also verified: per-query `.setOptions({ sanitizeFilter: true })` does **not** sanitize and is silently inert - do not use it.
- **The consent ledger is append-only.** No code path may delete or mutate an existing event. Erasure removes PII from `Principal`, never events from `ConsentRecord`.
- **Test commands:** `npm test` runs the whole suite via bare `node --test` (no path argument). **Verified in this environment (Node v26.3.1): `node --test test/` FAILS** - it treats the positional `test/` as a module to load and reports a phantom failing test regardless of the real suite. Bare `node --test` discovers `test/**/*.test.js` correctly and treats `test/helpers/db.js` as a zero-test file. To run one file, invoke it directly: `node --test test/validate.test.js`. **Never write `npm test -- test/<file>`** - npm appends the argument, producing the broken two-path form. Every task that changes behaviour ships tests in the same commit.
- **Commit style:** conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). Every commit message body ends with the two trailer lines used in this repo:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K
  ```
- **Working directory:** all paths below are relative to `data-fiduciary-toolkit/` unless prefixed with `repo-root:`.
- **Finding IDs** (`C1`, `H5`, `M12`, `L3` ...) refer to [`spec.md`](spec.md) beside this plan. Every task lists the findings it closes; a task is not complete until each listed finding is actually addressed.

---

### Task 1: Repo hygiene, packaging, and license

**Closes:** H12, M12, M13, L1, L4, L7, L9, L10, L11 (doc half), L12

**Files:**
- Create: `repo-root:.gitignore`
- Create: `data-fiduciary-toolkit/.env.example`
- Modify: `data-fiduciary-toolkit/package.json`
- Modify: `data-fiduciary-toolkit/README.md` (lines 1-46 and 130-141)
- Modify: `repo-root:README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` script that later tasks rely on; the `engines` floor; the `.env.example` variable list that T12 validates against.

- [ ] **Step 1: Create `repo-root:.gitignore`**

```gitignore
node_modules/
.env
.env.*
!.env.example
*.log
npm-debug.log*
.DS_Store
coverage/
.superpowers/
```

- [ ] **Step 2: Create `data-fiduciary-toolkit/.env.example`**

Every variable the code reads. `PRINCIPAL_ID_SECRET` is added by T4 and is included now so the file is complete.

```bash
# Required - MongoDB connection string.
MONGO_URI=mongodb://localhost:27017/dpdp-toolkit

# Required - secret used to derive the lookup hash for a data principal's
# email and phone. Generate with: openssl rand -hex 32
# Changing this orphans every existing principal lookup, so treat it as
# permanent once you have data.
PRINCIPAL_ID_SECRET=

# Your organisation's identity, shown to data principals.
FIDUCIARY_NAME=Kavach Finance

# Grievance Officer / Data Protection Officer contact. The toolkit refuses
# to start if these are left at the example.com placeholder.
FIDUCIARY_DPO_NAME=Data Protection Officer
FIDUCIARY_DPO_EMAIL=dpo@example.com

# Days the Grievance Officer has to resolve a grievance before a data
# principal may escalate. Must be a positive integer.
GRIEVANCE_SLA_DAYS=7

# Example server only.
PORT=4000
```

- [ ] **Step 3: Rewrite `package.json`**

`express` moves to `peerDependencies` (L4), license becomes Apache-2.0 (M12), `files` allowlist added (H12), `engines` floor and `repository` added, `test` script added.

```json
{
  "name": "dpdp-fiduciary-toolkit",
  "version": "0.2.0",
  "description": "Reference implementation of Digital Personal Data Protection Act, 2023 data-fiduciary obligations: consent capture, withdrawal, data principal rights, grievance redressal, and consent manager handoff.",
  "main": "src/index.js",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/datsogood/dpdp-data-fiduciary-toolkit.git",
    "directory": "data-fiduciary-toolkit"
  },
  "engines": {
    "node": ">=20"
  },
  "files": [
    "src/",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "test": "node --test",
    "example": "node examples/server.js"
  },
  "peerDependencies": {
    "express": "^4.19.2 || ^5.0.0"
  },
  "dependencies": {
    "mongoose": "^8.5.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "express": "^4.19.2",
    "mongodb-memory-server": "^10.1.2"
  }
}
```

- [ ] **Step 4: Copy the LICENSE into the package directory**

The `files` allowlist references `LICENSE`, so the package needs its own copy:

```bash
cp ../LICENSE ./LICENSE
```

Add `LICENSE` to `repo-root:.gitignore`? **No** - it must be committed. Verify with `git status` that `data-fiduciary-toolkit/LICENSE` is tracked.

- [ ] **Step 5: Fix the statute citation and the two misstated obligations in `README.md`**

Line 4: change `Digital Personal Data Protection Act, 2025 (DPDP Act)` to `Digital Personal Data Protection Act, 2023 (DPDP Act)`.

Obligation 1 (line 10) currently overstates the language rule. Replace with:

```markdown
1. Consent must be requested through a clear, plain-language notice, and the
   data principal must be able to read that notice in English or in any
   language listed in the Eighth Schedule to the Constitution.
```

Obligation 13 (line 22) misstates the Significant Data Fiduciary test. Replace with:

```markdown
13. A Significant Data Fiduciary is one the Central Government notifies as
    such, based on factors including the volume and sensitivity of personal
    data processed and the risk to data principals - it is a notification,
    not a threshold an organisation self-assesses. An SDF must appoint a
    Data Protection Officer based in India, appoint an independent data
    auditor, and carry out periodic data protection impact assessments and
    audits.
```

- [ ] **Step 6: Fix the setup snippet (L10) and the README's own "not" list**

Replace the quickstart block at lines 30-46 with a version that runs. The top-level `await` is the bug:

````markdown
