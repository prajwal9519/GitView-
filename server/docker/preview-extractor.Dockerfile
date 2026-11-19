# ==============================================================================
# GitView Phase 5: Disposable Preview Extractor Dockerfile
# ==============================================================================
# Hardened Debian Bookworm Slim image pinned to verified multi-arch digest.
# Runs strictly as unprivileged user gitview (UID 10001) with read-only root.
# Execution is sandboxed with network disabled (--network none) and no caps.
# ==============================================================================

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

LABEL maintainer="GitView Team" \
      description="GitView Isolated Preview Archive Extractor Image" \
      security.unprivileged="UID 10001" \
      security.read_only="true"

# 1. Create dedicated unprivileged group and user
RUN groupadd -g 10001 gitview \
    && useradd -u 10001 -g gitview -m -d /home/gitview -s /bin/sh gitview

# 2. Pre-create workspace and user cache directories with explicit ownership
RUN mkdir -p /workspace /home/gitview \
    && chown -R 10001:10001 /workspace /home/gitview

# 3. Install trusted streaming tar parser globally and symlink to root node_modules
RUN npm install -g --no-audit --no-fund \
    tar-stream@3.1.7 \
    && rm -rf /root/.npm \
    && ln -s /usr/local/lib/node_modules /node_modules

# 4. Copy trusted extraction script
COPY scripts/gitview-extract.js /usr/local/bin/gitview-extract.js
RUN chmod 755 /usr/local/bin/gitview-extract.js

# 5. Set hardened runtime environment
ENV NODE_ENV=production \
    HOME=/home/gitview \
    NODE_PATH=/usr/local/lib/node_modules \
    PATH="/usr/local/bin:/usr/bin:/bin"

# 6. Switch to unprivileged non-root user
USER 10001:10001
WORKDIR /workspace

# Default command: Extract archive from stdin into /workspace
CMD ["node", "/usr/local/bin/gitview-extract.js", "--dest", "/workspace"]
