#!/usr/bin/env bash
# Run a local BRouter routing server on http://localhost:17777/brouter
#
# Usage:
#   ./scripts/run-brouter.sh
#   SEGMENTS="E0_N45 E5_N45" ./scripts/run-brouter.sh
#
# Downloads (cached in brouter/): the latest BRouter release from GitHub
# and the routing segment tiles listed in $SEGMENTS from brouter.de.

set -euo pipefail

PORT=17777
SEGMENTS="${SEGMENTS:-E0_N45}"
SEGMENTS_BASE_URL="https://brouter.de/brouter/segments4"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROUTER_DIR="$REPO_ROOT/brouter"

CURL=(curl -fL --retry 5 --retry-delay 3 --connect-timeout 30 --max-time 1800)

# --- 1. Check java >= 11 -----------------------------------------------------
if ! command -v java >/dev/null 2>&1; then
  echo "ERROR: 'java' not found. BRouter needs a Java runtime (>= 11)." >&2
  echo "Install one, e.g.: sudo apt install default-jre   (or openjdk-17-jre)" >&2
  exit 1
fi

JAVA_VERSION_RAW="$(java -version 2>&1 | head -n1)"
JAVA_MAJOR="$(echo "$JAVA_VERSION_RAW" | sed -E 's/.*version "([0-9]+)(\.[0-9]+)*.*/\1/')"
if [[ "$JAVA_MAJOR" == "1" ]]; then
  # Old versioning scheme, e.g. 1.8.0 -> major is the second field
  JAVA_MAJOR="$(echo "$JAVA_VERSION_RAW" | sed -E 's/.*version "1\.([0-9]+).*/\1/')"
fi
if ! [[ "$JAVA_MAJOR" =~ ^[0-9]+$ ]] || (( JAVA_MAJOR < 11 )); then
  echo "ERROR: Java >= 11 required, found: $JAVA_VERSION_RAW" >&2
  echo "Install a newer JRE, e.g.: sudo apt install openjdk-17-jre" >&2
  exit 1
fi
echo "Using $JAVA_VERSION_RAW"

# --- 2. Directories + .gitignore --------------------------------------------
mkdir -p "$BROUTER_DIR/segments4" "$BROUTER_DIR/profiles2" "$BROUTER_DIR/customprofiles"

GITIGNORE="$REPO_ROOT/.gitignore"
if ! grep -qxE 'brouter/?' "$GITIGNORE" 2>/dev/null; then
  echo "brouter/" >> "$GITIGNORE"
  echo "Added brouter/ to .gitignore"
fi

# --- 3. Download BRouter release (jar + profiles) ----------------------------
JAR="$(find "$BROUTER_DIR" -maxdepth 1 -name 'brouter-*.jar' | sort | tail -n1 || true)"

if [[ -z "$JAR" ]]; then
  echo "Fetching latest BRouter release info from GitHub..."
  RELEASE_JSON="$BROUTER_DIR/latest-release.json"
  "${CURL[@]}" -s -o "$RELEASE_JSON" https://api.github.com/repos/abrensch/brouter/releases/latest

  # Prefer a zip asset (contains jar + misc/profiles2); fall back to a bare jar.
  ZIP_URL="$(grep -oE '"browser_download_url": *"[^"]*brouter[^"]*\.zip"' "$RELEASE_JSON" | head -n1 | sed -E 's/.*"(https[^"]*)"/\1/' || true)"
  JAR_URL="$(grep -oE '"browser_download_url": *"[^"]*brouter[^"]*\.jar"' "$RELEASE_JSON" | head -n1 | sed -E 's/.*"(https[^"]*)"/\1/' || true)"

  if [[ -n "$ZIP_URL" ]]; then
    ZIP_FILE="$BROUTER_DIR/$(basename "$ZIP_URL")"
    if [[ ! -f "$ZIP_FILE" ]]; then
      echo "Downloading $ZIP_URL ..."
      "${CURL[@]}" -o "$ZIP_FILE.tmp" "$ZIP_URL" && mv "$ZIP_FILE.tmp" "$ZIP_FILE"
    fi
    echo "Extracting release zip..."
    EXTRACT_DIR="$BROUTER_DIR/release"
    mkdir -p "$EXTRACT_DIR"
    unzip -oq "$ZIP_FILE" -d "$EXTRACT_DIR"
    # Locate the server jar inside the zip (exclude Android apk/aar artifacts)
    ZJAR="$(find "$EXTRACT_DIR" -name 'brouter-*.jar' | sort | tail -n1 || true)"
    if [[ -z "$ZJAR" ]]; then
      echo "ERROR: no brouter-*.jar found inside $ZIP_FILE" >&2
      exit 1
    fi
    cp "$ZJAR" "$BROUTER_DIR/"
    # Copy standard profiles shipped in the zip (misc/profiles2 or profiles2)
    PROFILES_SRC="$(find "$EXTRACT_DIR" -type d -name profiles2 | head -n1 || true)"
    if [[ -n "$PROFILES_SRC" ]]; then
      cp "$PROFILES_SRC"/* "$BROUTER_DIR/profiles2/"
    fi
  elif [[ -n "$JAR_URL" ]]; then
    echo "Downloading $JAR_URL ..."
    "${CURL[@]}" -o "$BROUTER_DIR/$(basename "$JAR_URL").tmp" "$JAR_URL"
    mv "$BROUTER_DIR/$(basename "$JAR_URL").tmp" "$BROUTER_DIR/$(basename "$JAR_URL")"
  else
    echo "ERROR: could not find a brouter zip or jar asset in the latest GitHub release." >&2
    echo "Check https://github.com/abrensch/brouter/releases manually." >&2
    exit 1
  fi

  JAR="$(find "$BROUTER_DIR" -maxdepth 1 -name 'brouter-*.jar' | sort | tail -n1)"
fi
echo "Using jar: $JAR"

# Profiles: if still empty (e.g. bare-jar release), fetch profiles2 from the repo tree
if [[ -z "$(ls -A "$BROUTER_DIR/profiles2" 2>/dev/null)" ]]; then
  echo "Fetching standard profiles from the BRouter git repo..."
  PROF_TARBALL="$BROUTER_DIR/profiles2.tar.gz"
  "${CURL[@]}" -o "$PROF_TARBALL" https://api.github.com/repos/abrensch/brouter/tarball/master
  tar -xzf "$PROF_TARBALL" -C "$BROUTER_DIR" --wildcards '*/misc/profiles2/*' --strip-components=3
  rm -f "$PROF_TARBALL"
fi
echo "Profiles: $(ls "$BROUTER_DIR/profiles2" | wc -l) files in $BROUTER_DIR/profiles2"

# --- 4. Download segment tiles ------------------------------------------------
for TILE in $SEGMENTS; do
  DEST="$BROUTER_DIR/segments4/$TILE.rd5"
  if [[ -f "$DEST" ]]; then
    echo "Segment $TILE.rd5 already present, skipping."
  else
    echo "Downloading segment $TILE.rd5 (this can be 100-250 MB, be patient)..."
    "${CURL[@]}" -o "$DEST.tmp" "$SEGMENTS_BASE_URL/$TILE.rd5"
    mv "$DEST.tmp" "$DEST"
  fi
done

# --- 5. Start the server -------------------------------------------------------
echo "Starting BRouter server on port $PORT ..."
echo "URL: http://localhost:$PORT/brouter"
echo "Example: curl 'http://localhost:$PORT/brouter?lonlats=2.2945,48.8584|2.3376,48.8606&profile=trekking&alternativeidx=0&format=geojson'"
exec java -Xmx256M -Xms64M -Xmn32M -cp "$JAR" btools.server.RouteServer \
  "$BROUTER_DIR/segments4" "$BROUTER_DIR/profiles2" "$BROUTER_DIR/customprofiles" "$PORT" 1
