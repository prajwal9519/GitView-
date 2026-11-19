#!/usr/bin/env node
/**
 * ==============================================================================
 * GitView Phase 5: Trusted Static File Server (gitview-serve.js)
 * ==============================================================================
 * Security & Functional Guarantees:
 * 1. Zero dependencies: Pure Node.js standard library (http, fs, path, url).
 * 2. Scope confinement: Serves files exclusively from --root (default: /workspace).
 * 3. Path traversal defense: Strict canonical path resolution; rejects "..", "%2e%2e",
 *    and null bytes.
 * 4. Symlink rejection: Uses fs.lstatSync to explicitly reject symbolic links.
 * 5. Directory listing disabled: Returns 404 or index.html; never exposes directory trees.
 * 6. Sensitive file protection: Explicitly denies access to .env*, .git*, node_modules,
 *    .npmrc, and hidden files starting with '.'.
 * 7. Single-Page Application (SPA) fallback: Unmatched extensionless routes fall back
 *    to /index.html with HTTP 200 for client-side routing.
 * 8. MIME type fidelity: Comprehensive dictionary covering HTML, CSS, JS, WASM, SVG, fonts.
 * ==============================================================================
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Parse CLI flags: --root, --port, --host
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return defaultValue;
}

const ROOT_DIR = path.resolve(getArg('--root', '/workspace'));
const PORT = parseInt(getArg('--port', process.env.PORT || '3000'), 10);
const HOST = getArg('--host', '0.0.0.0');

// Comprehensive MIME mapping
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

// Patterns strictly denied from serving
const SENSITIVE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.gitlab',
  '.npmrc',
  '.yarnrc',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.gitignore',
  '.dockerignore',
  '.DS_Store'
]);

function isSensitive(targetPath) {
  const rel = path.relative(ROOT_DIR, targetPath);
  const segments = rel.split(path.sep);

  for (const seg of segments) {
    if (!seg) continue;
    // Any segment starting with a dot (hidden files/folders like .git, .env)
    if (seg.startsWith('.')) {
      return true;
    }
    // Any segment explicitly sensitive
    if (SENSITIVE_SEGMENTS.has(seg)) {
      return true;
    }
    // Any .env variant
    if (/^\.env(\..+)?$/i.test(seg)) {
      return true;
    }
  }
  return false;
}

function sendResponse(res, statusCode, headers, body) {
  const defaultHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Server': 'GitView-Preview-Serve/1.0',
    'Cache-Control': 'no-cache'
  };
  res.writeHead(statusCode, { ...defaultHeaders, ...headers });
  if (body) {
    res.end(body);
  } else {
    res.end();
  }
}

const server = http.createServer((req, res) => {
  const startTime = Date.now();

  // Method check: only GET and HEAD are permitted for static file serving
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendResponse(res, 405, { 'Content-Type': 'text/plain', 'Allow': 'GET, HEAD' }, 'Method Not Allowed\n');
  }

  // Path Traversal Pre-check on raw URL string
  const rawUrl = req.url;
  if (rawUrl.includes('..') || /%2e/i.test(rawUrl)) {
    console.warn(`[SECURITY] Path traversal blocked in raw URL: ${rawUrl}`);
    return sendResponse(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden: Path Traversal Prohibited\n');
  }

  // Parse and validate URL
  let parsedUrl;
  try {
    parsedUrl = new url.URL(req.url, 'http://localhost');
  } catch (err) {
    return sendResponse(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request: Invalid URL\n');
  }

  // Decode URI path safely
  let pathname;
  try {
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch (err) {
    return sendResponse(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request: Invalid URI Encoding\n');
  }

  // Reject null bytes and control characters
  if (pathname.includes('\0')) {
    return sendResponse(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request: Null Byte Detected\n');
  }

  // Check decoded pathname for traversal segments
  if (pathname.split('/').some(part => part === '..')) {
    console.warn(`[SECURITY] Path traversal segment blocked: ${pathname}`);
    return sendResponse(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden: Path Traversal Prohibited\n');
  }

  // Normalize path and resolve within ROOT_DIR
  const normalizedPath = path.normalize(pathname);
  const resolvedPath = path.resolve(ROOT_DIR, '.' + normalizedPath);

  // Path Traversal Guard: Ensure resolved path is strictly within ROOT_DIR
  if (resolvedPath !== ROOT_DIR && !resolvedPath.startsWith(ROOT_DIR + path.sep)) {
    console.warn(`[SECURITY] Path traversal blocked: ${pathname} -> ${resolvedPath}`);
    return sendResponse(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden: Access Denied\n');
  }

  // Sensitive File Guard: Block access to .env, .git, node_modules, etc.
  if (isSensitive(resolvedPath)) {
    console.warn(`[SECURITY] Sensitive path blocked: ${pathname}`);
    return sendResponse(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden: Sensitive Resource\n');
  }

  // Inspect file/directory status
  let stat;
  try {
    // Use lstatSync to detect symbolic links
    stat = fs.lstatSync(resolvedPath);
  } catch (err) {
    // Path does not exist. Check if eligible for SPA fallback.
    const ext = path.extname(resolvedPath);
    // If extensionless and root index.html exists, serve SPA fallback
    if (!ext) {
      const fallbackIndex = path.join(ROOT_DIR, 'index.html');
      try {
        const indexStat = fs.lstatSync(fallbackIndex);
        if (indexStat.isFile() && !indexStat.isSymbolicLink()) {
          const content = fs.readFileSync(fallbackIndex);
          return sendResponse(res, 200, {
            'Content-Type': 'text/html; charset=utf-8',
            'X-GitView-Fallback': 'SPA'
          }, req.method === 'HEAD' ? null : content);
        }
      } catch (e) {
        // Fallback index.html doesn't exist
      }
    }
    return sendResponse(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found\n');
  }

  // Symlink Guard: Reject all symbolic links
  if (stat.isSymbolicLink()) {
    console.warn(`[SECURITY] Symlink access rejected: ${pathname}`);
    return sendResponse(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden: Symbolic Links Prohibited\n');
  }

  // Handle directory
  let filePath = resolvedPath;
  if (stat.isDirectory()) {
    const dirIndex = path.join(resolvedPath, 'index.html');
    try {
      const indexStat = fs.lstatSync(dirIndex);
      if (indexStat.isFile() && !indexStat.isSymbolicLink()) {
        filePath = dirIndex;
        stat = indexStat;
      } else {
        // Directory listing disabled
        return sendResponse(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found: Directory Listing Disabled\n');
      }
    } catch (err) {
      // Directory listing disabled
      return sendResponse(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found: Directory Listing Disabled\n');
    }
  }

  // Ensure it's a regular file
  if (!stat.isFile()) {
    return sendResponse(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden: Not a Regular File\n');
  }

  // Determine MIME type
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // Read and serve file
  try {
    const content = fs.readFileSync(filePath);
    const duration = Date.now() - startTime;
    console.log(`[${req.method}] ${pathname} 200 (${contentType}, ${content.length} bytes, ${duration}ms)`);
    sendResponse(res, 200, {
      'Content-Type': contentType,
      'Content-Length': content.length
    }, req.method === 'HEAD' ? null : content);
  } catch (err) {
    console.error(`[ERROR] Failed to read file ${filePath}:`, err.message);
    sendResponse(res, 500, { 'Content-Type': 'text/plain' }, 'Internal Server Error\n');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[GitView-Serve] Serving static content from: ${ROOT_DIR}`);
  console.log(`[GitView-Serve] Listening on http://${HOST}:${PORT}`);
});

// Graceful shutdown
function shutdown() {
  console.log('\n[GitView-Serve] Shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
