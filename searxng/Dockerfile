# Panda's private SearXNG for container hosts with no file mounts (PMS): the
# settings (JSON API on) are baked in, and SEARXNG_SECRET supplies the secret_key.
# Owned by uid 1000 because PMS runs every container as that user.
FROM searxng/searxng:latest
COPY --chown=1000:1000 config/settings.example.yml /etc/searxng/settings.yml
RUN chown -R 1000:1000 /etc/searxng /var/cache/searxng
