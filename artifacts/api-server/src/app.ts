import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

const PgSession = connectPgSimple(session);

const app: Express = express();

// Trust exactly one proxy hop (Replit's TLS-terminating reverse proxy).
// Without this, express-session sees the forwarded HTTP connection as insecure
// and refuses to set cookie.secure=true cookies, blocking all authenticated flows.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// CORS — explicit allowlist derived from Replit environment variables.
// origin: true is intentionally never used — reflected origins enable CSRF via
// credentialed cross-origin requests from any attacker-controlled HTTPS page.
//
// In production the frontend and API share the same Replit-proxied domain, so
// all fetch() calls are same-origin and no CORS header is emitted.
// In development the Replit proxy domain is still the only allowed origin.
function buildAllowedOrigins(): string[] {
  const origins = new Set<string>();

  // Primary Replit dev proxy domain
  if (process.env.REPLIT_DEV_DOMAIN) {
    origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }

  // All domains listed in REPLIT_DOMAINS (comma-separated in some environments)
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
      // Same-origin requests have no Origin header — always allow
      if (!incomingOrigin) return callback(null, true);
      if (allowedOrigins.includes(incomingOrigin)) return callback(null, true);
      callback(new Error(`CORS: origin "${incomingOrigin}" is not allowed`));
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware — uses SESSION_SECRET from Replit Secrets.
// Sessions are stored in PostgreSQL (connect-pg-simple) so they survive
// across container restarts and multiple autoscale instances.
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  logger.error("SESSION_SECRET environment variable is required");
  process.exit(1);
}

app.use(
  session({
    store: new PgSession({
      pool,
      // The session table is provisioned by runStartupMigrations() before the
      // server begins accepting traffic, so lazy creation is not needed and is
      // disabled to prevent concurrent cold-start races.
      createTableIfMissing: false,
      // Prune expired sessions every 15 minutes.
      //
      // Table-growth expectation: with maxAge=24h and pruning every 15 min,
      // the "session" table will hold at most ~96 pruning windows worth of
      // concurrent live sessions. Under typical load (a few hundred active
      // users) this stays well under a few thousand rows. The IDX_session_expire
      // index (created in runStartupMigrations) makes both the DELETE prune
      // query and session lookups O(log n) so the table never becomes a hotspot.
      // If load grows significantly, reduce this interval further or add
      // pg_cron to schedule pruning independently of process uptime.
      pruneSessionInterval: 15 * 60,
    }),
    secret: sessionSecret,
    name: "screener.sid",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // Secure is required when SameSite=None; Replit proxies all traffic over
      // HTTPS so this is safe to enable in development too.
      secure: true,
      // Lax is correct here: the frontend and API are co-located behind the
      // same Replit proxy domain. SameSite=None is only needed for explicitly
      // cross-site deployments and would allow third-party cookie sending.
      sameSite: "lax",
      // 24 hours max session age
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use("/api", router);

export default app;
