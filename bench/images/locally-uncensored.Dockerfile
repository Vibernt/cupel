FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev libxdo-dev libxkbcommon-dev libssl-dev \
    patchelf file \
    && rm -rf /var/lib/apt/lists/*
