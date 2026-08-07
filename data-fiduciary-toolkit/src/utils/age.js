/**
 * Whole years between dob and asOf. Returns null for an unparseable date.
 *
 * Uses UTC getters throughout, not local ones. A date-only string such as
 * "2008-08-07" is parsed as UTC midnight - that is the ISO 8601 rule the
 * Date constructor follows - so reading it back with local getters (getDate,
 * getMonth, getFullYear) shifts the effective day by however far the running
 * process's timezone sits from UTC. In any timezone behind UTC (all of the
 * Americas, for instance) that shift lands on the PREVIOUS calendar day,
 * which would move a person's recognised birthday a day earlier purely
 * because of where the Node process happens to be deployed - for an age
 * gate, that means a child could be misclassified as an adult a day early.
 * Comparing dob and asOf with UTC getters anchors both to the same instant
 * the dob string was parsed against, so the result no longer depends on the
 * server's timezone.
 */
function ageInYears(dob, asOf = new Date()) {
  const birth = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  let age = asOf.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = asOf.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

module.exports = { ageInYears, ADULT_AGE: 18 };
