# ==============================================================================
# GitView Phase 5: Hardened Preview Runner Dockerfile
# ==============================================================================
# Hardened Debian Bookworm Slim image pinned to verified multi-arch digest.
# Runtime execution is strictly locked to unprivileged user gitview (UID 10001).
# Root filesystem is designed for read-only runtime enforcement (--read-only).
# ==============================================================================

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

LABEL maintainer="GitView Team" \
      description="GitView Isolated Preview Runner Image" \
      security.unprivileged="UID 10001" \
      security.read_only="true"

# 1. Create dedicated unprivileged group and user
RUN groupadd -g 10001 gitview \
    && useradd -u 10001 -g gitview -m -d /home/gitview -s /bin/sh gitview

# 2. Pre-create workspace and user cache directories with explicit ownership
RUN mkdir -p /workspace /home/gitview/.npm /home/gitview/.cache \
    && chown -R 10001:10001 /workspace /home/gitview

# 3. Install trusted static file server
COPY scripts/gitview-serve.js /usr/local/bin/gitview-serve.js
RUN chmod 755 /usr/local/bin/gitview-serve.js

# 4. Install pinned, trusted Vite CLI and React plugin globally
RUN npm install -g --no-audit --no-fund \
    vite@5.4.14 \
    @vitejs/plugin-react@4.3.4 \
    && rm -rf /root/.npm \
    && chmod 755 /usr/local/bin/vite

# 5. Set hardened runtime environment
ENV NODE_ENV=production \
    HOME=/home/gitview \
    npm_config_cache=/tmp/npm-cache \
    NODE_PATH=/usr/local/lib/node_modules \
    PATH="/usr/local/bin:/usr/bin:/bin"

# 6. Switch to unprivileged non-root user
USER 10001:10001
WORKDIR /workspace

# Default command: Serve static content from /workspace
CMD ["node", "/usr/local/bin/gitview-serve.js", "--port", "3000", "--root", "/workspace"]
