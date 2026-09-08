#!/bin/sh
#
# Install RSIH into a directory on your PATH.
#
#   ./install.sh                # ask which mode
#   ./install.sh --copy         # self-contained install
#   ./install.sh --link         # symlink to this checkout's build
#
# Two install modes:
#
#   copy   Copies the built binary and everything it resolves relative to itself
#          into $RSIH_LIB_DIR (~/.local/lib/rsih) and links to it. Independent of
#          this checkout afterwards -- move or delete the repo and rsih keeps
#          working. This is what you want when installing for real.
#
#   link   Points $RSIH_INSTALL_DIR/rsih straight at this checkout's build.
#          Nothing is copied, so every `npm run build:binary` takes effect
#          immediately. This is what you want while developing RSIH itself.
#          The checkout has to stay where it is.
#
# Also writes `gee`, which is exactly `rsih --genome harness-rsi`.
#
# Environment: RSIH_INSTALL_DIR, RSIH_LIB_DIR, RSIH_INSTALL_MODE=copy|link.
# Safe to re-run: it overwrites its own output and touches nothing else.

set -eu

REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_MINOR=19
MODE=${RSIH_INSTALL_MODE:-}

for argument in "$@"; do
  case $argument in
    --copy) MODE=copy ;;
    --link) MODE=link ;;
    -h | --help)
      # The header comment is the help text; keep the range on its last line.
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown option: %s (try --help)\n' "$argument" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD="$(tput bold)"; DIM="$(tput dim)"; RED="$(tput setaf 1)"
  GREEN="$(tput setaf 2)"; YELLOW="$(tput setaf 3)"; MAGENTA="$(tput setaf 5)"
  RESET="$(tput sgr0)"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; MAGENTA=""; RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '%s warn%s %s\n' "$YELLOW" "$RESET" "$1"; }
die() { printf '%serror%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# ------------------------------------------------------------------ locate repo

script_path=$0
# Follow symlinks so the script works when linked from elsewhere.
while [ -L "$script_path" ]; do
  link=$(readlink "$script_path")
  case $link in
    /*) script_path=$link ;;
    *) script_path=$(dirname "$script_path")/$link ;;
  esac
done
REPO=$(cd "$(dirname "$script_path")" && pwd)

[ -f "$REPO/package.json" ] || die "run this from an RSIH checkout: $REPO has no package.json"
grep -q '"name": *"rsih"' "$REPO/package.json" ||
  die "$REPO does not look like the RSIH repository"

BIN_DIR=${RSIH_INSTALL_DIR:-$HOME/.local/bin}
LIB_DIR=${RSIH_LIB_DIR:-$HOME/.local/lib/rsih}

# ---------------------------------------------------------------- prerequisites

step "Checking prerequisites"

command -v node >/dev/null 2>&1 ||
  die "node $REQUIRED_NODE_MAJOR.$REQUIRED_NODE_MINOR+ is required. See https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm is required and was not found next to node"

node_version=$(node -v | sed 's/^v//')
node_major=$(echo "$node_version" | cut -d. -f1)
node_minor=$(echo "$node_version" | cut -d. -f2)
if [ "$node_major" -lt "$REQUIRED_NODE_MAJOR" ] ||
  { [ "$node_major" -eq "$REQUIRED_NODE_MAJOR" ] && [ "$node_minor" -lt "$REQUIRED_NODE_MINOR" ]; }; then
  die "node $REQUIRED_NODE_MAJOR.$REQUIRED_NODE_MINOR+ is required, found $node_version"
fi
note "node $node_version"

if command -v bun >/dev/null 2>&1; then
  HAVE_BUN=yes
  note "bun $(bun --version)"
else
  HAVE_BUN=no
  warn "bun not found, so there is no standalone binary to install."
  warn "Falling back to a node wrapper, which needs this checkout to stay put."
  note "Install bun and re-run for a self-contained install: https://bun.sh"
fi

# ------------------------------------------------------------------- pick mode

if [ -z "$MODE" ]; then
  if [ "$HAVE_BUN" = no ]; then
    # Without bun there is no payload to copy, so the choice does not exist.
    MODE=link
  elif [ -t 0 ] && [ -t 1 ]; then
    printf '\n%s==>%s How should rsih be installed?\n' "$BOLD" "$RESET"
    printf '      %s1)%s %scopy%s  self-contained in %s; survives moving or deleting this checkout\n' \
      "$BOLD" "$RESET" "$BOLD" "$RESET" "$LIB_DIR"
    printf '      %s2)%s %slink%s  symlink to %s/dist; picks up every rebuild\n' \
      "$BOLD" "$RESET" "$BOLD" "$RESET" "$REPO"
    printf '    Choose [%s1%s/2]: ' "$BOLD" "$RESET"
    read -r answer || answer=""
    case $answer in
      2 | l | link) MODE=link ;;
      *) MODE=copy ;;
    esac
    printf '\n'
  else
    MODE=copy
  fi
fi

if [ "$MODE" = copy ] && [ "$HAVE_BUN" = no ]; then
  warn "copy mode needs bun to build the binary; using link mode instead."
  MODE=link
fi

# ------------------------------------------------------------ build and install

step "Installing dependencies"
(cd "$REPO" && npm install --silent) || die "npm install failed"

step "Building and installing to $BIN_DIR ($MODE)"
mkdir -p "$BIN_DIR"

if [ "$MODE" = copy ]; then
  # One implementation of copy-install, shared with `npm run install:binary`.
  # The binary resolves its version, built-in Genome seeds and themes relative
  # to itself, so the whole payload has to travel with it.
  (cd "$REPO" && RSIH_INSTALL_DIR="$BIN_DIR" RSIH_LIB_DIR="$LIB_DIR" \
    npm run --silent install:binary) || die "build or install failed"
elif [ "$HAVE_BUN" = yes ]; then
  (cd "$REPO" && npm run --silent build:binary) || die "build failed"
  [ -f "$REPO/dist/rsih" ] || die "build reported success but $REPO/dist/rsih is missing"
  rm -f "$BIN_DIR/rsih"
  ln -s "$REPO/dist/rsih" "$BIN_DIR/rsih"
  note "linked $BIN_DIR/rsih -> $REPO/dist/rsih"
else
  (cd "$REPO" && npm run --silent build) || die "build failed"
  [ -f "$REPO/dist/src/cli.js" ] || die "build reported success but $REPO/dist/src/cli.js is missing"
  rm -f "$BIN_DIR/rsih"
  cat > "$BIN_DIR/rsih" <<EOF
#!/bin/sh
# Generated by RSIH install.sh. Delete freely.
exec "$(command -v node)" "$REPO/dist/src/cli.js" "\$@"
EOF
  chmod 755 "$BIN_DIR/rsih"
  note "wrote a node wrapper at $BIN_DIR/rsih"
fi

# `gee` is `rsih --genome harness-rsi`. It cannot be a link, because the binary
# has no way to know which name invoked it. Copy mode's install step writes this
# too; doing it here as well keeps link and wrapper mode complete.
if [ "$MODE" != copy ]; then
  cat > "$BIN_DIR/gee" <<EOF
#!/bin/sh
# Generated by RSIH install.sh. Equivalent to: rsih --genome harness-rsi
exec "$BIN_DIR/rsih" --genome harness-rsi "\$@"
EOF
  chmod 755 "$BIN_DIR/gee"
fi

note "rsih -> $BIN_DIR/rsih"
note "gee  -> $BIN_DIR/gee"

# ------------------------------------------------------------------- verify

step "Verifying"
installed_version=$("$BIN_DIR/rsih" --version 2>/dev/null </dev/null) ||
  die "$BIN_DIR/rsih was installed but does not run"
note "rsih $installed_version"

# The binary finds its Genome seeds relative to itself, so a payload that did
# not travel with it fails here rather than at first use.
"$BIN_DIR/rsih" genome validate paperlab >/dev/null 2>&1 </dev/null ||
  die "the built-in Genomes did not install correctly (rsih genome validate paperlab failed)"
note "built-in Genomes: paperlab, harness-rsi"

# --------------------------------------------------------------------- PATH

on_path=no
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) on_path=yes ;;
esac

printf '\n'
if [ "$on_path" = yes ]; then
  printf '%sInstalled.%s\n' "$GREEN$BOLD" "$RESET"
else
  printf '%sInstalled, but %s is not on your PATH.%s\n' "$YELLOW$BOLD" "$BIN_DIR" "$RESET"
  case $(basename "${SHELL:-sh}") in
    zsh) rc="$HOME/.zshrc" ;;
    bash) rc="$HOME/.bashrc" ;;
    fish) rc="$HOME/.config/fish/config.fish" ;;
    *) rc="your shell profile" ;;
  esac
  printf '\n  Add this to %s, then restart your shell:\n\n' "$rc"
  if [ "$(basename "${SHELL:-sh}")" = fish ]; then
    printf '    fish_add_path %s\n' "$BIN_DIR"
  else
    printf '    export PATH="%s:$PATH"\n' "$BIN_DIR"
  fi
fi

# ------------------------------------------------------------------ next steps

cat <<EOF

  ${BOLD}Try it${RESET}

    ${MAGENTA}rsih${RESET}                  ${DIM}# plain Pi, no Genome, zero difference${RESET}
    ${MAGENTA}rsih :harness-rsi${RESET}     ${DIM}# build a Genome from your own session history${RESET}
    ${MAGENTA}rsih :paperlab${RESET}        ${DIM}# a ready-made paper-experiment Genome${RESET}

  A leading ${BOLD}:${RESET} ${BOLD}::${RESET} or ${BOLD}+${RESET} is shorthand for --genome, so
  ${BOLD}rsih :harness-rsi${RESET} == ${BOLD}gee${RESET} == ${BOLD}rsih --genome harness-rsi${RESET}.

    ${MAGENTA}rsih genome list${RESET}      ${DIM}# what is installed, and what ships with it${RESET}

EOF
