require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const packageRoutes = require('./routes/package.routes');
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const adminRoutes = require('./routes/admin.routes');
const tourGuideRoutes = require('./routes/tour-guide.routes');
const paymentRoutes = require('./routes/payment.routes');

const app = express();

// Trust proxy - REQUIRED for Railway/Render/Heroku deployment
app.set('trust proxy', 1);

/* CONFIGURATION */
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required!');
  process.exit(1);
}

/* SECURITY */
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

/* RATE LIMITING */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // max requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again later.' }
});

app.use('/auth/login', loginLimiter);
app.use(apiLimiter);

/* BODY PARSER */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* CORS */
const allowedOrigins = FRONTEND_URL.includes(',')
  ? FRONTEND_URL.split(',').map(url => url.trim())
  : [FRONTEND_URL];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true
  })
);

/* SESSION */
const sessionPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false
});

app.use(
  session({
    name: 'meetandgo.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new pgSession({
      pool: sessionPool,
      tableName: 'session',
      createTableIfMissing: true
    }),
    cookie: {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 2 // 2 hours
    }
  })
);

/* CSRF PROTECTION */
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (req.method !== 'GET') {
    if (origin && !allowedOrigins.includes(origin)) {
      console.warn(`[CSRF] Blocked request from origin: ${origin}`);
      return res.status(403).json({ error: 'CSRF blocked' });
    }
  }
  next();
});

/* HEALTH CHECK */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: 'postgresql'
  });
});

/* ROUTES */
app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/admin', adminRoutes);
app.use('/tour-guide', tourGuideRoutes);
app.use('/packages', packageRoutes);
app.use('/uploads', express.static('uploads'));
app.use('/payment', paymentRoutes);


/* 404 HANDLER */
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

/* ERROR HANDLER */
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

/* START SERVER */
const server = app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
  console.log(`Frontend allowed from: ${FRONTEND_URL}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database: PostgreSQL`);
});

/* GRACEFUL SHUTDOWN */
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    sessionPool.end(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    sessionPool.end(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});