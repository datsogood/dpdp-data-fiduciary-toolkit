/**
 * @typedef {object} HttpContext
 * @property {string} method
 * @property {string} basePath
 * @property {Record<string, string|undefined>} headers - lowercase keys
 * @property {Record<string, string>} query
 * @property {Record<string, string>} params
 * @property {object} body
 * @property {string|null} [principalId]
 * @property {string} host
 */

/**
 * @typedef {object} HttpResult
 * @property {number} status
 * @property {Record<string, string>} [headers]
 * @property {unknown} [json]
 * @property {string} [html]
 */

module.exports = {};
