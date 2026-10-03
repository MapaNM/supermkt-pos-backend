// 🔐 TRANSACTIONS: Inside a mongoose session.withTransaction(...) callback you can't call
// res.status(...).json(...) directly to "return early" the way a normal route handler does -
// the callback just needs to throw, and the transaction auto-rolls-back whatever it already
// wrote. This small class lets validation code `throw new RouteError(400, "...")` and have
// the outer try/catch turn that into the right HTTP response, while anything that's NOT a
// RouteError (a real bug, a DB hiccup) still falls through to a generic 500 + server-side log.
class RouteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = RouteError;