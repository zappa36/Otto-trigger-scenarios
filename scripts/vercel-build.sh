#!/bin/sh
# ============================================================
# Vercel build: bake env vars into config.js.
#
# All three values are public in the browser anyway (the anon key
# by Supabase's design, the Maps key referrer-locked) — injecting
# them at build time just keeps them out of the git history of a
# public repo. A variable that is not set leaves its placeholder,
# and config.js's runtime guard turns that into demo mode.
#
# vercel.json's buildCommand runs this file; it moved out of the
# inline command when the third injection outgrew Vercel's
# 256-character buildCommand limit.
# ============================================================
set -eu

sub() { # sub ENV_NAME PLACEHOLDER
  name="$1"; ph="$2"
  val="$(printenv "$name" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -n "$val" ]; then
    # the placeholder must still be there — refuse to ship a half-built config
    grep -q "$ph" config.js || { echo "config.js: $ph placeholder drifted"; exit 1; }
    sed -i "s|$ph|$val|" config.js
    echo "injected $name"
  else
    echo "$name not set — $ph stays (runtime falls back to demo mode)"
  fi
}

sub GMAPS_BROWSER_KEY __GMAPS_KEY__
sub SUPABASE_URL __SUPABASE_URL__
sub SUPABASE_ANON_KEY __SUPABASE_ANON_KEY__

# deploy stamp: UTC date.time plus the commit, e.g. 250806.1432-c05ebe0
b="$(date -u +'%y%m%d.%H%M')"
s="$(printf %s "${VERCEL_GIT_COMMIT_SHA:-}" | cut -c1-7)"
[ -n "$s" ] && b="$b-$s"
if grep -q __BUILD__ config.js; then
  sed -i "s|__BUILD__|$b|" config.js
  echo "build stamp: $b"
fi
