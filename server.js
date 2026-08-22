import 'dotenv/config';

import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';

const requiredEnvironment = [
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
  'GOOGLE_CLIENT_ID',
];

const missingEnvironment = requiredEnvironment.filter(
  (key) => !process.env[key]?.trim(),
);

if (missingEnvironment.length > 0) {
  console.error(
    `Missing environment variables: ${missingEnvironment.join(', ')}`,
  );
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must contain at least 32 characters.');
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 3000);

const allowedOrigins = (process.env.CLIENT_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  enableKeepAlive: true,
});

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin is not allowed by CORS.'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: '64kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please try again later.',
  },
});

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row) {
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
  };
}

function createToken(user) {
  return jwt.sign(
    {
      email: user.email,
    },
    process.env.JWT_SECRET,
    {
      subject: String(user.id),
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      issuer: 'sehatroute-api',
      audience: 'sehatroute-app',
    },
  );
}

function validateRegistration(body) {
  const name =
    typeof body.name === 'string'
      ? body.name.trim().replace(/\s+/g, ' ')
      : '';

  const email =
    typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : '';

  const password = typeof body.password === 'string' ? body.password : '';

  if (name.length < 2 || name.length > 80) {
    return {
      error: 'Name must contain 2 to 80 characters.',
    };
  }

  if (!emailPattern.test(email) || email.length > 191) {
    return {
      error: 'Enter a valid email address.',
    };
  }

  if (password.length < 8 || password.length > 72) {
    return {
      error: 'Password must contain 8 to 72 characters.',
    };
  }

  return {
    value: {
      name,
      email,
      password,
    },
  };
}

function validateLogin(body) {
  const email =
    typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : '';

  const password = typeof body.password === 'string' ? body.password : '';

  if (!emailPattern.test(email) || password.length === 0) {
    return {
      error: 'Enter a valid email and password.',
    };
  }

  return {
    value: {
      email,
      password,
    },
  };
}

function validateGoogleName(name, email) {
  const cleanedName =
    typeof name === 'string'
      ? name.trim().replace(/\s+/g, ' ').slice(0, 80)
      : '';

  if (cleanedName.length >= 2) {
    return cleanedName;
  }

  const emailName = email
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .trim()
    .slice(0, 80);

  if (emailName.length >= 2) {
    return emailName;
  }

  return 'Google User';
}

function authenticate(req, res, next) {
  const authorization = req.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({
      success: false,
      message: 'Authentication is required.',
    });
    return;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'sehatroute-api',
      audience: 'sehatroute-app',
    });

    req.auth = {
      userId: payload.sub,
    };

    next();
  } catch {
    res.status(401).json({
      success: false,
      message: 'Your session is invalid or has expired.',
    });
  }
}

app.get('/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      success: true,
      service: 'sehatroute-auth-api',
      database: 'connected',
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  const validation = validateRegistration(req.body || {});

  if (validation.error) {
    res.status(422).json({
      success: false,
      message: validation.error,
    });
    return;
  }

  const { name, email, password } = validation.value;

  try {
    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email],
    );

    if (existing.length > 0) {
      res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, passwordHash],
    );

    const user = {
      id: result.insertId,
      name,
      email,
    };

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      data: {
        token: createToken(user),
        user: publicUser(user),
      },
    });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
      return;
    }

    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  const validation = validateLogin(req.body || {});

  if (validation.error) {
    res.status(422).json({
      success: false,
      message: validation.error,
    });
    return;
  }

  const { email, password } = validation.value;

  try {
    const [rows] = await pool.execute(
      'SELECT id, name, email, password_hash FROM users WHERE email = ? LIMIT 1',
      [email],
    );

    const user = rows[0];

    const passwordMatches = user?.password_hash
      ? await bcrypt.compare(password, user.password_hash)
      : false;

    if (!user || !passwordMatches) {
      res.status(401).json({
        success: false,
        message: 'Incorrect email or password.',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Signed in successfully.',
      data: {
        token: createToken(user),
        user: publicUser(user),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/google', authLimiter, async (req, res, next) => {
  const idToken =
    typeof req.body?.idToken === 'string'
      ? req.body.idToken.trim()
      : '';

  if (!idToken || idToken.length > 10000) {
    res.status(422).json({
      success: false,
      message: 'A valid Google ID token is required.',
    });
    return;
  }

  let googlePayload;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    googlePayload = ticket.getPayload();
  } catch (error) {
    console.error('Google token verification failed:', error?.message);

    res.status(401).json({
      success: false,
      message: 'Google authentication could not be verified.',
    });
    return;
  }

  const googleSub =
    typeof googlePayload?.sub === 'string'
      ? googlePayload.sub.trim()
      : '';

  const email =
    typeof googlePayload?.email === 'string'
      ? googlePayload.email.trim().toLowerCase()
      : '';

  const emailVerified = googlePayload?.email_verified === true;

  if (
    !googleSub ||
    !emailVerified ||
    !emailPattern.test(email) ||
    email.length > 191
  ) {
    res.status(401).json({
      success: false,
      message: 'Google did not return a verified email account.',
    });
    return;
  }

  const name = validateGoogleName(googlePayload?.name, email);

  try {
    const [googleUsers] = await pool.execute(
      'SELECT id, name, email, google_sub FROM users WHERE google_sub = ? LIMIT 1',
      [googleSub],
    );

    if (googleUsers.length > 0) {
      const user = googleUsers[0];

      res.json({
        success: true,
        message: 'Signed in with Google successfully.',
        data: {
          token: createToken(user),
          user: publicUser(user),
          isNewUser: false,
        },
      });
      return;
    }

    const [emailUsers] = await pool.execute(
      'SELECT id, name, email, google_sub FROM users WHERE email = ? LIMIT 1',
      [email],
    );

    if (emailUsers.length > 0) {
      res.status(409).json({
        success: false,
        message:
          'An account with this email already exists. Please sign in using your password.',
      });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO users (
        name,
        email,
        password_hash,
        google_sub
      ) VALUES (?, ?, ?, ?)`,
      [name, email, null, googleSub],
    );

    const user = {
      id: result.insertId,
      name,
      email,
    };

    res.status(201).json({
      success: true,
      message: 'Google account created successfully.',
      data: {
        token: createToken(user),
        user: publicUser(user),
        isNewUser: true,
      },
    });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      res.status(409).json({
        success: false,
        message: 'An account with this Google account or email already exists.',
      });
      return;
    }

    next(error);
  }
});

app.get('/api/auth/me', authenticate, async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, email FROM users WHERE id = ? LIMIT 1',
      [req.auth.userId],
    );

    if (rows.length === 0) {
      res.status(404).json({
        success: false,
        message: 'User account was not found.',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        user: publicUser(rows[0]),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'API route not found.',
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);

  const corsError =
    error?.message === 'Origin is not allowed by CORS.';

  res.status(corsError ? 403 : 500).json({
    success: false,
    message: corsError
      ? error.message
      : 'The server could not complete this request.',
  });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`SehatRoute API listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received. Closing server.`);

  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));