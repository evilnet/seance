FROM rust:1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
    xvfb xauth imagemagick dbus dbus-x11 fonts-noto-color-emoji fonts-dejavu-core \
    nodejs npm file xdg-utils \
 && rm -rf /var/lib/apt/lists/*
# The Tauri CLI for the bundles (build-linux.sh), at package.json's version.
# Installed here rather than from the checkout's node_modules, which hold the
# host's platform binary.
ARG TAURI_CLI
RUN npm install -g "@tauri-apps/cli@$TAURI_CLI"
