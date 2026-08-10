/**
 * An error with an HTTP status attached, so the transport layer can map it
 * without guessing. Anything thrown that is NOT an AppError is treated as an
 * internal fault and reported as 500 with a generic message.
 */
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

module.exports = { AppError };
