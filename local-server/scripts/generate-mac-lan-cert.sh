#!/usr/bin/env bash
# Create a local TEST certificate for hostname gtct-pos + this Mac's LAN IP
# so iPhones can open https://<lan-ip>:8787 without a hosts file.
set -euo pipefail

HOST_NAME="${GTCT_LAN_HOSTNAME:-gtct-pos}"
OUT_DIR="${GTCT_TLS_DIR:-$HOME/Library/Application Support/GTCT/RestaurantLocalServer/tls}"
DAYS="${GTCT_TLS_DAYS:-825}"

LAN_IP="${GTCT_LAN_BIND_ADDRESS:-}"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
fi
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
if [[ -z "$LAN_IP" ]]; then
  echo "Set GTCT_LAN_BIND_ADDRESS to this Mac's Wi-Fi IP (e.g. 192.168.0.114)."
  exit 1
fi

mkdir -p "$OUT_DIR"
CERT="$OUT_DIR/${HOST_NAME}.crt"
KEY="$OUT_DIR/${HOST_NAME}.key"
CFG="$OUT_DIR/${HOST_NAME}.cnf"

cat > "$CFG" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ${HOST_NAME}
O = GTCT Restaurant TEST
OU = Local Terminal LAN

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${HOST_NAME}
IP.1 = ${LAN_IP}
EOF

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$KEY" \
  -out "$CERT" \
  -days "$DAYS" \
  -config "$CFG"

chmod 600 "$KEY"
chmod 644 "$CERT"

echo "Certificate: $CERT"
echo "Private key: $KEY"
echo "LAN IP in cert: $LAN_IP"
echo
echo "On iPhone / tablet open:"
echo "  https://${LAN_IP}:8787/pair.html"
echo "(Accept the certificate warning once for TEST.)"
echo
echo "On Windows PC you can either use that IP URL, or add hosts:"
echo "  ${LAN_IP}  ${HOST_NAME}"
echo "  then https://${HOST_NAME}:8787"
