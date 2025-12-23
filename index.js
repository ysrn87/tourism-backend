require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const adminRoutes = require('./routes/admin.routes');
const agentRoutes = require('./routes/agent.routes');

const app = express();

// Trust proxy - REQUIRED for Railway/Render/Heroku deployment
app.set('trust proxy', 1);

/* CONFIGURATION */
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

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
app.use(
  cors({
    origin: [
      FRONTEND_URL,
      'meetandgo-backend.up.railway.app'
    ],
    credentials: true
  })
);

/* SESSION */
const path = require('path');

app.use(
  session({
    name: 'meetandgo.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({
      db: 'sessions.sqlite',
      dir: path.join(__dirname, 'db')
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 2 // 2 hours
    }
  })
);

/* CSRF PROTECTION */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  if (req.method !== 'GET') {
    if (!origin || origin !== FRONTEND_URL) {
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
    uptime: process.uptime()
  });
});

/* ROUTES */
app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/admin', adminRoutes);
app.use('/agent', agentRoutes);

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
});

/* GRACEFUL SHUTDOWN */
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});