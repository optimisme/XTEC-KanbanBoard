import { Router } from 'express';
import config from '../config/index.js';
import * as auth from '../controllers/authController.js';
import { csrfProtection } from '../middleware/csrf.js';

const router = Router();

router.get('/auth/login', auth.login);
router.get(config.oidc.callbackPath, auth.callback);
router.post('/auth/logout', csrfProtection, auth.logout);

// Password login of the administrator configured in .env (optional).
if (config.adminLogin.enabled) {
  router.post('/auth/admin-login', csrfProtection, auth.adminLogin);
}

// Development-only login. config.devAuthEnabled can never be true in
// production: the server refuses to start with that combination.
if (config.devAuthEnabled) {
  router.post('/auth/dev-login', csrfProtection, auth.devLogin);
}

export default router;
