// Creates (or promotes) an administrator account by email:
//   npm run create-admin -- name@institute.example
// The account is bound to the institutional identity on its first login.
import config from '../config/index.js';
import { closePool, db } from './pool.js';
import * as userRepo from '../repositories/userRepository.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
const domain = email.slice(email.lastIndexOf('@') + 1);

if (!email.includes('@') || !config.allowedEmailDomains.includes(domain)) {
  console.error(`Usage: npm run create-admin -- <email in ${config.allowedEmailDomains.join(' or ')}>`);
  process.exit(1);
}

try {
  const existing = await userRepo.findByEmail(db, email);
  if (existing) {
    await userRepo.update(db, existing.id, { role: 'admin', status: 'active' });
    console.log(`${email} is now an active administrator.`);
  } else {
    await userRepo.create(db, {
      issuer: null,
      subject: null,
      email,
      name: email.split('@')[0],
      role: 'admin',
      status: 'active',
    });
    console.log(`Administrator ${email} created. The account is linked on its first institutional login.`);
  }
} finally {
  await closePool();
}
