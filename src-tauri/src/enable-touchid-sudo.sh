#!/bin/bash
# Enables Touch ID for sudo by ensuring /etc/pam.d/sudo_local contains an
# uncommented pam_tid.so line. Re-execs itself under sudo if not already
# running as root, so the password is typed into sudo itself, in a terminal
# the user can see. Adapted from iTerm2's install-touchid-sudo.sh (GPLv2+).
#
# sudo_local (macOS 14+) is included by /etc/pam.d/sudo and survives OS
# updates, unlike an edit to /etc/pam.d/sudo itself, which this never touches.

set -e

if [ "$EUID" -ne 0 ]; then
    echo "Termic will enable Touch ID for sudo by running:"
    echo "  sudo \"$0\""
    echo
    echo "Script contents:"
    echo "----------------------------------------------------------------"
    cat "$0"
    echo "----------------------------------------------------------------"
    echo
    exec sudo "$0"
fi

SUDO_PAM=/etc/pam.d/sudo
SUDO_LOCAL=/etc/pam.d/sudo_local
TEMPLATE=/etc/pam.d/sudo_local.template
PAM_LINE='auth       sufficient     pam_tid.so'

if ! grep -q '^auth.*sudo_local' "$SUDO_PAM" 2>/dev/null; then
    echo "$SUDO_PAM does not include sudo_local (it needs macOS 14 or later)."
    echo "Nothing was changed."
    exit 1
fi

if [ -f "$SUDO_LOCAL" ]; then
    SRC=$SUDO_LOCAL
elif [ -f "$TEMPLATE" ]; then
    SRC=$TEMPLATE
else
    echo "$PAM_LINE" > "$SUDO_LOCAL"
    chmod 644 "$SUDO_LOCAL"
    echo "Touch ID for sudo enabled (created $SUDO_LOCAL)."
    exit 0
fi

# Build the result in a temp file and copy it into place: an in-place edit
# of a file under /etc/pam.d/ fails with "Operation not permitted" on
# macOS 26, even as root.
T=$(mktemp)
trap 'rm -f "$T"' EXIT

sed "s/^#auth.*pam_tid.so/$PAM_LINE/" "$SRC" > "$T"
grep -q '^auth.*pam_tid.so' "$T" || echo "$PAM_LINE" >> "$T"

cp -f "$T" "$SUDO_LOCAL"
chmod 644 "$SUDO_LOCAL"
echo "Touch ID for sudo enabled. Test it with: sudo -k && sudo -v"
