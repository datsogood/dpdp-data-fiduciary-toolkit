/**
 * Whole years between dob and asOf. Returns null for an unparseable date.
 *
 * dob and asOf are read with DIFFERENT getters, deliberately, because they
 * are different kinds of thing:
 *
 *   - dob is a CALENDAR DATE. A date-only string such as "2008-08-08" is
 *     parsed as UTC midnight - that is the ISO 8601 rule the Date
 *     constructor follows - and a Date loaded back from Mongo for a
 *     date-only value is UTC midnight too. UTC getters recover the
 *     calendar date that was actually written, in both cases.
 *
 *   - asOf is an INSTANT - "now". The civil date that matters for "has the
 *     birthday happened yet" is whatever date the deployment is actually
 *     living in at that instant, which is a LOCAL-time question.
 *
 * Reading both with the same kind of getter breaks one direction or the
 * other. All-local misreads dob: a UTC-midnight instant converted to local
 * time in any timezone behind UTC (the Americas, for instance) lands on the
 * PREVIOUS calendar day, so the recognised birthday silently moves a day
 * earlier than what was actually stored - a child can be misclassified as an
 * adult up to a day early. All-UTC "fixes" that but breaks asOf instead: a
 * deployment east of Greenwich (this Act's own jurisdiction among them) that
 * is already on the local calendar date of the birthday, but before that
 * date has arrived in UTC, gets read as still being on the day before -
 * misclassifying a person who has already turned 18 by the clock on the wall
 * as still a minor for several hours after local midnight.
 *
 * So: UTC getters for dob, local getters for asOf. Verified by execution,
 * not just reasoning - see the timezone regression test in
 * test/children.test.js, which spawns one subprocess per timezone with TZ
 * set at process start (Node resolves the timezone at startup, so a runtime
 * assignment to process.env.TZ does not reliably take effect).
 */
function ageInYears(dob, asOf = new Date()) {
  const birth = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  let age = asOf.getFullYear() - birth.getUTCFullYear();
  const monthDiff = asOf.getMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < birth.getUTCDate())) age -= 1;
  return age;
}

module.exports = { ageInYears, ADULT_AGE: 18 };
