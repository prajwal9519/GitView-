// Builds the Express app but does NOT call listen(), so tests can import it
// and make requests without opening a real port.
//
// Order matters: each line runs for every request, top to bottom.
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import routes from './routes.js';

export const app = express();

// Behind a reverse proxy (Render, Heroku, nginx) every request appears to come
// from the proxy. Telling Express how many proxies to trust makes req.ip the
// real client, which the rate limiter needs. 0 = no proxy.
app.set('trust proxy', env.TRUST_PROXY);

// Sets security headers (CSP, no MIME sniffing, ...) and removes X-Powered-By.
app.use(helmet());

// CORS allow-list: only OUR frontend may call the API from a browser, and
// `credentials: true` lets it send the auth cookies. A wildcard origin is
// forbidden together with credentials, which is why we name the origin.
app.use(cors({ origin: new URL(env.FRONTEND_URL).origin, credentials: true }));

if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Parses JSON bodies and caps their size (blocks oversized payloads).
app.use(express.json({ limit: '100kb' }));

// Parses the Cookie header into req.cookies (we read the auth tokens from it).
app.use(cookieParser());

app.use('/api/v1', routes);

app.use(notFound); // no route matched
app.use(errorHandler); // must be last: catches every error thrown above
