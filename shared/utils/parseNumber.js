/**
 * Parse a value to a number with a fallback.
 * @param {*} value - The value to parse
 * @param {number} fallback - The fallback value if parsing fails
 * @returns {number} The parsed number or the fallback value
 */
function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  parseNumber,
};
