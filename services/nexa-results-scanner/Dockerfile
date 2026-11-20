FROM clamav/clamav:1.4-debian13-slim
USER root

# ClamAV 1.4.6 and 1.5.4 include upstream security fixes for prior scanner
# releases. Reject older versions if the floating 1.4 Debian image tag lags.
RUN version="$(clamscan --version | awk '{print $2}')" \
    && awk -F. -v version="$version" 'BEGIN { \
      split(version, v, "."); \
      safe = (v[1] > 1 || \
        (v[1] == 1 && v[2] == 4 && v[3] >= 6) || \
        (v[1] == 1 && v[2] == 5 && v[3] >= 4) || \
        (v[1] == 1 && v[2] > 5)); \
      exit safe ? 0 : 1; \
    }' || { echo "ClamAV 1.4.6 or 1.5.4+ is required." >&2; exit 1; }

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /run/clamav \
    && chown clamav:clamav /app /run/clamav

# Avoid keeping two signature engines in memory during daily database reloads.
RUN if grep -q '^ConcurrentDatabaseReload ' /etc/clamav/clamd.conf; then \
      sed -i 's/^ConcurrentDatabaseReload .*/ConcurrentDatabaseReload no/' /etc/clamav/clamd.conf; \
    else \
      printf '\nConcurrentDatabaseReload no\n' >> /etc/clamav/clamd.conf; \
    fi

WORKDIR /app
COPY --chown=clamav:clamav server.mjs ./server.mjs
COPY --chown=clamav:clamav entrypoint.sh ./entrypoint.sh
RUN chmod 0555 /app/entrypoint.sh
USER clamav
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
