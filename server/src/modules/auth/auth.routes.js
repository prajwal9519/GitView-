// Maps URL + method to a middleware chain and a controller. No logic here.
// Order matters: rate limiter (cheapest rejection) -> validation -> controller.
import { Router } from 'express';
import { credentialsLimiter, refreshLimiter } from '../../middleware/rateLimiters.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth } from '../../middleware/optionalAuth.js';
import * as authController from './auth.controller.js';
import { loginSchema, registerSchema } from './auth.schemas.js';

const router = Router();

router.post('/register', credentialsLimiter, validate({ body: registerSchema }), authController.register);
router.post('/login', credentialsLimiter, validate({ body: loginSchema }), authController.login);

// refresh and logout authenticate with the refresh-token COOKIE, not the
// access token, so they work even when the access token has already expired.
router.post('/refresh', refreshLimiter, authController.refresh);
router.post('/logout', authController.logout);

// GitHub OAuth endpoints
router.get('/github', authController.githubAuth);
router.get('/github/callback', optionalAuth, authController.githubCallback);

export default router;
