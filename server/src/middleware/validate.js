// INPUT VALIDATION middleware: runs zod schemas before the controller.
//
// Why: never trust the client. Each endpoint declares exactly what valid input
// looks like; anything else is rejected with 400, and zod also (a) converts
// types (e.g. "2" -> 2 for query strings), (b) applies defaults, and
// (c) DROPS fields the schema doesn't list. (c) is what stops "mass
// assignment": a client sending { "role": "ADMIN" } to /register is ignored.
//
// Usage: validate({ body: registerSchema, query: listSchema, params: idSchema })
// A failing schema throws a ZodError, which errorHandler turns into
// 400 VALIDATION_ERROR with per-field messages.

// In Express 5, req.query is a read-only getter, so plain assignment would
// throw. defineProperty replaces it with the parsed value safely.
const replace = (req, key, value) =>
  Object.defineProperty(req, key, { value, writable: true, configurable: true, enumerable: true });

export const validate = (schemas) => (req, _res, next) => {
  if (schemas.params) replace(req, 'params', schemas.params.parse(req.params));
  if (schemas.query) replace(req, 'query', schemas.query.parse(req.query));
  // `?? {}` so a request with no body produces "field is required" messages
  // instead of one confusing root-level error.
  if (schemas.body) replace(req, 'body', schemas.body.parse(req.body ?? {}));
  next();
};
