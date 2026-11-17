// HTTP only: read the request, call ONE service function, set cookies, choose
// the status code, send { data }. No business rules and no Prisma in here.
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from '../../utils/cookies.js';
import { UnauthorizedError } from '../../utils/AppError.js';
import * as authService from './auth.service.js';

export const register = async (req, res) => {
  const { user, tokens } = await authService.register(req.body);
  setAuthCookies(res, tokens);
  res.status(201).json({ data: { user } });
};

export const login = async (req, res) => {
  const { user, tokens } = await authService.login(req.body);
  setAuthCookies(res, tokens);
  res.status(200).json({ data: { user } });
};

export const refresh = async (req, res) => {
  try {
    const { user, tokens } = await authService.refresh(req.cookies?.[REFRESH_COOKIE]);
    setAuthCookies(res, tokens);
    res.status(200).json({ data: { user } });
  } catch (err) {
    // A failed refresh means this session is over, so remove the dead cookies.
    // (Only for 401s: a temporary database error must not log people out.)
    if (err instanceof UnauthorizedError) clearAuthCookies(res);
    throw err;
  }
};

export const logout = async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  res.status(204).end();
};
