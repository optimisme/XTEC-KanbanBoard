import { Router } from 'express';
import config from '../config/index.js';
import * as auth from '../controllers/authController.js';
import { csrfProtection } from '../middleware/csrf.js';

const router = Router();

router.get('/auth/login', auth.login);
router.get(config.oidc.callbackPath, auth.callback);
router.post('/auth/logout', csrfProtection, auth.logout);

// Password sign-in: the administrator from .env and accounts with a password.
router.post('/auth/password-login', csrfProtection, auth.passwordLogin);

// Development-only login. config.devAuthEnabled can never be true in
// production: the server refuses to start with that combination.
if (config.devAuthEnabled) {
  router.post('/auth/dev-login', csrfProtection, auth.devLogin);
}

export default router;
