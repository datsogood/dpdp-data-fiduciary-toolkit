# SDD ledger — plan: docs/superpowers/plans/2026-08-07-dpdp-audit-remediation.md

Branch: fix/dpdp-audit-remediation
Isolation: dedicated feature branch in the primary working directory (not main).
Pre-flight scan: one conflict found and fixed in the plan before Task 1 — T2 originally
committed a test that could only pass after T3. Rewritten so T2 builds its model inline
and ends green; T3 swaps it to buildModels. No remaining plan self-contradictions.

Tasks: 14. Findings: 43 (C1-C4, H1-H12, M1-M15, L1-L12).

Task 1: complete (commits db6a65d..3dad92c, review approved)
Task 1: minor (deferred): pre-existing em dashes in README "five APIs" section - T14 territory
Task 1: PLAN-MANDATED findings raised, awaiting human ruling:
  T1 Step 2/6 wrote docs describing behaviour that lands in T4/T7/T12:
   (a) README "principalId is a random opaque identifier keyed with PRINCIPAL_ID_SECRET"
       - false until T4; src/utils/principalId.js still does sha256(email)
   (b) README three-state ledger granted/denied/withdrawn - false until T7; enum is 2-state
   (c) README quickstart wires createRouter({db, resolvePrincipal}) as "Required"
       - createRouter() takes zero params until T5
   (d) .env.example "toolkit refuses to start if DPO email is the placeholder" - false until T12
  Also confirmed: README:85 and 5 examples still say principalId is sha256(email),
  contradicting the new bullet. T14 owns rewriting that section.
Task 1: PLAN-MANDATED ruling: human chose "accept forward-referencing docs" - branch lands
  as one PR, T14 re-syncs the README. No change to T1. Findings recorded, not fixed.

PLAN REVISION 1 (after adversarial plan review: 26 defects survived, 47 refuted)
  Verified by execution before accepting:
   - `node --test test/` FAILS (phantom failing test); bare `node --test` works. CRITICAL.
   - mongoose.set("sanitizeFilter",true) makes a HOST app's {$gt:5} query throw CastError.
     connection.set(...) is correctly scoped: host unaffected, library sanitized.
     Per-query .setOptions({sanitizeFilter:true}) is silently INERT - reviewer's alt fix wrong.
   - DPDP s.7(b) is the State subsidy clause, NOT legal obligation. s.7(d) is disclosure-to-State
     only. Section 7 has no general legal-obligation ground for a private fiduciary.
  Plan changes made:
   - test script -> "node --test"; all per-file runs -> `node --test test/x.test.js`
   - sanitizeFilter moved to connection.set() in T3; global set deleted from T2/T3; new test
   - T6: kyc split into kyc_reporting (7(d), non-withdrawable) + identity_verification
     (consent, withdrawable); clause allow-list test replaces /^Section 7/ prefix
   - T4: added read-only findPrincipalByContact + findPrincipalById
   - T5: 409 must be checked BEFORE any write; PUT /consent added for authenticated update
     (regrant was unreachable); identity from req.principalId never from payload (403 on
     cross-principal); await resolvePrincipal; body normalisation (single checkbox string,
     consentSubmitted signal, flat<->nested pii); POST /consent/withdraw added; error mapper
     moved here from T12 with 5xx no-leak + CastError->400; 3 services' throws -> AppError
   - T7: E11000 recovery recomputes the delta and re-applies the notice instead of replaying
   - T8: buildNotice wired into POST /consent; notice gains personalData/withdrawal/
     boardComplaint; NOTICE_LANGUAGES added to .env.example
   - T11: resolution field added to Grievance; "escalated" removed from GRIEVANCE_TRANSITIONS;
     null-safe re-escalation guard; RIGHTS_SLA_DAYS added to .env.example
   - T13: forms actually submitted in tests; single-checkbox case covered
   - T14: example gains POST /demo/login so authenticated routes are reachable; M13 stated
     honestly as documented-not-fixed; .env.example completeness check
  EXECUTION ORDER CHANGED (task numbers stable): 1,2,3,4,6,7,9,5,8,10,11,12,13,14
    T5 moved after T7/T9 - its POST /consent tests cannot pass while the consent service is
    mid-refactor between T3 and T7.
Task 1: fix round 1/5 (1 addressed, 0 open - npm test script; commits 3dad92c..669db77)
Task 1: re-review ADJUDICATED BY CONTROLLER rather than dispatched. Reasoning: the fix diff is
  a single line in package.json ("node --test test/" -> "node --test"), I read it in full, it
  matches the value the revised plan specifies verbatim, and I had already verified bare
  `node --test` empirically before raising the finding. Implementer reported `npm test` ->
  tests 0 / fail 0 / exit 0 in the pre-Task-2 state. No code path, no logic, nothing a fresh
  reviewer could add. Recorded here rather than silently skipped.
Task 1: complete (commits db6a65d..669db77, review approved + 1 fix round)

Task 2: NEEDS_CONTEXT at first dispatch, resolved. Implementer found the brief's TDD order
  unworkable: pre-fix withdrawConsent resolves ConsentRecord from the global mongoose
  singleton, which the harness never connects, so the malicious query hit a 10s buffering
  timeout instead of reproducing the vulnerability. Ruled: resequence within the task -
  inject `models` first (mechanical, no behaviour change), THEN run the red phase (which now
  genuinely reproduces C2: operator matches the victim and appends an event), THEN add the
  guard. Rejected the alternative of connecting the global default in the test helper, which
  would contradict the isolation T3 establishes. Plan corrected at T2 Step 8.

  NOTE ON THE REVIEW PROCESS: the adversarial plan review DID raise this, twice -
  "(coverage) F20: Task 2's injection test cannot reproduce C2, so the stated expected failure
  is wrong" and "(tests) F6: the documented red-phase reason is wrong". My refutation pass
  killed both. The implementer then proved them correct by execution. So the refuter
  over-refuted on at least these two, and refuted findings are not safe to discard
  unexamined - worth weighting when reading the remaining 47 refutations.

PLAN REVISION 2 - re-examined the 47 refuted plan-review findings after the refuter was shown
  to have over-refuted on Task 2. Judged each of the substantive-looking ones myself:
   - design F8 (router broken in transit), design F13 (requireAuth does not check existence):
     refutations HOLD. Transitional state; host contract. No change.
   - design F1 (shared phone): refuted on the WRONG AXIS. The refuter checked only the attack
     path and correctly found the 409 blocks it, but never checked the legitimate path: mother
     registers with shared phone X, daughter registers a different email with phone X,
     findPrincipalByContact matches phoneHash, daughter gets 409 and CANNOT REGISTER. Real
     functional defect for the stated audience. FIXED: signup matches on emailHash only when an
     email is supplied, phoneHash only when there is none; email correction moves to a new
     authenticated updatePrincipalContact() taking identity from the session, which also
     removes an identity-inference path in the spirit of C1. Two new tests: shared-phone
     registration, and refusing to steal another principal's email (409).
   - design F17 (decide() ignores withdrawable): refutation technically holds for the shipped
     catalog, but it is a footgun for adopters. FIXED defensively - one line, decide() now
     returns null instead of "withdrawn" for a non-withdrawable purpose, so POST /consent and
     withdrawConsent agree by construction rather than by catalog coincidence.
   - design F15 (erasure leaves PII in request free-text): out of scope of any reviews.md
     finding, as the refuter said, but the JSDoc claim was loose. FIXED as documentation: an
     explicit KNOWN LIMIT block stating that a deployment treating this as a complete Section 12
     erasure, without reviewing the three request collections, has not completed it.
  Re-examined the four refuted LEGAL findings (they bear on T7/T9, both imminent):
   - DPDP-05 (ledger retention after erasure has no legal basis): refutation HOLDS. It cites
     verified Rule 8(3) - a minimum one-year retention of personal data and processing logs -
     which is the "compliance with any law" limb of s.8(7). Retained artefact carries no PII.
   - DPDP-06 (parental consent self-declared): refutation HOLDS on the mechanism - parentalConsent
     is never wired to HTTP or any form, so a minor cannot supply it; it is a server-side
     parameter like resolvePrincipal. BUT the refutation surfaces a real gap it did not name:
     a minor with a genuinely consenting parent therefore cannot register over HTTP at all.
     Not expanding scope (H4 does not ask for identity verification) - added T9 Step 6b
     requiring this be stated in the README as a limitation, plus an explicit warning never to
     expose parentalConsent to a form.
   - DPDP-08 (legitimate uses recorded as "granted" asserts consent): refutation HOLDS. The
     required lawfulBasisKind field sits alongside status on every event and is surfaced by
     getConsentState, so the ledger records authorisation and names the non-consent basis.
   - DPDP-10 (mandatory dob over-collects): refutation HOLDS. reviews.md H4 itself prescribes
     "dob (or an age band)", every plan fixture already carries dob, and in the worked example
     (a lender) dob is collected anyway.
  Net: the refuter was right on 4 of 4 legal findings and wrong on 2 test-sequencing findings
  plus the axis of 1 design finding. Refutations are useful but not authoritative.

CONTROLLER ERROR, corrected: I ran `git add -A` for my own plan-doc commits while the Task 2
  implementer had uncommitted work in the same working tree. That swept its source files and
  tests into commits a53f705 and 57ef186 under docs: messages. The implementer correctly
  reported "nothing to commit" and did not touch history itself. Fixed by soft-resetting to
  669db77 and recommitting by path: docs separately (2beb36d), all Task 2 code under its
  proper fix: message (b67b548). Tests re-verified 6/6 after the rewrite, tree clean.
  LESSON for the remaining 12 tasks: never `git add -A` while an implementer is live. Stage by
  explicit path, or commit only between dispatches.
  Cosmetic residue accepted: 6c2261d and 2beb36d share a subject line. Both bodies are
  accurate and they are separated by a code commit. Not worth a second history rewrite.
Task 2: implementer DONE_WITH_CONCERNS (concern was the commit collision above, now resolved)
Task 2: 6/6 tests pass, output pristine. TDD evidence shows all three states with the red
  phase reproducing the real vulnerability (operator matched victim, events 1 -> 2).
Task 2: task review APPROVED, spec compliant. Reviewer independently confirmed the red phase
  reproduced the real vulnerability (resolved-instead-of-rejected + victim docRef matched +
  events 1->2), not a timeout. No Critical, no Important.
Task 2: minor (deferred): withdrawConsent.js:32 loops the raw `consentTypes` param rather than
  the `types` value returned by assertStringArray. Behaviourally identical today; would matter
  only if assertStringArray ever sanitizes rather than validates. T7 rewrites this whole file -
  carry the pointer there.
Task 2: minor (deferred): no test exercises the new maxlength caps at the Mongoose validation
  layer. Brief specified no test for Step 11. Candidate for T14's suite completion.
Task 2: complete (commits 2beb36d..b67b548, review approved)
Task 3: task review APPROVED, spec compliant. Reviewer independently confirmed connect() leaves
  mongoose.connection at readyState 0, zero occurrences of mongoose.set( in the diff, all four
  models converted, buildModels idempotent, all six services threaded, no global fallback.
Task 3: PLAN-MANDATED finding handled without a fix round, deliberately: the T3 connection tests
  call conn.close() inside try rather than finally, so a failing assertion leaks the connection.
  Copied verbatim from my plan, so it is my defect not the implementer's. Practical impact is
  ~zero (single node --test process, handles reaped at exit) and the reviewer itself graded it
  borderline Important/Minor with "no action needed from the implementer". Handled two ways
  instead of a fix round: (1) the PLAN is corrected so the pattern cannot propagate into the
  ten remaining tasks, (2) the existing instance is deferred to T14's suite pass. Not dismissed.
Task 3: minor (deferred): existing conn.close()-in-try instances in test/connection.test.js -> T14
Task 3: minor (deferred): buildModels attaches $dpdpModels to any duck-typed connection, incl. one
  a host passes in. Low risk, mechanism specified by the plan. -> note in T14 docs
Task 3: complete (commits b67b548..8a76f1e, review approved)
Task 4: implementer DONE, 19/19. Both judgement questions answered empirically (mongoose 8.24
  auto-inits a bare nested path to {} so the toObject guard is defensive not load-bearing;
  phoneHash/emailHash confirmed sparse-not-unique against a real index listing).
Task 4: task review (opus) - all 9 security properties VERIFIED, incl. erasure confirmed at the
  raw-document level ($unset, not set-to-null, so nothing survives on disk). No Critical.
  4 Important, 3 reproduced empirically by the reviewer:
   1. PLAN-MANDATED: the phone clash check 409s a principal resubmitting their OWN unchanged
      phone when another principal shares it. Directly contradicts the shared-handset design
      that phoneHash-non-unique exists to serve, and would lock the stated audience out of the
      s.12 correction right once T5 wires a profile-update endpoint. MY plan defect - the brief
      mandated a two-field clash loop while the same brief argued phone clashes are legitimate.
      Not asked of the human because the fix RESOLVES a self-contradiction in the plan rather
      than contradicting it: email-only uniqueness is what the plan's own rationale requires.
   2. Check-then-act race: two concurrent updates claiming one email both fulfilled,
      countDocuments(emailHash) = 2. Fix: unique+sparse on emailHash, catch 11000 -> 409.
   3. Erasure not terminal: update-after-erase writes PII back, leaving erasedAt set AND live
      PII, re-identifiable again. Fix: reject 409 when erasedAt is set.
   4. PLAN-MANDATED: erasure test asserts 3 of 8 cleared fields; phoneHash unasserted, so
      deleting that line leaves the suite green. Adding assertions contradicts nothing.
  Plan corrected for 1, 2, 3 and 4 before dispatching. Fix round 1 sent to the implementer.
Task 4: fix round 1/5 dispatched (4 Important + 3 minors: secret() entropy floor,
  findPrincipalById coverage, symmetrical dead-code removal)
Task 4: fix round 1/5 (4 addressed, 0 open; commits cec9aa2..7d8c5e7). Re-review verified each
  new test would genuinely fail if its property broke - incl. confirming the concurrency test
  exercises real interleaving (its RED mode "both fulfilled" is only reachable if both clash
  checks passed before either save committed).
Task 4: Principal.init() addition ACCEPTED on the merits. Reviewer confirmed nothing in the
  codebase awaited index-build completion before this, so the race window was open in
  PRODUCTION indefinitely, not just in tests. Placement per-call is not ideal; buildModels is
  the natural choke point but is sync and called sync in all 23 tests, so making it async was
  out of this round's mandate.
Task 4: minor (deferred) -> T5/T14: hoist a single `await models.Principal.init()` into the
  startup path once buildModels has an async entry point; per-call guards then become
  redundant-but-harmless.
Task 4: minor (deferred): the erasedAt guard is read-then-act, so a correction racing a
  concurrent erasure could still reach "erasedAt set AND live PII" via a different pair of calls
  than the one tested. Narrow. -> flag in T14 docs as an erasure-atomicity limitation.
Task 4: minor (deferred): secret() now requires >=32 chars - operational note for anyone with an
  existing shorter PRINCIPAL_ID_SECRET. .env.example already says `openssl rand -hex 32` (64 chars).
Task 4: minor (deferred): pre-existing em dashes in src/index.js and persistPIIwithconsent.js
  comments -> T7 rewrites the latter, T14 the former.
Task 4: complete (commits 638fd58..7d8c5e7, review approved + 1 fix round)
Task 6: implementer DONE, 30/30. Caught a real bug in my brief: assert.notMatch does not exist
  in Node's assert module (verified: require('assert').notMatch === undefined); used
  assert.doesNotMatch. Plan corrected globally.
Task 6: task review APPROVED. Reviewer independently checked EVERY clause citation against the
  statute text: kyc_reporting/7(d) correct for the PMLA disclosure limb, identity_verification
  correctly consent-based as wider than that duty, underwriting's GDPR contractual-necessity
  basis gone, no entry cites 7(b) or 7(c), erasure wording fixed for L5. Also independently
  confirmed no pre-existing test depended on entry.basis/entry.required, and grepped the tree
  to confirm only the two Task 7 files still reference the deleted fields.
  Controller resolved the reviewer's one cannot-verify item: checked `git log -1 4721d1d`
  directly, both required trailers present and exact.
Task 6: 2 Important, both PLAN-MANDATED test-coverage gaps in MY brief, both fixed in the plan
  and dispatched as fix round 1 (not asked of the human - strengthening a test contradicts
  nothing the plan intends, and finding 2 was self-disclosed by the implementer):
   1. ALLOWED_S7_CLAUSES accepts any of the 9 real letters, so reverting kyc_reporting to the
      wrong-but-real "Section 7(b)" would still pass. Protection came only from a separate
      dedicated test that exists by luck of that entry being named. Added a second list of
      clauses a PRIVATE fiduciary can actually rely on (7(a),(d),(e),(f),(i)) - 7(b)/7(c) are
      State-side. Asked the implementer to push back if my letter list is wrong.
   2. No generic invariant ties withdrawable to lawfulBasis.kind, so marketing/analytics are
      unasserted and a future edit could silently make one non-withdrawable. Added a loop.
   3. Minor, fixed now not deferred: prohibitedForChildren was on 2 of 5 entries (my brief's
      asymmetry). Normalised to all five + a test that every entry declares it explicitly,
      since T9 branches on it and omission-reads-as-false is not a decision.
  Fix round instructed to prove each new test fails against a deliberately broken catalog
  before keeping it - finding 1 exists precisely because one of my tests could not fail.
Task 6: fix round 1/5 dispatched
Task 6: fix round 1 - implementer PUSHED BACK on my PRIVATE_FIDUCIARY_S7_CLAUSES list and was
  CORRECT. I had excluded 7(g) and 7(h). Verified against the statute text: 7(g) ("measures to
  provide medical treatment or health services ... during an epidemic, outbreak of disease, or
  any other threat to public health") and 7(h) ("measures to ensure safety of, or provide
  assistance or services to, any individual during any disaster, or any breakdown of public
  order") carry NO State restriction - a private hospital can rely on 7(g), a private relief
  organisation on 7(h). Only 7(b) and 7(c) are State-limited. Plan corrected to the
  implementer's list. This is the second time asking an implementer to argue rather than encode
  a guess has caught an error of mine.
Task 6: fix round 1/5 (3 addressed, 0 open; commits 4721d1d..d9d91f4). Re-review verified the
  clause list matches 7(a),(d),(e),(f),(g),(h),(i) exactly and reasoned independently that all
  three new tests would genuinely fail on a deliberate break. Diff purely additive.
Task 6: minor (deferred): ALLOWED_S7_CLAUSES is now redundant alongside the narrower
  PRIVATE_FIDUCIARY_S7_CLAUSES test. Harmless; pruning not requested. -> T14 if tidying.
Task 6: minor (deferred): withdrawable is enforced at test time, not derived in the catalog
  itself. Implementer's own point, out of scope for the findings. -> note in T14 docs.
Task 6: complete (commits 7d8c5e7..d9d91f4, review approved + 1 fix round)
Task 7: implementer DONE_WITH_CONCERNS, 53/53 (33 pre-existing + 20 new). Verified the state
  table by killing 12 single-line mutants of decide(); added tests for rows 4, 5, 8 and the
  withdrawable guard, which my brief had left untested. Dropped my $dpdpNewEvents hack for
  inline closures. Found TWO defects in my brief:
   - withdrawConsent(["marketing","marketing"]) appended two withdrawn events to an append-only
     ledger. Deduplicated with a test. Plan corrected.
   - my test secret "test-secret-not-for-production" is 30 chars, under T4's 32-char floor.
     Plan corrected globally to a 41-char value.
Task 7: task review (opus) - all 8 state-table rows CORRECT and each pinned by a non-vacuous
  test; reviewer spot-checked the mutation claims and confirmed they are not padding; recovery
  genuinely recomputes against the winner; decision logic in exactly one place; ConsentRecord
  .init() judged justified not cargo-culted (traced principalId unique:true, so E11000 needs a
  built index); M3 confirmed not regressed. 1 Important blocker:
   - consentTypes: null reinstates C3. consentSubmitted = (consentTypes !== undefined) is TRUE
     for null, and assertStringArray maps null to [], so null walks the granted+absent row and
     withdraws every live optional consent. Unrecoverable on an append-only ledger. Not
     exploitable today (no HTTP caller until T5) but escalates to Critical the moment T5 passes
     a body through, and the defence belongs at the service boundary. The two services also
     disagreed: withdrawConsent already 400s on null.
  Plan corrected + fix round 1 dispatched with 3 minors (updatedAt on notice-only change,
  effectiveFrom on a no-op withdrawal, race test can silently degrade to a no-op).
Task 7: NAMED FOLLOW-UP (not deferred-and-forgotten): concurrent writes to an ALREADY EXISTING
  ConsentRecord append duplicate same-status events. Reviewer walked the adversarial
  interleavings and confirmed currentState() is correct in every one, so it is ledger noise not
  state corruption, and strictly better than the pre-change behaviour. Real fix is optimistic
  concurrency (__v guard + retry) on ConsentRecord, which also makes concurrent PII-only updates
  throw VersionError. Owner: post-branch, or T14 if it can be done without destabilising.
Task 7: fix round 1/5 dispatched
Task 7: fix round 1/5 (4 addressed, 0 open; commits 2b9596e..d1de99e). Implementer improved on
  my instructions twice: found the SAME updatedAt nesting bug in the recovery path (fixing only
  the first attempt would have left the two paths disagreeing), and replaced my timing-dependent
  race test with a CONSTRUCTED one that stubs findOne to miss once, forcing the E11000 so the
  recovery is the only route through. Re-review judged that legitimate fault injection at the
  right seam, not a mock testing itself - every downstream step runs against real Mongo and the
  assertions check persisted state. Killed by two distinct mutants.
Task 7: null probe confirmed worse than the review described - pre-fix, consentTypes: null
  revoked THREE live consents at once (underwriting, marketing, analytics).
Task 7: minor (deferred) -> T14: `created` in the persistPIIwithconsent return value names the
  Principal, not the ConsentRecord. Ambiguous; rename.
Task 7: minor (deferred/accepted): withdrawConsent 400s on consentTypes: null while
  persistPIIwithconsent treats null as omission. Intentional asymmetry - withdrawal has no
  "no decision" semantics to fall back to. Document in T14 rather than unify.
Task 7: minor (deferred): suite runtime now ~25s, driven by MongoMemoryServer instances per
  test file. Watch it; consider a shared server in T14 if it keeps growing.
Task 7: complete (commits a202e92..d1de99e, review approved + 1 fix round)
BASELINE VERIFIED after my own tooling error: 56/56 pass, 25.3s, warm cache.
  CONTROLLER ERROR: I let three foreground `npm test` runs time out into the background, giving
  12 concurrent node --test processes (one per test file per run) fighting for CPU and ports.
  The suite looked like it had slowed 25s -> 196s. My pkill then killed 5 test files mid-run,
  producing a "23 tests, 18 pass, 0 fail" result that looked like breakage but was my cleanup.
  Nothing was wrong with the code. Rule added: always run the suite with run_in_background,
  never let it time out into the background, and never pkill without checking what is mine.
REAL DEFECT found underneath it, now assigned to T14 Step 4b: on a COLD mongod binary cache the
  suite genuinely fails - 3 of 56, each the first test in its file, each ~11ms, racing for
  ~/.cache/mongodb-binaries/<ver>.lock. A fresh clone's first `npm test` fails and the second
  passes. Fix: pretest binary warm-up + pinned mongod version + a
  `rm -rf ~/.cache/mongodb-binaries && npm test` verification. Also measure the 8s -> 25s
  runtime growth rather than leaving it unmeasured.
Task 9: fix round 1/5 (1 addressed, 0 open; commits d7d619b..cf5e192). I re-verified both
  timezone cases myself against the shipped module: NY Aug7 23:30 -> 17 (was 18), IST Aug8
  00:30 -> 18 (was 17), and all 8 cases pass in UTC / New_York / Calcutta / Kiritimati(+14).
  Re-review traced an all-UTC regression by hand and confirmed the new TZ subprocess test fails
  on the very first non-UTC iteration - it is not decorative. Implementer supplied
  deliberate-break evidence with pasted output plus a `diff` proving byte-identical restoration.
Task 9: complete (commits 17c553e..cf5e192, review approved + 1 fix round)

PROCESS NOTE: the age-gate bug needed all four layers to catch. My plan had the original defect;
  the implementer found it but shipped a fix that did not work and reported it verified from
  reasoning alone; the reviewer caught that by EXECUTING the claimed repro; I confirmed and
  diagnosed the real root cause (dob is a calendar date, asOf is an instant - they must be read
  in different frames). Standing rule now in the plan: timezone and boundary claims need a
  subprocess test, not an argument.

Task 5: implementer DONE_WITH_CONCERNS, 77/77 (65 baseline + 12 new). Was interrupted mid-task
  by an API error; resumed with context intact. It correctly reported that the interruption
  landed mid-complaintToTheBoard.js with the AppError edits on disk but the escalateToBoard
  ownership check not yet written, and reconstructed it from the brief rather than guessing -
  the reviewer independently confirmed the file is complete and shows no half-edit.
Task 5: task review (opus) APPROVED. All four C1 properties VERIFIED from code:
   1. the 409 fires before any write (findPrincipalByContact at router.js:138, throw at :139,
      service not reached until :142) and its guarding test is non-vacuous - full document
      comparison plus a positive pii.name assertion plus countDocuments
   2. PUT /consent passes principal.pii.toObject(), the STORED record, so no payload path can
      redirect the write; assertOwnContact 403s a mismatch
   3. default-deny on all seven mutating routes; POST /consent is the only unauthenticated one
   4. resolvePrincipal is awaited, with a throw mapped to 401 not 500
  Reviewer also confirmed by grep that NO route anywhere reads principalId from body, query or
  params, and that ownership is checked before status in escalateToBoard, closing a status
  oracle the brief never asked about.
Task 5: 1 Important, subtle and genuinely new - PUT /consent resolves identity TWICE. It loads
  by req.principalId, then discards that and lets persistPIIwithconsent re-derive by contact
  hash. phoneHash is deliberately non-unique, so the query can have two candidates and the
  winner is decided by MongoDB insertion order, not by anything asserted. Probed and currently
  correct - but only incidentally. Deterministic trigger needing no collision: rotate
  PRINCIPAL_ID_SECRET, every emailHash goes stale, and an authenticated update MINTS A NEW
  PRINCIPAL with the old one's PII, returns the new id, and forks the ledger.
  Took the structural fix over the assertion: persistPIIwithconsent gains an optional
  principalId that short-circuits findOrCreatePrincipal. Plan updated, briefs 5 and 7 regenerated.
Task 5: NEW FINDING WITH AN OWNER - CSRF. The original audit REFUTED a CSRF finding, correctly:
  with no ambient credential a cross-site POST conferred nothing curl could not. Task 5 changes
  that - resolvePrincipal will be cookie-backed, and POST /consent/withdraw exists so an HTML
  form can reach it. A forged withdrawal writes to an append-only ledger. The library cannot
  issue CSRF tokens (it owns no session store, by design), so T12 gains an Origin check plus
  README guidance that hosts must set SameSite. Must land before T13 renders a form.
  This is the audit's own section 6 prediction coming true: "becomes a real finding the moment
  C1 is fixed with cookie-based sessions".
Task 5: fix round 1/5 dispatched (1 Important + 4 minors: vacuous body-principalId test,
  missing urlencoded withdrawal test, onGrievanceFiled throw loses the refId, narrow
  victim-ledger assertion)
Task 5: minor (deferred) -> T13: GET /consent/new and GET /consent/withdraw are in the brief's
  route table but not implemented. GET /consent is T10's. Confirm T13 claims the other two.
Task 5: minor (deferred) -> T14: mongod-per-withDb flake, one port-bind failure in five runs.
  Reviewer's point is right that flake rate scales with every task that adds tests, and a suite
  failing 20% of the time trains people to re-run rather than read.
Task 5: fix round 1/5 (1 Important + 4 minors addressed, 0 open; commits d3b8f42..4a805b9).
  81/81. Implementer PROVED the finding by reverting the one-line fix and capturing the failing
  output - a different, newly minted principalId came back. It also disclosed that the household
  test passed WITHOUT the fix, confirming the reviewer's diagnosis that MongoDB insertion
  ordering had been supplying the guarantee.
Task 5: re-review named which tests actually discriminate: ONLY the secret-rotation test fails on
  a revert. The household test and the countDocuments assertions pass either way, because an
  un-rotated principal's own stored email re-finds its own document. Worth remembering - "the
  required test was added" is not the same as "the property is guarded".
Task 5: minor (deferred): the onGrievanceFiled try/catch has no automated test, only a manual
  console trace. Nothing would fail if it were deleted. -> T12 or T14.
Task 5: judgement calls both upheld by the reviewer - (a) the age gate must run on the update
  path too, because isMinor is read by decideFor, so skipping it would make PUT /consent a route
  where a child can be granted marketing; a stored principal with no dob now 400s on a consent
  update, which is the more defensible failure; (b) onWithdrawal stays fatal while
  onGrievanceFiled becomes non-fatal - a re-submitted withdrawal is idempotent and returns
  noChange, whereas a re-filed grievance creates a second document, and onWithdrawal is the
  host's only signal to cease processing.
Task 5: FORWARD DEPENDENCY handled - T12's planned fault-injection test used onGrievanceFiled
  throwing to force a 500, which this fix makes non-fatal. Plan updated to use onWithdrawal via
  PUT /consent/withdraw instead. T12 brief regenerated.
Task 5: complete (commits 05a283f..4a805b9, review approved + 1 fix round). C1 CLOSED.

Task 8: implementer DONE, 90/90, then fix round 1 (3 Important + 3 minors addressed; commits
  77c4cfd..d26299b), 94/94. It raised two of the three findings ITSELF and was right on both.
Task 8: task review found the notice core solid but three Important:
   1. per-record lastNotice cannot support H3's claim. Concrete case: grant marketing in Jan,
      catalog changes June, grant analytics July -> January's notice gone entirely, not even its
      hash surviving. DESIGN CHANGED on the implementer's recommendation, which the reviewer
      reached independently: content-addressed NoticeVersion side collection, noticeVersion
      stamped per EVENT, lastNotice reduced to a pointer. Storage grows with distinct notices,
      not with consent events.
   2. the new `withdrawal` right silently no-opped - and was WORSE than pre-diff, where it was
      rejected as unknown. Recognised, listed on the rights page promising withdrawal "as easily
      as you gave it", and fake-succeeding with a manual ticket. Same failure class as H2/C4,
      freshly created. Now redirects to the self-service flow.
   3. the PUT notice test COULD NOT FAIL - it signed up via POST (which sets lastNotice), then
      asserted the field was truthy, which setup guaranteed. Deleting PUT's wiring left it green.
      Exactly the false-green my own Step 4b warning existed to prevent, relocated one route
      over. Now asserts shownAt moves, with executed deliberate-break evidence in the report.
Task 8: re-review went past the ask - fired 5 concurrent upserts at one version key, with and
  without the index pre-built, and found exactly ONE document every time, no error. So the floor
  is better than disclosed: not "at worst a harmless duplicate" but no duplicate at all on this
  stack. It named the real residual gap: the NoticeVersion updateOne has no 11000 catch, so a
  MongoDB version that did surface one would fail the request (not corrupt evidence).
Task 8: minor (deferred) -> T14 Step 4c: pre-existing em dashes in six src/ files no task
  rewrote wholesale. Every task correctly enforced the rule only on lines it touched.
Task 8: minor (deferred) -> T14 Step 4d: ConsentRecord documents written before the lastNotice
  shape change retain lastNotice.body at rest, and strict mode drops it silently on next
  read/save. Package is unpublished so no migration script, but the README must say so.
Task 8: complete (commits 5bca5e0..d26299b, review approved + 1 fix round)
Task 10: implementer DONE, 102/102, then fix round 1 (3 Important + 3 minors; commits
  dc236e2..74de8d3), 105/105. C4 CLOSED.
Task 10: task review (opus) APPROVED - could not construct any cross-principal read. It tried
  operator injection through principalId, an undefined principalId collapsing the filter to
  match-all, spread-built filters, fetch-then-check timing leaks and route shadowing; all held.
  It also checked each cross-principal test for vacuity and confirmed none passes for the wrong
  reason, noting the implementer created a second REAL principal rather than re-pointing
  resolvePrincipal at an unknown id. 3 Important:
   1. the ledger dropped noticeVersion - MY Step 3 defect. It undercut the implementer's own
      (correct) justification for not resolving notice bodies, which rested on the ledger
      carrying that pointer. Also internally inconsistent: currentState() serialises raw event
      subdocs which DO include it, so the present exposed the pointer and the history hid it.
   2. the PII reads were cacheable - first cacheable responses in the toolkit carrying personal
      data, on a URL with no user-identifying component. Fixed with no-store + Vary: Cookie.
   3. escalateToBoard was still an existence oracle (403 for another principal's grievance while
      the new getGrievance 404s the same probe). Folded principalId into the filter; the Task 5
      test was UPDATED in place, not deleted, and still proves a non-owner cannot escalate.
Task 10: re-review honestly flagged that one new test (valid-but-nonexistent refId) guards
  pre-existing code and would pass regardless of this round - good calibration, kept anyway
  since it closes a real coverage gap.
Task 10: minor (deferred) -> follow-up: no GET /consent-manager/requests/:refId item route;
  ConsentManagerRequest.updatedAt has a creation default but no code path mutates it;
  consentManagerRequest.js's function-export-with-property shape is an ESM interop hazard.
Task 10: complete (commits b8391ca..74de8d3, review approved + 1 fix round)

PULLING TEST INFRASTRUCTURE FORWARD from T14. The mongod-per-withDb flake has now hit on
  Task 5's and Task 10's runs. Each task adds withDb calls and each call boots its own server,
  so exposure grows monotonically - and four tasks plus the whole-branch review still depend on
  a trustworthy suite. Fixing it now rather than at T14, where it would only protect the last
  task's own verification.
TEST INFRA FIXED (commit 739fb3b), pulled forward from T14. One mongod per PROCESS - so one per
  test file under node --test, 8 rather than 76 - with each withDb getting a fresh database on
  it, plus a pretest binary warm-up. Results: 105/105 across five consecutive runs, no flakes;
  38.4s -> ~19s. Cold cache passes first time, verified against both real cache locations.
  I independently confirmed run 1 at 105/105 in 18.3s.
  Implementer's two honest notes: (a) it put warm-binary.js in scripts/ not test/helpers/,
  because node --test counts any file under test/ as a phantom test - and test/helpers/db.js
  ALREADY does this, so the 105 baseline includes one phantom; (b) it could not reproduce the
  original cold-cache lock race on this mongodb-memory-server version, which has a proper
  lock-wait, and kept pretest anyway because it removes the race by construction.
  T14 Step 4b replaced with a re-verification step: run the suite three times at the end of the
  branch rather than assuming it stayed fixed while six tasks added tests.
Task 11: implementer DONE_WITH_CONCERNS, 111/111, then fix round 1 (commits 3add911..c900f6b),
  113/113. Task review APPROVED with no Critical and no Important in its own work.
  Reviewer independently confirmed both invariants: "escalated" never appears as a TARGET in any
  GRIEVANCE_TRANSITIONS array so it is unreachable from every from-state including itself, and
  resolution genuinely persists because the test re-queries the document rather than trusting the
  returned object. It verified mutation is atomic (assertTransition throws before any assignment,
  proved by two tests re-fetching after a rejected call), that every schema enum aligns 1:1 with
  its transition map keys with no orphaned states, and grepped every RightsRequest.create call
  site to confirm making slaDueAt required breaks nothing.
Task 11: all three implementer concerns upheld. The 6-vs-4 test count was MY stale brief text -
  Steps 4 and 5 ask for assertions the Step 1 code block does not contain. Leaving pre-existing
  em dashes was correct under surgical-changes discipline. And the resolution-not-on-the-read-path
  concern was a real Section 13 gap: a principal saw status "resolved" with no explanation, on a
  read path built by T10 that was hiding the very field T11 created.
Task 11: fix round re-review ADJUDICATED BY CONTROLLER. The diff is four additions of the word
  `resolution` to four projections in two files, plus tests; I read it in full, it is mechanically
  obvious, and the suite is green at 113/113 with readpath 11/11 also verified. Recorded rather
  than silently skipped.
Task 11: NEW FINDING from the implementer, correctly not fixed out of scope: slaDueAt has the
  IDENTICAL read-path gap. listGrievances/getGrievance include it; listRightsRequests/
  getRightsRequest do not - so a principal cannot see when their rights request is due, which is
  exactly when they would know to chase it. Carried into T12's dispatch.
Task 11: complete (commits ab8da78..c900f6b, review approved + 1 fix round)
Task 12: implementer DONE_WITH_CONCERNS, 131/131, then fix round 1 (commits de2ab60..1668c73),
  134/134. Closes H5, H7, M1, M2, M11, L2 and the CSRF gap Task 5 created.
Task 12: task review (opus) verified the CSRF control has NO browser-reachable bypass, by
  checking rather than reasoning: Origin is unconditionally appended on every non-GET/HEAD
  request; Origin: null throws into the 403 branch rather than reading as absent (the detail the
  whole control depends on - a sandboxed iframe or redirected cross-origin POST sends the literal
  string); it enumerated EVERY GET handler to confirm none mutates, so the GET/HEAD exemption
  confers nothing; 307/308 redirects re-run the append-Origin step; Node's parser cannot be
  case-tricked on the method. Also verified escapeHtml is complete across all three templates and
  all three router fragments, so T13 has no gap to fall through.
Task 12: the implementer found MY fault-injection test was broken - seeding consentTypes: []
  means marketing is DENIED, so withdrawConsent reports noChange, onWithdrawal never fires and
  the route returns 200. It would never have exercised the error mapper it was written to test.
  The reviewer confirmed the diagnosis in the source (withdrawConsent.js:58-60 and the
  if (withdrawn.length) gate).
Task 12: 1 Important, and it was SPEC DRIFT I CREATED - allowedOrigins shipped as replace, not
  union, because I changed the plan after implementation. The implementer had flagged the footgun
  and recommended union. The reviewer added the sharp part: the existing test passed identically
  under both semantics, so nothing would have caught the drift.
Task 12: fix round improved on my instructions twice - it FIXED scheme-less allowedOrigins
  entries rather than merely refusing them ("localhost:3000" and "portal.example" now match,
  which they never did), and it moved the checkOrigin function definition rather than leaning on
  hoisting so registration reads in source order. Non-vacuity proved by stashing ONLY the two
  source files back to HEAD with the new tests in place: 4 fail, 17 pass.
Task 12: NEW BREAKING CHANGE for T14's changelog - the DPO shape check now refuses a set but
  malformed address (" ", "tbd", "not-an-email", "dpo@localhost", a padded address) that
  previously booted. Deliberately not RFC 5322: wrongly rejecting a real Grievance Officer
  address is the worse failure. T14's changelog list expanded to seven items.
Task 12: complete (commits 13624b3..1668c73, review approved + 1 fix round)
Task 13: implementer DONE, 140/140, then fix round 1 (commits ef86a26..f5421b2), 142/142. H6
  CLOSED - the browser surface works end to end.
Task 13: task review APPROVED with NO Critical and NO Important. It verified all four properties
  from code, and singled out the withdrawal-submission test for asserting against the raw ledger
  rather than grepping markup - a test that only checks a <form> exists proves nothing about
  whether it can be submitted.
Task 13: the implementer extended the shared ERROR MAPPER beyond its brief so browser users see
  errors as HTML - its answer to what a minor rejected by the age gate actually sees. That needed
  checking, because the mapper is where the no-leak rule lives. Reviewer went through it line by
  line: the >=500 branch is untouched and still returns the fixed generic string regardless of
  wantsHtml, both HTML paths pass through escapeHtml, branch order preserved. It also
  independently confirmed the implementer's claim that no existing test hits the new branch, by
  grepping every Accept: text/html in the suite. Judged appropriate initiative, not scope creep.
Task 13: fix round closed two Minors that sat inside H6's own journey - the withdrawal form
  landed a browser user on raw JSON while granting gave a styled receipt (H6 IS "withdrawal as
  easy as granting"), and the consent receipt showed principalId without no-store while two read
  routes revealing far less had it. I explicitly told it NOT to fix the third minor: a genuine
  500 staying JSON-only is right.
Task 13: fix round re-review ADJUDICATED BY CONTROLLER. One new renderer, its wiring, two header
  lines and tests. I verified renderWithdrawalReceipt exists and is wired at router.js:371, and
  no-store is set on both receipt paths with the reasoning recorded inline. Suite green at
  142/142. Recorded rather than silently skipped.
Task 13: complete (commits b26be9e..f5421b2, review approved + 1 fix round)
