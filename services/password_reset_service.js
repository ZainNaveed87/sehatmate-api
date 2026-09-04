import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import https from 'node:https';

const PASSWORD_RESET_CODE_TTL_MINUTES = 10;
const PASSWORD_RESET_TOKEN_TTL_MINUTES = 10;
const PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = 60;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;

const genericRequestMessage =
  'If a password account exists for this email, a verification code has been sent.';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const schemaPromises = new WeakMap();

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';
}

function authProviderForUser(row) {
  if (!row) return null;

  const hasPassword =
    typeof row.password_hash === 'string' &&
    row.password_hash.trim().length > 0;

  const hasGoogle =
    typeof row.google_sub === 'string' &&
    row.google_sub.trim().length > 0;

  if (hasPassword && !hasGoogle) return 'password';
  if (hasGoogle && !hasPassword) return 'google';

  return null;
}

function errorResult(statusCode, message, code) {
  return {
    ok: false,
    statusCode,
    message,
    code,
  };
}

function passwordResetSecret() {
  const secret = process.env.JWT_SECRET?.trim();

  if (!secret) {
    throw new Error('JWT_SECRET is required for password reset security.');
  }

  return secret;
}

function hashResetValue({
  purpose,
  email,
  salt,
  value,
}) {
  return crypto
    .createHmac('sha256', passwordResetSecret())
    .update(`${purpose}\n${email}\n${salt}\n${value}`)
    .digest('hex');
}

function timingSafeHexEqual(left, right) {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(left) ||
    !/^[a-f0-9]{64}$/i.test(right)
  ) {
    return false;
  }

  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function resendEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    return Promise.reject(
      new Error('RESEND_API_KEY is not configured.'),
    );
  }

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          responseBody += chunk;
        });

        response.on('end', () => {
          const statusCode = Number(response.statusCode || 0);

          if (statusCode >= 200 && statusCode < 300) {
            resolve(responseBody);
            return;
          }

          let providerMessage =
            `Resend rejected the email request with status ${statusCode}.`;

          try {
            const parsed = JSON.parse(responseBody);

            if (typeof parsed?.message === 'string' && parsed.message.trim()) {
              providerMessage = parsed.message.trim();
            }
          } catch {
            // Keep the sanitized status-only fallback.
          }

          const error = new Error(providerMessage);
          error.statusCode = statusCode;

          reject(error);
        });
      },
    );

    request.setTimeout(10000, () => {
      request.destroy(
        new Error('Resend email request timed out.'),
      );
    });

    request.on('error', reject);

    request.write(body);
    request.end();
  });
}

async function sendPasswordResetCode({
  email,
  code,
}) {
  const from = process.env.PASSWORD_RESET_FROM_EMAIL?.trim();

  if (!from) {
    throw new Error(
      'PASSWORD_RESET_FROM_EMAIL is not configured.',
    );
  }

  await resendEmail({
    from,
    to: [email],
    subject: 'Your SehatMate password reset code',
    text:
      `Your SehatMate verification code is ${code}.\n\n` +
      `This code expires in ${PASSWORD_RESET_CODE_TTL_MINUTES} minutes.\n\n` +
      'If you did not request a password reset, you can ignore this email.',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#172033">
        <h2 style="margin:0 0 16px">Reset your SehatMate password</h2>

        <p style="line-height:1.6">
          Use the verification code below to continue your password reset.
        </p>

        <div style="
          margin:24px 0;
          padding:18px;
          background:#f4f8f7;
          border-radius:12px;
          text-align:center;
          font-size:32px;
          font-weight:700;
          letter-spacing:8px;
        ">
          ${code}
        </div>

        <p style="line-height:1.6">
          This code expires in
          <strong>${PASSWORD_RESET_CODE_TTL_MINUTES} minutes</strong>.
        </p>

        <p style="line-height:1.6;color:#667085">
          If you did not request this password reset, you can safely ignore
          this email.
        </p>
      </div>
    `,
    tags: [
      {
        name: 'category',
        value: 'password_reset',
      },
    ],
  });
}

export async function ensurePasswordResetSchema(db) {
  let promise = schemaPromises.get(db);

  if (promise) {
    return promise;
  }

  promise = (async () => {
    await db.execute(
      `CREATE TABLE IF NOT EXISTS password_reset_challenges (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        email VARCHAR(191) NOT NULL,
        code_hash CHAR(64) NOT NULL,
        code_salt CHAR(32) NOT NULL,
        attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
        expires_at DATETIME NOT NULL,
        verified_at DATETIME NULL DEFAULT NULL,
        reset_token_hash CHAR(64) NULL DEFAULT NULL,
        reset_token_expires_at DATETIME NULL DEFAULT NULL,
        used_at DATETIME NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        KEY password_reset_user_created_idx (
          user_id,
          created_at
        ),

        KEY password_reset_email_created_idx (
          email,
          created_at
        ),

        KEY password_reset_expiry_idx (
          expires_at,
          used_at
        ),

        CONSTRAINT password_reset_user_fk
          FOREIGN KEY (user_id)
          REFERENCES users (id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB
        DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_unicode_ci`,
    );

    await db.execute(
      `DELETE FROM password_reset_challenges
       WHERE created_at < DATE_SUB(
         CURRENT_TIMESTAMP,
         INTERVAL 2 DAY
       )`,
    );
  })().catch((error) => {
    schemaPromises.delete(db);
    throw error;
  });

  schemaPromises.set(db, promise);

  return promise;
}

export async function requestPasswordReset({
  db,
  email,
}) {
  const normalizedEmail = normalizeEmail(email);

  if (
    !emailPattern.test(normalizedEmail) ||
    normalizedEmail.length > 191
  ) {
    return errorResult(
      422,
      'Enter a valid email address.',
      'INVALID_RESET_EMAIL',
    );
  }

  await ensurePasswordResetSchema(db);

  const [users] = await db.execute(
    `SELECT
      id,
      email,
      password_hash,
      google_sub
     FROM users
     WHERE email = ?
     LIMIT 1`,
    [normalizedEmail],
  );

  if (users.length === 0) {
    return {
      ok: true,
      message: genericRequestMessage,
      data: {
        cooldownSeconds:
          PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
      },
    };
  }

  const user = users[0];
  const provider = authProviderForUser(user);

  if (provider === 'google') {
    return errorResult(
      409,
      'This account uses Google Sign-In. Please continue with Google.',
      'GOOGLE_AUTH_ACCOUNT',
    );
  }

  if (provider !== 'password') {
    return errorResult(
      409,
      'This account has an invalid sign-in configuration. Please contact support.',
      'INVALID_AUTH_CONFIGURATION',
    );
  }

  const [recent] = await db.execute(
    `SELECT id
     FROM password_reset_challenges
     WHERE user_id = ?
       AND used_at IS NULL
       AND created_at > DATE_SUB(
         CURRENT_TIMESTAMP,
         INTERVAL 60 SECOND
       )
     ORDER BY id DESC
     LIMIT 1`,
    [user.id],
  );

  if (recent.length > 0) {
    return {
      ok: true,
      message: genericRequestMessage,
      data: {
        cooldownSeconds:
          PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
      },
    };
  }

  await db.execute(
    `UPDATE password_reset_challenges
     SET used_at = CURRENT_TIMESTAMP
     WHERE user_id = ?
       AND used_at IS NULL`,
    [user.id],
  );

  const code = String(
    crypto.randomInt(0, 1000000),
  ).padStart(6, '0');

  const salt = crypto
    .randomBytes(16)
    .toString('hex');

  const codeHash = hashResetValue({
    purpose: 'password-reset-code',
    email: normalizedEmail,
    salt,
    value: code,
  });

  const [insertResult] = await db.execute(
    `INSERT INTO password_reset_challenges (
      user_id,
      email,
      code_hash,
      code_salt,
      expires_at
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      DATE_ADD(
        CURRENT_TIMESTAMP,
        INTERVAL 10 MINUTE
      )
    )`,
    [
      user.id,
      normalizedEmail,
      codeHash,
      salt,
    ],
  );

  try {
    await sendPasswordResetCode({
      email: normalizedEmail,
      code,
    });
  } catch (error) {
    await db.execute(
      `UPDATE password_reset_challenges
       SET used_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [insertResult.insertId],
    );

    console.error(
      'Password reset email delivery failed.',
      {
        userId: String(user.id),
        message: error?.message,
      },
    );

    return errorResult(
      503,
      'The password reset email could not be sent. Please try again later.',
      'RESET_EMAIL_FAILED',
    );
  }

  return {
    ok: true,
    message: genericRequestMessage,
    data: {
      cooldownSeconds:
        PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
    },
  };
}

export async function verifyPasswordResetCode({
  db,
  email,
  code,
}) {
  const normalizedEmail = normalizeEmail(email);

  const normalizedCode =
    typeof code === 'string'
      ? code.trim()
      : '';

  if (
    !emailPattern.test(normalizedEmail) ||
    normalizedEmail.length > 191 ||
    !/^\d{6}$/.test(normalizedCode)
  ) {
    return errorResult(
      422,
      'Invalid or expired verification code.',
      'INVALID_RESET_CODE',
    );
  }

  await ensurePasswordResetSchema(db);

  const [users] = await db.execute(
    `SELECT
      id,
      password_hash,
      google_sub
     FROM users
     WHERE email = ?
     LIMIT 1`,
    [normalizedEmail],
  );

  const user = users[0];

  if (
    !user ||
    authProviderForUser(user) !== 'password'
  ) {
    return errorResult(
      422,
      'Invalid or expired verification code.',
      'INVALID_RESET_CODE',
    );
  }

  const [rows] = await db.execute(
    `SELECT
      id,
      code_hash,
      code_salt,
      attempts
     FROM password_reset_challenges
     WHERE user_id = ?
       AND email = ?
       AND used_at IS NULL
       AND verified_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP
     ORDER BY id DESC
     LIMIT 1`,
    [
      user.id,
      normalizedEmail,
    ],
  );

  const challenge = rows[0];

  if (
    !challenge ||
    Number(challenge.attempts || 0) >=
      PASSWORD_RESET_MAX_ATTEMPTS
  ) {
    return errorResult(
      422,
      'Invalid or expired verification code.',
      'INVALID_RESET_CODE',
    );
  }

  const submittedHash = hashResetValue({
    purpose: 'password-reset-code',
    email: normalizedEmail,
    salt: challenge.code_salt,
    value: normalizedCode,
  });

  if (
    !timingSafeHexEqual(
      challenge.code_hash,
      submittedHash,
    )
  ) {
    await db.execute(
      `UPDATE password_reset_challenges
       SET
         attempts = attempts + 1,
         used_at = CASE
           WHEN attempts + 1 >= ?
             THEN CURRENT_TIMESTAMP
           ELSE used_at
         END
       WHERE id = ?`,
      [
        PASSWORD_RESET_MAX_ATTEMPTS,
        challenge.id,
      ],
    );

    return errorResult(
      422,
      'Invalid or expired verification code.',
      'INVALID_RESET_CODE',
    );
  }

  const resetToken = crypto
    .randomBytes(32)
    .toString('hex');

  const resetTokenHash = hashResetValue({
    purpose: 'password-reset-token',
    email: normalizedEmail,
    salt: challenge.code_salt,
    value: resetToken,
  });

  await db.execute(
    `UPDATE password_reset_challenges
     SET
       verified_at = CURRENT_TIMESTAMP,
       reset_token_hash = ?,
       reset_token_expires_at = DATE_ADD(
         CURRENT_TIMESTAMP,
         INTERVAL 10 MINUTE
       )
     WHERE id = ?
       AND used_at IS NULL
       AND verified_at IS NULL`,
    [
      resetTokenHash,
      challenge.id,
    ],
  );

  return {
    ok: true,
    message: 'Verification code confirmed.',
    data: {
      resetToken,
      expiresInSeconds:
        PASSWORD_RESET_TOKEN_TTL_MINUTES * 60,
    },
  };
}

export async function completePasswordReset({
  db,
  email,
  resetToken,
  newPassword,
}) {
  const normalizedEmail = normalizeEmail(email);

  const token =
    typeof resetToken === 'string'
      ? resetToken.trim()
      : '';

  const password =
    typeof newPassword === 'string'
      ? newPassword
      : '';

  if (
    !emailPattern.test(normalizedEmail) ||
    normalizedEmail.length > 191 ||
    !/^[a-f0-9]{64}$/i.test(token)
  ) {
    return errorResult(
      422,
      'Password reset session is invalid or expired. Please request a new code.',
      'INVALID_RESET_SESSION',
    );
  }

  if (
    password.length < 8 ||
    password.length > 72
  ) {
    return errorResult(
      422,
      'Password must contain 8 to 72 characters.',
      'INVALID_NEW_PASSWORD',
    );
  }

  await ensurePasswordResetSchema(db);

  const [users] = await db.execute(
    `SELECT
      id,
      password_hash,
      google_sub
     FROM users
     WHERE email = ?
     LIMIT 1`,
    [normalizedEmail],
  );

  const user = users[0];

  if (
    !user ||
    authProviderForUser(user) !== 'password'
  ) {
    return errorResult(
      422,
      'Password reset session is invalid or expired. Please request a new code.',
      'INVALID_RESET_SESSION',
    );
  }

  const [rows] = await db.execute(
    `SELECT
      id,
      code_salt,
      reset_token_hash
     FROM password_reset_challenges
     WHERE user_id = ?
       AND email = ?
       AND verified_at IS NOT NULL
       AND reset_token_hash IS NOT NULL
       AND reset_token_expires_at >
         CURRENT_TIMESTAMP
       AND used_at IS NULL
     ORDER BY id DESC
     LIMIT 1`,
    [
      user.id,
      normalizedEmail,
    ],
  );

  const challenge = rows[0];

  if (!challenge) {
    return errorResult(
      422,
      'Password reset session is invalid or expired. Please request a new code.',
      'INVALID_RESET_SESSION',
    );
  }

  const submittedTokenHash = hashResetValue({
    purpose: 'password-reset-token',
    email: normalizedEmail,
    salt: challenge.code_salt,
    value: token,
  });

  if (
    !timingSafeHexEqual(
      challenge.reset_token_hash,
      submittedTokenHash,
    )
  ) {
    return errorResult(
      422,
      'Password reset session is invalid or expired. Please request a new code.',
      'INVALID_RESET_SESSION',
    );
  }

  /*
   * Claim the reset challenge first. Only one concurrent request
   * can successfully consume a one-time token.
   */
  const [claimResult] = await db.execute(
    `UPDATE password_reset_challenges
     SET used_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND used_at IS NULL
       AND reset_token_hash = ?
       AND reset_token_expires_at >
         CURRENT_TIMESTAMP`,
    [
      challenge.id,
      challenge.reset_token_hash,
    ],
  );

  if (Number(claimResult.affectedRows || 0) !== 1) {
    return errorResult(
      422,
      'Password reset session is invalid or expired. Please request a new code.',
      'INVALID_RESET_SESSION',
    );
  }

  const passwordHash = await bcrypt.hash(
    password,
    12,
  );

  const [passwordResult] = await db.execute(
    `UPDATE users
     SET password_hash = ?
     WHERE id = ?
       AND password_hash IS NOT NULL
       AND google_sub IS NULL`,
    [
      passwordHash,
      user.id,
    ],
  );

  if (
    Number(passwordResult.affectedRows || 0) !== 1
  ) {
    return errorResult(
      409,
      'This account can no longer be reset using a password.',
      'AUTH_PROVIDER_CHANGED',
    );
  }

  await db.execute(
    `UPDATE password_reset_challenges
     SET used_at = COALESCE(
       used_at,
       CURRENT_TIMESTAMP
     )
     WHERE user_id = ?
       AND used_at IS NULL`,
    [user.id],
  );

  return {
    ok: true,
    message:
      'Password changed successfully. You can now sign in with your new password.',
    data: {},
  };
}