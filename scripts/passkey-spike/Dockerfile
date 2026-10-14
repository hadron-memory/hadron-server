FROM node:22-alpine
WORKDIR /spike
COPY scripts/passkey-spike/package*.json ./
RUN npm ci --omit=dev
COPY scripts/passkey-spike/ ./
COPY src/lib/signaturePayload.fixture.json /src/lib/signaturePayload.fixture.json
# preview.mjs resolves ../../src from /spike, which is /src.
USER node
ENV PASSKEY_SPIKE_BIND=0.0.0.0 PASSKEY_SPIKE_PORT=4380 PASSKEY_SPIKE_BASE_PATH=/__passkey-al/ PASSKEY_SPIKE_RP_ID=hadronmemory.com
EXPOSE 4380
CMD ["node", "preview.mjs"]
