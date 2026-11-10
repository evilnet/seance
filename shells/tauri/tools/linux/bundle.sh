#!/bin/sh
# Inside the container (build-linux.sh): the release .deb and AppImage, from
# the public/ and icons the host prepared, copied to /out.
set -e
cd /src/shells/tauri
# linuxdeploy is itself an AppImage, and a container has no FUSE.
export APPIMAGE_EXTRACT_AND_RUN=1
tauri build --bundles deb,appimage --config '{"build":{"beforeBuildCommand":""}}'
rm -f /out/*.deb /out/*.AppImage
cp /target/release/bundle/deb/*.deb /target/release/bundle/appimage/*.AppImage /out/
ls -l /out
