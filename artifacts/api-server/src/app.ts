import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
} from "./middlewares/clerkProxyMiddleware.js";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { pool } from "@workspace/db";

const PgSession = connectPgSimple(session);

const app: Express = express();

// Trust exactly one proxy hop (Replit's TLS-terminating reverse proxy).
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  })
);

// Clerk Frontend API proxy — MUST be before body parsers (streams raw bytes).
// Only active in production; no-ops in development.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// CORS
function buildAllowedOrigins(): string[] {
  const origins = new Set<string>();
  if (process.env.REPLIT_DEV_DOMAIN) origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  if (process.env.REPLIT_DOMAINS) {
    for (const domain of process.env.REPLIT_DOMAINS.split(",")) {
      const d = domain.trim();
      if (d) origins.add(`https://${d}`);
    }
  }
  return [...origins];
}

const allowedOrigins = buildAllowedOrigins();
logger.info({ allowedOrigins }, "CORS allowlist configured");

app.use(
  cors({
    origin: (incomingOrigin, callback) => {
      if (!incomingOrigin) return callback(null, true);
      if (allowedOrigins.includes(incomingOrigin)) return callback(null, true);
      callback(new Error(`CORS: origin "${incomingOrigin}" is not allowed`));
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Clerk middleware — populates getAuth(req) on every request.
// Must be mounted after CORS and body parsers.
// Auto-reads CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY from env vars.
app.use(clerkMiddleware());

// Session middleware — kept for database schema compatibility (session table).
// Auth is now handled by Clerk; sessions are not used for authentication.
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  logger.warn("SESSION_SECRET not set — session middleware disabled");
} else {
  app.use(
    session({
      store: new PgSession({
        pool,
        createTableIfMissing: false,
        pruneSessionInterval: 15 * 60,
      }),
      secret: sessionSecret,
      name: "screener.sid",
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );
}

app.use("/api", router);

export default app;
