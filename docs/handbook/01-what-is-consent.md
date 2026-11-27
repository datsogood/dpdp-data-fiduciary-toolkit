# 1. What consent actually means here

This chapter has no code in it. It is the vocabulary and the law the rest of the
handbook assumes. If you read only this one, you should be able to sit in a
design review and tell a good consent decision from a bad one.

The statute is the **Digital Personal Data Protection Act, 2023**. Where a rule
comes from the **DPDP Rules, 2025** instead, this chapter says so - they are a
separate instrument.

Nothing here is legal advice, and this package is not a certified compliance
product. It is a reference implementation with its reasoning written down.

---

## Meet Asha

Asha Rao is 34. She wants a small loan to buy a sewing machine, and she applies
to Kavach Finance - the fictional lender the toolkit ships as a worked example
in `data-fiduciary-toolkit/src/config/catalog.js`.

To decide on the loan, Kavach needs some things about her: her name, her phone
number, her date of birth, and her PAN - the Permanent Account Number issued by
the Income Tax Department, India's standard identifier for anything financial.
It would also *like* some things: permission
to text her about other products, permission to watch how she uses the app so it
can improve it.

Those two lists are not the same kind of thing, and almost every idea in this
chapter is a consequence of that sentence.

---

## The three roles

**Data principal.** The person the data is about. That is Asha. The Act gives
rights to her, not to her data.

**Data fiduciary.** Whoever decides why and how her data gets processed. That is
Kavach Finance. "Fiduciary" is a deliberate word choice - it is the language of
someone holding something in trust for another, not the language of an owner.
Kavach carries the obligations in this chapter whether or not it does the work
itself.

**Data processor.** Whoever processes her data on Kavach's behalf and on its
instructions - the credit bureau API, the SMS gateway, the cloud host, the
analytics vendor. A processor has no independent purpose of its own. If the SMS
gateway leaks Asha's number, Asha's claim is against Kavach. Kavach may engage a
processor only under a valid contract, and delegating the work does not delegate
the duty.

One consequence you will hit in week one: **the toolkit can record that Asha
withdrew consent, and it cannot tell the SMS gateway to stop.** It has no idea
the SMS gateway exists. Whoever integrates this library owns that pipeline. The
library gives you the signal and the erasure primitive, not the plumbing.

---

## What consent has to be to count

Section 6(1) is one sentence, and every word in it rules something out. Read it
as a list of banned patterns rather than a list of virtues.

| The word | What it rules out | Asha's version |
| --- | --- | --- |
| **Free** | Consent squeezed out by pressure, or by making refusal expensive. | The loan officer says the application "moves faster" if she agrees to marketing. That is not free. |
| **Specific** | A single blanket tickbox covering everything the firm might ever do. | Asha gets one decision per purpose - underwriting, identity checks, marketing, analytics - not one for "our services". |
| **Informed** | Consent collected before, or without, telling her what she is agreeing to. | She cannot agree to a credit-bureau pull she was never told about. |
| **Unconditional** | Withholding a service to extract data the service does not need. | Kavach may refuse the loan if she declines the underwriting check. It may not refuse the loan because she declined marketing. |
| **Unambiguous** | Reading consent into silence, inaction, or "continued use of this app". | Not ticking a box is a no, not a yes-by-default. |
| **Clear affirmative action** | Pre-ticked boxes, opt-out flows, consent buried in accepted terms. | The box starts empty. Asha ticks it or she does not. |
| **Limited to the purpose** | Collecting more than the purpose needs, or reusing it for a second purpose later. | Her PAN is collected for the credit assessment. It does not become marketing fuel because it happens to be on file. |

Two follow-on rules worth knowing:

- **A bad part does not poison the good parts.** Section 6(2): consent given in
  breach of the Act is invalid *to that extent*. If the marketing tickbox was
  pre-ticked, that consent is invalid. The underwriting consent she genuinely
  gave still stands.
- **The request itself has to be readable.** Section 6(3): the request for
  consent must be in clear, plain language, and must give her the contact
  details of the Data Protection Officer or the person who can answer her
  questions.

In the toolkit, "clear affirmative action" is why the consent page renders each
consent-based purpose as an unticked checkbox
(`data-fiduciary-toolkit/src/http/forms.js`), and "specific" is why there is a
catalog of separate purposes rather than a single flag on the record.

---

## The notice comes first (Section 5)

Before Kavach asks Asha for consent - or at the same moment, never after - it
must give her a notice. Section 5(1) says the notice must tell her:

1. **What personal data**, and **for what purpose** it will be processed.
2. **How to exercise her rights** - specifically her right to withdraw consent
   (Section 6(4)) and her right to grievance redressal (Section 13).
3. **How to complain to the Data Protection Board of India** - the body the Act
   creates to hear complaints and impose penalties. It is not a GDPR-style
   supervisory authority you register with; it adjudicates, and under Section 13
   it only hears a complaint that the fiduciary's own Grievance Officer failed
   to resolve.

Section 5(3) adds that she must be able to read it in English or in any language
in the Eighth Schedule to the Constitution - the list of twenty-two scheduled
languages, Hindi, Bengali, Tamil, Marathi and the rest. So "only English ships"
is a gap of twenty-two languages, not a missing locale file.

### Why itemised beats long

A five-page notice that says Kavach processes personal data "for its business
purposes, including marketing and analytics" is not shorter on obligations than
an itemised one - it is worse at them, in two ways.

**It destroys "specific".** If the notice describes one undifferentiated blob,
the only consent Asha can give is one undifferentiated yes. She has no way to
take the loan and refuse the marketing, which is exactly the choice the Act
exists to give her.

**It destroys the evidence.** A year later Asha complains about a marketing call.
Kavach says she consented. The Grievance Officer asks the only question that
matters: *what did she actually see?* If the answer is a five-page blob, "she
consented to marketing" is an assertion, not a record. If the answer is an
itemised list where "Marketing and personalised offers - telling you about
products we think you will want - kept for 24 months" sat above its own tickbox,
it is a record.

This is why the toolkit generates the notice from the same purpose catalog the
processing code reads (`data-fiduciary-toolkit/src/config/notice.js`), hashes the
result, and stamps that hash on every consent event. The page a person saw and
the evidence the fiduciary keeps have to be the same document. A notice written
by hand alongside code that does something slightly different is the normal way
this goes wrong.

One honest limit, stated because it is the kind of thing newcomers assume was
solved: **only English ships.** There is no translation map in this package.
Serving Section 5(3) properly means writing a translated catalog and having
someone who reads the language review it. It is not a config setting.

---

## Lawful basis: there are exactly two, and only two

This is the part people get wrong most often, and it is worth slowing down.

Under this Act, personal data may be processed for a lawful purpose on one of
two grounds:

- **Section 6 - the data principal's consent.**
- **Section 7 - one of the enumerated "certain legitimate uses".**

That is the whole list. Section 4 says so.

### The two grounds that do not exist here

If you have worked under the GDPR, you carry two habits that will produce wrong
code in this repository:

**There is no general "necessary for the contract" ground.** That is GDPR Article
6(1)(b). It does not exist in this Act. "We need it to give her the loan she
asked for" is not, by itself, a lawful basis. It is a very good reason for her to
say yes, and you still have to ask.

**There is no general "legitimate interests" ground.** That is GDPR Article
6(1)(f) - the balancing test where a firm weighs its own interest against the
individual's. It does not exist here either. Section 7 is called "certain
legitimate uses", which reads like the same idea and is not: it is a **closed
list of specific situations**, not a test you can argue your way through. You
cannot invent a new legitimate use by reasoning well about it.

### What is actually in Section 7

The clauses the toolkit's own catalog analyses in detail, because they are the
ones a private company reaches for:

| Clause | Covers | Does it help a private lender? |
| --- | --- | --- |
| 7(b) | The **State** providing a subsidy, benefit, service, certificate, licence or permit. | No. Kavach is not the State. |
| 7(c) | The **State** performing a function under law. | No. |
| 7(d) | Fulfilling an obligation under any law **on any person to disclose information to the State** or its instrumentalities. | Yes - but only for the disclosure. |

The rest of Section 7 covers situations that are real but narrow: data a person
voluntarily provided for a specified purpose and has not indicated she objects
to, compliance with a court judgment or order, medical emergencies, public health
measures, disaster and public-order safety measures, and certain
employment-related purposes. Read the section text before relying on any of them.
Note what is *not* in the list: "we needed it", "everyone does it", "it was in
the contract".

### The worked example: KYC is two purposes, not one

Kavach must do know-your-customer checks. The lazy modelling is one purpose
called "KYC", marked as legally required and therefore not withdrawable. The
toolkit deliberately does not do that, and the reasoning is worth internalising
because it generalises.

Pull the duty apart:

- **Reporting prescribed information about Asha to the Financial Intelligence
  Unit**, under the Prevention of Money-Laundering Act, 2002. This is a legal
  obligation to disclose information to the State. That is Section 7(d) exactly.
  It is not Asha's choice, she was never offered a tickbox for it, and she
  cannot withdraw it. The catalog calls it `kyc_reporting`.

- **Checking that Asha is who she says she is, and keeping Kavach's own record of
  that check.** No law obliges Kavach to hand *this* to the State. It is Kavach's
  own verification, for Kavach's own file. It is wider than the disclosure duty,
  so it does not inherit that clause's cover. It rests on Section 6 - her
  consent - and she can withdraw it. The catalog calls it
  `identity_verification`.

Same three letters, two different lawful bases, because one limb discloses to the
State and the other does not.

Getting this wrong is not cosmetic. Mark the whole of "KYC" non-withdrawable and
the software will **refuse a withdrawal the statute guarantees**, and tell Asha
she has no right she in fact has. That refusal will look principled. It will cite
a clause. It will be wrong.

### The test to apply

For every purpose your organisation adds to the catalog, ask one question:

> Is this the person's consent, or does it cite a specific Section 7 clause by
> number and stay inside what that clause actually covers?

There is no third answer. And the answer determines everything downstream:

| If the basis is... | Then... |
| --- | --- |
| **Consent (Section 6)** | It is offered as a choice, it can be declined, and it can be withdrawn at any time. |
| **A Section 7 legitimate use** | It is not a choice, so it is never rendered as a tickbox - it is stated in the notice. It is recorded once so there is a record of it, and it cannot be withdrawn. |

You can see both halves in the shipped catalog: `kyc_reporting` is stated and
non-withdrawable; `identity_verification`, `underwriting`, `marketing` and
`analytics` are consent-based, offered, and withdrawable.

---

## Withdrawal

Asha can withdraw her consent at any time, for any consent-based purpose, and
**Section 6(4) sets the standard for how hard that may be: comparable to how easy
it was to give.** If she consented with one tap in an app, she may not be made to
post a signed letter to withdraw. The DPDP Rules, 2025 (Rule 3) carry this into
the notice itself - the notice has to tell her how to withdraw, not just that she
may.

Three things follow from a withdrawal.

**The past stays lawful.** Section 6(5): withdrawal does not make the processing
that already happened unlawful. Kavach does not owe her an apology for the texts
it sent while she was consenting. It owes her no more texts.

**She bears the consequences, and that is not a reason to refuse.** If Asha
withdraws consent for underwriting mid-application, Kavach may not be able to
continue the application. That is a commercial consequence of her choice and it
is allowed. What is *not* allowed is refusing to record the withdrawal because it
is inconvenient.

**Processing must stop, and processors must be made to stop.** Section 6(6):
within a reasonable time, the fiduciary must cease processing and cause its data
processors to cease too, unless some other law requires the processing to
continue. Section 8(7) adds the erasure duty - erase her personal data unless
retention is required for compliance with law.

Here is the honest boundary of this package, and you should know it before your
first integration meeting: **the toolkit records the withdrawal. It does not stop
anything and it does not erase anything.** It appends a withdrawal to an
append-only ledger, calls a hook so your own code learns it happened, and exports
an erasure function you call yourself. It cannot notify a third-party processor
it has never heard of. Ceasing and erasing downstream is work your integration
has to do.

And a purpose resting on Section 7 cannot be withdrawn at all. When Asha asks to
withdraw `kyc_reporting`, the toolkit refuses and names the clause it rests on -
rather than accepting the request and quietly doing nothing, which would be
worse. **That refusal is itself recorded**, which is the subject of the last
section of this chapter.

---

## The rights (Chapter III)

Five things Asha can do, in plain words.

| Right | Section | What she can ask for |
| --- | --- | --- |
| **Access** | 11 | A summary of the personal data Kavach holds about her, what it is doing with it, and who it has been shared with. |
| **Correction, completion and updation** | 12 | Fix what is wrong, fill in what is missing, refresh what is stale. |
| **Erasure** | 12 | Delete her personal data - and Kavach must, unless a law requires it to be kept, in which case it should say which law and why. |
| **Grievance redressal** | 13 | Complain to Kavach's own Grievance Officer first, and get an answer within a stated period. |
| **Nomination** | 14 | Name someone to exercise these rights for her if she dies or becomes incapacitated. |

Two notes a newcomer needs.

**Section 13 is a queue, not a bypass.** Asha complains to Kavach's Grievance
Officer first. Only if that is not resolved in time does the Data Protection
Board hear it. Code that lets someone "file with the Board" as their opening move
is modelling the wrong process. Related duty: Section 8 requires the fiduciary to
publish working contact details for its DPO or grievance contact - which is why
this toolkit refuses to start up with a placeholder or malformed address on file.
A published address that goes nowhere fails the duty while looking like it meets
it.

**Chapter III also contains Section 15, which is not a right.** It sets duties on
the data principal - not to impersonate, not to file frivolous complaints, not to
submit false particulars. Worth knowing it exists so you are not surprised by it.

Separately, Section 6(7) to 6(9) create the **Consent Manager**: an independent
entity registered with the Board, through which a person can give, manage, review
and withdraw consent across many fiduciaries from one place, and which is
accountable to her. Asha might one day manage her Kavach consents from there.
This toolkit can record a request to be connected to one. It is not a Consent
Manager and does not act as one.

---

## Children (Section 9)

Suppose the applicant is not Asha but her 16-year-old nephew.

Two rules, and the second is the one people forget.

**Before processing a child's personal data at all, the fiduciary must obtain
verifiable consent from a parent or lawful guardian.** A child is anyone under
18. The same requirement applies to a person with a disability who has a lawful
guardian. The load-bearing word is *verifiable*: a text box where someone types a
parent's name is not verifiable parental consent, it is a text box.

**Even with perfect parental consent, some processing stays off the table.**
Section 9 prohibits tracking, behavioural monitoring and targeted advertising
directed at children, and prohibits processing likely to have a detrimental
effect on a child's well-being. A parent cannot consent their way into these.
They are not un-consented, they are not permitted.

That distinction is modelled directly: the toolkit's catalog marks `marketing`
and `analytics` as prohibited for children, and a minor's application is refused
those purposes outright and told so - regardless of what any parent agreed to.
The age gate runs before anything is written, so a minor refused for want of
verifiable parental consent leaves no `Principal` and no `ConsentRecord`
behind - only an `age_gate_refused` trail row. A minor whose guardian the
fiduciary has verified is registered normally; `marketing` and `analytics` are
simply never offered or recorded for them, and that refusal is itself kept as a
`consent_refused` trail row.

Where the toolkit stops is stated plainly in its README: **it has no verifiable
parental consent mechanism.** It can detect that someone is under 18 and refuse.
It cannot verify a parent. There is deliberately no web route by which a minor
can be registered, even with genuine parental consent - an adopter serving minors
has to build that verification themselves and call the service function from
trusted server-side code.

---

## Why any of this needs a trail

Here is the sentence to leave with:

> **Consent is not a state. It is a history.**

A system that stores `marketing: granted` can answer one question: what does Asha
consent to right now. That is a genuinely useful answer, and it is not the
question anyone actually asks when something has gone wrong.

The questions that get asked are these. Asha rings the Grievance Officer about a
marketing call. She says she withdrew consent months ago. The officer opens the
record and sees `marketing: granted`. Now what?

- Did she ever ask to withdraw, and what did the system tell her?
- On the day she consented, what did the notice she was shown actually say?
- Did anyone in the back office open her file, when, and under which ticket?
- Was she ever refused something - a withdrawal, a purpose, a registration - and
  on what stated ground?
- Did anyone change the email address on her record, and when?

None of those can be answered from current state, and several of them cannot be
answered from a naive event log either, because the interesting acts are the ones
where **nothing changed**. A refused withdrawal writes no new state. A re-grant
that the system quietly declined to apply writes no new state. A purpose refused
for a child writes no new state - the whole point is that nothing was recorded. A
status that moved from `received` to `in_progress` to `closed` overwrites its own
history unless someone stores each step.

Those silences are exactly what a Grievance Officer, a Section 11 access request
and the Data Protection Board come looking for. "We have no record of her asking"
and "she never asked" are different facts, and a system that cannot tell them
apart will confidently report the second when the truth is the first.

So this toolkit keeps a second record - the consent trail - and Chapter 3 of this
handbook covers how. Three of its properties are worth carrying into that
chapter, because they are the ones that make it evidence rather than decoration:

- **It never invents a timestamp nobody observed.** No backfill, ever. A trail
  that reconstructs history is doing the one thing an audit trail must never do.
- **It says where the record begins.** Every read returns a coverage date, so an
  empty trail reads as "we were not recording before this date" and not as
  "nothing happened".
- **It claims to be evidence of what was recorded, not proof that nothing else
  happened.** Its instrumentation is deliberately allowed to fail without taking
  down consent capture, so an entry can be missing. This package makes no
  completeness claim, and neither should you when you talk about it.

That last point is the register the whole repository is written in. Read the
grievance flow and you will find it says a complaint was **recorded** - never
that it was *sent*. Nothing leaves the process. Saying otherwise would be the
same kind of lie as a backfilled timestamp, just easier to tell.
